import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useProject } from '../../lib/ProjectContext';
import { EmptyState } from '../ui/EmptyState';
import { ReportSection } from './ReportSection';
import { PieChart } from './charts/PieChart';
import { downloadPrintout, esc } from '../../lib/reports/projectPrintouts';
import type { GeneralParameterReportData } from '../../lib/reports/generalParameterReport';
import { PROCUREMENT_INPUT_PRESET_DAYS } from '../../lib/taskDetail/constants';
import { fetchTaskTypes } from '../../lib/flowchart/data';
import type { TaskTypeOption } from '../../lib/flowchart/types';
import { DPR_DEPENDENCY_CATEGORIES, DPR_DEPENDENCY_LABEL } from '../../lib/dprEntries';

// taskTypes is fetched ordered by default_duration_days ascending — same
// deterministic A/B/C.../G-by-index labeling as the Flowchart Template
// Kit's own CreateTaskSheet.tsx/TaskDetailSheet.tsx/TemplateTaskSheet.tsx
// (all three share this identical function), so this report shows the same
// "Type A" a site engineer already sees there, not the DB's own raw "Type
// 1"..."Type 7" names, which this app never surfaces to a user anywhere
// else.
function typeLetter(index: number): string {
  return String.fromCharCode(65 + index); // 65 = 'A'
}

// Completed/Pending colors for the Quantity donut — orange/black, by
// explicit request. Planned (a text row only, not a donut slice) stays the
// app's blue.
const CHART_PRIMARY = '#2563EB';
const CHART_COMPLETED = '#16A34A';
const CHART_PENDING = '#111827';
// A finished prerequisite reads as green, distinct from every department's
// own pending color — Pre Construction's readiness list below.
const DONE_COLOR = '#16A34A';

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// 3-letter form, for the Construction tab's own single-line "value - label"
// rows only — "7 September 2026 - Projected End Date" was long enough to
// wrap onto a second line; "7 Sep 2026 - Projected End Date" reliably fits
// on one. Every other date on this report keeps the full month name, by
// explicit request.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "26 August 2026" — the report's own header date (today, when the report
// is being viewed), day + full month name + year.
function formatReportDate(d: Date): string {
  return `${d.getDate()} ${FULL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Same "26 August 2026" style, but straight off a 'YYYY-MM-DD' date-key
// string (plannedStartDate/dueDate) — split by hand rather than going
// through Date, so there's no local-timezone shift on a date that's really
// just a UTC-conceptual calendar day.
function formatDateKeyLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${d} ${FULL_MONTHS[m - 1]} ${y}`;
}

// Same either-shape handling formatFlexibleDate (removed — its only
// callers were the Pre Construction "Status of the Work" rows, themselves
// removed by explicit request) used to need, for date-math
// instead of display — used by procurementDelayDays.
function parseFlexibleDateMs(value: string): number {
  return value.includes('T') ? new Date(value).getTime() : new Date(`${value}T00:00:00Z`).getTime();
}

// Weekday-only day-add (Sat/Sun skipped) — a lightweight stand-in for the
// app's real holiday-table-aware addWorkingDaysSync (lib/workingDays.ts),
// which needs a fetched blockedDates set this component doesn't otherwise
// need. Reasonable here since projectedWorkingDays below is only ever a
// few days out — not worth a second data fetch for that precision.
function addWeekdaysDate(from: Date, days: number): Date {
  const cursor = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) remaining--;
  }
  return cursor;
}

function addWeekdaysLabel(from: Date, days: number): string {
  const cursor = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) remaining--;
  }
  return `${cursor.getDate()} ${SHORT_MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
}

// The report header's own Project Name...Procurement Lead Time facts, two
// per row, by explicit request — label stacked above value (not side by
// side like Row below) since a 50%-width column is too narrow for a label
// column plus a value column both to sit comfortably on one line.
function InfoCell({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={{ width: '50%' }} className="pr-3 pb-1.5">
      <Text className="text-2xs text-neutral-400 mb-0.5">{label}</Text>
      <Text className="text-sm font-bold" style={{ color: valueColor ?? '#111827' }}>{value}</Text>
    </View>
  );
}

// Label gets a fixed column so it never wraps; the value starts right next
// to it (not pushed to the far right edge) and wraps in its own remaining
// space if it's long — by explicit request.
function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View className="flex-row py-1.5 border-b border-neutral-50">
      <Text className="text-xs text-neutral-500" style={{ width: 100 }}>{label}</Text>
      <Text className="text-sm font-bold flex-1" style={{ color: color ?? '#111827' }}>{value}</Text>
    </View>
  );
}

// Title on the left, value right next to it with a small gap (not pushed to
// the far edge) — same close-together spacing as the Delay by Prerequisites
// legend below, by explicit request. flexWrap lets the value drop to its
// own line only if the two truly can't both fit — never truncated, so the
// full title always reads in full.
function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View className="flex-row items-baseline gap-2" style={{ flexWrap: 'wrap' }}>
      <Text className="text-xs text-neutral-500">{label}</Text>
      <Text className="text-xs font-bold" style={{ color }}>{value}</Text>
    </View>
  );
}

// No assigned-contractor field exists anywhere in the schema yet — a
// placeholder person's name by explicit request, standing in until that
// field is built. Shown with no on-screen disclosure, by explicit request.
const DUMMY_CONTRACTOR_NAME = 'Suresh Reddy';

// A task whose work type has no real Procurement Duration Type set yet
// falls back to this, by explicit request — same dummy-when-empty
// convention as everywhere else in this report. Matches a real row (Type
// 3 = 15 days) in the task_types table Flowchart Template's own task-type
// picker reads from, rather than an invented name/day pair that wouldn't
// correspond to any real type.
const DUMMY_PROCUREMENT_TYPE_NAME = 'Type 3';
const DUMMY_PROCUREMENT_DURATION_DAYS = 15;

// One color per core department, for the "Delay by Prerequisites" pie
// below — red/yellow/blue/brown/violet, by explicit request (the black
// originally used for Consultant was changed to blue; violet added for
// Vendor). Only the 5 core departments have an entry since
// delayByDepartment is already filtered down to just those 5.
const DEPARTMENT_COLOR: Record<string, string> = {
  architect: '#DC2626',
  client: '#EAB308',
  consultant: '#2563EB',
  contractor: '#92400E',
  vendor: '#7C3AED',
};
const DEPARTMENT_COLOR_FALLBACK = '#9CA3AF';

// Planned Working Days is the 100% baseline every other day-count on the
// Construction tab's StatRow list is measured against — 4 planned days
// means each day is 25%, by explicit request ("split into percentage...
// mention percent at last in bracket").
function daysPercentLabel(days: number, plannedDays: number): string {
  const percent = plannedDays > 0 ? Math.round((days / plannedDays) * 100) : 0;
  return `${days} days (${percent}%)`;
}

interface DelayByCategoryItem {
  category: string;
  label: string;
  pending: number;
  // Only set on the DPR-sourced dataset (dprDelayByCategory).
  lastComment?: string | null;
  // Only set on the combined dataset (cumulativeDelayByCategory).
  fromChecklist?: number;
  fromDpr?: number;
  // Only set on the checklist-sourced dataset (checklistDelayByCategory) —
  // the real still-open items behind this category's pending count, each
  // with its own real comment thread's most recent entry when one exists.
  pendingItems?: { label: string; comment: string | null; statusLabel: string }[];
}


// Shared donut + legend + expandable "Reasons for Delays" list — used 3x
// (Pre Construction/Construction/Post Construction), each with a different
// items source and expanded-detail text, by explicit request. Kept as one
// component so the three tabs can never visually drift apart from each
// other.
function DelayByCategorySection({
  title,
  subtitle,
  items,
  sortAsc,
  onToggleSort,
  emptyMessage,
  expandedReason,
  onToggleExpand,
  getExpandedText,
  checklistTaskId,
}: {
  title: string;
  subtitle: string;
  items: DelayByCategoryItem[];
  sortAsc: boolean;
  onToggleSort: () => void;
  emptyMessage: string;
  expandedReason: string | null;
  onToggleExpand: (category: string | null) => void;
  getExpandedText: (item: DelayByCategoryItem) => string;
  // Pre Construction only, by explicit request — the items listed here are
  // real, live rows off this task's own quality checklist (dependency_items/
  // dependency_completions), so marking one done there is what actually
  // clears it out of this list, not something this report itself can
  // change. A direct link to go do that, instead of leaving someone to hunt
  // for the task's checklist screen on their own. A bare taskId (not a
  // pre-built Href string) — expo-router's typed routes need the
  // pathname/params object form for a dynamic segment like this one.
  checklistTaskId?: string;
}) {
  // "16+1" instead of the summed "17", by explicit request — only when
  // this item actually carries the checklist/DPR breakdown (fromChecklist/
  // fromDpr both set, i.e. cumulativeDelayByCategory-shaped data); Pre
  // Construction's own checklist-only items have neither field and just
  // show the plain count, unchanged.
  function pendingLabel(d: DelayByCategoryItem): string {
    // Single total only — the "checklist+DPR" split (e.g. "7+0") was removed
    // by client request; the combined number is still checklist + DPR.
    return `${d.pending}`;
  }
  return (
    <View>
      <View className="flex-row items-center justify-between mt-1 mb-0.5">
        <Text className="text-xs font-extrabold uppercase tracking-wide text-neutral-700">{title}</Text>
        <Pressable onPress={onToggleSort} className="flex-row items-center gap-1 rounded-lg bg-neutral-100 px-2 py-1">
          <Ionicons name={sortAsc ? 'arrow-up' : 'arrow-down'} size={11} color="#6B7280" />
          <Text className="text-2xs font-semibold text-neutral-500">{sortAsc ? 'Low to high' : 'High to low'}</Text>
        </Pressable>
      </View>
      <Text className="text-2xs text-neutral-400 mb-2">{subtitle}</Text>
      <View className="flex-row items-center gap-2">
        <PieChart
          data={items.map((d) => ({
            key: d.category,
            label: d.label,
            value: d.pending,
            color: DEPARTMENT_COLOR[d.category] ?? DEPARTMENT_COLOR_FALLBACK,
          }))}
          size={104}
          donut
          showLegend={false}
          sliceLabels
        />
        <View className="gap-2">
          {items.map((d) => {
            const color = DEPARTMENT_COLOR[d.category] ?? DEPARTMENT_COLOR_FALLBACK;
            return (
              <View key={d.category} className="flex-row items-center gap-2">
                <View className="flex-row items-center gap-1.5">
                  <View className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <Text className="text-xs text-neutral-500">{d.label}</Text>
                </View>
                <Text className="text-xs font-bold" style={{ color }}>{pendingLabel(d)} pending</Text>
              </View>
            );
          })}
        </View>
      </View>
      {items.every((d) => d.pending === 0) && <Text className="text-2xs text-neutral-400 mt-1.5">{emptyMessage}</Text>}

      <Text className="text-xs font-extrabold uppercase tracking-wide text-neutral-700 mt-3 mb-2">Reasons for Delays</Text>
      <View className="gap-1">
        {items.map((d) => {
          const expanded = expandedReason === d.category;
          return (
            <Pressable
              key={d.category}
              onPress={() => onToggleExpand(expanded ? null : d.category)}
              className="rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-1.5"
            >
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2 flex-1 pr-2">
                  <Text className="text-xs font-semibold text-neutral-900">Delay from {d.label}</Text>
                </View>
                <View className="flex-row items-center gap-2">
                  <Text className="text-xs font-bold text-neutral-900">{pendingLabel(d)} delays</Text>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color="#9CA3AF" />
                </View>
              </View>
              {expanded && (
                <>
                  <Text className="text-2xs text-neutral-500 mt-1.5">{getExpandedText(d)}</Text>
                  {checklistTaskId && (
                    <Pressable
                      onPress={() => router.push({ pathname: '/task/[taskId]', params: { taskId: checklistTaskId } })}
                      className="flex-row items-center gap-1 mt-2 self-start"
                    >
                      <Text className="text-2xs font-bold text-brand-navy">View full checklist</Text>
                      <Ionicons name="arrow-forward" size={11} color="#0F1F33" />
                    </Pressable>
                  )}
                </>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Every derived figure the report screen shows (delay tables, procurement
// type, quantity/projection numbers) — one shared function so the on-screen
// report and the 3-stage PDF (report screen AND project Settings) can never
// disagree.
export function deriveReportView(data: GeneralParameterReportData, taskTypes: TaskTypeOption[], delaySortAsc = false) {
  const { base } = data;
  const CORE_CHECKLIST_CATEGORIES = new Set(['architect', 'client', 'consultant', 'contractor', 'procurement']);
  const checklistDelayByCategory = base.departmentCompletion
    .filter((d) => CORE_CHECKLIST_CATEGORIES.has(d.category))
    .map((d) => ({
      category: d.category === 'procurement' ? 'vendor' : d.category,
      label: d.category === 'procurement' ? 'Vendor' : d.label,
      // Open items only (Pending/On Hold/Revisions) — Issued and Not
      // Required don't count as delays.
      pending: d.pendingItems.length,
      pendingItems: d.pendingItems,
    }))
    .sort((a, b) => (delaySortAsc ? a.pending - b.pending : b.pending - a.pending));

  const dprDelayByCategory = [...data.delayByCategory]
    .map((d) => ({ category: d.category as string, label: d.label, pending: d.count, lastComment: d.lastComment }))
    .sort((a, b) => (delaySortAsc ? a.pending - b.pending : b.pending - a.pending));

  const cumulativeDelayByCategory = DPR_DEPENDENCY_CATEGORIES.map((cat) => {
    const fromChecklist = checklistDelayByCategory.find((d) => d.category === cat)?.pending ?? 0;
    const dprEntry = dprDelayByCategory.find((d) => d.category === cat);
    const fromDpr = dprEntry?.pending ?? 0;
    return {
      category: cat as string,
      label: DPR_DEPENDENCY_LABEL[cat],
      pending: fromChecklist + fromDpr,
      fromChecklist,
      fromDpr,
      // Real DPR comment for this category, when one exists — Construction
      // tab's own expand text (below) still shows the real site-engineer
      // comment, not a generic line, now that it uses this combined
      // dataset instead of dprDelayByCategory directly.
      lastComment: dprEntry?.lastComment ?? null,
    };
  }).sort((a, b) => (delaySortAsc ? a.pending - b.pending : b.pending - a.pending));

  // Task Type (AC/AV) and Procurement Lead Time — real when this task's
  // work type has them set, dummy fallback otherwise, by explicit request.
  // Same "AC"/"AV" short label the app uses everywhere else (flowchart task
  // badges, checklist templates), same lead-time formula
  // (computeProcurementLeadTime in lib/taskDetail/constants.ts) as
  // ProcurementLeadTimeCard on the Task Detail screen.
  const taskTypeLabel = base.task.accountabilityType === 'ACV' ? 'AV' : 'AC';
  const procurementDurationDays = base.task.procurementTypeDurationDays ?? DUMMY_PROCUREMENT_DURATION_DAYS;
  const procurementTotalDays = procurementDurationDays + PROCUREMENT_INPUT_PRESET_DAYS;

  // Actual Procurement Start/End — real, by explicit request, but there is
  // still no dedicated "actual procurement date" field anywhere in the
  // schema, and never will be a fabricated one. This instead reuses the
  // procurement/vendor checklist category's own REAL status-change history
  // (dependency_status_history, already tracked for every checklist item
  // regardless of this report): Actual Start is the earliest real status
  // change on any procurement item for this task; Actual End is the latest
  // one, but only once EVERY procurement item is actually done.
  //
  // Real checklist history is only ONE real signal though, and by explicit
  // correction it isn't the only one worth showing: a task's own real
  // actualStartDate is itself real proof procurement was ready enough for
  // work to begin, even on a task whose checklist nobody bothered updating
  // (common — the checklist and the real jobsite aren't always kept in
  // sync). So whenever the checklist itself has ZERO real activity, this
  // falls back to the task's own actualStartDate for DISPLAY (a real date,
  // not a fabricated one, and not the unhelpful "Not started/finished yet"
  // that flatly contradicts a task that's visibly already underway).
  const procurementEntry = base.departmentCompletion.find((d) => d.category === 'procurement') ?? null;
  const procurementActualStartISO = procurementEntry?.firstActivityAtISO ?? base.actualStartDate ?? null;
  // Procurement delayed by — measured against Planned Procurement START
  // (Planned Procurement END, i.e. the task's own live planned start), by
  // explicit correction — comparing against Planned Procurement START (36
  // days earlier) always produced a big number the moment actualStartDate
  // sat anywhere near the task's own real construction window, which is
  // the normal case, not a special one. Comparing against END instead asks
  // the more useful question: by the time we have real evidence procurement
  // activity began (procurementActualStartISO — real checklist history, or
  // the task's own actualStartDate as an honest fallback), had procurement
  // already met its own deadline? Or today if neither exists yet. Plain
  // calendar-day math, matching computeProcurementLeadTime's own precision
  // (not holiday-aware working-day math like Task delayed by — procurement's
  // planned dates aren't working-day-derived either).
  const procurementDelayDays = (() => {
    if (!base.task.referenceStartDateISO) return 0;
    const plannedEndMs = new Date(`${base.task.referenceStartDateISO}T00:00:00Z`).getTime();
    const compareMs = procurementActualStartISO ? parseFlexibleDateMs(procurementActualStartISO) : new Date().getTime();
    return compareMs > plannedEndMs ? Math.round((compareMs - plannedEndMs) / 86_400_000) : 0;
  })();
  // "Type A" (matching the Flowchart Template Kit's own labeling), not the
  // DB's raw "Type 1" name — resolved by matching this duration against the
  // real task_types list's own ascending-duration order, same as
  // typeLetter's own comment explains. Falls back to the raw DB name only
  // if the fetch above hasn't resolved yet (e.g. this frame, before the
  // effect's promise settles).
  const procurementTypeIndex = taskTypes.findIndex((t) => t.defaultDurationDays === procurementDurationDays);
  const procurementTypeName =
    procurementTypeIndex >= 0 ? `Type ${typeLetter(procurementTypeIndex)}` : base.task.procurementTypeName ?? DUMMY_PROCUREMENT_TYPE_NAME;

  // Real, DPR-driven Quantity figures — replaces the old fixed 45%/55%
  // placeholder. completedPercent is every DPR entry's own "% Work Done
  // Today" summed together (data.cumulativePercentComplete, see
  // generalParameterReport.ts), plannedDays is the task's real planned
  // working-day span (data.plannedWorkingDays, same value Schedule (E)
  // above already shows) — so nothing here can disagree with the rest of
  // this report.
  const plannedDays = data.plannedWorkingDays ?? 0;
  const completedPercent = data.cumulativePercentComplete;
  const pendingPercent = 100 - completedPercent;
  const workInProgressDays = Math.round((completedPercent / 100) * plannedDays);
  // Same day count the Construction tab's own "Projected Working Days" and
  // "Projected End Date" rows both read from — kept as one shared value so
  // the two can never disagree with each other.
  const projectedWorkingDays = Math.round((pendingPercent / 100) * plannedDays);
  // Anchored to the DPR timeline, not today, by explicit correction: DPR day
  // N falls on Actual Start + (N-1) working days, so the last filled DPR's
  // date + the remaining days is the end. A fully-complete 4-day task that
  // started 8 Sep ends 11 Sep — it no longer drifts forward to "today"
  // just because Actual End hasn't been set. No actual start yet -> today.
  const filledDprDays = data.dailyProgress.length;
  let projectedFrom = new Date();
  if (base.actualStartDate) {
    const [y, m, d] = base.actualStartDate.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    projectedFrom = filledDprDays > 0 ? addWeekdaysDate(start, filledDprDays - 1) : start;
  }
  const projectedEndDateLabel = addWeekdaysLabel(projectedFrom, projectedWorkingDays);

  // Pace explanation + "speed it up" comparison — the real %/day rate
  // implicit in the task's own planned duration (100% ÷ plannedDays), plus
  // one illustrative faster-pace example (30%/day) showing how much sooner
  // the real remaining % would finish at that rate. Exact one-decimal day
  // counts, not rounded to whole days like Projected Working Days above —
  // rounding both to the nearest whole day can coincidentally land on the
  // same number for two different rates, which would make "speeding up"
  // look like it did nothing; the exact decimals always show the real
  // difference.
  const dailyRatePercent = plannedDays > 0 ? Math.round((100 / plannedDays) * 10) / 10 : 0;
  const plannedPaceDaysExact = dailyRatePercent > 0 ? Math.round((pendingPercent / dailyRatePercent) * 10) / 10 : 0;
  const FASTER_RATE_PERCENT = 30;
  const fasterPaceDaysExact = Math.round((pendingPercent / FASTER_RATE_PERCENT) * 10) / 10;
  return {
    CORE_CHECKLIST_CATEGORIES,
    checklistDelayByCategory,
    dprDelayByCategory,
    cumulativeDelayByCategory,
    taskTypeLabel,
    procurementDurationDays,
    procurementTotalDays,
    procurementEntry,
    procurementActualStartISO,
    procurementDelayDays,
    procurementTypeIndex,
    procurementTypeName,
    plannedDays,
    completedPercent,
    pendingPercent,
    workInProgressDays,
    projectedWorkingDays,
    filledDprDays,
    projectedFrom,
    projectedEndDateLabel,
    dailyRatePercent,
    plannedPaceDaysExact,
    FASTER_RATE_PERCENT,
    fasterPaceDaysExact,
  };
}

// One A4 PDF covering all three stages (Pre Construction, Construction,
// Post Construction), by explicit request — used by the report screen's
// Download PDF and by project Settings' Printouts.
export function buildTaskReportPdfHtml(data: GeneralParameterReportData, projectName: string, taskTypes: TaskTypeOption[]): string {
  const { base } = data;
  const {
    checklistDelayByCategory,
    cumulativeDelayByCategory,
    taskTypeLabel,
    procurementTypeName,
    procurementTotalDays,
    procurementDelayDays,
    plannedDays,
    dailyRatePercent,
    workInProgressDays,
    completedPercent,
    projectedWorkingDays,
    pendingPercent,
    projectedEndDateLabel,
    plannedPaceDaysExact,
    FASTER_RATE_PERCENT,
    fasterPaceDaysExact,
  } = deriveReportView(data, taskTypes, false);

  // SVG donut — same look as the on-screen PieChart (donut, slices from 12
  // o'clock clockwise, % labels just outside each slice).
  function donut(slices: { value: number; color: string }[], size = 150): string {
    const total = slices.reduce((sum, x) => sum + x.value, 0);
    const r = size * 0.32;
    const cx = size / 2;
    const cy = size / 2;
    const stroke = size * 0.16;
    const circ = 2 * Math.PI * r;
    if (total <= 0) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#E5E7EB" stroke-width="${stroke}"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="10" fill="#9CA3AF">No data</text></svg>`;
    }
    let offset = 0;
    let arcs = '';
    let labels = '';
    for (const sl of slices) {
      if (sl.value <= 0) continue;
      const frac = sl.value / total;
      arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${sl.color}" stroke-width="${stroke}" stroke-dasharray="${frac * circ} ${circ}" stroke-dashoffset="${-offset * circ}" transform="rotate(-90 ${cx} ${cy})"/>`;
      const mid = (offset + frac / 2) * 2 * Math.PI - Math.PI / 2;
      const lr = r + stroke / 2 + 11;
      labels += `<text x="${cx + lr * Math.cos(mid)}" y="${cy + lr * Math.sin(mid) + 3}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#111827">${Math.round(frac * 100)}%</text>`;
      offset += frac;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="overflow:visible">${arcs}${labels}</svg>`;
  }

  const info = (label: string, value: string, color?: string) =>
    `<div class="info"><div class="lbl">${esc(label)}</div><div class="val"${color ? ` style="color:${color}"` : ''}>${esc(value)}</div></div>`;
  const infoGrid = (cells: string[]) => `<div class="grid">${cells.join('')}</div>`;
  const statRow = (label: string, value: string, color: string) =>
    `<div class="stat"><div class="lbl">${esc(label)}</div><div class="sval" style="color:${color}">${esc(value)}</div></div>`;

  const headerCells = [
    info('Project Name', projectName),
    info('Task Name', base.task.taskName),
    info('Task ID', base.task.taskCode),
    info('Report Date', formatReportDate(new Date())),
    info('Department', base.task.workName),
    info('Contractor', DUMMY_CONTRACTOR_NAME),
    info('Task Type', taskTypeLabel),
    info('Procurement Lead Time', `${procurementTypeName} — ${procurementTotalDays} days`),
  ];

  // Delay section — donut + legend + Reasons for Delays with every open item.
  function delaySection(title: string, subtitle: string, items: DelayByCategoryItem[], detail: (d: DelayByCategoryItem) => string[]): string {
    const sorted = [...items].sort((a, b) => b.pending - a.pending);
    const legend = sorted
      .map((d) => {
        const c = DEPARTMENT_COLOR[d.category] ?? DEPARTMENT_COLOR_FALLBACK;
        return `<div class="leg"><span class="dot" style="background:${c}"></span><span class="legl">${esc(d.label)}</span><b style="color:${c}">${d.pending} pending</b></div>`;
      })
      .join('');
    const reasons = sorted
      .map((d) => {
        const lines = detail(d);
        return `<div class="reason"><div class="rhead"><span>Delay from ${esc(d.label)}</span><b>${d.pending} delays</b></div>${
          lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''
        }</div>`;
      })
      .join('');
    return `
      <div class="sec">${esc(title)}</div>
      <div class="subt">${esc(subtitle)}</div>
      <div class="chartrow">
        ${donut(sorted.map((d) => ({ value: d.pending, color: DEPARTMENT_COLOR[d.category] ?? DEPARTMENT_COLOR_FALLBACK })))}
        <div class="legend">${legend}</div>
      </div>
      ${sorted.every((d) => d.pending === 0) ? '<div class="subt">Nothing pending — all prerequisite items are issued.</div>' : ''}
      <div class="sec">Reasons for Delays</div>
      ${reasons}`;
  }

  const checklistItemsFor = (category: string) =>
    (checklistDelayByCategory.find((c) => c.category === category)?.pendingItems ?? []).map((i) => `${i.label} — ${i.statusLabel}`);

  const actualStart = base.actualStartDate
    ? `${formatDateKeyLabel(base.actualStartDate)}${procurementDelayDays > 0 ? ` (+${procurementDelayDays}d from Pre Construction)` : ''}`
    : 'Not started yet';
  const actualEnd = data.effectiveActualEndDate ? formatDateKeyLabel(data.effectiveActualEndDate) : 'Not finished yet';
  const workforceCells = data.showWorkforceOnReport
    ? [
        info('Targeted Workforce / Day', data.targetedWorkforcePerDay != null ? `${data.targetedWorkforcePerDay} people` : 'Not logged'),
        info(
          'Actual Workforce / Day',
          data.actualWorkforcePerDay != null
            ? `${data.actualWorkforcePerDay} people${data.targetedWorkforcePerDay ? ` (${Math.round((data.actualWorkforcePerDay / data.targetedWorkforcePerDay) * 100)}%)` : ''}`
            : 'Not logged',
          data.targetedWorkforcePerDay != null && data.actualWorkforcePerDay != null && data.actualWorkforcePerDay < data.targetedWorkforcePerDay ? CHART_PENDING : undefined
        ),
      ]
    : [];

  const stageTitle = (n: number, name: string) =>
    `<div class="stage"><span class="badge">${n}</span>${esc(name)}</div>`;

  const pre = `
    <section class="page">
      ${stageTitle(1, 'Pre Construction')}
      <div class="card">
        ${infoGrid([
          ...headerCells,
          info('Planned Start', base.plannedStartDate ? formatDateKeyLabel(base.plannedStartDate) : 'Not set'),
          info('Planned End', base.dueDate ? formatDateKeyLabel(base.dueDate) : 'Not set'),
        ])}
        ${delaySection('Delay by Prerequisites', "From this task's prerequisite checklist — Pending, On Hold and Revisions items", checklistDelayByCategory, (d) =>
          (d.pendingItems ?? []).map((i) => `${i.label} — ${i.statusLabel}${i.comment ? ` · ${i.comment}` : ''}`)
        )}
      </div>
    </section>`;

  const construction = `
    <section class="page">
      ${stageTitle(2, 'Construction')}
      <div class="card">
        ${infoGrid(headerCells)}
        ${infoGrid([
          info('Total Working Days', data.plannedWorkingDays != null ? `${data.plannedWorkingDays} days` : 'Not set'),
          info('Actual Start Date', actualStart),
          info('Actual End Date', actualEnd, data.effectiveActualEndDate ? undefined : '#9CA3AF'),
          ...workforceCells,
        ])}
        <div class="chartrow">
          <div style="text-align:center">${donut([
            { value: completedPercent, color: CHART_COMPLETED },
            { value: pendingPercent, color: CHART_PENDING },
          ])}</div>
          <div class="stats">
            ${statRow('Planned Working Days', `${daysPercentLabel(plannedDays, plannedDays)} · ${dailyRatePercent}%/day`, CHART_PRIMARY)}
            ${statRow('Work in progress', `${workInProgressDays} days (${completedPercent}%)`, CHART_COMPLETED)}
            ${statRow('Projected Working Days', `${projectedWorkingDays} days (${pendingPercent}%)`, CHART_PENDING)}
            ${statRow('Projected End Date', projectedEndDateLabel, CHART_PENDING)}
          </div>
        </div>
        <div class="note">At the planned <b>${dailyRatePercent}%/day</b> pace, the remaining ${pendingPercent}% needs <b>${plannedPaceDaysExact} days</b> (→ ${esc(projectedEndDateLabel)}). Speed up to <b style="color:#059669">${FASTER_RATE_PERCENT}%/day</b> and the same ${pendingPercent}% would only need <b style="color:#059669">${fasterPaceDaysExact} days</b>.</div>
        ${
          data.dailyProgress.length
            ? `<div class="note muted">${esc(
                data.dailyProgress
                  .map((d) => {
                    const [, m, dd] = d.date.split('-').map(Number);
                    return `${dd} ${SHORT_MONTHS[m - 1]}: ${d.percentComplete}%`;
                  })
                  .join('   ·   ')
              )}</div>`
            : ''
        }
        ${delaySection('Delay by Prerequisites', 'Pre Construction checklist + DPR submissions', cumulativeDelayByCategory, (d) => [
          ...checklistItemsFor(d.category),
          ...(d.lastComment ? [`DPR comment: ${d.lastComment}`] : []),
        ])}
      </div>
    </section>`;

  const { constructionDays, totalDays: totalDelay } = data.stageDelays;
  const constructionLabel = data.effectiveActualEndDate ? 'Construction (Actual Days − Planned Days)' : 'Construction (Expected Progress − Actual DPR Progress)';
  const delayColor = (n: number) => (n > 0 ? CHART_PENDING : DONE_COLOR);
  const post = `
    <section class="page">
      ${stageTitle(3, 'Post Construction')}
      <div class="card">
        ${infoGrid(headerCells)}
        <div class="sec">Cumulative Delay</div>
        <div class="rows">
          <div class="row"><span>Preconstruction (Planned Start − Actual Start)</span><b style="color:${delayColor(data.preconstructionDelayDays)}">${data.preconstructionDelayDays}d</b></div>
          <div class="row"><span>${constructionLabel}</span><b style="color:${delayColor(constructionDays)}">${constructionDays}d</b></div>
          <div class="row"><span>Cumulative Total (Preconstruction + Construction)</span><b style="color:${delayColor(totalDelay)}">${totalDelay}d</b></div>
        </div>
        ${delaySection('Cumulative Reason for Delay', 'Checklist + DPR combined', cumulativeDelayByCategory, (d) => checklistItemsFor(d.category))}
      </div>
    </section>`;

  const style = `
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111827; margin: 0; font-size: 11px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { page-break-after: always; max-width: 190mm; margin: 0 auto; }
    .page:last-child { page-break-after: auto; }
    .top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0F1F33; padding-bottom: 6px; margin-bottom: 10px; }
    .top .logo { font-size: 11px; font-weight: 800; letter-spacing: .12em; color: #0F1F33; }
    .top .meta { font-size: 9.5px; color: #6B7280; text-align: right; }
    .stage { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 800; margin: 4px 0 8px; }
    .badge { display: inline-flex; width: 22px; height: 22px; border-radius: 11px; background: #0F1F33; color: #fff; font-size: 12px; align-items: center; justify-content: center; }
    .card { border: 1px solid #E5E7EB; border-radius: 14px; padding: 14px 16px; }
    .grid { display: flex; flex-wrap: wrap; margin-bottom: 6px; }
    .info { width: 50%; padding: 4px 8px 6px 0; }
    .lbl { font-size: 9.5px; color: #9CA3AF; }
    .val { font-size: 12px; font-weight: 700; color: #111827; margin-top: 1px; }
    .sec { font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: #404040; margin: 12px 0 2px; }
    .subt { font-size: 9.5px; color: #9CA3AF; margin-bottom: 6px; }
    .chartrow { display: flex; align-items: center; gap: 22px; margin: 6px 0 4px; padding-left: 10px; }
    .legend { display: flex; flex-direction: column; gap: 5px; }
    .leg { display: flex; align-items: center; gap: 6px; font-size: 11px; }
    .dot { width: 8px; height: 8px; border-radius: 4px; display: inline-block; }
    .legl { color: #6B7280; }
    .stats { display: flex; flex-direction: column; gap: 6px; }
    .stat .lbl { font-size: 10px; color: #6B7280; }
    .sval { font-size: 12.5px; font-weight: 800; }
    .note { background: #FAFAFA; border: 1px solid #F3F4F6; border-radius: 10px; padding: 8px 10px; margin-top: 8px; font-size: 10.5px; color: #4B5563; line-height: 1.5; }
    .note.muted { font-weight: 600; color: #6B7280; }
    .reason { background: #FAFAFA; border: 1px solid #F3F4F6; border-radius: 10px; padding: 6px 10px; margin-bottom: 4px; page-break-inside: avoid; }
    .rhead { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; }
    .reason ul { margin: 4px 0 0 14px; padding: 0; color: #6B7280; font-size: 10px; }
    .rows .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #F3F4F6; font-size: 11px; }
    .sign { display: flex; gap: 24px; margin-top: 18px; }
    .sign div { flex: 1; border-top: 1px solid #111827; padding-top: 3px; font-size: 9.5px; color: #6B7280; margin-top: 26px; }
  `;
  const top = `<div class="top"><div class="logo">PMC PORTAL · TASK BASED REPORT</div><div class="meta">${esc(projectName)} · ${esc(base.task.taskCode)}<br/>Generated ${esc(formatReportDate(new Date()))}</div></div>`;
  const sign = `<div class="sign"><div>Prepared by (PMC)</div><div>Client acknowledgement &amp; date</div></div>`;
  const withChrome = (section: string) => section.replace('<section class="page">', `<section class="page">${top}`).replace(/<\/section>$/, `${sign}</section>`);

  return `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(base.task.taskCode)} — Task Based Report</title><style>${style}</style></head><body>${[pre, construction, post]
    .map((x) => withChrome(x.trim()))
    .join('')}</body></html>`;
}


// The "General Parameter" report: Department/Contractor, a Status of the
// Work chart, a Cumulative Delay breakdown (Preconstruction/Construction/
// Total — Post Construction tab only, real data), a
// Quantity donut, and a Delay by Prerequisites donut broken down by the
// task's own 5 core checklist
// departments (Architect/Client/Consultant/Contractor/Vendor).
export function GeneralParameterSection({ data }: { data: GeneralParameterReportData }) {
  const { base } = data;
  const { projects, selectedProjectId } = useProject();
  const projectName = projects.find((p) => p.id === selectedProjectId)?.name ?? '—';
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSavedTo, setExportSavedTo] = useState<string | null>(null);
  const [expandedReason, setExpandedReason] = useState<string | null>(null);
  const [taskTypes, setTaskTypes] = useState<TaskTypeOption[]>([]);

  useEffect(() => {
    fetchTaskTypes().then(setTaskTypes).catch(() => {}); // letter falls back to the raw name below if this fails
  }, []);
  // 3 tabs for Status of the Work, by explicit request, Pre Construction
  // first — Construction shows the task's own quantity donut; Pre
  // Construction shows Planned Start/End/Actual Start/Task delayed by plus
  // whether the 4 core prerequisites are done before construction starts;
  // Post Construction shows only a Planned-vs-Actual date comparison plus
  // Cumulative Delay (no donut, no repeat of Pre Construction's own
  // readiness view — by explicit request).
  const [reportType, setReportType] = useState<'pre-construction' | 'construction' | 'post-construction'>('pre-construction');
  // Priority order for Delay by Prerequisites — sorts both the list and the
  // donut's own clockwise slice order (PieChart draws slices in data-array
  // order, starting at 12 o'clock), by explicit request. Descending
  // (highest-pending department first) by default.
  const [delaySortAsc, setDelaySortAsc] = useState(false);
  // Per-DPR selector, by explicit request — the report defaults to every
  // real DPR entry summed/combined ("cumulative"), but a real construction
  // team reviewing "did DPR 1 specifically look right" needs to isolate one
  // submission's own numbers. Null (the default) means cumulative; a real
  // report_date switches the tab content below to that one entry's own
  // fields instead (see the dpr picker + effectiveEntry below).
  const [selectedDprDate, setSelectedDprDate] = useState<string | null>(null);
  const [dprPickerOpen, setDprPickerOpen] = useState(false);

  // No report at all until this task's first real "Submit DPR" — by
  // explicit request: before that, every field below would read 0%/100%
  // pending/empty categories, which looks like real computed data rather
  // than "nothing has actually been reported yet." Planned dates and
  // subtasks are still visible on the DPR form itself either way — this
  // gate is specifically about the Report screen, not DPR entry.
  if (!data.hasSubmittedDpr) {
    return (
      <EmptyState
        icon="document-text-outline"
        iconColor="#9CA3AF"
        title="No DPR submitted yet"
        subtitle="This task's report will be available once its first DPR is submitted."
      />
    );
  }

  // Three distinct delay-by-category views, by explicit request — same 5
  // real-world categories (architect/client/consultant/contractor/vendor),
  // three different data sources depending on which tab is showing them:
  //   Pre Construction — the admin's quality checklist (base.
  //     departmentCompletion, from real dependency_items). This is set up
  //     before work starts, hence "pre construction."
  //   Construction — the site engineer's own DPR "Reason for Delay" picks
  //     (data.delayByCategory), which only exist once real work is
  //     actually happening day to day.
  //   Post Construction — the two summed together per category, the full
  //     picture once the task is done.
  // No sample/illustrative fallback on any of these — a category with
  // nothing real behind it just reads 0, not a fake plausible number.
  const {
    checklistDelayByCategory,
    cumulativeDelayByCategory,
    taskTypeLabel,
    procurementTotalDays,
    procurementDelayDays,
    procurementTypeName,
    plannedDays,
    completedPercent,
    pendingPercent,
    workInProgressDays,
    projectedWorkingDays,
    projectedEndDateLabel,
    dailyRatePercent,
    plannedPaceDaysExact,
    FASTER_RATE_PERCENT,
    fasterPaceDaysExact,
  } = deriveReportView(data, taskTypes, delaySortAsc);

  async function handleExport() {
    setExportError(null);
    setExportSavedTo(null);
    setExporting(true);
    try {
      const note = await downloadPrintout(buildTaskReportPdfHtml(data, projectName, taskTypes), `${base.task.taskCode}-Task-Based-Report`);
      if (note) setExportSavedTo(note);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not create the PDF.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <ReportSection>
        {/* Per-DPR selector, by explicit request — defaults to "All
            (Cumulative)" (the existing tabbed report, unchanged); picking a
            specific real DPR swaps the whole tabbed view below for a
            focused card of just that one submission's own fields, since
            "cumulative" doesn't mean anything for a single day. Only shown
            once there's at least one real entry to pick from. */}
        {data.perDayEntries.length > 0 && (
          <View className="mb-3">
            <Text className="text-2xs text-neutral-400 mb-1">Viewing</Text>
            <Pressable
              onPress={() => setDprPickerOpen((v) => !v)}
              className="flex-row items-center justify-between border border-neutral-200 rounded-lg px-3 py-2.5"
            >
              <Text className="text-sm font-bold text-neutral-900">
                {selectedDprDate
                  ? `DPR ${data.perDayEntries.findIndex((e) => e.reportDate === selectedDprDate) + 1} — ${formatDateKeyLabel(selectedDprDate)}`
                  : 'All (Cumulative)'}
              </Text>
              <Text className="text-neutral-400">{dprPickerOpen ? '▲' : '▼'}</Text>
            </Pressable>
            {dprPickerOpen && (
              <View className="mt-1 border border-neutral-100 rounded-lg overflow-hidden">
                <Pressable
                  onPress={() => { setSelectedDprDate(null); setDprPickerOpen(false); }}
                  className="px-3 py-2.5 border-b border-neutral-50"
                  style={{ backgroundColor: selectedDprDate === null ? '#0F1F33' : undefined }}
                >
                  <Text className={`text-xs font-bold ${selectedDprDate === null ? 'text-white' : 'text-neutral-800'}`}>All (Cumulative)</Text>
                </Pressable>
                {data.perDayEntries.map((entry, i) => {
                  const active = selectedDprDate === entry.reportDate;
                  return (
                    <Pressable
                      key={entry.reportDate}
                      onPress={() => { setSelectedDprDate(entry.reportDate); setDprPickerOpen(false); }}
                      className={`px-3 py-2.5 ${i < data.perDayEntries.length - 1 ? 'border-b border-neutral-50' : ''}`}
                      style={{ backgroundColor: active ? '#0F1F33' : undefined }}
                    >
                      <Text className={`text-xs font-bold ${active ? 'text-white' : 'text-neutral-800'}`}>
                        DPR {i + 1} — {formatDateKeyLabel(entry.reportDate)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {selectedDprDate ? (
          (() => {
            const entry = data.perDayEntries.find((e) => e.reportDate === selectedDprDate);
            const entryIndex = data.perDayEntries.findIndex((e) => e.reportDate === selectedDprDate);
            if (!entry) return null;
            return (
              <View>
                <Text className="text-2xs text-neutral-400 mb-0.5">{base.task.workName}</Text>
                <Text className="text-sm font-bold text-neutral-900 mb-3">{base.task.taskName}</Text>
                <View className="flex-row flex-wrap mb-1">
                  <InfoCell label="DPR" value={`DPR ${entryIndex + 1} of ${data.perDayEntries.length}`} />
                  <InfoCell label="Report Date" value={formatDateKeyLabel(entry.reportDate)} />
                  <InfoCell label="% Work Done That Day" value={entry.percentComplete != null ? `${entry.percentComplete}%` : 'Not logged'} />
                  {data.showWorkforceOnReport && (
                    <>
                      <InfoCell label="Targeted Workforce" value={entry.targetedWorkforcePerDay != null ? `${entry.targetedWorkforcePerDay} people` : 'Not logged'} />
                      <InfoCell label="Actual Workforce" value={entry.actualWorkforcePerDay != null ? `${entry.actualWorkforcePerDay} people` : 'Not logged'} />
                    </>
                  )}
                </View>
                <Text className="text-2xs text-neutral-400 mb-1 mt-2">Reason for Delay</Text>
                {entry.dependencyCategories.length > 0 ? (
                  <View className="flex-row flex-wrap gap-1.5 mb-3">
                    {entry.dependencyCategories.map((cat) => (
                      <View key={cat} className="px-2.5 py-1 rounded-full bg-neutral-100">
                        <Text className="text-2xs font-semibold text-neutral-700">{DPR_DEPENDENCY_LABEL[cat]}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="text-xs text-neutral-400 mb-3">None logged</Text>
                )}
                <Text className="text-2xs text-neutral-400 mb-1">Comments</Text>
                <Text className="text-sm text-neutral-800">{entry.commentLabel ?? 'None logged'}</Text>
              </View>
            );
          })()
        ) : (
        <>
        <View className="flex-row self-start rounded-lg bg-neutral-100 p-0.5 mb-3">
          {(['pre-construction', 'construction', 'post-construction'] as const).map((type) => {
            const active = reportType === type;
            const label = type === 'construction' ? 'Construction' : type === 'pre-construction' ? 'Pre Construction' : 'Post Construction';
            return (
              <Pressable
                key={type}
                onPress={() => setReportType(type)}
                className="rounded-md px-2.5 py-1"
                style={{ backgroundColor: active ? '#fff' : 'transparent' }}
              >
                <Text className={`text-2xs font-bold ${active ? 'text-neutral-900' : 'text-neutral-400'}`}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        {/* 2 columns, by explicit request — was one label-per-row list.
            Task Type/Procurement Lead Time stay here (moved up out from
            under "Status of the Work" a few requests ago) — that heading
            didn't move with them, it now sits lower, over the Pre
            Construction tab's own Planned Start...Task delayed by rows
            instead (below). */}
        <View className="flex-row flex-wrap">
          <InfoCell label="Project Name" value={projectName} />
          <InfoCell label="Task Name" value={base.task.taskName} />
          <InfoCell label="Task ID" value={base.task.taskCode} />
          <InfoCell label="Report Date" value={formatReportDate(new Date())} />
          <InfoCell label="Department" value={base.task.workName} />
          <InfoCell label="Contractor" value={DUMMY_CONTRACTOR_NAME} />
          <InfoCell label="Task Type" value={taskTypeLabel} />
          <InfoCell label="Procurement Lead Time" value={`${procurementTypeName} — ${procurementTotalDays} days`} />
          {/* Pre Construction tab ONLY, by explicit request — Construction
              dropped its own Planned Start/End in favor of Total Working
              Days (previous request); Post Construction has its own
              "Planned vs Actual" span strings already. */}
          {reportType === 'pre-construction' && (
            <>
              <InfoCell label="Planned Start" value={base.plannedStartDate ? formatDateKeyLabel(base.plannedStartDate) : 'Not set'} />
              <InfoCell label="Planned End" value={base.dueDate ? formatDateKeyLabel(base.dueDate) : 'Not set'} />
            </>
          )}
        </View>

        {/* Post Construction tab ONLY, by explicit request — not
            Construction (moved off there) and not Pre Construction (nothing
            has happened yet at that stage for "cumulative" to mean
            anything). Preconstruction/Construction are real, already-
            computed figures (lib/reports/generalParameterReport.ts) that
            weren't rendered anywhere in this screen before; Cumulative
            Total is the two added together. Real data, not a dummy
            placeholder — both values already exist on `data`. */}
        {reportType === 'post-construction' && (
          <>
            <Text className="text-xs font-extrabold uppercase tracking-wide text-neutral-700 mt-3 mb-2">Cumulative Delay</Text>
            <Row
              label="Preconstruction (Planned Start − Actual Start)"
              value={`${data.preconstructionDelayDays}d`}
              color={data.preconstructionDelayDays > 0 ? CHART_PENDING : DONE_COLOR}
            />
            {/* Was data.constructionDelayDays — elapsed working days since
                actual start vs planned duration — by explicit correction:
                that grows every single day the task stays open regardless
                of real progress, so a task genuinely 58% done via real DPR
                submissions (3 of 5 planned days) still read as "16d behind"
                just because Actual End hasn't been set yet. Swapped for
                data.progressDelayDays instead — the same real earned-
                progress shortfall Pre Construction's own "Task delayed by"
                used (how much of the expected-by-today % hasn't actually
                been submitted, in day-equivalents) — ~2 days pending here,
                matching "3 done, 2 pending" for a 5-day task. */}
            {/* data.stageDelays (shared with the Daily/Weekly/Monthly
                reports, so both always agree) — same earned-progress figure
                while the task is open; once finished, the working days
                actually taken beyond the plan (the shortfall is 0 by then). */}
            <Row
              label={data.effectiveActualEndDate ? 'Construction (Actual Days − Planned Days)' : 'Construction (Expected Progress − Actual DPR Progress)'}
              value={`${data.stageDelays.constructionDays}d`}
              color={data.stageDelays.constructionDays > 0 ? CHART_PENDING : DONE_COLOR}
            />
            <Row
              label="Cumulative Total (Preconstruction + Construction)"
              value={`${data.stageDelays.totalDays}d`}
              color={data.stageDelays.totalDays > 0 ? CHART_PENDING : DONE_COLOR}
            />
          </>
        )}

        {reportType === 'construction' && (
          <>
            {/* Planned Start/End removed here, by explicit request — Total
                Working Days (the same real plannedWorkingDays value the
                daily %/day target elsewhere on this report is itself built
                from) shown in their place instead. Actual Start/End stay,
                same reasoning as before — this tab has no Cumulative Delay
                section of its own (that moved to Post Construction only),
                so this is the one place Construction shows whether/when the
                task actually started and finished.
                A 2-column wrapping grid of stacked label/value cells (same
                InfoCell the top info card already uses), by explicit
                correction — the previous side-by-side Row layout put a
                fixed-width label right next to its value inside a half-
                width column, which forced "Actual Workforce / Day" and its
                own "14 people (78%)" value to each wrap onto multiple
                uneven lines. Stacking label-above-value avoids that squeeze
                regardless of how long either one is, and wrapping all 5
                cells into ONE grid (instead of two separate 3-item/2-item
                columns) keeps every row's height naturally even. */}
            <View className="flex-row flex-wrap">
              <InfoCell label="Total Working Days" value={data.plannedWorkingDays != null ? `${data.plannedWorkingDays} days` : 'Not set'} />
              <InfoCell
                label="Actual Start Date"
                value={
                  base.actualStartDate
                    ? `${formatDateKeyLabel(base.actualStartDate)}${procurementDelayDays > 0 ? ` (+${procurementDelayDays}d from Pre Construction)` : ''}`
                    : 'Not started yet'
                }
                valueColor={base.actualStartDate ? undefined : '#9CA3AF'}
              />
              <InfoCell
                label="Actual End Date"
                value={data.effectiveActualEndDate ? formatDateKeyLabel(data.effectiveActualEndDate) : 'Not finished yet'}
                valueColor={data.effectiveActualEndDate ? undefined : '#9CA3AF'}
              />
              {/* Workforce — Construction only, by explicit request (moved
                  off Pre Construction: nothing to track manpower against
                  before the task has started). Still real, DPR-sourced,
                  still gated on the same project-level toggle. */}
              {data.showWorkforceOnReport && (
                <>
                  {/* Summed across every real DPR entry now, by explicit
                      request (was just the most recent one) — a percentage
                      of Targeted shown in brackets next to Actual, the real
                      Actual/Targeted ratio across all of them combined. */}
                  <InfoCell
                    label="Targeted Workforce / Day"
                    value={data.targetedWorkforcePerDay != null ? `${data.targetedWorkforcePerDay} people` : 'Not logged'}
                  />
                  <InfoCell
                    label="Actual Workforce / Day"
                    value={
                      data.actualWorkforcePerDay != null
                        ? `${data.actualWorkforcePerDay} people${
                            data.targetedWorkforcePerDay != null && data.targetedWorkforcePerDay > 0
                              ? ` (${Math.round((data.actualWorkforcePerDay / data.targetedWorkforcePerDay) * 100)}%)`
                              : ''
                          }`
                        : 'Not logged'
                    }
                    valueColor={
                      data.targetedWorkforcePerDay != null &&
                      data.actualWorkforcePerDay != null &&
                      data.actualWorkforcePerDay < data.targetedWorkforcePerDay
                        ? CHART_PENDING
                        : undefined
                    }
                  />
                </>
              )}
            </View>
            {/* gap-2 -> gap-5 here only — the chart's own outside slice-%
                labels (sliceLabels) sit right at its outer edge, so the
                default row gap read as the text column touching the
                circle. */}
            <View className="flex-row items-center gap-5">
              <PieChart
                data={[
                  { key: 'completed', label: 'Completed', value: completedPercent, color: CHART_COMPLETED },
                  { key: 'pending', label: 'Pending', value: pendingPercent, color: CHART_PENDING },
                ]}
                size={104}
                donut
                showLegend={false}
                sliceLabels
              />
              {/* flex-1 + StatRow (title left, value right, each forced to
                  one line) — by explicit request. The earlier "value -
                  label" single-Text format still wrapped onto a second line
                  once the label was long enough ("Projected Working Days"),
                  since a wrapping paragraph has no per-side layout to force
                  it back onto one line; StatRow's two independently-
                  constrained sides do. Full titles restored ("Projected
                  Working Days"/"Projected End Date"), by explicit request —
                  the earlier shortened wording is gone, tight gap-2 spacing
                  (not a full-width stretch) is what keeps each row compact
                  now instead. */}
              <View className="flex-1 gap-2">
                <StatRow
                  label="Planned Working Days"
                  value={`${daysPercentLabel(plannedDays, plannedDays)} · ${dailyRatePercent}%/day`}
                  color={CHART_PRIMARY}
                />
                <StatRow label="Work in progress" value={`${workInProgressDays} days (${completedPercent}%)`} color={CHART_COMPLETED} />
                {/* Was a plain "Pending: N days" row — client feedback asked
                    for a projected completion date instead, plus the
                    working-day count it's projected from, both shown
                    (previously only the date was rendered). */}
                <StatRow label="Projected Working Days" value={`${projectedWorkingDays} days (${pendingPercent}%)`} color={CHART_PENDING} />
                <StatRow label="Projected End Date" value={projectedEndDateLabel} color={CHART_PENDING} />
              </View>
            </View>

            {/* Pace math first, then the day-by-day breakdown below it, by
                explicit request (was the reverse) — the headline summary
                reads before the supporting detail. Both moved off bare
                text-2xs into their own lightly-padded card each, also by
                explicit request ("very small... make it easy to read") —
                text-xs instead of text-2xs, real line-height via leading-5,
                and breathing room via the card padding itself rather than
                a single mt-2 between two cramped lines. */}
            <View className="rounded-xl bg-neutral-50 border border-neutral-100 px-3 py-2.5 mt-3">
              <Text className="text-xs text-neutral-600 leading-5">
                At the planned <Text className="font-bold text-neutral-800">{dailyRatePercent}%/day</Text> pace, the remaining {pendingPercent}%
                needs <Text className="font-bold text-neutral-800">{plannedPaceDaysExact} days</Text> (→ {projectedEndDateLabel}). Speed up to{' '}
                <Text className="font-bold text-emerald-600">{FASTER_RATE_PERCENT}%/day</Text> and the same {pendingPercent}% would only need{' '}
                <Text className="font-bold text-emerald-600">{fasterPaceDaysExact} days</Text>.
              </Text>
            </View>

            {/* Real per-day DPR breakdown behind the "Work in progress"
                cumulative %, by explicit request — data.dailyProgress, the
                same real entries cumulativePercentComplete itself sums, one
                line each rather than the aggregate number alone. */}
            {data.dailyProgress.length > 0 && (
              <View className="rounded-xl bg-neutral-50 border border-neutral-100 px-3 py-2.5 mt-2.5">
                <Text className="text-xs font-semibold text-neutral-500 leading-5">
                  {data.dailyProgress
                    .map((d) => {
                      const [, m, dd] = d.date.split('-').map(Number);
                      return `${dd} ${SHORT_MONTHS[m - 1]}: ${d.percentComplete}%`;
                    })
                    .join('   ·   ')}
                </Text>
              </View>
            )}

            {/* Why this task is delayed + who it's holding up, by explicit
                request — real data, both already computed elsewhere and
                simply not surfaced here before: base.delay (source/
                causedByTaskCode/causedByTaskName — the same upstream-cause
                resolution findUpstreamDelayCause already does in
                lib/reports/taskReport.ts) and base.dependencies.blocking
                (the same downstream list Task Report's own Dependencies
                section shows). Only rendered when this task actually IS
                delayed — an on-track task isn't "affecting" anything
                downstream, so there's nothing to warn about. */}
            {base.delay.source !== 'none' && (
              <View className="mt-3 pt-3 border-t border-neutral-100 gap-2">
                <View className="rounded-xl bg-red-50 border border-red-100 px-3 py-2.5">
                  <Text className="text-2xs font-bold uppercase tracking-wide text-red-700 mb-1">Why this task is delayed</Text>
                  <Text className="text-xs text-red-700">
                    {base.delay.source === 'upstream' && base.delay.causedByTaskName
                      ? `Delayed by ${base.delay.totalDelayDays}d — waiting on ${base.delay.causedByTaskCode} (${base.delay.causedByTaskName}), which hasn't finished yet.`
                      : `Delayed by ${base.delay.totalDelayDays}d — this task itself is running behind its own planned schedule.`}
                  </Text>
                </View>
                <View className="rounded-xl bg-amber-50 border border-amber-100 px-3 py-2.5">
                  <Text className="text-2xs font-bold uppercase tracking-wide text-amber-700 mb-1">
                    {base.dependencies.blocking.length > 0
                      ? `This will also delay ${base.dependencies.blocking.length} task${base.dependencies.blocking.length === 1 ? '' : 's'}`
                      : 'Tasks that will also be affected'}
                  </Text>
                  <Text className="text-xs text-amber-700">
                    {base.dependencies.blocking.length > 0
                      ? base.dependencies.blocking.map((t) => `${t.taskCode} — ${t.taskName}`).join(', ')
                      : 'No downstream tasks are linked to this one yet.'}
                  </Text>
                </View>
              </View>
            )}
          </>
        )}

        {/* "Status of the Work" (Start date/End date/Actual Start date/
            Actual End date) removed here entirely, by explicit request —
            Pre Construction now goes straight into Delay by Prerequisites
            below. The underlying procurement-lead-time/actual-date data
            this used to show is untouched; nothing but this display block
            depended on it (see procurementLeadTime/procurementActualEndISO/
            procurementFullyDone/procurementAnyRealActivity — all removed
            alongside it, along with BarRow, since none had any other
            reader left in this file). */}

        {/* Planned vs Actual section removed here, by explicit request —
            Post Construction now goes straight from Cumulative Delay into
            Cumulative Reason for Delay below. */}

        {/* mt-3 down to mt-1, by explicit request — less gap between the
            tab's own content above and this section. Three different
            sources depending on the tab, by explicit request — see the
            checklistDelayByCategory/dprDelayByCategory/
            cumulativeDelayByCategory comment above. */}
        {reportType === 'pre-construction' && (
          <DelayByCategorySection
            title="Delay by Prerequisites"
            subtitle="From this task's prerequisite checklist — Pending, On Hold and Revisions items"
            items={checklistDelayByCategory}
            sortAsc={delaySortAsc}
            onToggleSort={() => setDelaySortAsc((prev) => !prev)}
            emptyMessage="All prerequisite items for this task are issued — nothing pending."
            expandedReason={expandedReason}
            onToggleExpand={setExpandedReason}
            getExpandedText={(d) =>
              (d.pendingItems ?? []).length === 0
                ? 'All items issued.'
                : (d.pendingItems ?? [])
                    .map((item) => `• ${item.label} — ${item.statusLabel}${item.comment ? ` · ${item.comment}` : ''}`)
                    .join('\n')
            }
            checklistTaskId={base.task.id}
          />
        )}
        {reportType === 'construction' && (
          <DelayByCategorySection
            title="Delay by Prerequisites"
            subtitle="Pre Construction checklist + DPR submissions (checklist+DPR)"
            items={cumulativeDelayByCategory}
            sortAsc={delaySortAsc}
            onToggleSort={() => setDelaySortAsc((prev) => !prev)}
            emptyMessage="Nothing pending from the checklist or any DPR entry for this task."
            expandedReason={expandedReason}
            onToggleExpand={setExpandedReason}
            getExpandedText={(d) => d.lastComment ?? 'No comment has been filled in for this category yet.'}
          />
        )}
        {reportType === 'post-construction' && (
          <DelayByCategorySection
            title="Cumulative Reason for Delay"
            subtitle="Checklist + DPR combined"
            items={cumulativeDelayByCategory}
            sortAsc={delaySortAsc}
            onToggleSort={() => setDelaySortAsc((prev) => !prev)}
            emptyMessage="Nothing pending from the checklist or any DPR entry for this task."
            expandedReason={expandedReason}
            onToggleExpand={setExpandedReason}
            getExpandedText={(d) => `${d.fromChecklist ?? 0} pending on the checklist, ${d.fromDpr ?? 0} picked across DPR entries.`}
          />
        )}
        </>
        )}
      </ReportSection>

      <Pressable
        onPress={handleExport}
        disabled={exporting}
        className="flex-row items-center justify-center gap-2 rounded-xl bg-brand-navy py-2.5 mt-1"
        style={{ opacity: exporting ? 0.6 : 1 }}
      >
        {exporting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="download-outline" size={16} color="#fff" />}
        <Text className="text-sm font-bold text-white">{exporting ? 'Preparing PDF…' : 'Download PDF'}</Text>
      </Pressable>
      {exportError && <Text className="text-2xs text-red-600 mt-2">{exportError}</Text>}
      {exportSavedTo && <Text className="text-2xs text-green-600 font-semibold mt-2">{exportSavedTo}</Text>}
    </>
  );
}
