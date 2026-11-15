// Run with the absolute path to an installed @electric-sql/pglite entry module.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function public.is_active_user() returns boolean language sql as 'select true';
    create function public.is_administrator() returns boolean language sql as 'select true';
    create table public.products(id uuid primary key, tasks jsonb not null default '[]');
    create table public.manufacturing_operations(id uuid primary key, operation_code text unique,
      operation_name text, operation_name_ja text);
    create table public.production_tasks(id uuid primary key);
    insert into public.manufacturing_operations values
      ('00000000-0000-0000-0000-000000000001','LASER','Laser','レーザー'),
      ('00000000-0000-0000-0000-000000000002','FULL_MACHINING','Full machining','全加工');
    insert into public.products values ('00000000-0000-0000-0000-000000000003',
      '[{"content":"Laser","time":5},{"content":"Inspection","time":7}]');
  `);
  for (const file of [
    '20261107120000_protect_full_machining_name.sql',
    '20261107124607_client_revision_21_configuration.sql',
    '20261107130000_wip_valuation_configuration.sql',
    '20261107140000_wip_valuation_calculation.sql',
  ]) await db.exec(await readFile(new URL(`../backend/supabase/migrations/${file}`, import.meta.url), 'utf8'));

  await db.exec("update manufacturing_operations set operation_name='Laser cutting' where operation_code='LASER'");
  const route = (await db.query('select tasks from products')).rows[0].tasks;
  assert.equal(route[0].content, 'Laser cutting');
  assert.equal(route[0].time, 5);
  assert.equal(route[0].operationId, '00000000-0000-0000-0000-000000000001');
  assert.deepEqual(route[1], { content: 'Inspection', time: 7 });
  await db.exec(`insert into products values ('00000000-0000-0000-0000-000000000005',
    '[{"content":"Laser cutting","time":9}]')`);
  await db.exec("update manufacturing_operations set operation_name='Laser final' where operation_code='LASER'");
  const newRoute = (await db.query("select tasks from products where id='00000000-0000-0000-0000-000000000005'")).rows[0].tasks;
  assert.equal(newRoute[0].content, 'Laser final');
  assert.equal(newRoute[0].time, 9);
  assert.equal(newRoute[0].operationId, '00000000-0000-0000-0000-000000000001');
  await assert.rejects(db.exec("update manufacturing_operations set operation_name='Other' where operation_code='FULL_MACHINING'"), /protected/);
  await assert.rejects(db.exec("update manufacturing_operations set operation_code='OTHER' where operation_code='FULL_MACHINING'"), /protected/);
  await assert.rejects(db.exec("update manufacturing_operations set operation_name='Pemrosesan Lengkap' where operation_code='LASER'"), /reserved/);
  await db.exec("insert into production_tasks(id, processed_quantity, completed_quantity, actual_time_basis) values ('00000000-0000-0000-0000-000000000004',10,3,'per_batch')");
  await assert.rejects(db.exec('update production_tasks set completed_quantity=11'), /production_task_quantity_order/);
  const incomplete = (await db.query('select calculate_wip_valuation() as result')).rows[0].result;
  assert.equal(incomplete.configured, false);
  await db.exec(`update wip_valuation_settings set valuation_method='actual_time', actual_time_basis='per_batch',
    include_in_progress_operation=false, material_issue_point='issue', outsourcing_recognition='received',
    stock_valuation_method='standard_cost', include_labor_cost=true, include_machine_cost=false, include_overhead_cost=false`);
  const blocked = (await db.query("select calculate_wip_valuation('2026-11-07') as result")).rows[0].result;
  assert.equal(blocked.policy_complete, true);
  assert.equal(blocked.configured, false);
  assert.equal(blocked.code, 'valuation_history_required');
  assert.equal(blocked.total, undefined);
  await db.exec("grant usage on schema public to authenticated; set role authenticated");
  assert.equal((await db.query('select * from wip_valuation_settings')).rows.length, 1);
  console.log('PASS: migration execution, stable routes, protected names, quantities, WIP gates, authenticated policy access');
} finally { await db.close(); }
