-- Attachment-derived demo reset for the main project.
-- This removes only dummy operational/master rows. Auth, profiles and audit logs remain.
begin;

-- The existing dummy orders carry old BOM snapshots and stock ledgers. Disable
-- row triggers during this test-data reset so their old reversal logic cannot
-- run while the old rows are being removed.
alter table public.orders disable trigger user;
alter table public.stock_movements disable trigger user;

delete from public.production_task_submission_receipts;
delete from public.production_tasks;
delete from public.production_costs;
delete from public.stock_movements;
delete from public.purchases;
delete from public.product_materials;
delete from public.orders;
delete from public.products;
delete from public.manufacturing_operations;
delete from public.clients;
delete from public.inventory_items;

insert into public.manufacturing_operations
  (id, operation_code, operation_name, operation_name_ja, base_time_charge_jpy, default_minutes, sequence, is_active)
values
  ('a0000000-0000-0000-0000-000000000001', 'FULL_MACHINING', 'Full machining', '全加工', 0, null, 0, true),
  ('a0000000-0000-0000-0000-000000000002', 'PICKLING', 'Pickling', '酸洗い', 0, null, 10, true),
  ('a0000000-0000-0000-0000-000000000003', 'DIP_PICKLING', 'Dip pickling', 'ドブ漬け酸洗い処理', 0, null, 20, true);

insert into public.clients (id, name, phone, email, postal_code, address) values
  ('c0000000-0000-0000-0000-000000000001', '伸和テクノス株式会社', '0266-28-0105', 'info@shinwa.example.com', '393-0011', '長野県諏訪郡下諏訪町4611番地90'),
  ('c0000000-0000-0000-0000-000000000002', '株式会社マスダ', '0265-85-0000', 'info@masuda.example.com', '399-4301', '長野県上伊那郡宮田村6623-2');

-- Item names and units follow the workbook. The x6 notation is kept as a note;
-- it is not multiplied until the client identifies the exact part.
insert into public.inventory_items
  (id, item_code, item_name, category, procurement_type, unit, opening_qty, minimum_qty, target_qty, supplier_name, unit_cost, active)
values
  ('a1000000-0000-0000-0000-000000000001', 'ITM-000001', 'Pelat aluminium', 'material', 'buy', 'kg', 100, 10, 150, 'Supplier A', 4500, true),
  ('a1000000-0000-0000-0000-000000000002', 'ITM-000002', 'Batang baja', 'material', 'buy', 'kg', 80, 10, 120, 'Supplier B', 4200, true),
  ('a1000000-0000-0000-0000-000000000003', 'ITM-000003', 'Baut M6', 'component', 'buy', 'pcs', 500, 50, 800, 'Supplier C', 35, true),
  ('a1000000-0000-0000-0000-000000000004', 'ITM-000004', 'Bearing 608', 'component', 'buy', 'pcs', 100, 10, 150, 'Supplier C', 850, true),
  ('a1000000-0000-0000-0000-000000000005', 'ITM-000005', 'Cairan potong', 'consumable', 'buy', 'liter', 20, 3, 30, 'Supplier D', 1200, true),
  ('a1000000-0000-0000-0000-000000000006', 'ITM-000006', 'Sarung tangan', 'consumable', 'buy', 'pair', 100, 20, 150, 'Supplier D', 250, true);

insert into public.products
  (id, client_name, product_name, product_number, unit_price, tasks, drawings, internal_company_name)
values
  ('b0000000-0000-0000-0000-000000000001', '伸和テクノス株式会社', 'タンク', 'NHD-F1772-11', 5000,
    '[{"content":"酸洗い","time":""}]'::jsonb, '[]'::jsonb, ''),
  ('b0000000-0000-0000-0000-000000000002', '株式会社マスダ', 'タンク (TOP)', 'NSQ-F0124-05', 6000,
    '[{"content":"ドブ漬け酸洗い処理","time":""}]'::jsonb, '[]'::jsonb, '');

insert into public.product_materials (id, product_id, inventory_item_id, quantity_per_unit, notes) values
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 1, 'Workbook material mapping'),
  ('e0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', .5, 'Workbook material mapping'),
  ('e0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 4, 'Workbook material mapping'),
  ('e0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 1, 'Workbook material mapping'),
  ('e0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000004', 1, 'Workbook material mapping'),
  ('e0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000005', .1, 'Process consumable');

with jst as (select (now() at time zone 'Asia/Tokyo')::date d)
insert into public.orders
  (id, order_date, delivery_date, client, order_number, product_name, quantity, order_amount, progress,
   required_manhours, worked_manhours, order_contact, contact_contents, finish_task, has_contact, completed_tasks, product_id)
select v.id, j.d + v.od, j.d + v.dd, v.client, v.no, v.name, v.qty, v.amount, 'Order request',
  v.manhours, 0, '', '', false, false, '[]'::jsonb, v.product_id
from (values
  ('d0000000-0000-0000-0000-000000000001'::uuid, -8, 5, '伸和テクノス株式会社', '210266', 'タンク', 3, 15000, 1, 'b0000000-0000-0000-0000-000000000001'::uuid),
  ('d0000000-0000-0000-0000-000000000002'::uuid, -7, 2, '株式会社マスダ', 'MS294541', 'タンク (TOP)', 1, 6000, 1, 'b0000000-0000-0000-0000-000000000002'::uuid)
) v(id, od, dd, client, no, name, qty, amount, manhours, product_id) cross join jst j;

update public.orders set progress = 'In production', worked_manhours = 0
where order_number = '210266';
update public.orders set progress = 'Complete', worked_manhours = 1,
  production_end_date = (now() at time zone 'Asia/Tokyo')::date
where order_number = 'MS294541';

insert into public.production_tasks
  (id, order_id, operation_id, status, actual_minutes, actual_time_basis, processed_quantity, completed_quantity)
values
  ('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'in_progress', 15, 'per_unit', 1, 0),
  ('f0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'completed', 20, 'per_unit', 1, 1);

update public.wip_valuation_settings set
  client_decisions = jsonb_set(
    client_decisions || '{"fullMachiningMode":"summary","x6Status":"note_only","x6Note":"Exact part for ×6 is not identified; no multiplication applied."}'::jsonb,
    '{notes}', to_jsonb('Japan 2.pdf: Full machining is a read-only summary; new stages apply to active production orders. WIP includes in-progress operations; material is recognized at production start; outsourcing is recognized on receipt. x6 remains a note only until the exact part is identified.'::text), true),
  version = version + 1,
  updated_at = now()
where id = true;

alter table public.stock_movements enable trigger user;
alter table public.orders enable trigger user;

commit;
