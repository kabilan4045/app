import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Redirect, Stack, router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../lib/AuthContext';
import { Card } from '../../components/ui/Card';
import { DateField } from '../../components/ui/DateField';
import { EmptyState } from '../../components/ui/EmptyState';
import { CommentPicker } from '../../components/dpr/CommentPicker';
import { DprDelayBreakdown } from '../../components/dpr/DprDelayBreakdown';
import { SubtaskListEditor } from '../../components/dpr/SubtaskListEditor';
import { formatDateLabel, formatDateTimeLabel } from '../../lib/formatTime';
import { fetchGeneralParameterReport, type GeneralParameterReportData } from '../../lib/reports/generalParameterReport';
import { fetchWorksForProject, type WorkOption } from '../../lib/flowchart/data';
import {
  DPR_DEPENDENCY_CATEGORIES,
  EMPTY_DPR_ENTRY,
  buildFullDayEntryList,
  dependencyDisplayLabel,
  fetchAllDprEntriesForTask,
  fetchDailyProgressPhotos,
  fetchDprTaskById,
  fetchSubtasksForTask,
  fetchSubtaskActualStarts,
  updateSubtaskActualStart,
  isDprPending,
  markDprSubmitted,
  todayDateKey,
  updateTaskActualDate,
  updateTaskStatusRpc,
  uploadDailyProgressPhoto,
  upsertTodayDprEntry,
  withNextDprDay,
  type DailyProgressPhoto,
  type DprComment,
  type DprDependencyCategory,
  type DprEntryFields,
  type DprHistoryEntry,
  type DprSubtaskItem,
  type DprTask,
  type TaskStatus,
} from '../../lib/dprEntries';

// Full-page DPR editor, by explicit correction — a task spans several real
// days (one planned day = one real DPR), so this pages through EVERY one of
// them ("DPR 1 of N", Prev/Next) instead of only ever showing today's entry
// in a flat form. Opens on Day 1 every time. "DPR History" (below) is now a
// lightweight popup FROM this page — a quick day-index to jump the pager —
// not a second full page, since this page already covers every day's real
// editing. Self-contained: fetches everything by taskId (the task row, its
// full real history, subtasks, works, photos) rather than receiving it as
// props, since a navigated page has no live connection back to the list
// screen's own state.

const STATUS_DISPLAY_LABEL: Record<TaskStatus, string> = {
  draft: 'Pending',
  ready: 'Pending',
  blocked: 'Pending',
  in_progress: 'In Progress',
  on_hold: 'On Hold',
  completed: 'Completed',
};

// A single dropdown replacing the old pill+conditional-action-buttons row,
// by explicit request — 'ready' is the real DB value behind the "Pending"
// label shown/selected here. update_task_status still enforces every real
// transition rule server-side (completed-lock, ready/on_hold-before-
// in_progress, cross-trade prerequisites), so offering all 4 up front is
// safe — an invalid pick just comes back as statusError.
// "Pending" isn't offered here, by explicit request — it's the natural
// starting state a task is already in before work begins, not something you
// manually switch a task back to. STATUS_DISPLAY_LABEL above still shows
// "Pending" as the current label for a task that's genuinely in that state.
const STATUS_DROPDOWN_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'in_progress', label: 'In Progress' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
];

function dayGap(fromKey: string, toKey: string): number {
  const from = new Date(`${fromKey}T00:00:00Z`).getTime();
  const to = new Date(`${toKey}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

export default function DprEditScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const { state } = useAuth();
  const profile = state.status === 'signed-in' ? state.profile : null;
  const userId = profile?.id ?? null;
  // Admin can correct a DPR after it's been submitted (or the task
  // completed): edit the actual dates and submit the day again.
  const isAdmin = profile?.role === 'admin';

  const [task, setTask] = useState<DprTask | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every real planned/submitted day for this task, oldest first — the
  // pager below walks through this. index resets to 0 ("DPR 1") every
  // fresh load, by explicit request.
  const [entries, setEntries] = useState<DprHistoryEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [subtasksByDate, setSubtasksByDate] = useState<Record<string, DprSubtaskItem[]>>({});
  // Per-subtask Actual Start Date, keyed by subtask id (null = same as task).
  const [subtaskStarts, setSubtaskStarts] = useState<Record<string, string | null>>({});
  const [subtaskStartError, setSubtaskStartError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    setError(null);
    try {
      const found = await fetchDprTaskById(taskId, todayDateKey());
      if (!found) {
        setTask(null);
        return;
      }
      setTask(found.task);
      setProjectId(found.projectId);
      const [rows, subtaskRows, worksList, photoList] = await Promise.all([
        fetchAllDprEntriesForTask(taskId),
        fetchSubtasksForTask(taskId),
        found.projectId ? fetchWorksForProject(found.projectId) : Promise.resolve([]),
        fetchDailyProgressPhotos(taskId),
      ]);
      setEntries(buildFullDayEntryList(rows, found.task.plannedStartDate, found.task.plannedEndDate));
      setIndex(0);
      const grouped: Record<string, DprSubtaskItem[]> = {};
      for (const s of subtaskRows) (grouped[s.reportDate] ??= []).push(s);
      setSubtasksByDate(grouped);
      const starts = await fetchSubtaskActualStarts(subtaskRows.map((s) => s.id));
      setSubtaskStarts(starts.dates);
      setWorks(worksList);
      setPhotos(photoList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-fetches just the task row (status/actual start/quantity) — used by
  // the task-level actions below so they don't reset the day pager back to
  // "DPR 1" every time, the way a full load() would.
  async function refreshTaskOnly() {
    if (!taskId) return;
    const found = await fetchDprTaskById(taskId, todayDateKey());
    if (found) setTask(found.task);
  }

  // Preconstruction/Construction/Cumulative delay breakdown — task-level,
  // same across every day page, same real fetch the Task Based Report
  // itself uses.
  const [delayData, setDelayData] = useState<GeneralParameterReportData | null>(null);
  const [delayLoading, setDelayLoading] = useState(true);
  const [delayError, setDelayError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId || !projectId) return;
    let cancelled = false;
    setDelayLoading(true);
    setDelayError(null);
    fetchGeneralParameterReport(taskId, projectId)
      .then((data) => {
        if (!cancelled) setDelayData(data);
      })
      .catch((err) => {
        if (!cancelled) setDelayError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDelayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, projectId]);

  // Each planned day is an equal share of the task's 100% (4 days -> 25%).
  const plannedDurationDays =
    task?.plannedStartDate && task.plannedEndDate ? dayGap(task.plannedStartDate, task.plannedEndDate) + 1 : null;
  const dayShareExact = plannedDurationDays && plannedDurationDays > 0 ? 100 / plannedDurationDays : null;
  const formatPct = (n: number) => String(Math.round(n * 100) / 100);

  // DPR day N is labelled Actual Start + (N-1) working days once the task
  // has an actual start (e.g. started 8 Sep, 4 DPRs -> 8, 9, 10, 11 Sep), by
  // explicit correction; before that, the planned day it's stored under.
  // Same weekday rule as the report's Projected End Date, so they agree.
  function dprDayDate(dayIndex: number, reportDate: string): Date {
    if (!task?.actualStartDate) return new Date(`${reportDate}T00:00:00Z`);
    const [y, m, d] = task.actualStartDate.split('-').map(Number);
    const cursor = new Date(Date.UTC(y, m - 1, d));
    let remaining = dayIndex;
    while (remaining > 0) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) remaining--;
    }
    return cursor;
  }

  // Current day's editable copy — reset whenever the pager moves.
  const [draft, setDraft] = useState<DprEntryFields>(EMPTY_DPR_ENTRY);
  const [quantityText, setQuantityText] = useState('');
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [targetedWorkforceText, setTargetedWorkforceText] = useState('');
  const [actualWorkforceText, setActualWorkforceText] = useState('');
  const [otherText, setOtherText] = useState('');
  const [architectCommentText, setArchitectCommentText] = useState('');
  const [clientCommentText, setClientCommentText] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [delayDropdownOpen, setDelayDropdownOpen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dayFieldsSaved, setDayFieldsSaved] = useState(false);

  useEffect(() => {
    const current = entries[index]?.fields ?? EMPTY_DPR_ENTRY;
    setDraft(current);
    setQuantityText(current.percentComplete != null && dayShareExact ? formatPct((current.percentComplete / dayShareExact) * 100) : '');
    setQuantityError(null);
    setTargetedWorkforceText(current.targetedWorkforcePerDay != null ? String(current.targetedWorkforcePerDay) : '');
    setActualWorkforceText(current.actualWorkforcePerDay != null ? String(current.actualWorkforcePerDay) : '');
    setOtherText(current.dependencyOtherText ?? '');
    setArchitectCommentText(current.architectComment ?? '');
    setClientCommentText(current.clientComment ?? '');
    setValidationError(null);
  }, [index, entries, dayShareExact]);

  // Late start — the planned start passed with no work begun (still
  // Pending), or the Actual Start Date entered is after the planned start.
  // Shown as a red "Pending — not started" note and the Reason for Delay
  // picker opens up so the why gets recorded on the DPR.
  const plannedStartKey = task?.plannedStartDate?.slice(0, 10) ?? null;
  const actualStartKey = task?.actualStartDate?.slice(0, 10) ?? null;
  const startDelayDays = plannedStartKey ? dayGap(plannedStartKey, actualStartKey ?? todayDateKey()) : 0;
  const lateStart = task != null && task.status !== 'completed' && startDelayDays > 0 && (actualStartKey != null || isDprPending(task.status));
  const reasonEnabled = task?.status === 'on_hold' || lateStart;
  const previousReasons = index > 0 ? entries[index - 1]?.fields : null;

  function copyPreviousDayReason() {
    if (!previousReasons) return;
    setOtherText(previousReasons.dependencyOtherText ?? '');
    void persistDraft({
      ...draft,
      dependencyCategories: previousReasons.dependencyCategories,
      dependencyOtherText: previousReasons.dependencyOtherText,
      comment: previousReasons.comment ?? draft.comment,
    });
  }

  const suggestedPerDay = plannedDurationDays && plannedDurationDays > 0 ? Math.round(100 / plannedDurationDays) : null;
  const WORKING_HOURS_PER_DAY = 8;

  // Sum of every day's % (each DPR is that day's share of the work) —
  // straight from the days on screen, so an edit shows up immediately.
  const filledEntries = entries.filter((e) => e.fields.percentComplete != null);
  const totalCompletedPercent =
    filledEntries.length > 0 ? Math.min(100, filledEntries.reduce((sum, e) => sum + (e.fields.percentComplete ?? 0), 0)) : null;
  const totalPendingPercent = totalCompletedPercent != null ? 100 - totalCompletedPercent : null;
  // Real average pace so far (not the fixed planned rate) — total % actually
  // completed divided by how many real days have a filled-in % — by explicit
  // correction: "if the task keeps going at this pace" should reflect what's
  // actually happening on site, not a hypothetical faster rate.
  const filledDayCount = entries.filter((e) => e.fields.percentComplete != null).length;
  const actualPacePerDay =
    filledDayCount > 0 && totalCompletedPercent != null ? Math.round((totalCompletedPercent / filledDayCount) * 10) / 10 : null;
  const actualPaceDaysToFinish =
    actualPacePerDay && actualPacePerDay > 0 && totalPendingPercent != null
      ? Math.round((totalPendingPercent / actualPacePerDay) * 10) / 10
      : null;

  async function persistDraft(next: DprEntryFields) {
    setDraft(next);
    const current = entries[index];
    if (!current || !taskId) return;
    try {
      await upsertTodayDprEntry(taskId, current.reportDate, next, userId);
      const nextEntries = withNextDprDay(entries.map((e, i) => (i === index ? { ...e, fields: next } : e)));
      setEntries(nextEntries);
      await syncStatusWithProgress(nextEntries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Keep the task's status/actual end in step with the DPR total, so an
  // edit (including an admin re-edit later) shows correctly everywhere:
  // reaching 100% completes the task on that day; dropping back under 100%
  // reopens a completed task. Best-effort — the DPR itself is already saved
  // and update_task_status may refuse a transition.
  async function syncStatusWithProgress(list: DprHistoryEntry[]) {
    if (!taskId || !task) return;
    const total = list.reduce((sum, e) => sum + (e.fields.percentComplete ?? 0), 0);
    try {
      if (total >= 100 && task.status !== 'completed') {
        let running = 0;
        const finishIndex = list.findIndex((e) => (running += e.fields.percentComplete ?? 0) >= 100);
        if (!task.actualEndDate && finishIndex >= 0) {
          await updateTaskActualDate(taskId, 'actual_end_date', dprDayDate(finishIndex, list[finishIndex].reportDate).toISOString().slice(0, 10));
        }
        await updateTaskStatusRpc(taskId, 'completed');
      } else if (total < 100 && task.status === 'completed') {
        await updateTaskActualDate(taskId, 'actual_end_date', null);
        await updateTaskStatusRpc(taskId, 'in_progress');
      } else {
        return;
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
    await refreshTaskOnly();
  }

  async function saveDayFields() {
    let next = draft;
    // The day's % of the whole task = Quantity of Work % x this day's share
    // (see dayContribution). percent_complete is a smallint column, so it's
    // rounded to a whole percent on save.
    const contribution = quantityValue != null && dayShareExact != null ? (quantityValue * dayShareExact) / 100 : null;
    next = { ...next, percentComplete: contribution == null ? null : Math.max(0, Math.min(100, Math.round(contribution))) };
    const trimmedOther = otherText.trim();
    next = { ...next, dependencyOtherText: trimmedOther || null };
    const trimmedTargeted = targetedWorkforceText.trim();
    next = { ...next, targetedWorkforcePerDay: trimmedTargeted === '' ? null : Math.max(0, Math.round(Number(trimmedTargeted))) };
    const trimmedActual = actualWorkforceText.trim();
    next = { ...next, actualWorkforcePerDay: trimmedActual === '' ? null : Math.max(0, Math.round(Number(trimmedActual))) };
    next = { ...next, architectComment: architectCommentText.trim() || null, clientComment: clientCommentText.trim() || null };
    await persistDraft(next);
    setDayFieldsSaved(true);
    setTimeout(() => setDayFieldsSaved(false), 1500);
  }

  function toggleDependency(cat: DprDependencyCategory) {
    const next = draft.dependencyCategories.includes(cat)
      ? draft.dependencyCategories.filter((c) => c !== cat)
      : [...draft.dependencyCategories, cat];
    void persistDraft({ ...draft, dependencyCategories: next });
  }

  function handleSubtasksChange(next: DprSubtaskItem[]) {
    const entry = entries[index];
    if (!entry) return;
    setSubtasksByDate((prev) => ({ ...prev, [entry.reportDate]: next }));
  }

  async function handleStatusPress(target: TaskStatus) {
    if (!taskId) return;
    setChangingStatus(true);
    setStatusError(null);
    try {
      await updateTaskStatusRpc(taskId, target);
      await refreshTaskOnly();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setChangingStatus(false);
    }
  }

  async function handleSetActualStart(isoDate: string) {
    if (!taskId) return;
    await updateTaskActualDate(taskId, 'actual_start_date', isoDate);
    // Setting Actual Start Date should read as "the work has begun" — by
    // explicit request, this auto-advances status the same way update_task_
    // status's own in_progress transition already does when it captures this
    // same date the other way around. Only from 'ready' ("Pending"): an
    // on_hold/blocked task stays put until the site engineer explicitly
    // resumes it via the Status dropdown.
    if (task?.status === 'ready') {
      try {
        await updateTaskStatusRpc(taskId, 'in_progress');
      } catch {
        // Best-effort — the date itself is already saved either way.
      }
    }
    await refreshTaskOnly();
  }

  const [dateError, setDateError] = useState<string | null>(null);

  // Admin date edits. Setting an Actual End completes the task; clearing it
  // reopens it — so status, report bar and stage all follow the dates.
  async function handleSetActualDate(field: 'actual_start_date' | 'actual_end_date', isoDate: string | null) {
    if (!taskId) return;
    setDateError(null);
    try {
      if (field === 'actual_start_date' && isoDate) await handleSetActualStart(isoDate);
      else {
        await updateTaskActualDate(taskId, field, isoDate);
        if (field === 'actual_end_date' && isoDate && task?.status !== 'completed') await updateTaskStatusRpc(taskId, 'completed');
        if (field === 'actual_end_date' && !isoDate && task?.status === 'completed') await updateTaskStatusRpc(taskId, 'in_progress');
        await refreshTaskOnly();
      }
      reloadDelayData();
    } catch (err) {
      setDateError(err instanceof Error ? err.message : String(err));
    }
  }

  // Quantity of Work — by explicit request, entered per DPR day as a plain
  // percentage of THAT day's work (0-100). Each planned day is an equal share
  // of the task's 100% (4 days -> 25% each), so the day's real contribution
  // is entered% x dayShare / 100 — e.g. 60% of a 25% day = 15% of the task.
  // That contribution is what's stored as the day's dpr_entries.percent_
  // complete (which Total completed sums), and only on "Save Draft DPR" or
  // Submit — never on blur/enter. The box itself is re-derived from that
  // stored value when the day is reopened.
  const quantityValue = quantityText.trim() === '' ? null : Number(quantityText);
  const quantityValid = quantityValue == null || (Number.isFinite(quantityValue) && quantityValue >= 0 && quantityValue <= 100);
  const dayContribution = quantityValue != null && quantityValid && dayShareExact != null ? (quantityValue * dayShareExact) / 100 : null;
  const dayShortfall = dayContribution != null && dayShareExact != null ? Math.max(0, dayShareExact - dayContribution) : null;
  const dayShortfallHours =
    dayShortfall != null && dayShareExact ? Math.round((dayShortfall / dayShareExact) * WORKING_HOURS_PER_DAY * 10) / 10 : null;

  function validateQuantity(): boolean {
    if (!quantityValid) {
      setQuantityError('Enter a percentage between 0 and 100');
      return false;
    }
    setQuantityError(null);
    return true;
  }

  function reloadDelayData() {
    if (!taskId || !projectId) return;
    fetchGeneralParameterReport(taskId, projectId)
      .then(setDelayData)
      .catch(() => {
        // The on-screen summary is a courtesy view; the save itself succeeded.
      });
  }

  async function handleSaveDraft() {
    if (!validateQuantity()) return;
    await saveDayFields();
    reloadDelayData();
  }

  async function handleSubmit() {
    const current = entries[index];
    if (!current || !taskId || !task) return;
    const missing: string[] = [];
    if (isDprPending(task.status)) {
      // Reason for Delay is only actually pickable while On Hold (Pending
      // shows it disabled) — see the render below — so only require it then.
      if (reasonEnabled && draft.dependencyCategories.length === 0) missing.push('Reason for Delay');
      if (!draft.comment) missing.push('Comments');
    }
    if (missing.length > 0) {
      setValidationError(`${missing.join(' and ')} required before this day's DPR can be submitted.`);
      return;
    }
    setValidationError(null);
    if (!validateQuantity()) return;
    setSubmitting(true);
    try {
      await saveDayFields();
      await markDprSubmitted(taskId, current.reportDate);
      const nowIso = new Date().toISOString();
      setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, fields: { ...e.fields, dprSubmittedAtISO: nowIso } } : e)));
      setDraft((d) => ({ ...d, dprSubmittedAtISO: nowIso }));
      reloadDelayData();
    } finally {
      setSubmitting(false);
    }
  }

  // Point 9 — general daily progress photos, task-level (not per-day).
  const [photos, setPhotos] = useState<DailyProgressPhoto[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  async function reloadPhotos() {
    if (!taskId) return;
    try {
      setPhotos(await fetchDailyProgressPhotos(taskId));
    } catch {
      // A courtesy attachment, not load-bearing.
    }
  }

  async function handlePickedPhoto(base64: string, mimeType: string | undefined) {
    if (!taskId) return;
    setUploadingPhoto(true);
    setPhotoError(null);
    try {
      const contentType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      await uploadDailyProgressPhoto(taskId, base64, contentType, userId);
      await reloadPhotos();
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleTakePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera access needed', 'Allow camera access to attach a progress photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], base64: true, quality: 0.7 });
    if (!result.canceled && result.assets[0]?.base64) await handlePickedPhoto(result.assets[0].base64, result.assets[0].mimeType);
  }

  async function handleChooseFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photo access needed', 'Allow photo library access to attach a progress photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.7 });
    if (!result.canceled && result.assets[0]?.base64) await handlePickedPhoto(result.assets[0].base64, result.assets[0].mimeType);
  }

  function handleUploadPhoto() {
    if (Platform.OS === 'web') {
      void handleChooseFromLibrary();
      return;
    }
    Alert.alert('Add Photo', undefined, [
      { text: 'Take Photo', onPress: handleTakePhoto },
      { text: 'Choose from Library', onPress: handleChooseFromLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  if (state.status !== 'signed-in') {
    return <Redirect href="/login" />;
  }

  const current = entries[index];

  return (
    <View className="flex-1 bg-white">
      <Stack.Screen
        options={{
          headerShown: true,
          title: task?.taskName ?? 'DPR',
          headerStyle: { backgroundColor: '#0F1F33' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#0F1F33" />
        </View>
      ) : error ? (
        <View className="mx-4 mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3">
          <Text className="text-sm text-red-600 mb-2.5">{error}</Text>
          <Pressable onPress={load} className="self-start px-3.5 py-1.5 rounded-lg bg-white border border-red-200">
            <Text className="text-xs font-semibold text-red-600">Retry</Text>
          </Pressable>
        </View>
      ) : !task ? (
        <EmptyState icon="document-text-outline" iconColor="#9CA3AF" title="Task not found" subtitle="It may have been deleted." />
      ) : (
        <ScrollView className="flex-1 px-4 pt-3" contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
          <Text className="text-2xs text-neutral-400 mb-0.5">{task.workName}</Text>
          <Text className="text-lg font-bold text-neutral-900 mb-3">{task.taskName}</Text>

          {entries.length === 0 ? (
            <Text className="text-sm text-neutral-500 py-4 text-center">
              No planned dates set for this task yet.
            </Text>
          ) : (
            <>
              {/* The day pager — opens on Day 1 every time, by explicit
                  request. "DPR History" here is a lightweight popup listing
                  every day so you can jump straight to one, not a second
                  full page — the actual editing always happens right here. */}
              <View className="flex-row items-center justify-between mb-3 rounded-lg bg-neutral-50 border border-neutral-100 px-2.5 py-2">
                <Pressable onPress={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} hitSlop={8} style={{ opacity: index === 0 ? 0.3 : 1 }}>
                  <Ionicons name="chevron-back" size={18} color="#0F1F33" />
                </Pressable>
                <Pressable onPress={() => setHistoryOpen(true)} className="items-center">
                  <Text className="text-xs font-bold text-neutral-900">DPR {index + 1} of {entries.length}</Text>
                  <Text className="text-2xs text-neutral-400">{formatDateLabel(dprDayDate(index, current.reportDate))}</Text>
                </Pressable>
                <Pressable
                  onPress={() => setIndex((i) => Math.min(entries.length - 1, i + 1))}
                  disabled={index === entries.length - 1}
                  hitSlop={8}
                  style={{ opacity: index === entries.length - 1 ? 0.3 : 1 }}
                >
                  <Ionicons name="chevron-forward" size={18} color="#0F1F33" />
                </Pressable>
              </View>

              {draft.dprSubmittedAtISO ? (
                <Text className="text-2xs text-neutral-400 mb-3">
                  Submitted by {draft.submittedByName ?? 'Unknown user'} · {formatDateTimeLabel(new Date(draft.dprSubmittedAtISO))}
                </Text>
              ) : draft.submittedByName ? (
                <Text className="text-2xs text-neutral-400 mb-3">
                  Draft — last edited by {draft.submittedByName}
                  {draft.submittedAtISO && ` · ${formatDateTimeLabel(new Date(draft.submittedAtISO))}`}
                </Text>
              ) : (
                <Text className="text-2xs text-amber-600 mb-3">Not filled yet — add this day&apos;s update below.</Text>
              )}

              {lateStart && plannedStartKey && (
                <View className="mb-3 rounded-lg px-2.5 py-2 border" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA' }}>
                  <Text className="text-xs font-extrabold" style={{ color: '#B91C1C' }}>
                    {actualStartKey ? `Started ${startDelayDays} day${startDelayDays === 1 ? '' : 's'} late` : 'Pending — not started'}
                  </Text>
                  <Text className="text-2xs mt-0.5" style={{ color: '#B91C1C' }}>
                    Planned start {formatDateLabel(new Date(`${plannedStartKey}T00:00:00Z`))}
                    {actualStartKey
                      ? ` · actual start ${formatDateLabel(new Date(`${actualStartKey}T00:00:00Z`))}`
                      : ` · ${startDelayDays} day${startDelayDays === 1 ? '' : 's'} delayed so far`}
                  </Text>
                  <Text className="text-2xs mt-0.5 font-semibold" style={{ color: '#B91C1C' }}>
                    Reason:{' '}
                    {draft.dependencyCategories.length > 0
                      ? draft.dependencyCategories.map((c) => dependencyDisplayLabel(c, draft.dependencyOtherText)).join(', ')
                      : 'not given yet — pick it in Reason for Delay below'}
                  </Text>
                </View>
              )}

              {delayLoading && (
                <View className="mb-3 items-center py-3">
                  <ActivityIndicator color="#0F1F33" size="small" />
                </View>
              )}
              {delayError && (
                <View className="mb-3 px-2.5 py-2 rounded-lg bg-red-50 border border-red-200">
                  <Text className="text-2xs text-red-600">{delayError}</Text>
                </View>
              )}
              {delayData && <DprDelayBreakdown data={delayData} />}

              <View className="mb-3">
                <Text className="text-xs text-neutral-400 mb-0.5">Subtasks</Text>
                <Text className="text-2xs text-neutral-400 mb-1.5">
                  Add the subtasks for this day. Progress for the day is entered once in Quantity of Work below.
                </Text>
                <SubtaskListEditor
                  taskId={task.id}
                  reportDate={current.reportDate}
                  works={works}
                  subtasks={subtasksByDate[current.reportDate] ?? []}
                  editable
                  onChange={handleSubtasksChange}
                  actualStarts={subtaskStarts}
                  taskActualStart={task.actualStartDate}
                  onActualStartChange={(id, d) => {
                    setSubtaskStartError(null);
                    setSubtaskStarts((prev) => ({ ...prev, [id]: d }));
                    updateSubtaskActualStart(id, d)
                      .then(() => {
                        // Task's own Actual Start = earliest subtask start, so
                        // status auto-advance and reports keep working.
                        if (!task.actualStartDate || d < task.actualStartDate) return handleSetActualStart(d);
                      })
                      .catch((err) => {
                        setSubtaskStarts((prev) => ({ ...prev, [id]: null }));
                        setSubtaskStartError(err instanceof Error ? err.message : String(err));
                      });
                  }}
                />
                {subtaskStartError && <Text className="text-2xs text-red-600 mt-1">{subtaskStartError}</Text>}
              </View>

              <View className="flex-row flex-wrap gap-2 mb-3">
                <Pressable
                  onPress={() => router.push(`/dpr-checklist/${task.id}`)}
                  className="flex-row items-center gap-1.5 self-start px-2.5 py-1.5 rounded-lg bg-neutral-50 border border-neutral-200"
                >
                  <Ionicons name="document-text-outline" size={14} color="#0F1F33" />
                  <Text className="text-2xs font-bold text-brand-navy">Quality Checklist</Text>
                </Pressable>
              </View>

              {/* Only ONE Actual Start field on screen, by explicit correction:
                  when the day has subtasks, each subtask's own date (above) is
                  it, and the task's date follows the earliest of them; this
                  task-level picker only shows for a day with no subtasks. */}
              {isAdmin ? (
                <View className="mb-3 flex-row gap-2">
                  <View className="flex-1">
                    <Text className="text-xs text-neutral-400 mb-1">Actual Start Date</Text>
                    <DateField
                      value={task.actualStartDate}
                      onChange={(d) => void handleSetActualDate('actual_start_date', d)}
                      maxDate={task.actualEndDate ?? new Date().toISOString().slice(0, 10)}
                    />
                  </View>
                  <View className="flex-1">
                    <Text className="text-xs text-neutral-400 mb-1">Actual End Date</Text>
                    <DateField
                      value={task.actualEndDate}
                      onChange={(d) => void handleSetActualDate('actual_end_date', d)}
                      minDate={task.actualStartDate}
                      maxDate={new Date().toISOString().slice(0, 10)}
                    />
                    {task.actualEndDate && (
                      <Pressable onPress={() => void handleSetActualDate('actual_end_date', null)} hitSlop={6} className="self-start mt-1">
                        <Text className="text-2xs font-bold text-red-600">Clear end date</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              ) : (
                (subtasksByDate[current.reportDate] ?? []).length === 0 && (
                  <View className="mb-3">
                    <Text className="text-xs text-neutral-400 mb-1">Actual Start Date</Text>
                    <DateField value={task.actualStartDate} onChange={handleSetActualStart} maxDate={new Date().toISOString().slice(0, 10)} />
                  </View>
                )
              )}
              {dateError && <Text className="text-2xs text-red-600 -mt-2 mb-3">{dateError}</Text>}

              <View className="mb-3">
                <Text className="text-xs text-neutral-400 mb-1">Quantity of Work</Text>
                <View className="flex-row items-center gap-2">
                  <TextInput
                    value={quantityText}
                    onChangeText={setQuantityText}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    className="border border-neutral-200 rounded-lg px-2.5 py-1.5 text-sm text-neutral-900"
                    style={{ width: 64 }}
                  />
                  <Text className="text-sm text-neutral-500">%</Text>
                </View>
                {/* The "X% of this day's Y% share = Z% of total task" line was
                    removed from view by explicit request — the same
                    calculation still runs (dayContribution) and is what
                    Save Draft / Submit store as the day's percent_complete. */}
                {dayContribution != null && dayShareExact != null && dayShortfall != null && (
                  dayShortfall > 0 ? (
                    <View className="mt-1.5 rounded-lg px-2.5 py-2 border" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA' }}>
                      <Text className="text-2xs font-bold" style={{ color: '#B91C1C' }}>
                        {formatPct(dayContribution)}% completed today out of {formatPct(dayShareExact)}% — {formatPct(dayShortfall)}% short, this is delaying the task (~{dayShortfallHours} hrs to cover it up).
                      </Text>
                    </View>
                  ) : (
                    <View className="mt-1.5 rounded-lg px-2.5 py-2 border" style={{ backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' }}>
                      <Text className="text-2xs font-bold" style={{ color: '#15803D' }}>
                        {formatPct(dayContribution)}% completed today out of {formatPct(dayShareExact)}% — on track.
                      </Text>
                    </View>
                  )
                )}
                {quantityError && <Text className="text-2xs text-red-600 mt-1">{quantityError}</Text>}
              </View>

              <View className="mb-3">
                {suggestedPerDay != null && (
                  <Text className="text-2xs text-neutral-400 mt-1">
                    This task spans {plannedDurationDays} planned day{plannedDurationDays === 1 ? '' : 's'} — ~{suggestedPerDay}%/day
                  </Text>
                )}
                {totalCompletedPercent != null && totalPendingPercent != null && (
                  <View className="rounded-lg bg-neutral-50 border border-neutral-100 px-2.5 py-2 mt-1.5">
                    <Text className="text-2xs font-bold text-neutral-700">
                      Total completed: {totalCompletedPercent}%  ·  Total pending: {totalPendingPercent}%
                    </Text>
                    {actualPacePerDay != null && actualPaceDaysToFinish != null && (
                      <Text className="text-2xs text-neutral-600 mt-1 leading-4">
                        Going at <Text className="font-bold text-neutral-900">{actualPacePerDay}%/day</Text>, this task will take{' '}
                        <Text className="font-bold text-neutral-900">
                          {actualPaceDaysToFinish} more day{actualPaceDaysToFinish === 1 ? '' : 's'}
                        </Text>{' '}
                        to finish.
                      </Text>
                    )}
                  </View>
                )}
              </View>

              <View className="mb-3 flex-row gap-4">
                <View className="flex-1">
                  <Text className="text-xs text-neutral-400 mb-1">Targeted Workforce / Day</Text>
                  <View className="flex-row items-center gap-1.5">
                    <TextInput
                      value={targetedWorkforceText}
                      onChangeText={setTargetedWorkforceText}
                      onBlur={saveDayFields}
                      onSubmitEditing={saveDayFields}
                      keyboardType="number-pad"
                      placeholder="0"
                      className="border border-neutral-200 rounded-lg px-2.5 py-1.5 text-sm text-neutral-900"
                      style={{ width: 64 }}
                    />
                    <Text className="text-2xs text-neutral-400">people</Text>
                  </View>
                </View>
                <View className="flex-1">
                  <Text className="text-xs text-neutral-400 mb-1">Actual Workforce / Day</Text>
                  <View className="flex-row items-center gap-1.5">
                    <TextInput
                      value={actualWorkforceText}
                      onChangeText={setActualWorkforceText}
                      onBlur={saveDayFields}
                      onSubmitEditing={saveDayFields}
                      keyboardType="number-pad"
                      placeholder="0"
                      className="border border-neutral-200 rounded-lg px-2.5 py-1.5 text-sm text-neutral-900"
                      style={{ width: 64 }}
                    />
                    <Text className="text-2xs text-neutral-400">people</Text>
                  </View>
                </View>
              </View>

              <View className="mb-3 flex-row gap-2" style={{ zIndex: 10 }}>
                <View className="flex-1" style={{ zIndex: statusDropdownOpen ? 10 : undefined }}>
                  <Text className="text-xs text-neutral-400 mb-1">Status</Text>
                  <Pressable
                    onPress={() => (task.status !== 'completed' || isAdmin) && setStatusDropdownOpen((v) => !v)}
                    disabled={changingStatus}
                    className="flex-row items-center justify-between border border-neutral-200 rounded-lg px-2.5 py-2"
                    style={{ opacity: changingStatus ? 0.5 : 1 }}
                  >
                    <Text className="text-xs font-bold text-neutral-900">{STATUS_DISPLAY_LABEL[task.status]}</Text>
                    {(task.status !== 'completed' || isAdmin) && <Text className="text-2xs text-neutral-400">{statusDropdownOpen ? '▲' : '▼'}</Text>}
                  </Pressable>
                  {/* Expands in normal flow (pushes everything below it down)
                      rather than floating over it — by explicit correction,
                      an absolutely-positioned list here covered the Save
                      button underneath it. Same convention as every other
                      collapsed-header dropdown in this app. */}
                  {statusDropdownOpen && (
                    <View className="mt-1 border border-neutral-100 rounded-lg overflow-hidden">
                      {STATUS_DROPDOWN_OPTIONS.map((opt, i) => {
                        const active = task.status === opt.value;
                        return (
                          <Pressable
                            key={opt.value}
                            onPress={() => {
                              setStatusDropdownOpen(false);
                              void handleStatusPress(opt.value);
                            }}
                            className={`px-2.5 py-2 ${i < STATUS_DROPDOWN_OPTIONS.length - 1 ? 'border-b border-neutral-50' : ''}`}
                            style={{ backgroundColor: active ? '#0F1F33' : undefined }}
                          >
                            <Text className={`text-xs font-medium ${active ? 'text-white' : 'text-neutral-700'}`}>{opt.label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                  {statusError && <Text className="text-2xs text-red-600 mt-1">{statusError}</Text>}
                </View>

                {(isDprPending(task.status) || lateStart) && (
                  <View className="flex-1">
                    <Text className="text-xs text-neutral-400 mb-1">
                      Reason for Delay<Text style={{ color: '#DC2626' }}> *</Text>
                    </Text>
                    {/* Visible for both Pending and On Hold, but only
                        actually pickable once the task is On Hold — by
                        explicit request, Pending shows the field (so it
                        reads as "this will apply once paused") without
                        letting you log a delay reason before there's an
                        actual delay. */}
                    <Pressable
                      onPress={() => reasonEnabled && setDelayDropdownOpen((v) => !v)}
                      className="flex-row items-center justify-between border rounded-lg px-2.5 py-2"
                      style={{
                        borderColor: draft.dependencyCategories.length === 0 ? '#FECACA' : '#E5E5E5',
                        opacity: reasonEnabled ? 1 : 0.5,
                      }}
                    >
                      <Text className="text-xs text-neutral-900 flex-1" numberOfLines={1}>
                        {draft.dependencyCategories.length === 0
                          ? 'Select reason(s)'
                          : draft.dependencyCategories.map((c) => dependencyDisplayLabel(c, draft.dependencyOtherText)).join(', ')}
                      </Text>
                      {reasonEnabled && <Text className="text-2xs text-neutral-400">{delayDropdownOpen ? '▲' : '▼'}</Text>}
                    </Pressable>
                    {reasonEnabled && delayDropdownOpen && (
                      <View className="mt-1 border border-neutral-100 rounded-lg overflow-hidden">
                        {DPR_DEPENDENCY_CATEGORIES.map((cat, i) => {
                          const active = draft.dependencyCategories.includes(cat);
                          return (
                            <Pressable
                              key={cat}
                              onPress={() => toggleDependency(cat)}
                              className={`flex-row items-center justify-between px-2.5 py-2 ${i < DPR_DEPENDENCY_CATEGORIES.length - 1 ? 'border-b border-neutral-50' : ''}`}
                              style={{ backgroundColor: active ? '#0F1F33' : undefined }}
                            >
                              <Text className={`text-xs font-medium ${active ? 'text-white' : 'text-neutral-700'}`}>
                                {dependencyDisplayLabel(cat, draft.dependencyOtherText)}
                              </Text>
                              {active && <Ionicons name="checkmark" size={14} color="#fff" />}
                            </Pressable>
                          );
                        })}
                      </View>
                    )}
                    {reasonEnabled && draft.dependencyCategories.includes('other') && (
                      <TextInput
                        value={otherText}
                        onChangeText={setOtherText}
                        onBlur={saveDayFields}
                        placeholder="Type the reason…"
                        placeholderTextColor="#9CA3AF"
                        multiline
                        className="border border-neutral-200 rounded-lg px-2.5 py-2 text-xs text-neutral-900 mt-1.5"
                        style={{ minHeight: 40, textAlignVertical: 'top' }}
                      />
                    )}
                  </View>
                )}
              </View>

              {previousReasons && (previousReasons.dependencyCategories.length > 0 || previousReasons.comment) && (
                <Pressable
                  onPress={copyPreviousDayReason}
                  className="flex-row items-center gap-1.5 self-start mb-3 px-2.5 py-1.5 rounded-lg bg-neutral-50 border border-neutral-200"
                >
                  <Ionicons name="copy-outline" size={14} color="#0F1F33" />
                  <Text className="text-2xs font-bold text-brand-navy">
                    Same reason as previous day
                    {previousReasons.dependencyCategories.length > 0 &&
                      ` (${previousReasons.dependencyCategories.map((c) => dependencyDisplayLabel(c, previousReasons.dependencyOtherText)).join(', ')})`}
                  </Text>
                </Pressable>
              )}

              <Pressable
                onPress={handleSaveDraft}
                className="flex-row items-center justify-center gap-1.5 mb-3 py-3 rounded-xl"
                style={{ backgroundColor: dayFieldsSaved ? '#DCFCE7' : '#0F1F33' }}
              >
                <Ionicons name={dayFieldsSaved ? 'checkmark' : 'save-outline'} size={16} color={dayFieldsSaved ? '#15803D' : '#fff'} />
                <Text className="text-sm font-bold" style={{ color: dayFieldsSaved ? '#15803D' : '#fff' }}>
                  {dayFieldsSaved ? 'DPR Saved' : 'Save Draft DPR'}
                </Text>
              </Pressable>

              {isDprPending(task.status) && (
                <View className="mb-3">
                  <Text className="text-xs text-neutral-400 mb-1.5">
                    Comments<Text style={{ color: '#DC2626' }}> *</Text>
                  </Text>
                  <CommentPicker comment={draft.comment} required editable onChange={(next: DprComment | null) => void persistDraft({ ...draft, comment: next })} />
                </View>
              )}

              {isDprPending(task.status) && (
              <View className="mb-2">
                <Text className="text-xs text-neutral-400 mb-1">Architect</Text>
                <TextInput
                  value={architectCommentText}
                  onChangeText={setArchitectCommentText}
                  onBlur={saveDayFields}
                  placeholder="Comment box"
                  placeholderTextColor="#9CA3AF"
                  multiline
                  className="border border-neutral-200 rounded-lg px-2.5 py-2 text-sm text-neutral-900"
                  style={{ minHeight: 40, textAlignVertical: 'top' }}
                />
              </View>
              )}

              {isDprPending(task.status) && (
              <View className="mb-3">
                <Text className="text-xs text-neutral-400 mb-1">Client</Text>
                <TextInput
                  value={clientCommentText}
                  onChangeText={setClientCommentText}
                  onBlur={saveDayFields}
                  placeholder="Comment box"
                  placeholderTextColor="#9CA3AF"
                  multiline
                  className="border border-neutral-200 rounded-lg px-2.5 py-2 text-sm text-neutral-900"
                  style={{ minHeight: 40, textAlignVertical: 'top' }}
                />
              </View>
              )}

              <View className="mb-1">
                <Text className="text-xs text-neutral-400 mb-1.5">Photos</Text>
                <View className="flex-row flex-wrap gap-2.5">
                  {photos.map((photo) => (
                    <View key={photo.id} className="items-center" style={{ width: 92 }}>
                      {photo.signedUrl ? (
                        <Image source={{ uri: photo.signedUrl }} style={{ width: 92, height: 92, borderRadius: 10 }} />
                      ) : (
                        <View className="w-[92px] h-[92px] rounded-xl bg-neutral-200 items-center justify-center">
                          <Text className="text-2xs text-neutral-400">Unavailable</Text>
                        </View>
                      )}
                    </View>
                  ))}
                  <Pressable
                    onPress={handleUploadPhoto}
                    disabled={uploadingPhoto}
                    className="items-center justify-center rounded-xl border border-dashed border-neutral-300"
                    style={{ width: 92, height: 92, opacity: uploadingPhoto ? 0.5 : 1 }}
                  >
                    {uploadingPhoto ? (
                      <ActivityIndicator size="small" color="#0F1F33" />
                    ) : (
                      <>
                        <Ionicons name="camera-outline" size={20} color="#6B7280" />
                        <Text className="text-2xs font-semibold text-neutral-500 mt-1">Add Photo</Text>
                      </>
                    )}
                  </Pressable>
                </View>
                {photoError && <Text className="text-2xs text-red-600 mt-1.5">{photoError}</Text>}
              </View>

              {(task.status !== 'completed' || isAdmin) && (
                draft.dprSubmittedAtISO && !isAdmin ? (
                  <View className="mt-3 py-2.5 rounded-xl items-center bg-neutral-100">
                    <Text className="text-sm font-bold text-neutral-500">
                      Submitted · {formatDateTimeLabel(new Date(draft.dprSubmittedAtISO))}
                    </Text>
                  </View>
                ) : (
                  <Pressable
                    onPress={handleSubmit}
                    disabled={submitting}
                    className="mt-3 py-2.5 rounded-xl items-center flex-row justify-center gap-1.5"
                    style={{ backgroundColor: '#0F1F33', opacity: submitting ? 0.6 : 1 }}
                  >
                    {submitting && <ActivityIndicator size="small" color="#fff" />}
                    <Text className="text-sm font-bold text-white">{draft.dprSubmittedAtISO ? 'Resubmit DPR' : 'Submit DPR'}</Text>
                  </Pressable>
                )
              )}
              {validationError && (
                <View className="mt-2.5 px-2.5 py-2 rounded-lg bg-red-50 border border-red-200">
                  <Text className="text-2xs text-red-600">{validationError}</Text>
                </View>
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* DPR History — a lightweight popup day-index, by explicit request,
          not a second full page. Just jumps the pager above to whichever
          day is tapped. */}
      <Modal visible={historyOpen} transparent animationType="fade" onRequestClose={() => setHistoryOpen(false)}>
        <Pressable className="flex-1 bg-black/40 items-center justify-center px-6" onPress={() => setHistoryOpen(false)}>
          <Pressable onPress={() => {}} style={{ width: '100%', maxWidth: 380, maxHeight: '80%' }}>
            <Card style={{ flexShrink: 1, minHeight: 0 }}>
              <View className="flex-row items-center justify-between mb-2">
                <Text className="text-sm font-bold text-neutral-900">DPR History</Text>
                <Pressable onPress={() => setHistoryOpen(false)} hitSlop={8}>
                  <Ionicons name="close" size={20} color="#6B7280" />
                </Pressable>
              </View>
              <ScrollView style={{ flexShrink: 1, minHeight: 0 }} showsVerticalScrollIndicator={false}>
                {entries.map((e, i) => {
                  const label = e.fields.dprSubmittedAtISO
                    ? 'Submitted'
                    : e.fields.submittedByName
                      ? 'Draft'
                      : 'Not filled';
                  const labelColor = e.fields.dprSubmittedAtISO ? '#15803D' : e.fields.submittedByName ? '#B45309' : '#9CA3AF';
                  return (
                    <Pressable
                      key={e.reportDate}
                      onPress={() => { setIndex(i); setHistoryOpen(false); }}
                      className="flex-row items-center justify-between px-2 py-2.5 border-b border-neutral-50"
                      style={{ backgroundColor: i === index ? '#F5F5F5' : undefined }}
                    >
                      <View>
                        <Text className="text-xs font-bold text-neutral-900">DPR {i + 1}</Text>
                        <Text className="text-2xs text-neutral-400">{formatDateLabel(dprDayDate(i, e.reportDate))}</Text>
                      </View>
                      <Text className="text-2xs font-bold" style={{ color: labelColor }}>{label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </Card>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
