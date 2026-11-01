#!/usr/bin/env node
// One-time renumbering of EXISTING tasks to the sequential TASK-### ids new
// tasks now get (lib/taskCodes.ts) — replaces old "MILE-01" / "CIVIL-123456"
// / "1a" codes. Numbered per project, in planned-start order.
//
//   $env:SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."; node scripts/backfill-task-codes.mjs           # dry run, prints the plan
//   $env:SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."; node scripts/backfill-task-codes.mjs --apply   # writes it
//   $env:SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."; node scripts/backfill-task-codes.mjs --undo    # restores the old codes
//
// Tasks already on a TASK-### code are left alone. Every old→new pair is
// written to scripts/.backfill-task-codes.json as it's applied; --undo puts
// them back. Only tasks.task_id (the display code) changes — tasks.id,
// which every other table links to, is untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ledgerPath = path.join(here, '.backfill-task-codes.json');
const envLocal = fs.readFileSync(path.join(here, '../.env.local'), 'utf8');
const URL = envLocal.match(/^EXPO_PUBLIC_SUPABASE_URL=(.+)$/m)?.[1].trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY (and EXPO_PUBLIC_SUPABASE_URL in .env.local).');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const TASK_CODE_RE = /^TASK-(\d+)$/;
const formatTaskCode = (n) => `TASK-${String(n).padStart(3, '0')}`;

if (process.argv.includes('--undo')) {
  if (!fs.existsSync(ledgerPath)) {
    console.log('Nothing to undo — no ledger file.');
    process.exit(0);
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  for (const { id, oldCode } of ledger) {
    const { error } = await db.from('tasks').update({ task_id: oldCode }).eq('id', id);
    if (error) throw new Error(`${id}: ${error.message}`);
  }
  fs.unlinkSync(ledgerPath);
  console.log(`Restored ${ledger.length} old task codes.`);
  process.exit(0);
}

const all = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from('tasks')
    .select('id, task_id, task_name, planned_start_date, work:works!inner(project_id, project:projects(name))')
    .order('id')
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  all.push(...data);
  if (data.length < 1000) break;
}

const byProject = new Map();
for (const t of all) {
  const work = Array.isArray(t.work) ? t.work[0] : t.work;
  const project = Array.isArray(work.project) ? work.project[0] : work.project;
  const list = byProject.get(work.project_id) ?? [];
  list.push({ ...t, projectName: project?.name ?? work.project_id });
  byProject.set(work.project_id, list);
}

const plan = [];
for (const tasks of byProject.values()) {
  let next = Math.max(0, ...tasks.map((t) => Number(TASK_CODE_RE.exec(t.task_id)?.[1] ?? 0))) + 1;
  tasks
    .filter((t) => !TASK_CODE_RE.test(t.task_id))
    .sort((a, b) => (a.planned_start_date ?? '9999').localeCompare(b.planned_start_date ?? '9999') || a.task_id.localeCompare(b.task_id))
    .forEach((t) => plan.push({ id: t.id, oldCode: t.task_id, newCode: formatTaskCode(next++), name: t.task_name, project: t.projectName }));
}

for (const p of plan) console.log(`${p.project.padEnd(24)} ${p.oldCode.padEnd(16)} → ${p.newCode}  ${p.name}`);
console.log(`\n${plan.length} task(s) to renumber across ${byProject.size} project(s).`);

if (!process.argv.includes('--apply')) {
  console.log('Dry run — re-run with --apply to write these.');
  process.exit(0);
}
if (fs.existsSync(ledgerPath)) {
  console.error('A previous renumbering ledger exists — run --undo first.');
  process.exit(1);
}

const done = [];
try {
  for (const p of plan) {
    const { error } = await db.from('tasks').update({ task_id: p.newCode }).eq('id', p.id);
    if (error) throw new Error(`${p.oldCode} → ${p.newCode}: ${error.message}`);
    done.push({ id: p.id, oldCode: p.oldCode });
  }
} finally {
  if (done.length > 0) fs.writeFileSync(ledgerPath, JSON.stringify(done, null, 2));
}
console.log(`Renumbered ${done.length} task(s). Undo with --undo.`);
