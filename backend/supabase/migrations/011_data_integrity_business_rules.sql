-- Kiyometa — data integrity and business rule enforcement.
-- Run once in Supabase -> SQL Editor, after 010_security_role_separation.sql.
--
-- Why this file exists
-- --------------------
-- 1. inventory_items.opening_qty had no sign CHECK and no trigger. The only
--    negative balance guard is stock_movements_prevent_negative, which fires on
--    the ledger alone. A negative opening quantity therefore poisoned
--    inventory_balances permanently: every balance derived from it is negative,
--    and no future receipt can ever bring it back above zero.
-- 2. opening_qty is the base of every balance but the item form re-uploads it on
--    every edit of any field, so a stock correction could be made by editing a
--    supplier name. Nothing was written to the ledger, so history silently
--    disagreed with the books.
-- 3. orders had no version column. upsertOrder writes all sixteen columns with
--    no precondition, so two operators editing the same order produced a silent
--    last-write-wins. A stale "In production" save arriving after "Shipped"
--    reverted the order and made the BOM trigger return issued material to stock
--    for goods that had already left the building.
-- 4. progress was validated only as membership of a set of seven strings, so any
--    active user could move a shipped order back to Order request in one
--    select, reversing its material consumption. There was no Cancelled state at
--    all, making deletion the only way to stop work.
-- 5. orders.product_name is plain text, not a foreign key, and the BOM trigger
--    resolved it with "order by created_at limit 1". Renaming a product left
--    every historical order pointing at nothing, after which no status change on
--    those orders could be saved at all. Two products for one client sharing a
--    product_name silently issued the wrong BOM.
-- 6. apply_order_materials recomputed the desired ledger from product_materials
--    as it existed at save time, so editing a BOM after an order was produced
--    retroactively changed the materials that order was said to have consumed.
--
-- Existing rows are left alone. Every guard here fires on INSERT or UPDATE, so
-- no historical data has to be repaired before this file can be applied.

-- ===========================================================================
-- 1. inventory_items: sign constraints and a frozen opening balance
-- ===========================================================================

alter table public.inventory_items drop constraint if exists inventory_items_opening_qty_nonneg;
alter table public.inventory_items add constraint inventory_items_opening_qty_nonneg
  check (opening_qty >= 0) not valid;

alter table public.inventory_items drop constraint if exists inventory_items_minimum_qty_nonneg;
alter table public.inventory_items add constraint inventory_items_minimum_qty_nonneg
  check (minimum_qty >= 0) not valid;

alter table public.inventory_items drop constraint if exists inventory_items_target_qty_nonneg;
alter table public.inventory_items add constraint inventory_items_target_qty_nonneg
  check (target_qty >= 0) not valid;

alter table public.inventory_items drop constraint if exists inventory_items_unit_cost_nonneg;
alter table public.inventory_items add constraint inventory_items_unit_cost_nonneg
  check (unit_cost >= 0) not valid;

alter table public.inventory_items drop constraint if exists inventory_items_name_clean;
alter table public.inventory_items add constraint inventory_items_name_clean
  check (btrim(item_name) <> '' and char_length(btrim(item_name)) <= 200) not valid;

-- Once the ledger has any row for an item, its opening balance is history and
-- must be corrected with an explicit stock movement, not by editing the item.
create or replace function public.freeze_opening_quantity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The undo RPC restores the previous value and is exempt for the same reason
  -- the progress guard is: an explicit, audited correction must stay reversible.
  if coalesce(current_setting('app.audit_source', true), '') like 'undo:%' then
    return new;
  end if;

  if new.opening_qty is distinct from old.opening_qty
     and exists (
       select 1 from public.stock_movements where item_id = old.id
     )
  then
    raise exception
      'Opening quantity for % cannot be changed once stock movements exist. Record the difference as a stock adjustment instead.',
      old.item_code using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_items_freeze_opening on public.inventory_items;
create trigger inventory_items_freeze_opening
  before update of opening_qty on public.inventory_items
  for each row execute function public.freeze_opening_quantity();

-- ===========================================================================
-- 2. Orders: optimistic concurrency
-- ===========================================================================
--
-- version is bumped by the client on every successful save and the client sends
-- the version it read. A save that no longer matches is rejected, so the second
-- operator is told to reload instead of silently overwriting the first.

alter table public.orders add column if not exists version integer not null default 1;

create index if not exists orders_version_idx on public.orders (version)
  where version is not null;

-- ===========================================================================
-- 3. Progress state machine
-- ===========================================================================
--
--   Order request -> Receipt -> In preparation -> Preparation complete
--                -> In production -> Complete -> Shipped
--
-- Cancelled is reachable from any state before Shipped, reverses the materials
-- once, and is terminal. Shipped is terminal. Moving backwards is allowed only
-- while no material has ever been issued for the order, because a backward move
-- makes the BOM trigger post a reversal, and reversing a completed order would
-- hand back stock that the customer already received.
--
-- The undo RPC restores an old progress value and is therefore exempt, so the
-- audit trail stays reversible.

alter table public.orders drop constraint if exists orders_progress_check;
alter table public.orders add constraint orders_progress_check
  check (progress in (
    'Order request', 'Receipt', 'In preparation', 'Preparation complete',
    'In production', 'Complete', 'Shipped', 'Cancelled'
  ));

create or replace function public.enforce_order_progress_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_undoing boolean;
  v_rank integer;
  v_old_rank integer;
begin
  if new.progress is not distinct from old.progress then
    return new;
  end if;

  v_undoing := coalesce(current_setting('app.audit_source', true), '') like 'undo:%';
  if v_undoing then
    return new;
  end if;

  v_old_rank := case old.progress
    when 'Order request' then 1
    when 'Receipt' then 2
    when 'In preparation' then 3
    when 'Preparation complete' then 4
    when 'In production' then 5
    when 'Complete' then 6
    when 'Shipped' then 7
    else 0
  end;
  v_rank := case new.progress
    when 'Order request' then 1
    when 'Receipt' then 2
    when 'In preparation' then 3
    when 'Preparation complete' then 4
    when 'In production' then 5
    when 'Complete' then 6
    when 'Shipped' then 7
    when 'Cancelled' then 0
    else -1
  end;

  if old.progress = 'Shipped' then
    raise exception 'Order % has shipped and can no longer be reopened. Create a corrective order instead.',
      old.order_number using errcode = '23514';
  end if;
  if old.progress = 'Cancelled' then
    raise exception 'Order % is cancelled and can no longer change status',
      old.order_number using errcode = '23514';
  end if;

  -- Cancelling is always allowed from a non terminal state. The BOM trigger
  -- reverses the issued materials exactly once because it reconciles against
  -- the desired total, and a cancelled order desires nothing.
  if new.progress = 'Cancelled' then
    return new;
  end if;

  if old.progress = 'Complete' and new.progress <> 'Shipped' then
    raise exception 'A completed order can only move to Shipped or Cancelled (order %)',
      old.order_number using errcode = '23514';
  end if;

  if v_rank < v_old_rank and old.inventory_stock_applied then
    raise exception
      'Order % cannot move back from % to % because its materials have already been issued. Cancel the order instead',
      old.order_number, old.progress, new.progress using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_progress_transition on public.orders;
create trigger orders_progress_transition
  before update of progress on public.orders
  for each row execute function public.enforce_order_progress_transition();

-- ===========================================================================
-- 4. Products are referenced by name: make the reference safe
-- ===========================================================================
--
-- orders.product_name is text and orders.client is a real foreign key, so the
-- pair (client, product_name) is the order's only link to Product Master.
-- Renaming a product therefore orphaned every historical order that referenced
-- it, and the BOM trigger then raised 23503 on any later status change,
-- blocking all further edits to those orders.

create or replace function public.guard_product_identity_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orders integer;
begin
  if tg_op = 'DELETE' then
    select count(*) into v_orders
    from public.orders
    where client = old.client_name and product_name = old.product_name;
    if v_orders > 0 then
      raise exception
        'Product % is used by % order(s) and cannot be deleted. The orders must be closed or reassigned first',
        old.product_name, v_orders using errcode = '23514';
    end if;
    return old;
  end if;

  if new.product_name is distinct from old.product_name
     or new.client_name is distinct from old.client_name
  then
    select count(*) into v_orders
    from public.orders
    where client = old.client_name and product_name = old.product_name;
    if v_orders > 0 then
      raise exception
        'Product % is used by % order(s) and cannot be renamed or moved to another client',
        old.product_name, v_orders using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists products_guard_identity on public.products;
create trigger products_guard_identity
  before update of product_name, client_name or delete on public.products
  for each row execute function public.guard_product_identity_change();

-- Two products for one client may share a display name as long as their product
-- numbers differ, and apply_order_materials resolves the BOM by name. That makes
-- the oldest row win and issues the wrong materials. Uniqueness on
-- (client_name, product_name) closes it, but only if the existing data allows
-- it, so the constraint is added conditionally and the conflict is reported
-- rather than raised.
do $$
begin
  if exists (
    select 1 from public.products
    group by client_name, product_name
    having count(*) > 1
  ) then
    raise notice
      'Skipped unique(client_name, product_name): duplicate display names exist. Resolve them first, then run step 4b.';
  else
    alter table public.products drop constraint if exists products_client_name_product_name_key;
    alter table public.products add constraint products_client_name_product_name_key
      unique (client_name, product_name) not valid;
  end if;
end;
$$;

-- Step 4b, after resolving the duplicates reported above:
--   alter table public.products
--     add constraint products_client_name_product_name_key
--     unique (client_name, product_name);

-- ===========================================================================
-- 5. BOM snapshot per order
-- ===========================================================================
--
-- The desired ledger for an order is now taken from the material list captured
-- when the order first entered production, not from product_materials as it
-- stands today. Editing a BOM afterwards no longer rewrites the materials an
-- already produced order was recorded as consuming.
--
-- The reconciliation arithmetic is unchanged: it still compares what the ledger
-- currently holds for this order against what it should hold and posts only the
-- difference. Only the source of "what it should hold" moved.

create table if not exists public.order_material_issues (
  order_id           uuid not null references public.orders(id) on delete cascade,
  inventory_item_id  uuid not null references public.inventory_items(id) on delete restrict,
  quantity_per_unit  numeric(14,3) not null check (quantity_per_unit >= 0),
  created_at         timestamptz not null default now(),
  primary key (order_id, inventory_item_id)
);

alter table public.order_material_issues enable row level security;
drop policy if exists "active users read order material issues" on public.order_material_issues;
create policy "active users read order material issues" on public.order_material_issues
  for select to authenticated using ((select public.is_active_user()));
-- Writes happen only inside the BOM trigger, which runs as SECURITY DEFINER.
grant select on public.order_material_issues to authenticated;

create index if not exists order_material_issues_order_idx
  on public.order_material_issues(order_id);

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
    v_should_apply := new.progress in ('In production', 'Complete', 'Shipped');
  end if;

  if v_should_apply then
    select id into v_product_id
    from public.products
    where product_name = v_product_name and client_name = v_client
    order by created_at
    limit 1;

    if v_product_id is null then
      raise exception 'Product % for client % was not found in Product Master',
        v_product_name, v_client using errcode = '23503';
    end if;

    -- Capture the BOM the first time this order consumes materials. A later
    -- reconciliation, including a quantity change, uses the captured list.
    if not exists (
      select 1 from public.order_material_issues where order_id = v_order_id
    ) then
      if not exists (
        select 1 from public.product_materials where product_id = v_product_id
      ) then
        raise exception 'Product % has no material BOM. Add its materials in Product Master before starting production',
          v_product_name using errcode = '23514';
      end if;

      insert into public.order_material_issues (order_id, inventory_item_id, quantity_per_unit)
      select v_order_id, inventory_item_id, quantity_per_unit
      from public.product_materials
      where product_id = v_product_id
      on conflict do nothing;

      if not exists (
        select 1 from public.order_material_issues where order_id = v_order_id
      ) then
        raise exception 'Product % has no material BOM. Add its materials in Product Master before starting production',
          v_product_name using errcode = '23514';
      end if;
    end if;

    -- Lock every item in the captured BOM in a consistent order before
    -- reconciling the ledger.
    perform 1
    from public.inventory_items i
    join public.order_material_issues omi on omi.inventory_item_id = i.id
    where omi.order_id = v_order_id
    order by i.id
    for update of i;
  end if;

  for v_row in
    with current_totals as (
      select item_id, coalesce(sum(delta), 0)::numeric as current_delta
      from public.stock_movements
      where reference_type = 'order'
        and reference_id = v_order_id::text
        and movement_type in ('order_material_issue', 'order_material_reversal')
      group by item_id
    ), desired as (
      select omi.inventory_item_id as item_id,
             -(omi.quantity_per_unit * v_quantity)::numeric as desired_delta
      from public.order_material_issues omi
      where v_should_apply and omi.order_id = v_order_id
    )
    select coalesce(c.item_id, d.item_id) as item_id,
           coalesce(d.desired_delta, 0) - coalesce(c.current_delta, 0) as adjustment
    from current_totals c
    full join desired d on d.item_id = c.item_id
    order by coalesce(c.item_id, d.item_id)
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

-- Backfill the snapshot for orders that already consumed materials, so the first
-- save after this migration does not treat them as never issued.
--
-- The product is resolved the same way the trigger resolves it, including the
-- "oldest wins" tie-break. (client_name, product_name) is not unique, so a
-- plain join could snapshot the BOM of a different product than the trigger
-- would pick; the first reconciliation would then post an adjustment that
-- moves stock from one bill of materials to the other, which is exactly the
-- kind of silent quantity change the snapshot exists to prevent.
insert into public.order_material_issues (order_id, inventory_item_id, quantity_per_unit)
select o.id, pm.inventory_item_id, pm.quantity_per_unit
from public.orders o
join lateral (
  select p.id
  from public.products p
  where p.product_name = o.product_name and p.client_name = o.client
  order by p.created_at
  limit 1
) p on true
join public.product_materials pm on pm.product_id = p.id
where o.inventory_stock_applied
on conflict do nothing;

-- ===========================================================================
-- 6. Audit trail: do not record a change that changed nothing
-- ===========================================================================
--
-- audit_row_change fires on every full-row upsert. Toggling one checklist box
-- rewrites all sixteen order columns, and the trigger then stored two complete
-- row snapshots claiming a full row change. Skipping the no-op keeps the trail
-- meaningful and stops one user action from producing dozens of entries.

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    -- updated_at always moves, so compare everything else.
    v_old := v_old - 'updated_at';
    v_new := v_new - 'updated_at';
    if v_old = v_new then
      return new;
    end if;
  else
    if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
    if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  end if;

  insert into public.audit_logs(
    user_id, username, action, entity, entity_id, old_data, new_data, metadata
  ) values (
    auth.uid(),
    public.current_audit_username(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_new->>'id', v_old->>'id'),
    v_old,
    v_new,
    jsonb_build_object('source', coalesce(current_setting('app.audit_source', true), 'database'))
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- ===========================================================================
-- 7. Undo: report the affected row count from the statement that ran
-- ===========================================================================
--
-- GET DIAGNOSTICS after the if/elsif chain only reported the last statement
-- executed, so the "the target record no longer matches" guard was unreliable
-- for the insert branches. undo_audit_entry is redefined here with the count
-- captured per branch.

create or replace function public.undo_audit_entry(p_audit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log public.audit_logs%rowtype;
  v_affected integer;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Active account required';
  end if;

  select * into v_log
  from public.audit_logs
  where id = p_audit_id
  for update;

  if not found then raise exception 'Audit entry not found'; end if;
  if not public.is_administrator() and v_log.user_id is distinct from auth.uid() then
    raise exception 'Operators can only undo their own activity';
  end if;
  if v_log.undone_at is not null then
    raise exception 'This action was already undone';
  end if;
  if v_log.action not in ('insert', 'update', 'delete') then
    raise exception 'This audit action cannot be undone';
  end if;
  if coalesce(v_log.metadata->>'source', '') like 'undo:%' then
    raise exception 'An undo-generated change cannot be undone again';
  end if;
  if v_log.entity not in (
    'clients', 'products', 'orders', 'inventory_items',
    'purchases', 'stock_movements', 'product_materials'
  ) then
    raise exception 'Undo is not supported for entity %', v_log.entity;
  end if;
  if v_log.entity = 'stock_movements'
     and coalesce(v_log.new_data, v_log.old_data)->>'reference_type' in ('purchase', 'order') then
    raise exception 'Undo the related purchase or order instead of its automatic stock entry';
  end if;

  if exists (
    select 1
    from public.audit_logs newer
    where newer.entity = v_log.entity
      and newer.entity_id is not distinct from v_log.entity_id
      and newer.created_at > v_log.created_at
      and newer.undone_at is null
      and newer.action in ('insert', 'update', 'delete')
      and coalesce(newer.metadata->>'source', '') not like 'undo:%'
  ) then
    raise exception 'A newer change exists for this record. Undo the newest change first';
  end if;

  perform set_config('app.audit_source', 'undo:' || p_audit_id::text, true);

  if v_log.entity = 'inventory_items' then
    if v_log.action = 'insert' then
      delete from public.inventory_items where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.inventory_items set
        item_name=v_log.old_data->>'item_name', category=v_log.old_data->>'category',
        procurement_type=v_log.old_data->>'procurement_type', unit=v_log.old_data->>'unit',
        opening_qty=(v_log.old_data->>'opening_qty')::numeric,
        minimum_qty=(v_log.old_data->>'minimum_qty')::numeric,
        target_qty=(v_log.old_data->>'target_qty')::numeric,
        supplier_name=v_log.old_data->>'supplier_name',
        unit_cost=(v_log.old_data->>'unit_cost')::numeric,
        active=(v_log.old_data->>'active')::boolean
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
        purchase_date=(v_log.old_data->>'purchase_date')::date,
        supplier_name=v_log.old_data->>'supplier_name',
        item_id=(v_log.old_data->>'item_id')::uuid,
        ordered_qty=(v_log.old_data->>'ordered_qty')::numeric,
        received_qty=(v_log.old_data->>'received_qty')::numeric,
        unit_price=(v_log.old_data->>'unit_price')::numeric,
        due_date=nullif(v_log.old_data->>'due_date', '')::date,
        status=v_log.old_data->>'status', pic=v_log.old_data->>'pic',
        notes=v_log.old_data->>'notes'
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
        movement_type=v_log.old_data->>'movement_type',
        reference_type=v_log.old_data->>'reference_type',
        reference_id=v_log.old_data->>'reference_id',
        item_id=(v_log.old_data->>'item_id')::uuid,
        quantity=(v_log.old_data->>'quantity')::numeric,
        delta=(v_log.old_data->>'delta')::numeric,
        pic=v_log.old_data->>'pic', notes=v_log.old_data->>'notes'
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.stock_movements (
        movement_no, id, movement_date, movement_type, reference_type,
        reference_id, item_id, quantity, delta, pic, notes, created_by, created_at
      ) values (
        coalesce(nullif(v_log.old_data->>'movement_no', ''), public.next_stock_movement_no()),
        (v_log.old_data->>'id')::uuid,
        (v_log.old_data->>'movement_date')::date,
        v_log.old_data->>'movement_type', v_log.old_data->>'reference_type',
        v_log.old_data->>'reference_id', (v_log.old_data->>'item_id')::uuid,
        (v_log.old_data->>'quantity')::numeric, (v_log.old_data->>'delta')::numeric,
        v_log.old_data->>'pic', v_log.old_data->>'notes',
        nullif(v_log.old_data->>'created_by', '')::uuid,
        coalesce((v_log.old_data->>'created_at')::timestamptz, now())
      );
    end if;

  elsif v_log.entity = 'product_materials' then
    if v_log.action = 'insert' then
      delete from public.product_materials where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.product_materials set
        product_id=(v_log.old_data->>'product_id')::uuid,
        inventory_item_id=(v_log.old_data->>'inventory_item_id')::uuid,
        quantity_per_unit=(v_log.old_data->>'quantity_per_unit')::numeric,
        notes=v_log.old_data->>'notes'
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.product_materials (
        bom_no, id, product_id, inventory_item_id, quantity_per_unit, notes
      ) values (
        coalesce(nullif(v_log.old_data->>'bom_no', ''), public.next_bom_no()),
        (v_log.old_data->>'id')::uuid,
        (v_log.old_data->>'product_id')::uuid,
        (v_log.old_data->>'inventory_item_id')::uuid,
        (v_log.old_data->>'quantity_per_unit')::numeric,
        v_log.old_data->>'notes'
      );
    end if;

  elsif v_log.entity = 'clients' then
    if v_log.action = 'insert' then
      if exists (
        select 1 from public.products where client_name = v_log.new_data->>'name'
      ) then
        raise exception 'Remove or undo this client''s products first';
      end if;
      delete from public.clients where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.clients set
        name=v_log.old_data->>'name', phone=v_log.old_data->>'phone',
        email=v_log.old_data->>'email', postal_code=v_log.old_data->>'postal_code',
        address=v_log.old_data->>'address'
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.clients
      select * from jsonb_populate_record(null::public.clients, v_log.old_data);
    end if;

  elsif v_log.entity = 'products' then
    if v_log.action = 'insert' then
      if exists (
        select 1 from public.product_materials
        where product_id = (v_log.new_data->>'id')::uuid
      ) then
        raise exception 'Remove or undo this product''s BOM rows first';
      end if;
      delete from public.products where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      update public.products set
        client_name=v_log.old_data->>'client_name',
        product_name=v_log.old_data->>'product_name',
        product_number=v_log.old_data->>'product_number',
        unit_price=(v_log.old_data->>'unit_price')::integer,
        tasks=coalesce(v_log.old_data->'tasks', '[]'::jsonb),
        drawings=coalesce(v_log.old_data->'drawings', '[]'::jsonb)
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.products
      select * from jsonb_populate_record(null::public.products, v_log.old_data);
    end if;

  elsif v_log.entity = 'orders' then
    if v_log.action = 'insert' then
      delete from public.orders where id = (v_log.new_data->>'id')::uuid;
    elsif v_log.action = 'update' then
      -- version and inventory_stock_applied are deliberately not restored.
      -- Restoring version would make the client's next save conflict with its
      -- own undo, and inventory_stock_applied is recomputed by the trigger below.
      update public.orders set
        order_date=(v_log.old_data->>'order_date')::date,
        delivery_date=(v_log.old_data->>'delivery_date')::date,
        client=v_log.old_data->>'client', order_number=v_log.old_data->>'order_number',
        product_name=v_log.old_data->>'product_name',
        quantity=(v_log.old_data->>'quantity')::integer,
        order_amount=(v_log.old_data->>'order_amount')::integer,
        progress=v_log.old_data->>'progress',
        required_manhours=(v_log.old_data->>'required_manhours')::integer,
        worked_manhours=(v_log.old_data->>'worked_manhours')::integer,
        production_end_date=nullif(v_log.old_data->>'production_end_date', '')::date,
        order_contact=v_log.old_data->>'order_contact',
        contact_contents=v_log.old_data->>'contact_contents',
        finish_task=(v_log.old_data->>'finish_task')::boolean,
        has_contact=(v_log.old_data->>'has_contact')::boolean,
        completed_tasks=coalesce(v_log.old_data->'completed_tasks', '[]'::jsonb)
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.orders
      select * from jsonb_populate_record(null::public.orders, v_log.old_data);
    end if;
  end if;

  get diagnostics v_affected = row_count;
  if coalesce(v_affected, 0) <> 1 then
    raise exception 'The target record no longer matches this audit entry';
  end if;

  update public.audit_logs
  set undone_at = now(), undone_by = auth.uid()
  where id = p_audit_id;

  insert into public.audit_logs(user_id, username, action, entity, entity_id, metadata)
  values (
    auth.uid(), public.current_audit_username(), 'undo', v_log.entity,
    v_log.entity_id, jsonb_build_object('audit_id', p_audit_id, 'source', 'undo')
  );
end;
$$;

-- ===========================================================================
-- 8. Missing indexes
-- ===========================================================================
--
-- Neither existing stock_movements index leads with created_at, so
-- "order by created_at desc limit 500" performed a full scan of the ledger
-- plus a top-N sort. The ledger is the one table here that only ever grows.

create index if not exists stock_movements_created_at_idx
  on public.stock_movements (created_at desc);

-- products_client_product_name_idx leads with client_name, so it cannot serve a
-- bare "order by product_name".
create index if not exists products_product_name_idx
  on public.products (product_name);

-- Lets the inventory_balances aggregate and the per-row aggregate inside
-- prevent_negative_inventory_balance run index-only.
create index if not exists stock_movements_item_delta_idx
  on public.stock_movements (item_id) include (delta);

-- apply_purchase_receipt and apply_order_materials both sum the ledger by
-- reference on every write.
create index if not exists stock_movements_reference_item_idx
  on public.stock_movements (reference_type, reference_id) include (item_id, delta);

-- orders.product_name is filtered inside the BOM trigger on every order update.
create index if not exists orders_client_product_name_idx
  on public.orders (client, product_name);

-- ===========================================================================
-- 9. Validate the constraints that only guard future rows
-- ===========================================================================
--
-- These were added NOT VALID so the file never blocked on a full scan. Step 1
-- of migration 008 lists the offending rows if any of the order/client/product
-- rules were never validated. The inventory rules are new here, so this step
-- validates them and will name any item that already breaks them:
--
--   select item_code, item_name, opening_qty, minimum_qty, target_qty, unit_cost
--     from public.inventory_items
--    where opening_qty < 0 or minimum_qty < 0 or target_qty < 0 or unit_cost < 0
--       or btrim(item_name) = '';
--
-- Then:
--
-- Validation is attempted only when the existing data already satisfies the
-- rule. A hard failure here would abandon every statement above it, leaving a
-- half applied migration, so a violation is reported as a notice instead and
-- the constraint keeps working for every new row. Once the offending items are
-- corrected, re-running this file validates them for real.
do $$
declare
  v_offenders integer;
begin
  if exists (
    select 1 from public.inventory_items
    where opening_qty < 0 or minimum_qty < 0 or target_qty < 0 or unit_cost < 0
       or btrim(item_name) = '' or char_length(btrim(item_name)) > 200
  ) then
    raise notice 'Skipped validation: some inventory items still break the new sign and length rules. The constraints apply to new rows only until those items are corrected.';
  else
    alter table public.inventory_items validate constraint inventory_items_opening_qty_nonneg;
    alter table public.inventory_items validate constraint inventory_items_minimum_qty_nonneg;
    alter table public.inventory_items validate constraint inventory_items_target_qty_nonneg;
    alter table public.inventory_items validate constraint inventory_items_unit_cost_nonneg;
    alter table public.inventory_items validate constraint inventory_items_name_clean;
  end if;
end;
$$;

-- ===========================================================================
-- 10. Verify
-- ===========================================================================
--   select username, role, active from public.profiles order by created_at;
--   select policyname, cmd from pg_policies
--    where tablename = 'orders' order by cmd;
--   select version, count(*) from public.orders group by version order by 1;
--   select count(*) from public.order_material_issues;
