import { supabase } from '../supabase';
import { isPilotVisible } from '../pilot';
import { DPR_DEPENDENCY_CATEGORIES, DPR_DEPENDENCY_LABEL, type DprCommentPreset, type DprDependencyCategory } from '../dprEntries';
import { CATEGORY_LABEL } from '../taskDetail/constants';
import { addDaysUtc, daysBetweenInclusive, todayKeyUtc, type DateRange } from './dateRange';
import { computeStageDelays, fetchBlockedDates, type StageDelays } from './generalParameterReport';

// The Day/Week/Month/Custom "Report by time" reports (drawer's Reports
// submenu). Every task on the project's flowchart, by explicit request, as
// it stood at the end of the chosen window: its stage (Pre Construction /
// Construction / Post Construction), progress (the sum of its DPRs), the
// Pre/Construction/Total delay split (shared with the Task Based Report's
// Post Construction tab — computeStageDelays — so the two always agree),
// and the DPRs actually filed inside the window (their delay reasons).
// (The Architect/Client/Vendor/Dept/Contractor reports live in
// lib/reports/stakeholderReport.ts — a genuinely different report shape.)

export interface DprActivityRow {
  taskId: string;
  taskCode: string;
  taskName: string;
  workName: string; // "Department"
  reportDate: string;
  percentComplete: number | null;
  dependencyCategories: DprDependencyCategory[];
  commentPreset: DprCommentPreset | null;
  commentText: string | null;
}

// "X% done in N days · remaining Y% needs M more days (till date) · Z days
// behind/ahead of schedule" — a straight-line projection from the average
// daily progress rate since the task (or project) started.
export interface ProgressForecast {
  percentDone: number;
  asOfDate: string; // latest DPR date the percent comes from
  startDate: string;
  daysElapsed: number;
  remainingPercent: number;
  daysRemaining: number | null; // null when no progress yet (rate 0)
  forecastEndDate: string | null;
  scheduledEndDate: string | null;
  // forecastEndDate - scheduledEndDate: positive = delayed, <= 0 = on track.
  varianceDays: number | null;
}

// Which of the task report's 3 tabs the task is in at the window's end:
//   pre-construction  — not started, or its Pre Construction checklist isn't
//                       fully cleared yet (by explicit request, a task can't
//                       move into Construction until it is)
//   construction      — started, checklist cleared, under 100%
//   post-construction — finished: status Completed with an Actual End, or
//                       its DPRs add up to 100%
export type TaskStage = 'pre-construction' | 'construction' | 'post-construction';

export const TASK_STAGE_LABEL: Record<TaskStage, string> = {
  'pre-construction': 'Pre Construction',
  construction: 'Construction',
  'post-construction': 'Post Construction',
};

export interface DprActivityTask {
  taskId: string;
  taskCode: string;
  taskName: string;
  workName: string;
  // The task's type (task_types — "Type 1", 2 days …), shown in the Pre
  // Construction box. Null when none is set.
  taskType: { name: string; days: number } | null;
  entries: DprActivityRow[]; // DPRs filed inside the window, newest first
  forecast: ProgressForecast | null;
  stage: TaskStage;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  // Pre Construction checklist (architect/client/consultant/contractor/
  // procurement items) — every item YES/PROCEED = cleared. Not-done per
  // category below.
  checklist: { done: number; total: number };
  pendingPrerequisites: { label: string; count: number }[];
  // Working days — see computeStageDelays.
  delay: StageDelays;
  // Post Construction's "Cumulative Reason for Delay", same as the Task
  // Based Report: per category, checklist items not cleared + DPRs that
  // picked it. Only categories with something in them.
  cumulativeReasons: { label: string; fromChecklist: number; fromDpr: number }[];
}

export interface DprActivityReport {
  rows: DprActivityRow[];
  tasks: DprActivityTask[];
  overallForecast: ProgressForecast | null;
  taskCount: number;
  // Average progress across every flowchart task (not started = 0%).
  cumulativePercent: number | null;
}

interface RawWork {
  name: string;
  code: string | null;
  project_id: string;
}

interface RawTaskType {
  name: string;
  default_duration_days: number;
}

interface RawEntry {
  task_id: string;
  report_date: string;
  percent_complete: number | null;
  dependency_categories: DprDependencyCategory[] | null;
  comment_preset: DprCommentPreset | null;
  comment_text: string | null;
}

interface RawTaskRow {
  id: string;
  task_id: string;
  task_name: string;
  planned_start_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  status: string | null;
  due_date: string | null;
  current_due_date: string | null;
  work: RawWork | RawWork[] | null;
  task_type?: RawTaskType | RawTaskType[] | null;
  dpr_entries?: RawEntry[] | null;
  dependency_items?: { category: string; completion: { status: string } | { status: string }[] | null }[] | null;
}

function normalizeToOne<T>(raw: T | T[] | null): T | null {
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

const REPORT_SELECT = `
  id, task_id, task_name, status, planned_start_date, actual_start_date, actual_end_date, due_date, current_due_date,
  work:works!inner(name, code, project_id),
  task_type:task_types(name, default_duration_days),
  dpr_entries(task_id, report_date, percent_complete, dependency_categories, comment_preset, comment_text),
  dependency_items(category, completion:dependency_completions(status))
`;

function daysFromTo(from: string, to: string): number {
  return daysBetweenInclusive({ from, to }) - 1;
}

export function computeForecast(percentDone: number, asOfDate: string, startDate: string, scheduledEndDate: string | null): ProgressForecast {
  const daysElapsed = Math.max(1, daysBetweenInclusive({ from: startDate, to: asOfDate }));
  const remainingPercent = Math.max(0, Math.round((100 - percentDone) * 10) / 10);
  const rate = percentDone / daysElapsed;
  const daysRemaining = remainingPercent === 0 ? 0 : rate > 0 ? Math.ceil(remainingPercent / rate) : null;
  const forecastEndDate = daysRemaining == null ? null : addDaysUtc(asOfDate, daysRemaining);
  const varianceDays = forecastEndDate && scheduledEndDate ? daysFromTo(scheduledEndDate, forecastEndDate) : null;
  return { percentDone, asOfDate, startDate, daysElapsed, remainingPercent, daysRemaining, forecastEndDate, scheduledEndDate, varianceDays };
}

const PREREQUISITE_CATEGORIES = ['architect', 'client', 'consultant', 'contractor', 'procurement'] as const;
const DONE_STATUSES = new Set(['YES', 'PROCEED']);

// Every prerequisite item that isn't YES/PROCEED — PENDING, ON_HOLD, NO,
// REVISIONS, or never filled in — counts as not done.
function checklistSummary(r: RawTaskRow) {
  const counts = new Map<string, number>();
  let done = 0;
  let total = 0;
  for (const item of r.dependency_items ?? []) {
    if (!(PREREQUISITE_CATEGORIES as readonly string[]).includes(item.category)) continue;
    total++;
    if (DONE_STATUSES.has(normalizeToOne(item.completion)?.status ?? '')) done++;
    else counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  const pending = PREREQUISITE_CATEGORIES.filter((c) => counts.has(c)).map((c) => ({ label: CATEGORY_LABEL[c], count: counts.get(c) ?? 0 }));
  return { checklist: { done, total }, pending, counts };
}

// Sum of the day percents up to `asOf` (capped at 100) — each DPR is THAT
// day's share of the work, the DPR screen's own model — and the day the
// running total first reached 100%.
export function cumulativeProgress(history: { date: string; percent: number | null }[], asOf: string): { percent: number; reached100On: string | null } {
  let sum = 0;
  let reached100On: string | null = null;
  for (const h of history) {
    if (h.date > asOf) break;
    sum += h.percent ?? 0;
    if (reached100On == null && sum >= 100) reached100On = h.date;
  }
  return { percent: Math.min(100, Math.round(sum * 10) / 10), reached100On };
}

const STAGE_ORDER: Record<TaskStage, number> = { 'pre-construction': 0, construction: 1, 'post-construction': 2 };

function buildTask(r: RawTaskRow, range: DateRange, asOf: string, blocked: Set<string>): DprActivityTask {
  const work = normalizeToOne(r.work);
  const workName = work?.name ?? 'Unassigned';
  const plannedStart = r.planned_start_date?.slice(0, 10) ?? null;
  const due = (r.current_due_date ?? r.due_date)?.slice(0, 10) ?? null;
  const dprs = [...(r.dpr_entries ?? [])].filter((e) => e.report_date <= asOf).sort((a, b) => a.report_date.localeCompare(b.report_date));

  const entries: DprActivityRow[] = dprs
    .filter((e) => e.report_date >= range.from && e.report_date <= range.to)
    .reverse()
    .map((e) => ({
      taskId: r.id,
      taskCode: r.task_id,
      taskName: r.task_name,
      workName,
      reportDate: e.report_date,
      percentComplete: e.percent_complete,
      dependencyCategories: e.dependency_categories ?? [],
      commentPreset: e.comment_preset,
      commentText: e.comment_text,
    }));

  const progress = cumulativeProgress(
    dprs.map((e) => ({ date: e.report_date, percent: e.percent_complete })),
    asOf
  );
  const actualStart = r.actual_start_date?.slice(0, 10) ?? null;
  const actualEnd = r.actual_end_date?.slice(0, 10) ?? null;
  // Started = the Actual Start entered (once it's reached), else the first
  // DPR. Finished = Completed with an Actual End (once reached), else the day
  // the DPRs added up to 100%. An Actual End on a task that isn't Completed
  // is ignored — the DPRs say it's still going.
  const started = (actualStart && actualStart <= asOf ? actualStart : null) ?? dprs[0]?.report_date ?? null;
  const finishedOn = (r.status === 'completed' && actualEnd && actualEnd <= asOf ? actualEnd : null) ?? progress.reached100On;
  const percent = finishedOn ? 100 : progress.percent;

  const { checklist, pending, counts } = checklistSummary(r);
  const stage: TaskStage = finishedOn ? 'post-construction' : started && checklist.done >= checklist.total ? 'construction' : 'pre-construction';

  let forecast: ProgressForecast;
  if (started) {
    const lastDay = finishedOn ?? dprs[dprs.length - 1]?.report_date ?? asOf;
    forecast = computeForecast(percent, lastDay, started <= lastDay ? started : lastDay, due);
  } else {
    // Not started — an empty bar with the planned duration still to go.
    const plannedDays = plannedStart && due ? Math.max(1, daysBetweenInclusive({ from: plannedStart, to: due })) : null;
    forecast = { percentDone: 0, asOfDate: asOf, startDate: plannedStart ?? asOf, daysElapsed: 0, remainingPercent: 100, daysRemaining: plannedDays, forecastEndDate: null, scheduledEndDate: due, varianceDays: null };
  }

  const delay = computeStageDelays({ plannedStart, due, actualStart: started, actualEnd: finishedOn, cumulativePercent: percent, asOf, blocked });

  const dprCounts = new Map<string, number>();
  for (const e of dprs) for (const c of e.dependency_categories ?? []) dprCounts.set(c, (dprCounts.get(c) ?? 0) + 1);
  const cumulativeReasons = DPR_DEPENDENCY_CATEGORIES.map((c) => ({
    label: DPR_DEPENDENCY_LABEL[c],
    fromChecklist: counts.get(c === 'vendor' ? 'procurement' : c) ?? 0,
    fromDpr: dprCounts.get(c) ?? 0,
  })).filter((x) => x.fromChecklist + x.fromDpr > 0);

  return {
    taskId: r.id,
    taskCode: r.task_id,
    taskName: r.task_name,
    workName,
    taskType: (() => {
      const t = normalizeToOne(r.task_type ?? null);
      return t ? { name: t.name, days: t.default_duration_days } : null;
    })(),
    entries,
    forecast,
    stage,
    plannedStartDate: plannedStart,
    plannedEndDate: due,
    actualStartDate: started,
    actualEndDate: finishedOn,
    checklist,
    pendingPrerequisites: pending,
    delay,
    cumulativeReasons,
  };
}

// PostgREST caps a single response at 1000 rows — same pagination
// convention as every other report fetch in this app.
const PAGE_SIZE = 1000;

export async function fetchDprActivityReport(projectId: string, range: DateRange): Promise<DprActivityReport> {
  const all: RawTaskRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('tasks')
      .select(REPORT_SELECT)
      .eq('work.project_id', projectId)
      .is('deleted_at', null)
      // Same set the flowchart shows.
      .eq('hidden_from_flowchart', false)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as RawTaskRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  const asOf = reportAsOfDate(range);
  const years = new Set<number>([Number(asOf.slice(0, 4))]);
  for (const r of all) {
    for (const d of [r.planned_start_date, r.due_date, r.current_due_date, r.actual_start_date]) if (d) years.add(Number(d.slice(0, 4)));
  }
  const blocked = await fetchBlockedDates(years);

  const tasks = all
    .filter((r) => isPilotVisible(r.task_id, normalizeToOne(r.work)?.code))
    .map((r) => buildTask(r, range, asOf, blocked))
    .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.taskCode.localeCompare(b.taskCode));

  const rows = tasks.flatMap((t) => t.entries).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || a.taskCode.localeCompare(b.taskCode));

  const cumulativePercent =
    tasks.length > 0 ? Math.round((tasks.reduce((sum, t) => sum + (t.forecast?.percentDone ?? 0), 0) / tasks.length) * 10) / 10 : null;
  let overallForecast: ProgressForecast | null = null;
  const startedTasks = tasks.filter((t) => t.actualStartDate);
  if (cumulativePercent != null && startedTasks.length > 0) {
    const start = startedTasks.reduce((m, t) => ((t.actualStartDate as string) < m ? (t.actualStartDate as string) : m), startedTasks[0].actualStartDate as string);
    const dues = tasks.map((t) => t.plannedEndDate).filter((d): d is string => d != null);
    const due = dues.length > 0 ? dues.reduce((m, d) => (d > m ? d : m)) : null;
    overallForecast = computeForecast(cumulativePercent, asOf, start, due);
  }

  return { rows, tasks, overallForecast, taskCount: tasks.length, cumulativePercent };
}

// Days from `from` to `to` (negative when `to` is earlier) — used for
// "starts in N days" / "start delayed by N days" / "finished N days late".
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// "Today" for the report — the window's last day when looking at the past.
export function reportAsOfDate(range: DateRange): string {
  const today = todayKeyUtc();
  return range.to < today ? range.to : today;
}
