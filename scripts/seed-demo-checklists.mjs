#!/usr/bin/env node
// Demo Pre Construction checklists for the time-based reports, where a task
// only moves into Construction once its checklist is fully cleared.
//
//   $env:SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."; node scripts/seed-demo-checklists.mjs
//   $env:SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."; node scripts/seed-demo-checklists.mjs --cleanup
//
// Tasks that already have DPRs (under way / finished): every prerequisite
//   item is marked YES — they can't be building without it.
// Tasks with no DPRs (not started): each blank item is randomly YES (~75%)
//   or PENDING, except the latest-planned task, which is fully cleared so
//   "ready to start" shows too. Items that already have a status are kept.
// Every row written is recorded in scripts/.seed-demo-checklists.json;
// --cleanup deletes the inserted rows and restores the updated ones.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const PROJECT_NAME_LIKE = '%ROAST%';
const PREREQUISITE_CATEGORIES = ['architect', 'client', 'consultant', 'contractor', 'procurement'];
const DONE = new Set(['YES', 'PROCEED']);
const YES_SHARE = 0.75;

const here = path.dirname(fileURLToPath(import.meta.url));
const ledgerPath = path.join(here, '.seed-demo-checklists.json');
const envLocal = fs.readFileSync(path.join(here, '../.env.local'), 'utf8');
const URL = envLocal.match(/^EXPO_PUBLIC_SUPABASE_URL=(.+)$/m)?.[1].trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY (and EXPO_PUBLIC_SUPABASE_URL in .env.local).');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const one = (v) => (Array.isArray(v) ? (v[0] ?? null) : v);

if (process.argv.includes('--cleanup')) {
  if (!fs.existsSync(ledgerPath)) {
    console.log('Nothing to clean up — no ledger file.');
    process.exit(0);
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  if (ledger.insertedItemIds.length) {
    const { error } = await db.from('dependency_completions').delete().in('item_id', ledger.insertedItemIds);
    if (error) throw new Error(error.message);
  }
  for (const u of ledger.updated) {
    const { error } = await db.from('dependency_completions').update({ status: u.oldStatus }).eq('id', u.id);
    if (error) throw new Error(error.message);
  }
  fs.unlinkSync(ledgerPath);
  console.log(`Removed ${ledger.insertedItemIds.length} checklist statuses; restored ${ledger.updated.length}.`);
  process.exit(0);
}
if (fs.existsSync(ledgerPath)) {
  console.error('Demo checklists already seeded — run with --cleanup first.');
  process.exit(1);
}

// Small seeded PRNG so a re-run after --cleanup gives the same demo data.
let seed = 20261029;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const { data: projects, error: projErr } = await db.from('projects').select('id, name').ilike('name', PROJECT_NAME_LIKE);
if (projErr) throw new Error(projErr.message);
if (!projects?.length) throw new Error(`No project matching ${PROJECT_NAME_LIKE}`);
const project = projects[0];

const { data: tasks, error } = await db
  .from('tasks')
  .select('id, task_id, planned_start_date, work:works!inner(project_id), dpr_entries(id), dependency_items(id, category, completion:dependency_completions(id, status))')
  .eq('work.project_id', project.id)
  .is('deleted_at', null)
  .order('planned_start_date', { ascending: true });
if (error) throw new Error(error.message);

const { data: members } = await db.from('project_users').select('user_id').eq('project_id', project.id);
const { data: engineers } = await db
  .from('user_profiles')
  .select('id')
  .in('role', ['site_engineer', 'senior_site_engineer'])
  .in('id', (members ?? []).map((m) => m.user_id));
if (!engineers?.length) throw new Error('No site engineers are assigned to this project.');

const notStarted = tasks.filter((t) => (t.dpr_entries ?? []).length === 0);
const lastNotStarted = notStarted[notStarted.length - 1]?.id;

const ledger = { insertedItemIds: [], updated: [] };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

try {
  for (const t of tasks) {
    const underWay = (t.dpr_entries ?? []).length > 0;
    const allClear = underWay || t.id === lastNotStarted;
    const stamp = `${(t.planned_start_date ?? new Date().toISOString()).slice(0, 10)}T09:00:00Z`;
    const inserts = [];
    let pending = 0;
    for (const item of t.dependency_items ?? []) {
      if (!PREREQUISITE_CATEGORIES.includes(item.category)) continue;
      const c = one(item.completion);
      if (c) {
        if (allClear && !DONE.has(c.status)) {
          const { error: uErr } = await db.from('dependency_completions').update({ status: 'YES' }).eq('id', c.id);
          if (uErr) throw new Error(uErr.message);
          ledger.updated.push({ id: c.id, oldStatus: c.status });
          save();
        } else if (!DONE.has(c.status)) pending++;
        continue;
      }
      const status = allClear || random() < YES_SHARE ? 'YES' : 'PENDING';
      if (status === 'PENDING') pending++;
      inserts.push({ item_id: item.id, status, completed_by: engineers[0].id, completed_at: stamp, updated_at: stamp, issue_date: stamp.slice(0, 10) });
    }
    if (inserts.length) {
      const { error: iErr } = await db.from('dependency_completions').insert(inserts);
      if (iErr) throw new Error(iErr.message);
      ledger.insertedItemIds.push(...inserts.map((r) => r.item_id));
      save();
    }
    console.log(`${t.task_id}  ${underWay ? 'under way ' : 'not started'}  ${pending === 0 ? 'checklist cleared' : `${pending} pending`}`);
  }
} finally {
  save();
}
console.log('Undo later with: node scripts/seed-demo-checklists.mjs --cleanup');
