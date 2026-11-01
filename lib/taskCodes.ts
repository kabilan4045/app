import { supabase } from './supabase';

// Human-readable, sequential task IDs per project — TASK-001, TASK-002, ...
// — by explicit request, replacing the old `${workCode}-${6 digits}` /
// "MILE-01" codes that read as milestone ids rather than task ids.
// Existing tasks are renumbered once via scripts/backfill-task-codes.mjs,
// which uses this exact same format.
const TASK_CODE_RE = /^TASK-(\d+)$/;

export function formatTaskCode(n: number): string {
  return `TASK-${String(n).padStart(3, '0')}`;
}

function maxTaskNumber(codes: string[]): number {
  let max = 0;
  for (const c of codes) {
    const m = TASK_CODE_RE.exec(c);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

// Deleted tasks are counted too, so a code is never handed out twice.
export async function nextTaskCode(projectId: string): Promise<string> {
  const { data, error } = await supabase
    .from('tasks')
    .select('task_id, work:works!inner(project_id)')
    .eq('work.project_id', projectId)
    .like('task_id', 'TASK-%');
  if (error) throw new Error(error.message);
  return formatTaskCode(maxTaskNumber((data ?? []).map((r) => r.task_id as string)) + 1);
}

// Fallback when a per-project code collides (e.g. task_id turns out to be
// unique across ALL projects) — the next number after every project's max.
export async function nextGlobalTaskCode(): Promise<string> {
  const { data, error } = await supabase.from('tasks').select('task_id').like('task_id', 'TASK-%');
  if (error) throw new Error(error.message);
  return formatTaskCode(maxTaskNumber((data ?? []).map((r) => r.task_id as string)) + 1);
}

// Task-name keywords → which department they belong to. A department
// (works row) matches a group when its name or code contains any of the
// group's `dept` fragments — department names vary per project ("Civil
// Works", "Civil", "CIVIL"), so this matches loosely rather than exactly.
const DEPARTMENT_KEYWORDS: { dept: string[]; words: string[] }[] = [
  { dept: ['elect'], words: ['electric', 'wiring', 'cable', 'conduit', 'panel', 'lighting', 'light', 'earthing', 'switch', 'socket', 'transformer', 'dg set', 'generator'] },
  { dept: ['plumb'], words: ['plumb', 'pipe', 'piping', 'drain', 'sanitary', 'water supply', 'water line', 'sewer', 'toilet', 'tap', 'stp', 'sump', 'tank'] },
  { dept: ['hvac', 'mech'], words: ['hvac', 'duct', 'chiller', 'ventilation', 'air condition', 'ahu', 'fcu', 'vrf', 'exhaust', 'a/c'] },
  { dept: ['fire'], words: ['fire', 'sprinkler', 'hydrant', 'smoke'] },
  { dept: ['interior', 'finish'], words: ['paint', 'tile', 'tiling', 'flooring', 'false ceiling', 'ceiling', 'carpentry', 'door', 'window', 'granite', 'marble', 'putty', 'gypsum', 'joinery'] },
  { dept: ['civil'], words: ['pcc', 'rcc', 'concrete', 'column', 'beam', 'slab', 'footing', 'excavation', 'brick', 'block', 'plaster', 'masonry', 'foundation', 'shuttering', 'casting', 'raft', 'plinth', 'backfill', 'waterproof', 'level'] },
];

export function suggestDepartmentId(taskName: string, works: { id: string; name: string; code: string }[]): string | null {
  const name = taskName.toLowerCase();
  if (name.trim().length < 3) return null;
  for (const group of DEPARTMENT_KEYWORDS) {
    if (!group.words.some((w) => name.includes(w))) continue;
    const match = works.find((w) => group.dept.some((d) => w.name.toLowerCase().includes(d) || w.code.toLowerCase().includes(d)));
    if (match) return match.id;
  }
  return null;
}
