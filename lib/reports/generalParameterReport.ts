import { supabase } from '../supabase';
import { fetchTaskReport, type TaskReportData } from './taskReport';
import { countWorkingDaysBetween, isWorkingDay, workingDaysBetween } from '../workingDays';
import {
  DPR_COMMENT_LABEL,
  DPR_DEPENDENCY_CATEGORIES,
  DPR_DEPENDENCY_LABEL,
  type DprCommentPreset,
  type DprDependencyCategory,
} from '../dprEntries';

// The "General Parameter" report (A-I from the spec, F/G not defined yet —
// see this feature's own discussion thread) — built on top of
// fetchTaskReport rather than a second fetch, since checklist completion
// (for "I. detailed prereq"/Contractor) and the upstream-delay-cause lookup
// (for "H") are identical data this screen already computes correctly.
// Mobile counterpart to admin-web's lib/data/general-parameter-report.ts —
// same formulas, same 'holidays' table, ported to this app's own
// workingDays.ts/date-string conventions instead of Prisma Dates.
export interface GeneralParameterReportData {
  base: TaskReportData;
  // E — inclusive working-day span from planned start to due date. Null if
  // either date is missing.
  plannedWorkingDays: number | null;
  // H, Type 1 (Preconstruction delay) — working days between planned start
  // and actual start (or today, if it still hasn't started) that the task
  // is behind on even beginning. 0 when it started on/before schedule.
  preconstructionDelayDays: number;
  // H, Type 2 (Construction delay) — only meaningful once actually started:
  // actual working days spent (actual start through actual end, or today if
  // still in progress) minus E. Null before the task has an actual start.
  constructionDelayDays: number | null;
  // I, Contractor — using the existing 'contractor' checklist category as
  // the real, available signal (there is no assigned-contractor-company
  // field anywhere in the schema). Null if this task's AC/AV classification
  // hides that category entirely.
  contractorChecklist: { done: number; total: number } | null;
  // 100% planned progress split evenly across every real working day
  // between planned start and due date (by explicit request) — day 1 of an
  // N-working-day task should read 100/N% expected-complete, day 2 should
  // read 200/N%, and so on up to 100% on the last day. Null if either date
  // is missing. Length equals plannedWorkingDays exactly.
  plannedDaySplit: { date: string; cumulativePercent: number }[] | null;
  // Manpower numbers summed across every real DPR entry for this task (not
  // just the most recent one), and whether the owning project's admin has
  // turned on showing them at all — the caller renders nothing for these
  // unless showWorkforceOnReport is true.
  targetedWorkforcePerDay: number | null;
  actualWorkforcePerDay: number | null;
  showWorkforceOnReport: boolean;
  // False means this task has never had a real "Submit DPR" pass (dpr_
  // entries.submitted_at) — a draft row with percent_complete/dependencies
  // autosaved but never formally submitted does NOT count, by explicit
  // request. The caller (GeneralParameterSection.tsx) renders a plain "No
  // DPR submitted for this task yet" state instead of any of the fields/
  // charts below whenever this is false, since those would otherwise show
  // 0%/100% pending/empty categories that read as real computed data rather
  // than "nothing has actually been reported yet."
  hasSubmittedDpr: boolean;
  // "Delay by Prerequisites" / "Reasons for Delays" — real, DPR-only data
  // now (was previously derived from checklist dependency_items, which a
  // task with no checklist template — e.g. a fresh test task — would never
  // have, permanently showing a sample fallback instead). Every DPR entry
  // ever submitted for this task contributes: each category picked in that
  // day's "Reason for Delay" chips increments that category's count by 1,
  // and lastComment is the most recent entry's comment among the entries
  // that picked it — so this genuinely grows as the site engineer submits
  // real DPRs, and only the 5 real DPR categories appear (no Manpower/
  // Material Shortage — those aren't things DPR actually collects).
  delayByCategory: { category: DprDependencyCategory; label: string; count: number; lastComment: string | null }[];
  // Sum of every DPR entry's own "% Work Done Today" for this task, capped
  // at 100 — the real, DPR-driven replacement for the Construction tab's
  // old fixed 45%/55% placeholder.
  cumulativePercentComplete: number;
  // Same real entries as cumulativePercentComplete, kept per-day — see its
  // own comment above.
  dailyProgress: { date: string; percentComplete: number }[];
  // Every real DPR entry for this task, oldest first, with its own full
  // fields (not just percentComplete) — the data behind the report's own
  // per-DPR selector, by explicit request: the report defaults to showing
  // every entry summed/combined together, but a real construction team
  // reviewing "did DPR 1 specifically look right" needs to isolate one
  // submission's own numbers, not just the running total.
  perDayEntries: {
    reportDate: string;
    percentComplete: number | null;
    targetedWorkforcePerDay: number | null;
    actualWorkforcePerDay: number | null;
    dependencyCategories: DprDependencyCategory[];
    commentLabel: string | null;
  }[];
  // Pre Construction's own "Task delayed by" figure, by explicit request —
  // an earned-progress shortfall, not a start-date slippage: a
  // plannedWorkingDays-day task should earn 100/plannedWorkingDays % on
  // every one of those working days (the same daily rate Construction's own
  // dailyRatePercent/DprTaskRow's own suggestedPerDay already use); whatever
  // real cumulativePercentComplete hasn't caught up to what today's date
  // implies it should be, converted back into a day-equivalent. Deliberately
  // a SEPARATE figure from preconstructionDelayDays above (which still
  // drives Post Construction's own Cumulative Delay section, untouched by
  // this request) — the two can legitimately disagree, e.g. a task that
  // started on time but is behind on daily output.
  progressDelayDays: number;
  // Actual End to SHOW: the real tasks.actual_end_date when set; otherwise,
  // once the DPRs add up to 100%, the last DPR's day on the actual-start
  // timeline (DPR N = Actual Start + (N-1) working days), by explicit
  // request — e.g. started 8 Sep, 4 DPRs at 25% -> 11 Sep. Null = not done.
  effectiveActualEndDate: string | null;
  // Post Construction's Cumulative Delay (Preconstruction + Construction =
  // Total) — see computeStageDelays.
  stageDelays: StageDelays;
}

function parseDateKeyUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
function toDateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Post Construction's Cumulative Delay, shared with the Daily/Weekly/
// Monthly/Custom reports (dprActivityReport.ts) so both always show the
// same numbers. Working days, as of `asOf` (today here):
//   pre — Planned Start → Actual Start (or asOf if not started yet).
//   construction — not started: 0. Finished: working days actually taken
//     beyond the planned working days. Open: the earned-progress shortfall
//     (expected-by-asOf % minus the DPRs' real %, in day-equivalents).
//   total — the two added together.
export interface StageDelays {
  preDays: number;
  constructionDays: number;
  totalDays: number;
}

export function computeStageDelays(input: {
  plannedStart: string | null;
  due: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  cumulativePercent: number;
  asOf: string;
  blocked: Set<string>;
}): StageDelays {
  const { plannedStart, due, actualStart, actualEnd, cumulativePercent, asOf, blocked } = input;
  const plannedWorkingDays = plannedStart && due ? countWorkingDaysBetween(parseDateKeyUtc(plannedStart), parseDateKeyUtc(due), blocked) : null;

  let preDays = 0;
  if (plannedStart) {
    const compareEnd = parseDateKeyUtc(actualStart ?? asOf);
    const start = parseDateKeyUtc(plannedStart);
    if (compareEnd > start) preDays = Math.max(0, workingDaysBetween(start, compareEnd, blocked));
  }

  let constructionDays = 0;
  if (actualStart && plannedWorkingDays) {
    if (actualEnd) {
      constructionDays = Math.max(0, countWorkingDaysBetween(parseDateKeyUtc(actualStart), parseDateKeyUtc(actualEnd), blocked) - plannedWorkingDays);
    } else if (plannedStart) {
      const elapsed = Math.min(plannedWorkingDays, countWorkingDaysBetween(parseDateKeyUtc(plannedStart), parseDateKeyUtc(asOf), blocked));
      const dailyRatePercent = 100 / plannedWorkingDays;
      const shortfall = Math.max(0, elapsed * dailyRatePercent - cumulativePercent);
      constructionDays = Math.round((shortfall / dailyRatePercent) * 10) / 10;
    }
  }
  return { preDays, constructionDays, totalDays: Math.round((preDays + constructionDays) * 10) / 10 };
}

export async function fetchBlockedDates(years: Set<number>): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (years.size === 0) return blocked;
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const { data, error } = await supabase
    .from('holidays')
    .select('date')
    .gte('date', `${minYear}-01-01`)
    .lte('date', `${maxYear}-12-31`);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as { date: string }[]) blocked.add(row.date);
  return blocked;
}

export async function fetchGeneralParameterReport(taskId: string, projectId: string): Promise<GeneralParameterReportData | null> {
  const base = await fetchTaskReport(taskId, projectId);
  if (!base) return null;

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayKey = toDateKeyUtc(today);

  const relevantKeys = [base.plannedStartDate, base.dueDate, base.actualStartDate, base.actualEndDate, todayKey].filter(
    (d): d is string => d != null
  );
  const years = new Set(relevantKeys.map((k) => parseDateKeyUtc(k).getUTCFullYear()));
  const blocked = await fetchBlockedDates(years);

  const plannedWorkingDays =
    base.plannedStartDate && base.dueDate
      ? countWorkingDaysBetween(parseDateKeyUtc(base.plannedStartDate), parseDateKeyUtc(base.dueDate), blocked)
      : null;

  let preconstructionDelayDays = 0;
  if (base.plannedStartDate) {
    const plannedStart = parseDateKeyUtc(base.plannedStartDate);
    const compareEndKey = base.actualStartDate ?? todayKey;
    const compareEnd = parseDateKeyUtc(compareEndKey);
    if (compareEnd > plannedStart) {
      preconstructionDelayDays = Math.max(0, workingDaysBetween(plannedStart, compareEnd, blocked));
    }
  }

  let constructionDelayDays: number | null = null;
  if (base.actualStartDate && plannedWorkingDays != null) {
    const actualStart = parseDateKeyUtc(base.actualStartDate);
    const compareEndKey = base.actualEndDate ?? todayKey;
    const compareEnd = parseDateKeyUtc(compareEndKey);
    const actualWorkingDaysTaken = countWorkingDaysBetween(actualStart, compareEnd, blocked);
    constructionDelayDays = Math.max(0, actualWorkingDaysTaken - plannedWorkingDays);
  }

  const contractorEntry = base.departmentCompletion.find((d) => d.category === 'contractor');
  const contractorChecklist = contractorEntry ? { done: contractorEntry.done, total: contractorEntry.total } : null;

  let plannedDaySplit: { date: string; cumulativePercent: number }[] | null = null;
  if (base.plannedStartDate && base.dueDate) {
    const workingDates: string[] = [];
    const cursor = parseDateKeyUtc(base.plannedStartDate);
    const end = parseDateKeyUtc(base.dueDate);
    while (cursor <= end) {
      if (isWorkingDay(cursor, blocked)) workingDates.push(toDateKeyUtc(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const n = workingDates.length;
    plannedDaySplit = workingDates.map((date, i) => ({ date, cumulativePercent: Math.round(((i + 1) / n) * 100) }));
  }

  const [{ data: projectRow }, { count: submittedDprCount }, { data: allEntries }] = await Promise.all([
    supabase.from('projects').select('show_workforce_on_report').eq('id', projectId).maybeSingle(),
    supabase.from('dpr_entries').select('id', { count: 'exact', head: true }).eq('task_id', taskId).not('submitted_at', 'is', null),
    supabase
      .from('dpr_entries')
      .select('report_date, dependency_categories, comment_preset, comment_text, percent_complete, targeted_workforce_per_day, actual_workforce_per_day')
      .eq('task_id', taskId)
      .order('report_date', { ascending: false }),
  ]);

  interface AllEntryRow {
    report_date: string;
    dependency_categories: DprDependencyCategory[] | null;
    comment_preset: DprCommentPreset | null;
    comment_text: string | null;
    percent_complete: number | null;
    targeted_workforce_per_day: number | null;
    actual_workforce_per_day: number | null;
  }
  const typedEntries = (allEntries ?? []) as AllEntryRow[];

  const delayByCategory = DPR_DEPENDENCY_CATEGORIES.map((category) => {
    let count = 0;
    let lastComment: string | null = null;
    for (const row of typedEntries) {
      if (!(row.dependency_categories ?? []).includes(category)) continue;
      count += 1;
      // allEntries is already sorted newest-first, so the first match found
      // is the most recent one — never overwritten by an older row.
      if (lastComment === null && row.comment_preset) {
        lastComment = row.comment_preset === 'other' ? row.comment_text : DPR_COMMENT_LABEL[row.comment_preset];
      }
    }
    return { category, label: DPR_DEPENDENCY_LABEL[category], count, lastComment };
  });

  // Real cumulative completion — every DPR entry's own "% Work Done Today"
  // summed together (that field is already defined as a share of the
  // task's 100% total, see DprTaskRow.tsx's own percentComplete comment),
  // capped at 100. Replaces the Construction tab's previous fixed 45%/55%
  // placeholder split.
  const cumulativePercentComplete = Math.min(
    100,
    typedEntries.reduce((sum, row) => sum + (row.percent_complete ?? 0), 0)
  );

  // Same real per-entry rows as cumulativePercentComplete above, just kept
  // per-day instead of summed — Construction's own "Work in progress" stat
  // shows the real daily breakdown alongside the cumulative %, by explicit
  // request, rather than the aggregate number alone. Oldest first (allEntries
  // itself is newest-first).
  const dailyProgress = typedEntries
    .filter((row) => row.percent_complete != null)
    .map((row) => ({ date: row.report_date, percentComplete: row.percent_complete as number }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Every real entry, its own full fields — the per-DPR selector's own data
  // (see GeneralParameterReportData.perDayEntries' own comment). Oldest
  // first, same as dailyProgress above (allEntries itself is newest-first).
  const perDayEntries = [...typedEntries]
    .sort((a, b) => a.report_date.localeCompare(b.report_date))
    .map((row) => ({
      reportDate: row.report_date,
      percentComplete: row.percent_complete,
      targetedWorkforcePerDay: row.targeted_workforce_per_day,
      actualWorkforcePerDay: row.actual_workforce_per_day,
      dependencyCategories: row.dependency_categories ?? [],
      commentLabel: row.comment_preset ? (row.comment_preset === 'other' ? row.comment_text : DPR_COMMENT_LABEL[row.comment_preset]) : null,
    }));

  // Targeted/Actual Workforce — summed across every real DPR entry, by
  // explicit correction (was just the single most recent entry's own
  // numbers). null only when NOT ONE entry has ever logged a workforce
  // number, so "Not logged" still means that, not zero.
  const workforceEntries = typedEntries.filter((row) => row.targeted_workforce_per_day != null || row.actual_workforce_per_day != null);
  const targetedWorkforcePerDay =
    workforceEntries.length > 0 ? workforceEntries.reduce((sum, row) => sum + (row.targeted_workforce_per_day ?? 0), 0) : null;
  const actualWorkforcePerDay =
    workforceEntries.length > 0 ? workforceEntries.reduce((sum, row) => sum + (row.actual_workforce_per_day ?? 0), 0) : null;

  // See progressDelayDays' own doc comment above — 0 whenever real progress
  // is already at or ahead of what today's date implies it should be.
  let progressDelayDays = 0;
  if (base.plannedStartDate && plannedWorkingDays && plannedWorkingDays > 0) {
    const plannedStart = parseDateKeyUtc(base.plannedStartDate);
    const elapsedWorkingDays = Math.min(plannedWorkingDays, countWorkingDaysBetween(plannedStart, today, blocked));
    const dailyRatePercent = 100 / plannedWorkingDays;
    const expectedPercent = elapsedWorkingDays * dailyRatePercent;
    const percentShortfall = Math.max(0, expectedPercent - cumulativePercentComplete);
    progressDelayDays = Math.round((percentShortfall / dailyRatePercent) * 10) / 10;
  }

  let effectiveActualEndDate: string | null = base.actualEndDate;
  if (!effectiveActualEndDate && cumulativePercentComplete >= 100 && base.actualStartDate && dailyProgress.length > 0) {
    const cursor = parseDateKeyUtc(base.actualStartDate);
    let remaining = dailyProgress.length - 1;
    while (remaining > 0) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) remaining--;
    }
    effectiveActualEndDate = toDateKeyUtc(cursor);
  }

  const stageDelays = computeStageDelays({
    plannedStart: base.plannedStartDate,
    due: base.dueDate,
    actualStart: base.actualStartDate,
    actualEnd: effectiveActualEndDate,
    cumulativePercent: cumulativePercentComplete,
    asOf: todayKey,
    blocked,
  });

  return {
    effectiveActualEndDate,
    stageDelays,
    base,
    plannedWorkingDays,
    preconstructionDelayDays,
    constructionDelayDays,
    contractorChecklist,
    plannedDaySplit,
    targetedWorkforcePerDay,
    actualWorkforcePerDay,
    showWorkforceOnReport: (projectRow as { show_workforce_on_report: boolean } | null)?.show_workforce_on_report ?? false,
    hasSubmittedDpr: (submittedDprCount ?? 0) > 0,
    delayByCategory,
    cumulativePercentComplete,
    dailyProgress,
    perDayEntries,
    progressDelayDays,
  };
}
