-- Automatic, immutable business numbers for inventory operations.
-- Run after 002_roles_inventory_audit.sql.

create sequence if not exists public.inventory_item_no_seq;
create sequence if not exists public.purchase_no_seq;
create sequence if not exists public.stock_movement_no_seq;
create sequence if not exists public.bom_no_seq;

create or replace function public.next_inventory_item_no()
returns text
language sql
security definer
set search_path = public
volatile
as $$
  select 'ITM-' || lpad(nextval('public.inventory_item_no_seq')::text, 6, '0');
$$;

create or replace function public.next_purchase_no()
returns text
language sql
security definer
set search_path = public
volatile
as $$
  select 'PUR-' || to_char(current_date, 'YYYY') || '-' ||
         lpad(nextval('public.purchase_no_seq')::text, 6, '0');
$$;

create or replace function public.next_stock_movement_no()
returns text
language sql
security definer
set search_path = public
volatile
as $$
  select 'MOV-' || to_char(current_date, 'YYYY') || '-' ||
         lpad(nextval('public.stock_movement_no_seq')::text, 6, '0');
$$;

create or replace function public.next_bom_no()
returns text
language sql
security definer
set search_path = public
volatile
as $$
  select 'BOM-' || lpad(nextval('public.bom_no_seq')::text, 6, '0');
$$;

revoke all on function public.next_inventory_item_no() from public;
revoke all on function public.next_purchase_no() from public;
revoke all on function public.next_stock_movement_no() from public;
revoke all on function public.next_bom_no() from public;
revoke all on function public.next_inventory_item_no() from anon;
revoke all on function public.next_purchase_no() from anon;
revoke all on function public.next_stock_movement_no() from anon;
revoke all on function public.next_bom_no() from anon;
grant execute on function public.next_inventory_item_no() to authenticated;
grant execute on function public.next_purchase_no() to authenticated;
grant execute on function public.next_stock_movement_no() to authenticated;
grant execute on function public.next_bom_no() to authenticated;

-- Continue after any pre-existing number that already uses the new format.
select setval(
  'public.inventory_item_no_seq',
  greatest(coalesce(max(substring(item_code from '^ITM-([0-9]+)$')::bigint), 0), 1),
  coalesce(max(substring(item_code from '^ITM-([0-9]+)$')::bigint), 0) > 0
)
from public.inventory_items;

select setval(
  'public.purchase_no_seq',
  greatest(coalesce(max(substring(purchase_no from '^PUR-[0-9]{4}-([0-9]+)$')::bigint), 0), 1),
  coalesce(max(substring(purchase_no from '^PUR-[0-9]{4}-([0-9]+)$')::bigint), 0) > 0
)
from public.purchases;

alter table public.inventory_items
  alter column item_code set default public.next_inventory_item_no();
alter table public.purchases
  alter column purchase_no set default public.next_purchase_no();

alter table public.stock_movements add column if not exists movement_no text;
alter table public.product_materials add column if not exists bom_no text;

update public.stock_movements
set movement_no = public.next_stock_movement_no()
where movement_no is null or btrim(movement_no) = '';

update public.product_materials
set bom_no = public.next_bom_no()
where bom_no is null or btrim(bom_no) = '';

alter table public.stock_movements
  alter column movement_no set default public.next_stock_movement_no(),
  alter column movement_no set not null;
alter table public.product_materials
  alter column bom_no set default public.next_bom_no(),
  alter column bom_no set not null;

-- Keep UUIDs as stable internal references, while the visible business number
-- becomes the table primary key requested by the operational workflow.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_id_key') then
    alter table public.inventory_items add constraint inventory_items_id_key unique (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_id_key') then
    alter table public.purchases add constraint purchases_id_key unique (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_id_key') then
    alter table public.stock_movements add constraint stock_movements_id_key unique (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'product_materials_id_key') then
    alter table public.product_materials add constraint product_materials_id_key unique (id);
  end if;
end;
$$;

-- The current view uses the UUID primary key as a GROUP BY functional
-- dependency. Rebuild it after switching the primary key to the item number.
drop view if exists public.inventory_balances;

alter table public.product_materials
  drop constraint if exists product_materials_inventory_item_id_fkey;
alter table public.purchases
  drop constraint if exists purchases_item_id_fkey;
alter table public.stock_movements
  drop constraint if exists stock_movements_item_id_fkey;

alter table public.inventory_items drop constraint if exists inventory_items_pkey;
alter table public.inventory_items add constraint inventory_items_pkey primary key (item_code);
alter table public.purchases drop constraint if exists purchases_pkey;
alter table public.purchases add constraint purchases_pkey primary key (purchase_no);
alter table public.stock_movements drop constraint if exists stock_movements_pkey;
alter table public.stock_movements add constraint stock_movements_pkey primary key (movement_no);
alter table public.product_materials drop constraint if exists product_materials_pkey;
alter table public.product_materials add constraint product_materials_pkey primary key (bom_no);

alter table public.product_materials
  add constraint product_materials_inventory_item_id_fkey
  foreign key (inventory_item_id) references public.inventory_items(id) on delete restrict;
alter table public.purchases
  add constraint purchases_item_id_fkey
  foreign key (item_id) references public.inventory_items(id) on delete restrict;
alter table public.stock_movements
  add constraint stock_movements_item_id_fkey
  foreign key (item_id) references public.inventory_items(id) on delete restrict;

create or replace view public.inventory_balances
with (security_invoker = true)
as
select
  i.*,
  i.opening_qty + coalesce(sum(m.delta), 0) as available_qty,
  greatest(i.target_qty - (i.opening_qty + coalesce(sum(m.delta), 0)), 0) as suggested_purchase_qty,
  (i.opening_qty + coalesce(sum(m.delta), 0)) <= i.minimum_qty as needs_reorder,
  (i.opening_qty + coalesce(sum(m.delta), 0)) * i.unit_cost as stock_value
from public.inventory_items i
left join public.stock_movements m on m.item_id = i.id
group by i.item_code;

grant select on public.inventory_balances to authenticated;

create or replace function public.prevent_business_number_change()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) ->> tg_argv[0]) is distinct from
     (to_jsonb(old) ->> tg_argv[0]) then
    raise exception '% cannot be changed after it is generated', tg_argv[0]
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_items_lock_number on public.inventory_items;
create trigger inventory_items_lock_number
  before update on public.inventory_items
  for each row execute function public.prevent_business_number_change('item_code');

drop trigger if exists purchases_lock_number on public.purchases;
create trigger purchases_lock_number
  before update on public.purchases
  for each row execute function public.prevent_business_number_change('purchase_no');

drop trigger if exists stock_movements_lock_number on public.stock_movements;
create trigger stock_movements_lock_number
  before update on public.stock_movements
  for each row execute function public.prevent_business_number_change('movement_no');

drop trigger if exists product_materials_lock_number on public.product_materials;
create trigger product_materials_lock_number
  before update on public.product_materials
  for each row execute function public.prevent_business_number_change('bom_no');
