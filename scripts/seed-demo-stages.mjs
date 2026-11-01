#!/usr/bin/env node
// Demo data for the Daily/Weekly/Monthly/Custom Status reports' Pre and
// Post Construction sections, for a client presentation (the existing
// seed-demo-dprs.mjs only ever produces Construction-stage tasks).
//
//   $env:SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."; node scripts/seed-demo-stages.mjs
//   $env:SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."; node scripts/seed-demo-stages.mjs --cleanup
//
// Post Construction: 2 untouched tasks get 5 DPRs over the last ~3 weeks
//   climbing to 100% (the last one 1 day ago, so Weekly shows it too).
// Pre Construction: 3 not-started tasks are made to start in 3/7/12 days
//   (planned dates shifted, duration kept) and get a few checklist
//   prerequisites marked PENDING (only items that had no status yet).
// Everything is recorded in scripts/.seed-demo-stages.json as it's
// written; --cleanup deletes the inserted rows and restores the original
// planned dates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const PROJECT_NAME_LIKE = '%ROAST%';
const POST_TASKS = 2;
const PRE_TASKS = 3;
const PRE_START_OFFSETS = [3, 7, 12];
const POST_DPR_PLAN = [
  [-24, 20],
  [-18, 45],
  [-12, 70],
  [-6, 90],
  [-1, 100],
];
const PENDING_CATEGORIES = ['architect', 'client', 'procurement', 'consultant'];

const here = path.dirname(fileURLToPath(import.meta.url));
const ledgerPath = path.join(here, '.seed-demo-stages.json');
const envLocal = fs.readFileSync(path.join(here, '../.env.local'), 'utf8');
const URL = envLocal.match(/^EXPO_PUBLIC_SUPABASE_URL=(.+)$/m)?.[1].trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY (and EXPO_PUBLIC_SUPABASE_URL in .env.local).');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const today = new Date().toISOString().slice(0, 10);
const addDays = (key, n) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const one = (v) => (Array.isArray(v) ? (v[0] ?? null) : v);

if (process.argv.includes('--cleanup')) {
  if (!fs.existsSync(ledgerPath)) {
    console.log('Nothing to clean up — no ledger file.');
    process.exit(0);
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  if (ledger.dprIds.length) {
    const { error } = await db.from('dpr_entries').delete().in('id', ledger.dprIds);
    if (error) throw new Error(error.message);
  }
  if (ledger.completionItemIds.length) {
    const { error } = await db.from('dependency_completions').delete().in('item_id', ledger.completionItemIds);
    if (error) throw new Error(error.message);
  }
  for (const t of ledger.shiftedTasks) {
    const { error } = await db.from('tasks').update({ planned_start_date: t.planned_start_date, due_date: t.due_date }).eq('id', t.id);
    if (error) throw new Error(error.message);
  }
  fs.unlinkSync(ledgerPath);
  console.log(`Removed ${ledger.dprIds.length} DPRs, ${ledger.completionItemIds.length} checklist statuses; restored ${ledger.shiftedTasks.length} tasks' dates.`);
  process.exit(0);
}
if (fs.existsSync(ledgerPath)) {
  console.error('Demo stages already seeded — run with --cleanup first.');
  process.exit(1);
}

const { data: projects, error: projErr } = await db.from('projects').select('id, name').ilike('name', PROJECT_NAME_LIKE);
if (projErr) throw new Error(projErr.message);
if (!projects?.length) throw new Error(`No project matching ${PROJECT_NAME_LIKE}`);
const project = projects[0];
console.log(`Project: ${project.name} (${project.id})`);

const tasks = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from('tasks')
    .select('id, task_id, task_name, status, assigned_to, planned_start_date, due_date, actual_start_date, actual_end_date, work:works!inner(name, project_id), dpr_entries(id), dependency_items(id, category, sort_order, completion:dependency_completions(status))')
    .eq('work.project_id', project.id)
    .is('deleted_at', null)
    .order('planned_start_date', { ascending: true, nullsFirst: false })
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  tasks.push(...data);
  if (data.length < 1000) break;
}

// Untouched = never started, never reported on, not completed.
const untouched = tasks.filter((t) => !t.actual_start_date && !t.actual_end_date && t.status !== 'completed' && (t.dpr_entries ?? []).length === 0);
if (untouched.length < POST_TASKS + PRE_TASKS) throw new Error(`Need ${POST_TASKS + PRE_TASKS} untouched tasks, found ${untouched.length}.`);

const { data: members } = await db.from('project_users').select('user_id').eq('project_id', project.id);
const { data: engineers } = await db
  .from('user_profiles')
  .select('id, full_name, role')
  .in('role', ['site_engineer', 'senior_site_engineer'])
  .in('id', (members ?? []).map((m) => m.user_id));
if (!engineers?.length) throw new Error('No site engineers are assigned to this project — add one first.');

const ledger = { dprIds: [], completionItemIds: [], shiftedTasks: [] };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

try {
  // Latest-planned untouched tasks become Pre Construction (dates shifted
  // to start soon); the earliest-planned ones become Post Construction.
  const preTasks = untouched.slice(-PRE_TASKS);
  const postTasks = untouched.slice(0, POST_TASKS);

  for (const [i, t] of preTasks.entries()) {
    const duration = t.planned_start_date && t.due_date ? Math.max(1, dayDiff(t.planned_start_date.slice(0, 10), t.due_date.slice(0, 10))) : 10;
    const start = addDays(today, PRE_START_OFFSETS[i % PRE_START_OFFSETS.length]);
    ledger.shiftedTasks.push({ id: t.id, planned_start_date: t.planned_start_date, due_date: t.due_date });
    save();
    const { error } = await db.from('tasks').update({ planned_start_date: start, due_date: addDays(start, duration) }).eq('id', t.id);
    if (error) throw new Error(error.message);

    // Leave the last pre task fully cleared, so "ready to start" shows too.
    const flagCount = i === preTasks.length - 1 ? 0 : 2 + i;
    const open = (t.dependency_items ?? [])
      .filter((d) => PENDING_CATEGORIES.includes(d.category) && !one(d.completion))
      .sort((a, b) => a.sort_order - b.sort_order)
      .slice(0, flagCount);
    for (const item of open) {
      const now = new Date().toISOString();
      const { error: cErr } = await db
        .from('dependency_completions')
        .insert({ item_id: item.id, status: 'PENDING', completed_by: engineers[0].id, completed_at: now, updated_at: now });
      if (cErr) throw new Error(cErr.message);
      ledger.completionItemIds.push(item.id);
      save();
    }
    console.log(`Pre   ${t.task_id}  ${t.task_name}  → starts ${start}, ${open.length} prerequisite(s) pending`);
  }

  for (const [i, t] of postTasks.entries()) {
    const engineer = engineers.some((e) => e.id === t.assigned_to) ? t.assigned_to : engineers[i % engineers.length].id;
    const rows = POST_DPR_PLAN.map(([offset, percent]) => {
      const date = addDays(today, offset - i);
      return {
        task_id: t.id,
        report_date: date,
        dependency_categories: percent === 70 ? ['vendor'] : [],
        dependency_other_text: null,
        comment_preset: percent === 45 ? 'awaiting_material_delivery' : null,
        comment_text: null,
        percent_complete: percent,
        targeted_workforce_per_day: 10,
        actual_workforce_per_day: 9,
        submitted_by: engineer,
        submitted_at: `${date}T12:30:00Z`,
        architect_comment: null,
        client_comment: null,
      };
    });
    const { data: inserted, error } = await db.from('dpr_entries').insert(rows).select('id');
    if (error) throw new Error(error.message);
    ledger.dprIds.push(...inserted.map((r) => r.id));
    save();
    console.log(`Post  ${t.task_id}  ${t.task_name}  → ${rows.length} DPRs, 100% on ${rows[rows.length - 1].report_date}`);
  }
} finally {
  save();
}
console.log('Undo later with: node scripts/seed-demo-stages.mjs --cleanup');
