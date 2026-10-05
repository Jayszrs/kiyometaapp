-- =============================================================================
-- Kiyometa Order Management — Demo seed data (case study from two OCR quotations)
-- Run once in Supabase -> SQL Editor (as the postgres/service role).
--
-- Safety: only operational + master tables are cleared and re-seeded.
-- Authentication and employee profiles (auth.users / public.profiles) are
-- never touched, so you keep logging in with your existing @operator account.
-- Seeded purchase rows are attributed to @operator (operator@kiyometa.app).
--
-- Scenario A (伸和テクノス) — client AND product are already in the master.
--   Scanning the Shinwa quotation finds the client and the tank by drawing
--   number NHD-F1772-11, so the order is created with no prompting.
--
-- Scenario B (マスダ) — only the CLIENT is registered; the product タンク(TOP)
--   / NSQ-F0124-05 is intentionally absent, so scanning Masuda's quotation
--   triggers the "add a new product" flow. (The client name normalizes:
--   (株)マスダ シートメタル課 -> 株式会社マスダ via the department-stripping rule.)
--
-- Fixed UUIDs (only 0-9 a-f are valid hex) so every relationship is readable:
--   a- inventory items   b- products   c- clients   d- orders   e- BOM rows   f- purchases
--
-- Dates are relative to the day the seed is run, never hard-coded. Search &
-- Billing opens on a window of "last 30 days through the end of this month", so
-- fixed dates drift out of that window and the page looks empty even though the
-- rows exist. Every delivery date below sits between today-26 and today-2, which
-- is inside the default window on any day of any month. The offset is taken in
-- Asia/Tokyo to match the app's todayJST(), not the database's UTC.
-- =============================================================================

-- 1. Clear operational and master tables (FK-safe order) ---------------------
-- audit_logs is intentionally left so you can see the seed as a history trail.
delete from public.stock_movements;
delete from public.purchases;
delete from public.product_materials;
delete from public.orders;
delete from public.products;
delete from public.clients;
delete from public.inventory_items;

-- 2. Inventory master ---------------------------------------------------------
-- business numbers follow the ITM-000001 format used by the app's sequences.
insert into public.inventory_items (id, item_code, item_name, category, procurement_type, unit, opening_qty, minimum_qty, target_qty, supplier_name, unit_cost, active) values
('a1111111-1111-1111-1111-111111111111', 'ITM-000001', 'SPCC Steel Plate 1.6mm',    'material',       'buy', 'pcs', 50,   10,  80,  '信州鋼材センター株式会社', 4500, true),
('a2222222-2222-2222-2222-222222222222', 'ITM-000002', 'SUS304 Stainless Plate 1.6mm', 'material',   'buy', 'pcs', 30,    8,  50,  '信州鋼材センター株式会社', 8200, true),
('a3333333-3333-3333-3333-333333333333', 'ITM-000003', 'TIG Welding Rod 2.4mm',       'consumable', 'buy', 'pcs', 120, 200, 300, 'ナガノ溶材株式会社',       420,  true),
('a4444444-4444-4444-4444-444444444444', 'ITM-000004', 'Pickling Acid 25L canister',  'consumable', 'buy', 'can', 40,  10,   60, 'ナガノケミカル株式会社',   3500, true);

-- 3. Client master (from the two OCR documents) -------------------------------
insert into public.clients (id, name, phone, email, postal_code, address) values
('c1111111-1111-1111-1111-111111111111', '伸和テクノス株式会社', '0266-28-0105', 'info@shinwa.example.com', '393-0011', '長野県諏訪郡下諏訪町4611番地90')
on conflict (name) do nothing;

-- Scenario B client: name kept as 株式会社マスダ so the scanned "(株)マスダ シートメタル課" matches.
insert into public.clients (id, name, phone, email, postal_code, address) values
('c2222222-2222-2222-2222-222222222222', '株式会社マスダ', '0265-85-0000', 'info@masuda.example.com', '399-4301', '長野県上伊那郡宮田村6623-2')
on conflict (name) do nothing;

-- 4. Product master ------------------------------------------------------------
-- Scenario A: the tank already exists (tasks mirror the OCR process 酸洗い).
-- Scenario B intentionally has no row: the new-product flow must be triggered.
insert into public.products (id, client_name, product_name, product_number, unit_price, tasks, drawings) values
('b1111111-1111-1111-1111-111111111111', '伸和テクノス株式会社', 'タンク', 'NHD-F1772-11', 5000,
 '[{"content":"酸洗い","time":30}]'::jsonb, '[]'::jsonb)
on conflict (client_name, product_number) do nothing;

-- 5. Bill of materials for the tank ---------------------------------------------
-- One unit of タンク consumes these quantities (drives the automatic stock usage
-- posted when an order reaches In production / Complete / Shipped).
insert into public.product_materials (id, product_id, inventory_item_id, quantity_per_unit, notes) values
('e1111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 1.0,   'Body'),
('e2222222-2222-2222-2222-222222222222', 'b1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 0.5,   'Lid'),
('e3333333-3333-3333-3333-333333333333', 'b1111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333', 0.2,   'Fixtures'),
('e4444444-4444-4444-4444-444444444444', 'b1111111-1111-1111-1111-111111111111', 'a4444444-4444-4444-4444-444444444444', 0.1,   'Process bath')
on conflict (product_id, inventory_item_id) do nothing;

-- 6. Orders ---------------------------------------------------------------------
-- 210266 matches the actual Shinwa OCR quotation. No Masuda order is seeded on
-- purpose: its product is not registered yet.
--
-- The jst CTE is the Asia/Tokyo calendar day, matching todayJST() in the webapp.
-- Offsets keep order_date < production_end_date <= delivery_date, which is what
-- the migration 008 checks require, and keep every delivery inside the Search &
-- Billing default window.
--
-- Every order is INSERTed as 'Order request' and only then moved to its target
-- stage, exactly like the app does it. That is not cosmetic: migration 011 runs
-- apply_order_materials as a BEFORE trigger, and that function snapshots the BOM
-- into order_material_issues, whose order_id references orders(id). On INSERT the
-- order row does not exist yet, so a row inserted directly at 'In production' or
-- later fails with 23503 on order_material_issues_order_id_fkey. On UPDATE the
-- row is there, which is why the app never hits this.
with jst as (
  select ((now() at time zone 'Asia/Tokyo')::date) as d
), seeded as (
  select
    v.id,
    j.d + v.order_offset as order_date,
    j.d + v.delivery_offset as delivery_date,
    v.client,
    v.order_number,
    v.product_name,
    v.quantity,
    v.order_amount,
    v.required_manhours,
    v.target_progress,
    v.worked_manhours,
    v.production_end_offset,
    v.finish_task,
    v.has_contact,
    v.completed_tasks
  from (values
    ('d1111111-1111-1111-1111-111111111111'::uuid, -26, -23, '伸和テクノス株式会社', '210266', 'タンク', 3, 15000, 'Shipped',       90, 90, -24, false, false, '[true]'::jsonb),
    ('d2222222-2222-2222-2222-222222222222'::uuid, -21, -18, '伸和テクノス株式会社', '210267', 'タンク', 2, 10000, 'Complete',      60, 60, -19, false, false, '[true]'::jsonb),
    ('d3333333-3333-3333-3333-333333333333'::uuid, -16, -11, '伸和テクノス株式会社', '210268', 'タンク', 1,  5000, 'In production', 30, 10, -12, false, false, '[false]'::jsonb),
    ('d4444444-4444-4444-4444-444444444444'::uuid,  -6,  -2, '伸和テクノス株式会社', '210269', 'タンク', 1,  5000, 'Order request', 30,  0, null, false, false, '[]'::jsonb)
  ) as v (
    id, order_offset, delivery_offset, client, order_number, product_name, quantity,
    order_amount, target_progress, required_manhours, worked_manhours, production_end_offset,
    finish_task, has_contact, completed_tasks
  )
  cross join jst j
)
insert into public.orders (id, order_date, delivery_date, client, order_number, product_name, quantity, order_amount, progress, required_manhours, worked_manhours, production_end_date, order_contact, contact_contents, finish_task, has_contact, completed_tasks)
select
  s.id,
  s.order_date,
  s.delivery_date,
  s.client,
  s.order_number,
  s.product_name,
  s.quantity,
  s.order_amount,
  'Order request',
  s.required_manhours,
  0,
  null,
  '',
  '',
  s.finish_task,
  s.has_contact,
  s.completed_tasks
from seeded s
on conflict (id) do nothing;

-- Now move each order forward to its target stage. The BEFORE UPDATE triggers
-- fire here: enforce_order_progress_transition validates the move, and
-- apply_order_materials captures the BOM snapshot plus posts the stock issue.
-- The shipped/complete orders run low enough to stay inside the opening stock,
-- so stock_movements_prevent_negative stays satisfied.
with jst as (
  select ((now() at time zone 'Asia/Tokyo')::date) as d
), targets as (
  select
    'd1111111-1111-1111-1111-111111111111'::uuid as id, 'Shipped'::text as progress, 90::numeric as worked, -24 as prod_end_offset
  union all select 'd2222222-2222-2222-2222-222222222222', 'Complete',      60, -19
  union all select 'd3333333-3333-3333-3333-333333333333', 'In production', 10, -12
)
update public.orders o
set progress = t.progress,
    worked_manhours = t.worked,
    production_end_date = (select j.d + t.prod_end_offset from jst j)
from targets t
where o.id = t.id
  and o.progress is distinct from t.progress;

-- 7. Purchasing (posting receipts against the inventory master) ------------------
-- Seeded rows are attributed to the @operator account (the one we log in with);
-- the subqueries resolve its profile so the PIC and created_by look natural.
-- Purchase dates are relative to the JST day for the same reason as the orders:
-- a fixed date would make the Purchasing tab look empty a month later.
with jst as (
  select ((now() at time zone 'Asia/Tokyo')::date) as d
)
insert into public.purchases (id, purchase_no, purchase_date, supplier_name, item_id, ordered_qty, received_qty, unit_price, due_date, status, pic, notes, created_by)
select
  v.id,
  v.purchase_no,
  j.d + v.purchase_offset,
  v.supplier_name,
  v.item_id,
  v.ordered_qty,
  v.received_qty,
  v.unit_price,
  j.d + v.due_offset,
  v.status,
  (select username from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1),
  v.notes,
  (select id from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1)
from (values
  ('f1111111-1111-1111-1111-111111111111'::uuid, 'PUR-2026-000001', -30, '信州鋼材センター株式会社', 'a1111111-1111-1111-1111-111111111111'::uuid, 60,  60, 4500, -23, 'received', 'Opening stock SPCC'),
  ('f2222222-2222-2222-2222-222222222222'::uuid, 'PUR-2026-000002', -29, '信州鋼材センター株式会社', 'a2222222-2222-2222-2222-222222222222'::uuid, 40,  40, 8200, -22, 'received', 'Opening stock SUS304'),
  ('f3333333-3333-3333-3333-333333333333'::uuid, 'PUR-2026-000003', -15, 'ナガノケミカル株式会社',   'a4444444-4444-4444-4444-444444444444'::uuid, 20,  10, 3500,  -7, 'partial',  'Partial delivery'),
  ('f4444444-4444-4444-4444-444444444444'::uuid, 'PUR-2026-000004', -10, 'ナガノ溶材株式会社',       'a3333333-3333-3333-3333-333333333333'::uuid, 100,  0, 420,   4, 'ordered',  'TIG rod restock')
) as v (
  id, purchase_no, purchase_offset, supplier_name, item_id, ordered_qty,
  received_qty, unit_price, due_offset, status, notes
)
cross join jst j
on conflict (purchase_no) do nothing;

-- 8. Re-sync the auto-number sequences past the seeded business numbers ----------
select setval('public.inventory_item_no_seq',
  greatest(coalesce(max(substring(item_code from '^ITM-([0-9]+)$')::bigint), 0), 1),
  coalesce(max(substring(item_code from '^ITM-([0-9]+)$')::bigint), 0) > 0)
from public.inventory_items;

select setval('public.purchase_no_seq',
  greatest(coalesce(max(substring(purchase_no from '^PUR-[0-9]{4}-([0-9]+)$')::bigint), 0), 1),
  coalesce(max(substring(purchase_no from '^PUR-[0-9]{4}-([0-9]+)$')::bigint), 0) > 0)
from public.purchases;

select setval('public.stock_movement_no_seq',
  greatest(coalesce(max(substring(movement_no from '^MOV-[0-9]{4}-([0-9]+)$')::bigint), 0), 1),
  coalesce(max(substring(movement_no from '^MOV-[0-9]{4}-([0-9]+)$')::bigint), 0) > 0)
from public.stock_movements;

select setval('public.bom_no_seq',
  greatest(coalesce(max(substring(bom_no from '^BOM-([0-9]+)$')::bigint), 0), 1),
  coalesce(max(substring(bom_no from '^BOM-([0-9]+)$')::bigint), 0) > 0)
from public.product_materials;

-- 9. Verification ---------------------------------------------------------------
select 'clients' as what, count(*) from public.clients
union all select 'products', count(*) from public.products
union all select 'orders', count(*) from public.orders
union all select 'bom rows', count(*) from public.product_materials
union all select 'purchases', count(*) from public.purchases
union all select 'stock movements', count(*) from public.stock_movements;

select item_code, item_name, available_qty, needs_reorder, suggested_purchase_qty, stock_value
from public.inventory_balances order by item_code;

-- Mirror of the Search & Billing default window (today-30 .. end of this month,
-- JST) so the emptiness this seed was blamed for is visible as a pass/fail here
-- instead of only in the browser. 'orders in default window' must equal the
-- total order count.
with win as (
  select
    ((now() at time zone 'Asia/Tokyo')::date - 30) as from_date,
    (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date)
      + interval '1 month' - interval '1 day')::date as to_date
)
select
  'default window' as what,
  (select from_date from win)::text || ' .. ' || (select to_date from win)::text as detail,
  count(*) filter (where o.delivery_date between (select from_date from win) and (select to_date from win)) as orders_in_window,
  count(*) as orders_total
from public.orders o;