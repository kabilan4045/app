import { esc, page } from './projectPrintouts';
import { formatDateLabel, formatDayLabel, type DateRange } from './dateRange';
import { DPR_COMMENT_LABEL, DPR_DEPENDENCY_LABEL } from '../dprEntries';
import { dayDiff, TASK_STAGE_LABEL, type DprActivityReport, type DprActivityRow, type DprActivityTask, type ProgressForecast, type TaskStage } from './dprActivityReport';

// Daily/Weekly/Monthly/Custom Status as an A4 printout — the same task
// cards + cumulative rollup activity-report.tsx shows, as plain HTML so it
// goes through projectPrintouts.ts's downloadPrintout (web print window /
// Android folder save / iOS share sheet).

export type ForecastTone = 'normal' | 'late' | 'ok';

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

// The two labels under the progress bar — done % (days taken) on the left,
// remaining % (days still needed) on the right. Shared with
// activity-report.tsx so the screen and the PDF never word them differently.
export interface BarLabel {
  pct: string;
  days: string | null;
}

export function barLabels(f: ProgressForecast): { done: BarLabel; remaining: BarLabel } {
  const done = { pct: `${f.percentDone}%`, days: `(${days(f.daysElapsed)})` };
  if (f.remainingPercent === 0) return { done, remaining: { pct: 'Completed', days: null } };
  if (f.percentDone === 0) return { done, remaining: { pct: 'Not started', days: f.daysRemaining == null ? null : `(${days(f.daysRemaining)} planned)` } };
  return { done, remaining: { pct: `${f.remainingPercent}%`, days: `(${f.daysRemaining == null ? 'no rate yet' : `~${days(f.daysRemaining)}`})` } };
}

// Working-day figure, written like the Task Based Report ("26d").
const wd = (n: number) => `${n}d`;

// The line under a task card's bar — the same Pre + Construction = Total
// split as the tracker and the Task Based Report, plus the forecast finish.
export function taskDelayStatus(task: DprActivityTask): { text: string; tone: ForecastTone } {
  const { preDays, constructionDays, totalDays } = task.delay;
  const plannedEnd = task.plannedEndDate ? `Planned end ${formatDateLabel(task.plannedEndDate)}` : 'No planned end date';
  const expected = task.forecast?.forecastEndDate ? ` · Expected ${formatDateLabel(task.forecast.forecastEndDate)}` : '';
  if (totalDays > 0) {
    return { text: `Delayed ${wd(totalDays)} (Pre ${wd(preDays)} + Construction ${wd(constructionDays)}) · ${plannedEnd}${expected}`, tone: 'late' };
  }
  return { text: `On schedule · ${plannedEnd}${expected}`, tone: 'ok' };
}

// One line under the bar: on plan, or how many days late vs the planned end.
export function scheduleStatus(f: ProgressForecast): { text: string; tone: ForecastTone } {
  if (f.scheduledEndDate == null) return { text: 'No planned end date set', tone: 'normal' };
  if (f.varianceDays == null) return { text: `Planned end ${formatDateLabel(f.scheduledEndDate)} — not enough progress yet to forecast`, tone: 'normal' };
  if (f.varianceDays > 0) {
    return {
      text: `Delayed by ${days(f.varianceDays)} — planned end ${formatDateLabel(f.scheduledEndDate)}, now expected ${formatDateLabel(f.forecastEndDate)}`,
      tone: 'late',
    };
  }
  return { text: `Going as per planned dates — planned end ${formatDateLabel(f.scheduledEndDate)}`, tone: 'ok' };
}

export const STAGE_COLOR: Record<TaskStage, { fg: string; bg: string }> = {
  'pre-construction': { fg: '#B45309', bg: '#FEF3C7' },
  construction: { fg: '#1D4ED8', bg: '#DBEAFE' },
  'post-construction': { fg: '#047857', bg: '#D1FAE5' },
};

// The Pre → Construction → Post tracker on every card, by explicit request:
// where the task is now, the Pre Construction checklist whatever the
// stage, and each stage's delay — Post Construction is the total of the
// other two, same as the task report's Cumulative Delay.
export interface StageStep {
  stage: TaskStage;
  state: 'done' | 'current' | 'todo';
  note: string;
  tone: ForecastTone;
}

export function stageTrack(task: DprActivityTask): StageStep[] {
  const current = STAGE_ORDER_INDEX[task.stage];
  const state = (i: number): StageStep['state'] => (i < current ? 'done' : i === current ? 'current' : 'todo');
  const delayNote = (n: number, label: string) => (n > 0 ? `${label} ${wd(n)}` : 'On time');
  const { done, total } = task.checklist;
  const checklistNote = total === 0 ? 'No checklist' : done === total ? `Checklist ${done}/${total} ✓` : `Checklist ${done}/${total} · ${total - done} pending`;
  return [
    {
      stage: 'pre-construction',
      state: state(0),
      note: `${task.taskType ? `${task.taskType.name} · ${days(task.taskType.days)}\n` : ''}${checklistNote}\n${delayNote(task.delay.preDays, 'Delay')}`,
      tone: done < total || task.delay.preDays > 0 ? 'late' : 'ok',
    },
    {
      stage: 'construction',
      state: state(1),
      note: current < 1 ? 'Not started' : delayNote(task.delay.constructionDays, 'Delay'),
      tone: current < 1 ? 'normal' : task.delay.constructionDays > 0 ? 'late' : 'ok',
    },
    {
      stage: 'post-construction',
      state: state(2),
      // Only totalled once Pre and Construction are both fully complete.
      note: current < 2 ? 'Not calculated' : delayNote(task.delay.totalDays, 'Total delay'),
      tone: current < 2 ? 'normal' : task.delay.totalDays > 0 ? 'late' : 'ok',
    },
  ];
}

const STAGE_ORDER_INDEX: Record<TaskStage, number> = { 'pre-construction': 0, construction: 1, 'post-construction': 2 };

// Label/value rows for a Pre or Post Construction card (Construction uses
// the progress bar instead). `asOf` is the report's "today".
export function stageDetails(task: DprActivityTask, asOf: string): { label: string; value: string; tone: ForecastTone }[] {
  const rows: { label: string; value: string; tone: ForecastTone }[] = [];
  if (task.stage === 'pre-construction') {
    if (task.plannedStartDate) {
      const diff = dayDiff(asOf, task.plannedStartDate);
      rows.push({
        label: 'Planned start',
        value: `${formatDateLabel(task.plannedStartDate)} — ${diff > 0 ? `starts in ${days(diff)}` : diff === 0 ? 'starts today' : `start delayed by ${days(-diff)}`}`,
        tone: diff < 0 ? 'late' : 'normal',
      });
    } else {
      rows.push({ label: 'Planned start', value: 'Not set', tone: 'normal' });
    }
    rows.push({ label: 'Planned end', value: formatDateLabel(task.plannedEndDate), tone: 'normal' });
    if (task.actualStartDate) rows.push({ label: 'Actual start', value: `${formatDateLabel(task.actualStartDate)} — waiting on the checklist below`, tone: 'late' });
    rows.push(
      task.pendingPrerequisites.length > 0
        ? { label: 'Prerequisites pending', value: task.pendingPrerequisites.map((p) => `${p.label} ${p.count}`).join(' · '), tone: 'late' }
        : { label: 'Prerequisites', value: 'All cleared — ready to start', tone: 'ok' }
    );
  } else if (task.stage === 'post-construction') {
    rows.push({ label: 'Planned', value: `${formatDateLabel(task.plannedStartDate)} – ${formatDateLabel(task.plannedEndDate)}`, tone: 'normal' });
    rows.push({ label: 'Actual', value: `${formatDateLabel(task.actualStartDate)} – ${formatDateLabel(task.actualEndDate)}`, tone: 'normal' });
    // Cumulative Delay — same three rows (and numbers) as the Task Based
    // Report's Post Construction tab.
    const tone = (n: number): ForecastTone => (n > 0 ? 'late' : 'ok');
    const { preDays, constructionDays, totalDays } = task.delay;
    rows.push({ label: 'Preconstruction delay', value: `${wd(preDays)} (Planned Start − Actual Start)`, tone: tone(preDays) });
    rows.push({ label: 'Construction delay', value: `${wd(constructionDays)} (Actual Days − Planned Days)`, tone: tone(constructionDays) });
    rows.push({ label: 'Cumulative total', value: `${wd(totalDays)} (Preconstruction + Construction)`, tone: tone(totalDays) });
  }
  return rows;
}

// Post Construction's "Cumulative Reason for Delay" — checklist + DPR.
export function cumulativeReasonRows(task: DprActivityTask): { label: string; value: string }[] {
  return task.cumulativeReasons.map((r) => ({
    label: r.label,
    value: [r.fromChecklist > 0 ? `${r.fromChecklist} on checklist` : null, r.fromDpr > 0 ? `${r.fromDpr} in DPRs` : null].filter(Boolean).join(' · '),
  }));
}

// Only the DPR days that recorded a delay reason, newest first — no
// percentages, by explicit request (the bar above already shows progress).
export function delayReasonRows(entries: DprActivityRow[]): { date: string; reasons: string }[] {
  return entries
    .map((row) => ({ date: formatDayLabel(row.reportDate), reasons: entryNotes(row).join(' · ') }))
    .filter((r) => r.reasons.length > 0);
}

// Construction / Post cards: just the reason names, once each — the dates
// and detail are in the task's own report (tap the card).
export function delayReasonNames(entries: DprActivityRow[]): string[] {
  return [...new Set(entries.flatMap(entryNotes))];
}

export function entryNotes(row: DprActivityRow): string[] {
  return [
    ...row.dependencyCategories.map((c) => DPR_DEPENDENCY_LABEL[c]),
    ...(row.commentPreset ? [row.commentPreset === 'other' ? (row.commentText ?? 'Other') : DPR_COMMENT_LABEL[row.commentPreset]] : []),
  ];
}

const STYLE = `
  <style>
    .card { border: 1.5px solid #000; border-radius: 4px; padding: 4px 7px; margin-bottom: 4px; page-break-inside: avoid; }
    .card .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .card .name { font-size: 13px; font-weight: 800; }
    .card .meta { font-size: 10px; color: #6B7280; margin-top: 1px; }
    .card .meta b { color: #111827; }
    .card .pct { font-size: 15px; font-weight: 800; color: #059669; }
    .card .pct.late { color: #DC2626; }
    .bar { display: flex; height: 11px; border: 1.5px solid #0F1F33; border-radius: 3px; overflow: hidden; background: #fff; margin: 4px 0 1px; }
    .bar .fill { background: #059669; }
    .bar .fill.late { background: #DC2626; }
    .bar-labels .late { color: #DC2626; }
    .bar-labels { display: flex; text-align: center; font-size: 11px; font-weight: 800; color: #047857; }
    .bar-labels div { min-width: 30%; }
    .bar-labels small { display: inline !important; margin-left: 3px; }
    .bar-labels small { display: block; font-size: 9.5px; font-weight: 600; color: #4B5563; }
    .bar-labels .rem { color: #374151; }
    .track { display: flex; align-items: stretch; gap: 3px; margin: 7px 0 2px; }
    .track .step { flex: 1; border: 1px solid #E5E7EB; border-radius: 4px; padding: 3px 5px; color: #9CA3AF; }
    .track .step .t { font-size: 9.5px; font-weight: 800; }
    .track .step .n { font-size: 9px; font-weight: 600; color: #6B7280; margin-top: 1px; }
    .track .step .n.late { color: #DC2626; }
    .track .step .n.ok { color: #059669; }
    .track .arrow { align-self: center; font-size: 11px; color: #9CA3AF; }
    .stage-badge { display: inline-block; font-size: 9px; font-weight: 800; border-radius: 3px; padding: 1px 5px; margin-left: 4px; }
    .card table.details td { padding: 2px 6px 2px 0; font-size: 10.5px; color: #111827; font-weight: 600; }
    .card table.details td.k { width: 34mm; color: #6B7280; font-weight: 600; }
    .card table.details td.late { color: #DC2626; font-weight: 700; }
    .card table.details td.ok { color: #059669; font-weight: 700; }
    .status { font-size: 10px; margin-top: 1px; font-weight: 700; color: #4B5563; }
    .status.late { color: #DC2626; }
    .status.ok { color: #059669; }
    .reasons { margin-top: 3px; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
    .chip { font-size: 10px; font-weight: 700; color: #B91C1C; background: #FEE2E2; border-radius: 3px; padding: 1px 6px; }
    .reasons .k { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #9CA3AF; font-weight: 700; }
    .card td { padding: 3px 6px; font-size: 10.5px; }
    .card td.d { width: 18mm; color: #6B7280; font-weight: 600; }
    .card td.n { color: #374151; }
    .total { background: #171717; color: #fff; border-radius: 5px; padding: 10px 12px; margin-top: 4px; page-break-inside: avoid; }
    .total .k { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(255,255,255,0.55); font-weight: 700; }
    .total .v { font-size: 20px; font-weight: 800; margin: 2px 0; }
    .total .bar { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.6); }
    .total .bar .fill { background: #34D399; }
    .total .bar .fill.late { background: #F87171; }
    .total .bar-labels, .total .bar-labels .rem, .total .bar-labels small { color: rgba(255,255,255,0.85); }
    .total .status { color: rgba(255,255,255,0.85); }
    .total .status.late { color: #FCA5A5; }
    .total .status.ok { color: #6EE7B7; }
  </style>`;

function progressHtml(f: ProgressForecast, showStatus = true, statusOverride?: { text: string; tone: ForecastTone }): string {
  const labels = barLabels(f);
  const status = statusOverride ?? scheduleStatus(f);
  const done = Math.min(100, Math.max(0, f.percentDone));
  const label = (l: BarLabel, cls: string, flex: number) =>
    `<div class="${cls}" style="flex:${flex}">${esc(l.pct)}${l.days ? `<small>${esc(l.days)}</small>` : ''}</div>`;
  const late = status.tone === 'late' ? ' late' : '';
  return `<div class="bar"><div class="fill${late}" style="width:${done}%"></div></div>
    <div class="bar-labels">${done > 0 ? label(labels.done, late.trim(), done) : ''}${done < 100 ? label(labels.remaining, 'rem', 100 - done) : ''}</div>
    ${showStatus ? `<div class="status ${status.tone === 'normal' ? '' : status.tone}">${esc(status.text)}</div>` : ''}`;
}

function stageBadge(stage: TaskStage): string {
  const c = STAGE_COLOR[stage];
  return `<span class="stage-badge" style="color:${c.fg};background:${c.bg}">${esc(TASK_STAGE_LABEL[stage])}</span>`;
}

// Client's layout: stage badge, %, bar, delay line, reasons — nothing else.
function taskCard(task: DprActivityTask): string {
  const reasons = delayReasonNames(task.entries);
  return `<div class="card">
    <div class="head">
      <div>
        <div class="name">${esc(task.taskName)}</div>
        <div class="meta"><b>${esc(task.taskCode)}</b> · ${esc(task.workName)} ${stageBadge(task.stage)}</div>
      </div>
      ${task.forecast ? `<div class="pct${task.delay.totalDays > 0 ? ' late' : ''}">${task.forecast.percentDone}%</div>` : ''}
    </div>
    ${task.forecast ? progressHtml(task.forecast, true, taskDelayStatus(task)) : ''}
    ${
      task.stage === 'pre-construction'
        ? task.pendingPrerequisites.length > 0
          ? `<div class="reasons"><div class="k">Reasons for delay — checklist pending</div><div class="chips">${task.pendingPrerequisites
              .map((p) => `<span class="chip">${esc(p.label)} · ${p.count}</span>`)
              .join('')}</div></div>`
          : ''
        : reasons.length > 0
          ? `<div class="reasons"><div class="k">Reasons for delay</div><div class="chips">${reasons.map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div></div>`
          : ''
    }
  </div>`;
}

export function buildActivityReportPdfHtml(report: DprActivityReport, range: DateRange, projectName: string, title: string): string {
  return page(
    `${title} Report`,
    projectName,
    `${STYLE}
     <p class="sub">${esc(formatDateLabel(range.from))} – ${esc(formatDateLabel(range.to))} · ${report.taskCount} task${report.taskCount === 1 ? '' : 's'}</p>
     <h2>Task-Level Activity</h2>
     ${report.tasks.map((t) => taskCard(t)).join('')}`
  );
}
