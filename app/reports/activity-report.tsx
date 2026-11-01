import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Redirect, Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../lib/AuthContext';
import { useProject } from '../../lib/ProjectContext';
import {
  fetchDprActivityReport,
  TASK_STAGE_LABEL,
  type DprActivityReport,
  type DprActivityTask,
  type ProgressForecast,
} from '../../lib/reports/dprActivityReport';
import {
  type DateRange,
  currentCalendarMonth,
  currentWeekOfMonth,
  defaultLast7Days,
  defaultToday,
  formatDateLabel,
} from '../../lib/reports/dateRange';
import { DateRangeBar } from '../../components/reports/DateRangeBar';
import { PeriodPicker } from '../../components/reports/PeriodPicker';
import { ReportProjectPicker } from '../../components/reports/ReportProjectPicker';
import { EmptyState } from '../../components/ui/EmptyState';
import { downloadPrintout } from '../../lib/reports/projectPrintouts';
import {
  barLabels,
  buildActivityReportPdfHtml,
  delayReasonNames,
  STAGE_COLOR,
  taskDelayStatus,
  type ForecastTone,
} from '../../lib/reports/activityReportPdf';

// The drawer's "Report by time" submenu (Daily/Weekly/Monthly/Custom
// duration) all land here, parameterized via route params, rather than 4
// near-identical screens. By explicit request, Weekly/Monthly/Custom now
// behave exactly like Day Report — the same real dpr_entries-submission
// list + cumulative % rollup, just over a longer default window — rather
// than rangeTaskReport.ts's own due_date-based engine the old weekly-
// report.tsx/monthly-report.tsx/custom-report.tsx screens used. Those 3
// files are left in place but now unreachable from any nav entry point
// (this app has no git history to fall back on, so nothing is deleted
// outright) — see lib/reports/dprActivityReport.ts's own header comment
// for the full rationale on why this needed a new engine at all.
//
// The Architect/Client/Vendor/Dept/Contractor reports used to live here
// too (category/department filters over this same DPR-activity engine) —
// moved out to app/reports/stakeholder-report.tsx, which is a genuinely
// different report shape (pending checklist inputs + downstream delay
// impact, not a date-range activity list).
type Preset = 'day' | 'week' | 'month' | 'custom';

const DEFAULT_RANGE_FOR_PRESET: Record<Preset, () => DateRange> = {
  day: defaultToday,
  week: currentWeekOfMonth,
  month: currentCalendarMonth,
  custom: defaultLast7Days,
};

// The client's sketch: a bar on every card (empty if not started), with
// "80% (39 days)" under the filled part and "20% (20 days)" under the
// empty part, then the plan/delay line. Kept slim to save space.
function ProgressBlock({ f, status }: { f: ProgressForecast; status: { text: string; tone: ForecastTone } }) {
  const labels = barLabels(f);
  const statusClass = { normal: 'text-neutral-600', late: 'text-red-600', ok: 'text-emerald-600' }[status.tone];
  const done = Math.min(100, Math.max(0, f.percentDone));
  const late = status.tone === 'late';
  return (
    <View style={{ marginTop: 4 }}>
      <View style={{ flexDirection: 'row', height: 12, borderWidth: 1.5, borderColor: '#0F1F33', borderRadius: 3, overflow: 'hidden', backgroundColor: '#fff' }}>
        {done > 0 && <View style={{ flex: done, backgroundColor: late ? '#DC2626' : '#059669' }} />}
        {done < 100 && <View style={{ flex: 100 - done }} />}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 1 }}>
        {done > 0 && (
          <View style={{ flex: Math.max(done, 30), alignItems: 'center' }}>
            <Text className={`text-2xs font-extrabold ${late ? 'text-red-600' : 'text-emerald-700'}`} numberOfLines={1}>
              {labels.done.pct} <Text className="font-semibold text-neutral-500">{labels.done.days}</Text>
            </Text>
          </View>
        )}
        {done < 100 && (
          <View style={{ flex: Math.max(100 - done, 30), alignItems: 'center' }}>
            <Text className="text-2xs font-extrabold text-neutral-700" numberOfLines={1}>
              {labels.remaining.pct} {labels.remaining.days && <Text className="font-semibold text-neutral-500">{labels.remaining.days}</Text>}
            </Text>
          </View>
        )}
      </View>
      <Text className={`text-2xs font-semibold ${statusClass}`}>{status.text}</Text>
    </View>
  );
}

// Client's layout: stage badge, %, bar, delay line, reasons — nothing else.
// Stage is as of the report's date, so past weeks show past stages.
function TaskCard({ task }: { task: DprActivityTask }) {
  const reasons = delayReasonNames(task.entries);
  const stageColor = STAGE_COLOR[task.stage];
  const chipClass = 'flex-row items-center rounded px-1 bg-red-50 border border-red-200';
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/reports/general-parameter-report', params: { taskId: task.taskId } } as never)}
      className="rounded-md bg-white px-2 py-1.5 mb-1 active:opacity-70"
      style={{ borderWidth: 1.5, borderColor: '#000' }}
    >
      <View className="flex-row items-center">
        <View className="flex-1 pr-1.5">
          <Text className="text-xs font-bold text-neutral-900" numberOfLines={1}>
            {task.taskName}
          </Text>
          <View className="flex-row items-center">
            <Text className="text-2xs text-neutral-500 flex-shrink" numberOfLines={1}>
              <Text className="font-bold text-neutral-800">{task.taskCode}</Text> · {task.workName}
            </Text>
            <View style={{ marginLeft: 4, borderRadius: 3, paddingHorizontal: 4, backgroundColor: stageColor.bg }}>
              <Text style={{ color: stageColor.fg, fontSize: 9 }} className="font-extrabold">
                {TASK_STAGE_LABEL[task.stage]}
              </Text>
            </View>
          </View>
        </View>
        {task.forecast && (
          <Text className={`text-sm font-extrabold ${task.delay.totalDays > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{task.forecast.percentDone}%</Text>
        )}
        <Ionicons name="chevron-forward" size={14} color="#9CA3AF" />
      </View>
      {task.forecast && <ProgressBlock f={task.forecast} status={taskDelayStatus(task)} />}
      {/* Pre Construction: the checklist tabs still pending — tap one for
          the full checklist. Construction / Post: reason names only — tap
          the card for the task report with every day's detail. */}
      {task.stage === 'pre-construction'
        ? task.pendingPrerequisites.length > 0 && (
            <View className="flex-row flex-wrap items-center gap-1 mt-1">
              <Text className="text-2xs font-bold text-neutral-500">Pending:</Text>
              {task.pendingPrerequisites.map((p) => (
                <Pressable
                  key={p.label}
                  onPress={() => router.push({ pathname: '/task/[taskId]', params: { taskId: task.taskId } })}
                  className={`${chipClass} active:opacity-70`}
                >
                  <Text className="text-2xs font-bold text-red-700">
                    {p.label} · {p.count}
                  </Text>
                  <Ionicons name="chevron-forward" size={9} color="#B91C1C" />
                </Pressable>
              ))}
            </View>
          )
        : reasons.length > 0 && (
            <View className="flex-row flex-wrap items-center gap-1 mt-1">
              <Text className="text-2xs font-bold text-neutral-500">Reasons:</Text>
              {reasons.map((r) => (
                <View key={r} className={chipClass}>
                  <Text className="text-2xs font-bold text-red-700">{r}</Text>
                </View>
              ))}
            </View>
          )}
    </Pressable>
  );
}

export default function ActivityReportScreen() {
  const { state } = useAuth();
  const { projects, selectedProjectId } = useProject();
  const projectName = projects.find((p) => p.id === selectedProjectId)?.name ?? '—';
  const params = useLocalSearchParams<{ preset?: string; title?: string }>();
  const VALID_PRESETS: Preset[] = ['day', 'week', 'month', 'custom'];
  const preset: Preset = VALID_PRESETS.includes(params.preset as Preset) ? (params.preset as Preset) : 'day';
  const title = params.title ?? 'Daily Status';

  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE_FOR_PRESET[preset]());
  const [report, setReport] = useState<DprActivityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSavedTo, setExportSavedTo] = useState<string | null>(null);

  const load = useCallback(async () => {
    // range.from > range.to is a transient state while DateRangeBar's two
    // fields are being edited independently (each commits immediately, no
    // "Generate" button to wait for) — skip the fetch and leave whatever
    // report is already on screen until the range is valid again.
    if (!selectedProjectId || range.from > range.to) return;
    try {
      setError(null);
      setLoading(true);
      setReport(await fetchDprActivityReport(selectedProjectId, range));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId, range]);

  // On focus too, not just mount — coming back from an Edit DPR / flowchart
  // date change shows the new dates, status and progress straight away.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    setExportError(null);
    setExportSavedTo(null);
  }, [selectedProjectId, range]);

  async function handleExport() {
    if (!report) return;
    setExportError(null);
    setExportSavedTo(null);
    setExporting(true);
    try {
      const html = buildActivityReportPdfHtml(report, range, projectName, title);
      const note = await downloadPrintout(html, `${projectName}-${title}-${range.from}-to-${range.to}`);
      if (note) setExportSavedTo(note);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not create the PDF.');
    } finally {
      setExporting(false);
    }
  }

  if (state.status !== 'signed-in') {
    return <Redirect href="/login" />;
  }

  return (
    <View className="flex-1 bg-neutral-50">
      <Stack.Screen
        options={{
          headerShown: true,
          title,
          headerStyle: { backgroundColor: '#0F1F33' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />

      <ScrollView contentContainerClassName="px-3 pt-3 pb-10">
        <ReportProjectPicker variant="title" />

        {!selectedProjectId ? (
          <EmptyState icon="bar-chart-outline" iconColor="#9CA3AF" title="Select a project" subtitle="Pick a project above to generate its report." />
        ) : (
          <>
            {preset === 'week' || preset === 'month' ? (
              <PeriodPicker mode={preset} range={range} onChange={setRange} />
            ) : (
              <DateRangeBar range={range} onChange={setRange} />
            )}
            <Text className="text-xs text-neutral-400 mb-2">
              Showing {formatDateLabel(range.from)} – {formatDateLabel(range.to)}
            </Text>

            {loading ? (
              <View className="items-center py-10">
                <ActivityIndicator color="#0F1F33" />
              </View>
            ) : error ? (
              <View className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3">
                <Text className="text-sm text-red-600 mb-2.5">{error}</Text>
                <Pressable onPress={load} className="self-start px-3.5 py-1.5 rounded-lg bg-white border border-red-200">
                  <Text className="text-xs font-semibold text-red-600">Retry</Text>
                </Pressable>
              </View>
            ) : !report || report.tasks.length === 0 ? (
              <EmptyState
                icon="document-text-outline"
                iconColor="#9CA3AF"
                title="No tasks yet"
                subtitle="This project has no tasks on its flowchart yet."
              />
            ) : (
              <>
                <Text className="text-xs font-bold uppercase tracking-wide text-neutral-400 mb-1.5 px-1">
                  Task-Level Activity ({report.taskCount} task{report.taskCount === 1 ? '' : 's'}) · tap a task for its full report
                </Text>
                {(['pre-construction', 'construction', 'post-construction'] as const).map((stage) => {
                  const inStage = report.tasks.filter((t) => t.stage === stage);
                  if (inStage.length === 0) return null;
                  return (
                    <View key={stage}>
                      <Text className="text-xs font-extrabold mt-0.5 mb-0.5 px-1" style={{ color: STAGE_COLOR[stage].fg }}>
                        {TASK_STAGE_LABEL[stage]} ({inStage.length})
                      </Text>
                      {inStage.map((task) => (
                        <TaskCard key={task.taskId} task={task} />
                      ))}
                    </View>
                  );
                })}

                <Pressable
                  onPress={handleExport}
                  disabled={exporting}
                  className="flex-row items-center justify-center gap-2 rounded-xl bg-brand-navy py-2.5 mt-3"
                  style={{ opacity: exporting ? 0.6 : 1 }}
                >
                  {exporting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="download-outline" size={16} color="#fff" />}
                  <Text className="text-sm font-bold text-white">{exporting ? 'Preparing PDF…' : 'Download PDF'}</Text>
                </Pressable>
                {exportError && <Text className="text-2xs text-red-600 mt-2">{exportError}</Text>}
                {exportSavedTo && <Text className="text-2xs text-green-600 font-semibold mt-2">{exportSavedTo}</Text>}
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
