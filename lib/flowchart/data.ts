import { supabase } from '../supabase';
import { isPilotVisible } from '../pilot';
import { classifyAccountabilityType } from './accountability';
import { nextGlobalTaskCode, nextTaskCode } from '../taskCodes';
import type {
  AccountabilityType,
  DependencyType,
  FlowchartParallelEdge,
  FlowchartSeriesEdge,
  FlowchartTask,
  TaskTypeOption,
} from './types';

interface RawTaskRow {
  id: string;
  task_id: string;
  task_name: string;
  description: string | null;
  planned_start_date: string | null;
  due_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  current_planned_start_date: string | null;
  current_due_date: string | null;
  cascade_delay_days: number | null;
  accountability_type: AccountabilityType | null;
  task_type_id: string | null;
  manual_position_x: number | null;
  manual_position_y: number | null;
  hidden_from_flowchart: boolean;
  room_type: string | null;
  floor_level: string | null;
  milestone_id: string | null;
  work: { id: string; name: string; code: string; accountability_type: AccountabilityType | null } | null;
}

interface RawDependencyRow {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  type: DependencyType;
}

interface RawParallelLinkRow {
  id: string;
  task_a_id: string;
  task_b_id: string;
}

export interface FlowchartData {
  tasks: FlowchartTask[];
  seriesEdges: FlowchartSeriesEdge[];
  parallelEdges: FlowchartParallelEdge[];
  taskTypes: TaskTypeOption[];
}

const TASK_SELECT = `
  id, task_id, task_name, description, planned_start_date, due_date,
  actual_start_date, actual_end_date, current_planned_start_date, current_due_date,
  cascade_delay_days,
  accountability_type, task_type_id, manual_position_x, manual_position_y,
  hidden_from_flowchart, room_type, floor_level, milestone_id,
  work:works!inner(id, name, code, accountability_type, project_id)
`;

// Shared by fetchFlowchartData (bulk) and fetchTaskById (single-row, used by
// the undo/redo stack to re-fetch a task's full, join-resolved shape after
// restoring it from a delete snapshot) — one place that knows how a raw
// tasks-select row maps onto FlowchartTask, so the two never drift apart.
function mapRawTaskRow(t: RawTaskRow): FlowchartTask {
  return {
    id: t.id,
    taskId: t.task_id,
    taskName: t.task_name,
    description: t.description,
    plannedStartDate: t.planned_start_date,
    dueDate: t.due_date,
    actualStartDate: t.actual_start_date,
    actualEndDate: t.actual_end_date,
    currentPlannedStartDate: t.current_planned_start_date,
    currentDueDate: t.current_due_date,
    cascadeDelayDays: t.cascade_delay_days,
    accountabilityType: t.accountability_type,
    workAccountabilityType: t.accountability_type ?? t.work?.accountability_type ?? null,
    taskTypeId: t.task_type_id,
    workId: t.work?.id ?? null,
    workName: t.work?.name ?? 'Unassigned',
    manualPositionX: t.manual_position_x,
    manualPositionY: t.manual_position_y,
    roomType: t.room_type,
    floorLevel: t.floor_level,
    milestoneId: t.milestone_id,
  };
}

// Standalone — same task_types query fetchFlowchartData below bundles in
// with tasks/dependencies for the real Flowchart, but the Template Kit's
// task-creation popup (project-agnostic — a template isn't scoped to one
// project) only ever needs this one table, not the other three.
export async function fetchTaskTypes(): Promise<TaskTypeOption[]> {
  const { data, error } = await supabase
    .from('task_types')
    .select('id, name, default_duration_days')
    .order('default_duration_days', { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; name: string; default_duration_days: number }[])
    .map((t) => ({ id: t.id, name: t.name, defaultDurationDays: t.default_duration_days }));
}

// One fetch per table (tasks, task_dependencies, task_parallel_links,
// task_types), same "plain function wrapping supabase.from()" convention as
// fetchProjectTimeline (lib/projectTimeline.ts) — RLS does the real project
// scoping for all four (task_dependencies/task_parallel_links policies were
// added specifically for this feature, see admin-web/supabase/rls-policies.sql).
export async function fetchFlowchartData(projectId: string): Promise<FlowchartData> {
  const [tasksRes, depsRes, parallelRes, typesRes] = await Promise.all([
    supabase
      .from('tasks')
      .select(TASK_SELECT)
      .eq('work.project_id', projectId)
      .is('deleted_at', null),
    supabase.from('task_dependencies').select('id, task_id, depends_on_task_id, type'),
    supabase.from('task_parallel_links').select('id, task_a_id, task_b_id'),
    supabase.from('task_types').select('id, name, default_duration_days').order('default_duration_days', { ascending: true }),
  ]);

  if (tasksRes.error) throw new Error(tasksRes.error.message);
  if (depsRes.error) throw new Error(depsRes.error.message);
  if (parallelRes.error) throw new Error(parallelRes.error.message);
  if (typesRes.error) throw new Error(typesRes.error.message);

  // Pilot mode (lib/pilot.ts, mirrors admin-web's lib/config/pilot.ts):
  // client asked to scope every display surface down to only 12 Civil-work
  // tasks for now, everything else stays in the DB untouched but hidden.
  //
  // hidden_from_flowchart is a separate, narrower mechanism — flowchart
  // canvas ONLY (not DPR/Task List/Reports/admin-web, which all still show
  // every task normally). Used for ROAST @ Kokapet's own request: its 314
  // granular tasks are hidden here in favor of ~15 milestone-level tasks
  // meant just for this view (add-hidden-from-flowchart.sql).
  const rawTasks = ((tasksRes.data ?? []) as unknown as RawTaskRow[]).filter(
    (t) => isPilotVisible(t.task_id, t.work?.code) && !t.hidden_from_flowchart
  );
  const taskIds = new Set(rawTasks.map((t) => t.id));

  const tasks: FlowchartTask[] = rawTasks.map(mapRawTaskRow);

  // Edges are filtered to endpoints that survived the tasks query's own
  // project/deleted_at scoping — task_dependencies/task_parallel_links have
  // no project_id of their own, so this is what keeps a cross-project edge
  // (which shouldn't exist, but RLS + this both agree it never renders)
  // from ever appearing.
  const seriesEdges: FlowchartSeriesEdge[] = ((depsRes.data ?? []) as unknown as RawDependencyRow[])
    .filter((d) => taskIds.has(d.task_id) && taskIds.has(d.depends_on_task_id))
    .map((d) => ({ id: d.id, taskId: d.task_id, dependsOnTaskId: d.depends_on_task_id, type: d.type }));

  const parallelEdges: FlowchartParallelEdge[] = ((parallelRes.data ?? []) as unknown as RawParallelLinkRow[])
    .filter((p) => taskIds.has(p.task_a_id) && taskIds.has(p.task_b_id))
    .map((p) => ({ id: p.id, taskAId: p.task_a_id, taskBId: p.task_b_id }));

  const taskTypes: TaskTypeOption[] = ((typesRes.data ?? []) as { id: string; name: string; default_duration_days: number }[])
    .map((t) => ({ id: t.id, name: t.name, defaultDurationDays: t.default_duration_days }));

  return { tasks, seriesEdges, parallelEdges, taskTypes };
}

// Single-row counterpart to fetchFlowchartData's own tasks query — used by
// the undo/redo stack (lib/flowchart/undo.ts) to re-fetch a task's full,
// join-resolved shape (workName/workAccountabilityType) right after
// restoring its raw row from a delete snapshot, rather than hand-mapping
// those two derived fields a second time.
export async function fetchTaskById(taskId: string): Promise<FlowchartTask> {
  const { data, error } = await supabase.from('tasks').select(TASK_SELECT).eq('id', taskId).single();
  if (error) throw new Error(error.message);
  return mapRawTaskRow(data as unknown as RawTaskRow);
}

// ─── Mutations — all staff-only per the RLS write policies added alongside
// this feature (a client-role write is rejected by Postgres itself, not just
// hidden client-side; these calls surface that as a thrown error). ──────────

export async function updateTaskPosition(taskId: string, x: number, y: number): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update({ manual_position_x: x, manual_position_y: y })
    .eq('id', taskId);
  if (error) throw new Error(error.message);
}

export async function updateTaskType(taskId: string, taskTypeId: string | null): Promise<void> {
  const { error } = await supabase.from('tasks').update({ task_type_id: taskTypeId }).eq('id', taskId);
  if (error) throw new Error(error.message);
}

// The manual-override path for Part 4 of the Flowchart auto-classification
// feature — task creation sets this automatically (see createTask below),
// but a wrong guess or a no-match task can always be corrected afterward
// here. Passing null clears the override, falling back to the Work's own
// default (see mapRawTaskRow's workAccountabilityType resolution).
export async function updateTaskAccountabilityType(taskId: string, accountabilityType: AccountabilityType | null): Promise<void> {
  const { error } = await supabase.from('tasks').update({ accountability_type: accountabilityType }).eq('id', taskId);
  if (error) throw new Error(error.message);
}

// Same edit-dialog fields admin-web's Quick Edit exposes (Task Name,
// Description, Planned Start/End, Actual Start/End) — mirrored here so
// tapping a task on mobile can do the same edits, not a reduced set.
export async function updateTaskName(taskId: string, taskName: string): Promise<void> {
  const { error } = await supabase.from('tasks').update({ task_name: taskName }).eq('id', taskId);
  if (error) throw new Error(error.message);
}

// Department — the task's real Work assignment (id, name, code, badge
// color etc. all resolve from this), same field CreateTaskSheet's "Work *"
// picker sets at creation, made editable here too. Mandatory: unlike
// Room Type/Floor Level, TaskDetailSheet never lets this be cleared back
// to null.
export async function updateTaskWork(taskId: string, workId: string): Promise<void> {
  const { error } = await supabase.from('tasks').update({ work_id: workId }).eq('id', taskId);
  if (error) throw new Error(error.message);
}

// Room Type / Floor Level (ROOM_TYPE_PRESETS/FLOOR_LEVEL_PRESETS in
// lib/flowchart/types.ts) — plain preset tags on any task, editable from
// TaskDetailSheet same as every other field here.
export async function updateTaskRoomType(taskId: string, roomType: string | null): Promise<void> {
  const { error } = await supabase.from('tasks').update({ room_type: roomType }).eq('id', taskId);
  if (error) throw new Error(error.message);
}

export async function updateTaskFloorLevel(taskId: string, floorLevel: string | null): Promise<void> {
  const { error } = await supabase.from('tasks').update({ floor_level: floorLevel }).eq('id', taskId);
  if (error) throw new Error(error.message);
}

// "Push to Site Engineer" — the flowchart's own multi-select bulk action.
// Sets assigned_to (already a real column elsewhere in this app) plus a
// pushed-at/by pair, so DPR's own "Urgent" tab (fetchUrgentTasksForEngineer,
// lib/dprEntries.ts) can pick these up regardless of the task's actual
// scheduled date.
export async function pushTasksUrgent(taskIds: string[], assignedTo: string, pushedBy: string | null): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update({ assigned_to: assignedTo, urgent_pushed_at: new Date().toISOString(), urgent_pushed_by: pushedBy })
    .in('id', taskIds);
  if (error) throw new Error(error.message);
}

export async function updateTaskPlannedDates(
  taskId: string,
  plannedStartDate: string | null,
  dueDate: string | null
): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update({ planned_start_date: plannedStartDate, due_date: dueDate })
    .eq('id', taskId);
  if (error) throw new Error(error.message);
}

// NOTE: admin-web's own actual-date edit also triggers a server-side cascade
// (cascadePlannedDatesFromActualDelay in admin-web/app/actions/tasks.ts) that
// forward-shifts every downstream task's current_planned_start_date/
// current_due_date when a task runs late. This mobile write does NOT
// replicate that cascade — it's a substantial, separate algorithm, not a
// simple field mirror. Setting an actual date here updates this task only;
// downstream cascade_delay_days won't recompute until someone edits it (or
// this same field) from admin-web.
export async function updateTaskActualDate(
  taskId: string,
  field: 'actual_start_date' | 'actual_end_date',
  value: string | null
): Promise<void> {
  const { error } = await supabase.from('tasks').update({ [field]: value }).eq('id', taskId);
  if (error) throw new Error(error.message);
}

export async function createDependency(
  taskId: string,
  dependsOnTaskId: string,
  type: DependencyType
): Promise<FlowchartSeriesEdge> {
  const { data, error } = await supabase
    .from('task_dependencies')
    .insert({ task_id: taskId, depends_on_task_id: dependsOnTaskId, type })
    .select('id, task_id, depends_on_task_id, type')
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, taskId: data.task_id, dependsOnTaskId: data.depends_on_task_id, type: data.type };
}

export async function createParallelLink(taskAId: string, taskBId: string): Promise<FlowchartParallelEdge> {
  const { data, error } = await supabase
    .from('task_parallel_links')
    .insert({ task_a_id: taskAId, task_b_id: taskBId })
    .select('id, task_a_id, task_b_id')
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, taskAId: data.task_a_id, taskBId: data.task_b_id };
}

export async function deleteDependency(dependencyId: string): Promise<void> {
  const { error } = await supabase.from('task_dependencies').delete().eq('id', dependencyId);
  if (error) throw new Error(error.message);
}

export async function deleteParallelLink(linkId: string): Promise<void> {
  const { error } = await supabase.from('task_parallel_links').delete().eq('id', linkId);
  if (error) throw new Error(error.message);
}

// ─── Create Task ────────────────────────────────────────────────────────

export interface WorkOption {
  id: string;
  name: string;
  code: string;
}

export async function fetchWorksForProject(projectId: string): Promise<WorkOption[]> {
  const { data, error } = await supabase
    .from('works')
    .select('id, name, code')
    .eq('project_id', projectId)
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface DependencyTemplateEntry {
  category: string;
  label: string;
  sortOrder: number;
}

// Global, admin-editable checklist template (no per-project scoping) — the
// same table admin-web's createTaskCore reads from to auto-seed a new
// task's 6-category checklist, so a mobile-created task ends up with an
// identical starting checklist to one created on admin-web.
export async function fetchDependencyTemplate(): Promise<DependencyTemplateEntry[]> {
  const { data, error } = await supabase
    .from('dependency_template_items')
    .select('category, label, sort_order')
    .order('sort_order', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ category: r.category, label: r.label, sortOrder: r.sort_order }));
}

export interface CreateTaskInput {
  projectId: string;
  workId: string;
  workCode: string;
  taskName: string;
  description: string | null;
  taskTypeId: string;
  plannedStartDate: string;
  dueDate: string;
}

// taskId is the project's next sequential TASK-### code (see
// lib/taskCodes.ts). A unique-violation (another device created a task in
// the same moment, or task_id is unique across projects) retries once with
// the next code after every project's max.
export async function createTask(input: CreateTaskInput): Promise<FlowchartTask> {
  try {
    return await insertTask(input, await nextTaskCode(input.projectId));
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
    return insertTask(input, await nextGlobalTaskCode());
  }
}

async function insertTask(input: CreateTaskInput, taskId: string): Promise<FlowchartTask> {
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      task_id: taskId,
      task_name: input.taskName,
      project_name: input.workCode,
      description: input.description,
      task_type_id: input.taskTypeId,
      planned_start_date: input.plannedStartDate,
      due_date: input.dueDate,
      // Automatic AC/AV classification at creation (Part 4) — same
      // keyword match as admin-web's createTaskCore, so a task created on
      // either platform gets the identical AC/AV outcome. Left null
      // (never guessed) when neither or both lists match; a person can
      // always set/change it afterward via Edit Task.
      accountability_type: classifyAccountabilityType(input.taskName, input.description),
      work_id: input.workId,
      status: 'draft',
      // Task.updatedAt is `@updatedAt` in Prisma — a client-side ORM
      // timestamp, not a Postgres column default. A direct PostgREST
      // insert (this call) bypasses Prisma entirely, so it must be
      // supplied explicitly or the NOT NULL constraint rejects the row
      // outright (confirmed live while verifying this exact function).
      updated_at: new Date().toISOString(),
    })
    .select(`
      id, task_id, task_name, description, planned_start_date, due_date,
      actual_start_date, actual_end_date, current_planned_start_date, current_due_date,
      cascade_delay_days, accountability_type, task_type_id, manual_position_x, manual_position_y,
      work:works!inner(id, name, code, accountability_type, project_id)
    `)
    .single();
  if (error) throw Object.assign(new Error(error.message), { code: error.code });

  const work = Array.isArray(data.work) ? data.work[0] : data.work;
  return {
    id: data.id,
    taskId: data.task_id,
    taskName: data.task_name,
    description: data.description,
    plannedStartDate: data.planned_start_date,
    dueDate: data.due_date,
    actualStartDate: data.actual_start_date,
    actualEndDate: data.actual_end_date,
    currentPlannedStartDate: data.current_planned_start_date,
    currentDueDate: data.current_due_date,
    cascadeDelayDays: data.cascade_delay_days,
    accountabilityType: data.accountability_type,
    workAccountabilityType: data.accountability_type ?? work?.accountability_type ?? null,
    taskTypeId: data.task_type_id,
    workId: work?.id ?? input.workId,
    workName: work?.name ?? 'Unassigned',
    manualPositionX: data.manual_position_x,
    manualPositionY: data.manual_position_y,
    roomType: null,
    floorLevel: null,
    milestoneId: null,
  };
}

// Duplicate an existing task — by explicit request, dates are left BLANK on
// the copy (not carried over, since a duplicate is almost always meant for
// a different point in the schedule), while name/department/type/
// accountability carry over as-is. Status always resets to 'draft' (a copy
// hasn't started, regardless of the source's current status/actual dates).
// taskId generation matches createTask's own convention exactly — same
// workCode + last-6-digits-of-Date.now() scheme, not a separate one invented
// for copies. The caller (FlowchartCanvas's handleCopyTask) is responsible
// for seeding the standard checklist afterward via fetchDependencyTemplate +
// seedDependencyItems, same as any other freshly created task — this
// function only creates the task row itself.
export async function duplicateTask(sourceTaskId: string): Promise<FlowchartTask> {
  const { data: source, error: sourceErr } = await supabase
    .from('tasks')
    .select(`
      task_name, description, task_type_id, accountability_type, work_id,
      hidden_from_flowchart, manual_position_x, manual_position_y,
      work:works!inner(id, code)
    `)
    .eq('id', sourceTaskId)
    .single();
  if (sourceErr) throw new Error(sourceErr.message);
  const work = Array.isArray(source.work) ? source.work[0] : source.work;
  if (!work) throw new Error('Source task has no department to copy.');

  const taskId = `${work.code}-${Date.now().toString().slice(-6)}`;
  // Nudge the copy near the source rather than wherever safeLayout's
  // "brand new task" fallback would stack it — only when the source itself
  // has a real position; a source with no manual position yet just leaves
  // the copy null too, so it gets that same standard fallback placement.
  const hasSourcePosition = source.manual_position_x != null && source.manual_position_y != null;
  const manualPositionX = hasSourcePosition ? source.manual_position_x + 60 : null;
  const manualPositionY = hasSourcePosition ? source.manual_position_y + 60 : null;

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      task_id: taskId,
      task_name: source.task_name,
      project_name: work.code,
      description: source.description,
      task_type_id: source.task_type_id,
      accountability_type: source.accountability_type,
      work_id: source.work_id,
      hidden_from_flowchart: source.hidden_from_flowchart,
      manual_position_x: manualPositionX,
      manual_position_y: manualPositionY,
      status: 'draft',
      planned_start_date: null,
      due_date: null,
      // Task.updatedAt is `@updatedAt` in Prisma — a client-side ORM
      // timestamp, not a Postgres column default. A direct PostgREST
      // insert bypasses Prisma entirely, so it must be supplied explicitly
      // (same fix as createTask's own comment above).
      updated_at: new Date().toISOString(),
    })
    .select(`
      id, task_id, task_name, description, planned_start_date, due_date,
      actual_start_date, actual_end_date, current_planned_start_date, current_due_date,
      cascade_delay_days, accountability_type, task_type_id, manual_position_x, manual_position_y,
      work:works!inner(id, name, code, accountability_type, project_id)
    `)
    .single();
  if (error) throw new Error(error.message);

  const insertedWork = Array.isArray(data.work) ? data.work[0] : data.work;
  return {
    id: data.id,
    taskId: data.task_id,
    taskName: data.task_name,
    description: data.description,
    plannedStartDate: data.planned_start_date,
    dueDate: data.due_date,
    actualStartDate: data.actual_start_date,
    actualEndDate: data.actual_end_date,
    currentPlannedStartDate: data.current_planned_start_date,
    currentDueDate: data.current_due_date,
    cascadeDelayDays: data.cascade_delay_days,
    accountabilityType: data.accountability_type,
    workAccountabilityType: data.accountability_type ?? insertedWork?.accountability_type ?? null,
    taskTypeId: data.task_type_id,
    workId: insertedWork?.id ?? source.work_id,
    workName: insertedWork?.name ?? 'Unassigned',
    manualPositionX: data.manual_position_x,
    manualPositionY: data.manual_position_y,
    roomType: null,
    floorLevel: null,
    milestoneId: null,
  };
}

export async function seedDependencyItems(taskId: string, template: DependencyTemplateEntry[]): Promise<void> {
  if (template.length === 0) return;
  const { error } = await supabase.from('dependency_items').insert(
    template.map((t) => ({ task_id: taskId, category: t.category, item_label: t.label, sort_order: t.sortOrder }))
  );
  if (error) throw new Error(error.message);
}

// Hard delete, matching admin-web's own deleteTask exactly (a bare delete,
// not the separate soft-delete-only bulk "Delete All Tasks" path — see that
// feature's own history/warnings, unrelated to this single-task action).
// task_dependencies/task_parallel_links rows referencing this task cascade-
// delete automatically at the DB level (each has onDelete: Cascade on its
// FK), same as admin-web — no explicit edge cleanup needed here either.
export async function deleteTask(taskId: string): Promise<void> {
  const { error } = await supabase.from('tasks').delete().eq('id', taskId);
  if (error) throw new Error(error.message);
}
