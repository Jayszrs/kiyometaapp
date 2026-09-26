-- Kiyometa roles, audit trail, inventory, purchasing, and stock mutations.
-- Run after 001_order_management.sql in the Supabase SQL Editor.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Users and roles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  login_email  text not null unique,
  display_name text not null default '',
  role         text not null default 'operator'
               check (role in ('administrator', 'operator')),
  active       boolean not null default true,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

insert into public.profiles (id, username, login_email, display_name, role)
select
  u.id,
  lower(coalesce(nullif(u.raw_user_meta_data->>'username', ''), split_part(u.email, '@', 1))),
  u.email,
  coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), split_part(u.email, '@', 1)),
  case
    when u.email = 'operator@kiyometa.app' then 'administrator'
    when u.raw_user_meta_data->>'role' = 'administrator' then 'administrator'
    else 'operator'
  end
from auth.users u
where u.email is not null
on conflict (id) do update set
  login_email = excluded.login_email,
  updated_at = now();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, username, login_email, display_name, role, created_by
  ) values (
    new.id,
    lower(coalesce(nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1))),
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1)),
    case when new.raw_user_meta_data->>'role' = 'administrator' then 'administrator' else 'operator' end,
    nullif(new.raw_user_meta_data->>'created_by', '')::uuid
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.resolve_login_email(p_username text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select login_email
  from public.profiles
  where username = lower(trim(p_username)) and active = true
  limit 1;
$$;

revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;

create or replace function public.is_administrator(p_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id and role = 'administrator' and active = true
  );
$$;

create or replace function public.is_active_user(p_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id and active = true
  );
$$;

revoke all on function public.is_administrator(uuid) from public;
revoke all on function public.is_active_user(uuid) from public;
grant execute on function public.is_administrator(uuid) to authenticated;
grant execute on function public.is_active_user(uuid) to authenticated;

alter table public.profiles enable row level security;
drop policy if exists "authenticated read profiles" on public.profiles;
create policy "authenticated read profiles" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_administrator());

-- Profile writes happen through the manage-users Edge Function only.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  username    text not null default 'system',
  action      text not null,
  entity      text not null,
  entity_id   text,
  old_data    jsonb,
  new_data    jsonb,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid references auth.users(id) on delete set null
);

create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);
create index if not exists audit_logs_user_id_idx on public.audit_logs(user_id);
create index if not exists audit_logs_entity_idx on public.audit_logs(entity, entity_id);

alter table public.audit_logs enable row level security;
drop policy if exists "administrators read audit" on public.audit_logs;
create policy "administrators read audit" on public.audit_logs
  for select to authenticated using (public.is_administrator());

revoke insert, update, delete on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;

create or replace function public.current_audit_username()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select username from public.profiles where id = auth.uid()), 'system');
$$;

create or replace function public.record_audit_event(
  p_action text,
  p_entity text,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Active account required';
  end if;

  insert into public.audit_logs(user_id, username, action, entity, entity_id, metadata)
  values (auth.uid(), public.current_audit_username(), p_action, p_entity, p_entity_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.record_audit_event(text, text, text, jsonb) to authenticated;

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id text;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_id := coalesce(v_new->>'id', v_old->>'id');

  insert into public.audit_logs(
    user_id, username, action, entity, entity_id, old_data, new_data, metadata
  ) values (
    auth.uid(),
    public.current_audit_username(),
    lower(tg_op),
    tg_table_name,
    v_id,
    v_old,
    v_new,
    jsonb_build_object('source', coalesce(current_setting('app.audit_source', true), 'database'))
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists audit_clients on public.clients;
create trigger audit_clients after insert or update or delete on public.clients
  for each row execute function public.audit_row_change();
drop trigger if exists audit_products on public.products;
create trigger audit_products after insert or update or delete on public.products
  for each row execute function public.audit_row_change();
drop trigger if exists audit_orders on public.orders;
create trigger audit_orders after insert or update or delete on public.orders
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------------
-- Inventory master, BOM, purchases, and stock ledger
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_items (
  id               uuid primary key default gen_random_uuid(),
  item_code        text not null unique,
  item_name        text not null,
  category         text not null check (category in (
                     'finished_good', 'component', 'material',
                     'purchased_part', 'consumable', 'subcontract'
                   )),
  procurement_type text not null check (procurement_type in ('make', 'buy', 'subcontract')),
  unit             text not null default 'pcs',
  opening_qty      numeric(14,3) not null default 0,
  minimum_qty      numeric(14,3) not null default 0,
  target_qty       numeric(14,3) not null default 0,
  supplier_name    text not null default '',
  unit_cost        numeric(14,2) not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.product_materials (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity_per_unit numeric(14,3) not null check (quantity_per_unit > 0),
  notes             text not null default '',
  unique(product_id, inventory_item_id)
);

create table if not exists public.purchases (
  id             uuid primary key default gen_random_uuid(),
  purchase_no    text not null unique,
  purchase_date  date not null default current_date,
  supplier_name  text not null,
  item_id        uuid not null references public.inventory_items(id) on delete restrict,
  ordered_qty    numeric(14,3) not null check (ordered_qty > 0),
  received_qty   numeric(14,3) not null default 0 check (received_qty >= 0),
  unit_price     numeric(14,2) not null default 0,
  due_date       date,
  status         text not null default 'ordered'
                 check (status in ('ordered', 'partial', 'received', 'cancelled')),
  pic            text not null default '',
  notes          text not null default '',
  created_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (received_qty <= ordered_qty)
);

create table if not exists public.stock_movements (
  id             uuid primary key default gen_random_uuid(),
  movement_date  date not null default current_date,
  movement_type  text not null check (movement_type in (
                   'purchase_receipt', 'material_issue', 'production_output',
                   'sale_shipment', 'subcontract_out', 'subcontract_in',
                   'adjustment_in', 'adjustment_out', 'order_material_issue',
                   'order_material_reversal', 'undo'
                 )),
  reference_type text not null default 'manual',
  reference_id   text,
  item_id        uuid not null references public.inventory_items(id) on delete restrict,
  quantity       numeric(14,3) not null check (quantity > 0),
  delta          numeric(14,3) not null check (delta <> 0),
  pic            text not null default '',
  notes          text not null default '',
  created_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);

alter table public.orders add column if not exists inventory_stock_applied boolean not null default false;

create index if not exists stock_movements_item_date_idx
  on public.stock_movements(item_id, movement_date desc, created_at desc);
create index if not exists purchases_date_idx on public.purchases(purchase_date desc);

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
group by i.id;

alter table public.inventory_items enable row level security;
alter table public.product_materials enable row level security;
alter table public.purchases enable row level security;
alter table public.stock_movements enable row level security;

-- Replace the broad policies from migration 001 so disabled accounts lose
-- access immediately, even when an old Supabase session is still cached.
drop policy if exists "auth all" on public.clients;
drop policy if exists "active users manage clients" on public.clients;
create policy "active users manage clients" on public.clients
  for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "auth all" on public.products;
drop policy if exists "active users manage products" on public.products;
create policy "active users manage products" on public.products
  for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "auth all" on public.orders;
drop policy if exists "active users manage orders" on public.orders;
create policy "active users manage orders" on public.orders
  for all to authenticated using (public.is_active_user()) with check (public.is_active_user());

drop policy if exists "auth manage drawings" on storage.objects;
drop policy if exists "active users manage drawings" on storage.objects;
create policy "active users manage drawings" on storage.objects
  for all to authenticated
  using (bucket_id = 'product-drawings' and public.is_active_user())
  with check (bucket_id = 'product-drawings' and public.is_active_user());

drop policy if exists "authenticated manage inventory items" on public.inventory_items;
create policy "authenticated manage inventory items" on public.inventory_items
  for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "authenticated manage product materials" on public.product_materials;
create policy "authenticated manage product materials" on public.product_materials
  for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "authenticated manage purchases" on public.purchases;
create policy "authenticated manage purchases" on public.purchases
  for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "authenticated manage stock movements" on public.stock_movements;
create policy "authenticated manage stock movements" on public.stock_movements
  for all to authenticated using (public.is_active_user()) with check (public.is_active_user());

grant select, insert, update, delete on public.inventory_items to authenticated;
grant select, insert, update, delete on public.product_materials to authenticated;
grant select, insert, update, delete on public.purchases to authenticated;
grant select, insert, update, delete on public.stock_movements to authenticated;
grant select on public.inventory_balances to authenticated;

create or replace function public.apply_purchase_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_purchase_id uuid;
  v_purchase_no text;
  v_purchase_date date;
  v_item_id uuid;
  v_received numeric(14,3);
  v_pic text;
  v_created_by uuid;
begin
  if tg_op = 'DELETE' then
    v_purchase_id := old.id;
    v_purchase_no := old.purchase_no;
    v_purchase_date := current_date;
    v_item_id := null;
    v_received := 0;
    v_pic := old.pic;
    v_created_by := old.created_by;
  else
    v_purchase_id := new.id;
    v_purchase_no := new.purchase_no;
    v_purchase_date := new.purchase_date;
    v_item_id := new.item_id;
    v_received := new.received_qty;
    v_pic := new.pic;
    v_created_by := new.created_by;
  end if;

  -- Reconcile the ledger with the purchase's received quantity. This also
  -- handles item changes, deletion, and audit undo without double-posting.
  for v_row in
    with current_totals as (
      select item_id, coalesce(sum(delta), 0)::numeric as current_delta
      from public.stock_movements
      where reference_type = 'purchase' and reference_id = v_purchase_id::text
      group by item_id
    ), desired as (
      select v_item_id as item_id, v_received::numeric as desired_delta
      where v_item_id is not null and v_received <> 0
    )
    select coalesce(c.item_id, d.item_id) as item_id,
           coalesce(d.desired_delta, 0) - coalesce(c.current_delta, 0) as adjustment
    from current_totals c
    full join desired d on d.item_id = c.item_id
  loop
    if v_row.adjustment <> 0 then
      insert into public.stock_movements(
        movement_date, movement_type, reference_type, reference_id,
        item_id, quantity, delta, pic, notes, created_by
      ) values (
        v_purchase_date,
        case when v_row.adjustment > 0 then 'purchase_receipt' else 'undo' end,
        'purchase', v_purchase_id::text, v_row.item_id,
        abs(v_row.adjustment), v_row.adjustment, v_pic,
        'Automatic stock reconciliation for purchase ' || v_purchase_no,
        coalesce(auth.uid(), v_created_by)
      );
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists purchases_apply_receipt on public.purchases;
create trigger purchases_apply_receipt
  before insert or update of received_qty, item_id or delete on public.purchases
  for each row execute function public.apply_purchase_receipt();

create or replace function public.apply_order_materials()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_row record;
  v_order_id uuid;
  v_order_number text;
  v_client text;
  v_product_name text;
  v_quantity numeric(14,3);
  v_should_apply boolean;
begin
  if tg_op = 'DELETE' then
    v_order_id := old.id;
    v_order_number := old.order_number;
    v_client := old.client;
    v_product_name := old.product_name;
    v_quantity := old.quantity;
    v_should_apply := false;
  else
    v_order_id := new.id;
    v_order_number := new.order_number;
    v_client := new.client;
    v_product_name := new.product_name;
    v_quantity := new.quantity;
    v_should_apply := new.progress in ('Complete', 'Shipped');
  end if;

  if v_should_apply then
    select id into v_product_id
    from public.products
    where product_name = v_product_name and client_name = v_client
    order by created_at
    limit 1;
  end if;

  -- Bring the order's ledger to the exact BOM requirement. Running this on
  -- every relevant update makes completion idempotent and adjusts quantity.
  for v_row in
    with current_totals as (
      select item_id, coalesce(sum(delta), 0)::numeric as current_delta
      from public.stock_movements
      where reference_type = 'order'
        and reference_id = v_order_id::text
        and movement_type in ('order_material_issue', 'order_material_reversal')
      group by item_id
    ), desired as (
      select inventory_item_id as item_id,
             -(quantity_per_unit * v_quantity)::numeric as desired_delta
      from public.product_materials
      where v_should_apply and product_id = v_product_id
    )
    select coalesce(c.item_id, d.item_id) as item_id,
           coalesce(d.desired_delta, 0) - coalesce(c.current_delta, 0) as adjustment
    from current_totals c
    full join desired d on d.item_id = c.item_id
  loop
    if v_row.adjustment <> 0 then
      insert into public.stock_movements(
        movement_date, movement_type, reference_type, reference_id,
        item_id, quantity, delta, pic, notes
      ) values (
        current_date,
        case when v_row.adjustment < 0 then 'order_material_issue' else 'order_material_reversal' end,
        'order', v_order_id::text, v_row.item_id,
        abs(v_row.adjustment), v_row.adjustment,
        public.current_audit_username(),
        'Automatic BOM reconciliation for order ' || v_order_number
      );
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  new.inventory_stock_applied := v_should_apply;
  return new;
end;
$$;

drop trigger if exists orders_apply_materials on public.orders;
create trigger orders_apply_materials
  before insert or update of progress, quantity, product_name, client or delete on public.orders
  for each row execute function public.apply_order_materials();

drop trigger if exists audit_inventory_items on public.inventory_items;
create trigger audit_inventory_items after insert or update or delete on public.inventory_items
  for each row execute function public.audit_row_change();
drop trigger if exists audit_product_materials on public.product_materials;
create trigger audit_product_materials after insert or update or delete on public.product_materials
  for each row execute function public.audit_row_change();
drop trigger if exists audit_purchases on public.purchases;
create trigger audit_purchases after insert or update or delete on public.purchases
  for each row execute function public.audit_row_change();
drop trigger if exists audit_stock_movements on public.stock_movements;
create trigger audit_stock_movements after insert or update or delete on public.stock_movements
  for each row execute function public.audit_row_change();

-- Undo is restricted to administrators and supports the operational tables
-- shown in the audit screen. Updates are restored with explicit column lists.
create or replace function public.undo_audit_entry(p_audit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log public.audit_logs%rowtype;
begin
  if not public.is_administrator() then
    raise exception 'Administrator role required';
  end if;

  select * into v_log from public.audit_logs where id = p_audit_id for update;
  if not found then raise exception 'Audit entry not found'; end if;
  if v_log.undone_at is not null then raise exception 'This action was already undone'; end if;
  if v_log.action not in ('insert', 'update', 'delete') then
    raise exception 'This audit action cannot be undone';
  end if;
  if coalesce(v_log.metadata->>'source', '') like 'undo:%' then
    raise exception 'An undo-generated change cannot be undone again';
  end if;
  if v_log.entity = 'stock_movements'
     and coalesce(v_log.new_data, v_log.old_data)->>'reference_type' in ('purchase', 'order') then
    raise exception 'Undo the related purchase or order instead of its automatic stock entry';
  end if;

  perform set_config('app.audit_source', 'undo:' || p_audit_id::text, true);

  if v_log.entity = 'inventory_items' then
    if v_log.action = 'insert' then
      delete from public.inventory_items where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.inventory_items set
        item_code=v_log.old_data->>'item_code', item_name=v_log.old_data->>'item_name',
        category=v_log.old_data->>'category', procurement_type=v_log.old_data->>'procurement_type',
        unit=v_log.old_data->>'unit', opening_qty=(v_log.old_data->>'opening_qty')::numeric,
        minimum_qty=(v_log.old_data->>'minimum_qty')::numeric,
        target_qty=(v_log.old_data->>'target_qty')::numeric,
        supplier_name=v_log.old_data->>'supplier_name', unit_cost=(v_log.old_data->>'unit_cost')::numeric,
        active=(v_log.old_data->>'active')::boolean, updated_at=(v_log.old_data->>'updated_at')::timestamptz
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.inventory_items
      select * from jsonb_populate_record(null::public.inventory_items, v_log.old_data);
    end if;
  elsif v_log.entity = 'purchases' then
    if v_log.action = 'insert' then
      delete from public.purchases where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.purchases set
        purchase_no=v_log.old_data->>'purchase_no',
        purchase_date=(v_log.old_data->>'purchase_date')::date,
        supplier_name=v_log.old_data->>'supplier_name', item_id=(v_log.old_data->>'item_id')::uuid,
        ordered_qty=(v_log.old_data->>'ordered_qty')::numeric,
        received_qty=(v_log.old_data->>'received_qty')::numeric,
        unit_price=(v_log.old_data->>'unit_price')::numeric,
        due_date=nullif(v_log.old_data->>'due_date', '')::date,
        status=v_log.old_data->>'status', pic=v_log.old_data->>'pic', notes=v_log.old_data->>'notes',
        updated_at=(v_log.old_data->>'updated_at')::timestamptz
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.purchases
      select * from jsonb_populate_record(null::public.purchases, v_log.old_data);
    end if;
  elsif v_log.entity = 'stock_movements' then
    if v_log.action = 'insert' then
      delete from public.stock_movements where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.stock_movements set
        movement_date=(v_log.old_data->>'movement_date')::date,
        movement_type=v_log.old_data->>'movement_type', reference_type=v_log.old_data->>'reference_type',
        reference_id=v_log.old_data->>'reference_id', item_id=(v_log.old_data->>'item_id')::uuid,
        quantity=(v_log.old_data->>'quantity')::numeric, delta=(v_log.old_data->>'delta')::numeric,
        pic=v_log.old_data->>'pic', notes=v_log.old_data->>'notes'
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.stock_movements
      select * from jsonb_populate_record(null::public.stock_movements, v_log.old_data);
    end if;
  elsif v_log.entity = 'clients' then
    if v_log.action = 'insert' then
      delete from public.clients where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.clients set
        name=v_log.old_data->>'name', phone=v_log.old_data->>'phone',
        email=v_log.old_data->>'email', postal_code=v_log.old_data->>'postal_code',
        address=v_log.old_data->>'address', updated_at=(v_log.old_data->>'updated_at')::timestamptz
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.clients
      select * from jsonb_populate_record(null::public.clients, v_log.old_data);
    end if;
  elsif v_log.entity = 'products' then
    if v_log.action = 'insert' then
      delete from public.products where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.products set
        client_name=v_log.old_data->>'client_name', product_name=v_log.old_data->>'product_name',
        product_number=v_log.old_data->>'product_number', unit_price=(v_log.old_data->>'unit_price')::integer,
        tasks=coalesce(v_log.old_data->'tasks', '[]'::jsonb),
        drawings=coalesce(v_log.old_data->'drawings', '[]'::jsonb),
        updated_at=(v_log.old_data->>'updated_at')::timestamptz
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.products
      select * from jsonb_populate_record(null::public.products, v_log.old_data);
    end if;
  elsif v_log.entity = 'orders' then
    if v_log.action = 'insert' then
      delete from public.orders where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.orders set
        order_date=(v_log.old_data->>'order_date')::date,
        delivery_date=(v_log.old_data->>'delivery_date')::date,
        client=v_log.old_data->>'client', order_number=v_log.old_data->>'order_number',
        product_name=v_log.old_data->>'product_name', quantity=(v_log.old_data->>'quantity')::integer,
        order_amount=(v_log.old_data->>'order_amount')::integer, progress=v_log.old_data->>'progress',
        required_manhours=(v_log.old_data->>'required_manhours')::integer,
        worked_manhours=(v_log.old_data->>'worked_manhours')::integer,
        production_end_date=nullif(v_log.old_data->>'production_end_date', '')::date,
        order_contact=v_log.old_data->>'order_contact', contact_contents=v_log.old_data->>'contact_contents',
        finish_task=(v_log.old_data->>'finish_task')::boolean,
        has_contact=(v_log.old_data->>'has_contact')::boolean,
        completed_tasks=coalesce(v_log.old_data->'completed_tasks', '[]'::jsonb),
        updated_at=(v_log.old_data->>'updated_at')::timestamptz
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.orders
      select * from jsonb_populate_record(null::public.orders, v_log.old_data);
    end if;
  else
    raise exception 'Undo is not supported for entity %', v_log.entity;
  end if;

  update public.audit_logs
  set undone_at = now(), undone_by = auth.uid()
  where id = p_audit_id;

  insert into public.audit_logs(user_id, username, action, entity, entity_id, metadata)
  values (
    auth.uid(), public.current_audit_username(), 'undo', v_log.entity,
    v_log.entity_id, jsonb_build_object('audit_id', p_audit_id)
  );
end;
$$;

grant execute on function public.undo_audit_entry(uuid) to authenticated;
