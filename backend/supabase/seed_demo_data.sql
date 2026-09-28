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
-- Production-stage orders auto-post their BOM material issue (negative stock
-- movements); the progress check in migration 007 requires the Shinwa product
-- AND its BOM to exist, so this block is placed after steps 4-5. No Masuda order
-- is seeded on purpose: its product is not registered yet.
-- 210266 matches the actual Shinwa OCR quotation.
insert into public.orders (id, order_date, delivery_date, client, order_number, product_name, quantity, order_amount, progress, required_manhours, worked_manhours, production_end_date, order_contact, contact_contents, finish_task, has_contact, completed_tasks) values
('d1111111-1111-1111-1111-111111111111', '2026-08-17', '2026-08-20', '伸和テクノス株式会社', '210266', 'タンク', 3, 15000, 'Shipped',       90, 90, '2026-08-19', '', '', false, false, '[true]'::jsonb),
('d2222222-2222-2222-2222-222222222222', '2026-08-18', '2026-08-22', '伸和テクノス株式会社', '210267', 'タンク', 2, 10000, 'Complete',      60, 60, '2026-08-21', '', '', false, false, '[true]'::jsonb),
('d3333333-3333-3333-3333-333333333333', '2026-08-19', '2026-08-25', '伸和テクノス株式会社', '210268', 'タンク', 1,  5000, 'In production', 30, 10, '2026-08-24', '', '', false, false, '[false]'::jsonb),
('d4444444-4444-4444-4444-444444444444', '2026-08-19', '2026-08-29', '伸和テクノス株式会社', '210269', 'タンク', 1,  5000, 'Order request', 30,  0, null,         '', '', false, false, '[]'::jsonb)
on conflict (id) do nothing;

-- 7. Purchasing (posting receipts against the inventory master) ------------------
-- Seeded rows are attributed to the @operator account (the one we log in with);
-- the subqueries resolve its profile so the PIC and created_by look natural.
insert into public.purchases (id, purchase_no, purchase_date, supplier_name, item_id, ordered_qty, received_qty, unit_price, due_date, status, pic, notes, created_by) values
('f1111111-1111-1111-1111-111111111111', 'PUR-2026-000001', '2026-08-05', '信州鋼材センター株式会社', 'a1111111-1111-1111-1111-111111111111', 60, 60, 4500, '2026-08-12', 'received', (select username from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1), 'Opening stock SPCC',
  (select id from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1)),
('f2222222-2222-2222-2222-222222222222', 'PUR-2026-000002', '2026-08-06', '信州鋼材センター株式会社', 'a2222222-2222-2222-2222-222222222222', 40, 40, 8200, '2026-08-15', 'received', (select username from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1), 'Opening stock SUS304',
  (select id from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1)),
('f3333333-3333-3333-3333-333333333333', 'PUR-2026-000003', '2026-08-20', 'ナガノケミカル株式会社',      'a4444444-4444-4444-4444-444444444444', 20, 10, 3500, '2026-08-28', 'partial',  (select username from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1), 'Partial delivery',
  (select id from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1)),
('f4444444-4444-4444-4444-444444444444', 'PUR-2026-000004', '2026-08-25', 'ナガノ溶材株式会社',            'a3333333-3333-3333-3333-333333333333', 100, 0, 420,  '2026-09-05', 'ordered',  (select username from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1), 'TIG rod restock',
  (select id from public.profiles where login_email = 'operator@kiyometa.app' and active limit 1))
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