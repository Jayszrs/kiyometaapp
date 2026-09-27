-- Product BOM integration, production-stage material usage, and negative-stock protection.
-- Run after 006_employee_profiles.sql.

create index if not exists stock_movements_reference_idx
  on public.stock_movements(reference_type, reference_id);
create index if not exists products_client_product_name_idx
  on public.products(client_name, product_name);

-- Serialize every balance-reducing ledger change through the inventory item
-- row. This prevents two concurrent operators from both passing a stale stock
-- check and creating a negative balance.
create or replace function public.prevent_negative_inventory_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  v_first_item_id uuid;
  v_second_item_id uuid;
  v_available numeric(14,3);
  v_future numeric(14,3);
  v_item_code text;
begin
  if tg_op = 'INSERT' then
    v_first_item_id := new.item_id;
  elsif tg_op = 'DELETE' then
    v_first_item_id := old.item_id;
  else
    v_first_item_id := old.item_id;
    v_second_item_id := new.item_id;
  end if;

  -- Lock affected items in deterministic UUID order to avoid deadlocks.
  for v_item_id in
    select id from public.inventory_items
    where id = v_first_item_id or id = v_second_item_id
    order by id
    for update
  loop
    select i.item_code,
           i.opening_qty + coalesce(sum(m.delta), 0)
      into v_item_code, v_available
    from public.inventory_items i
    left join public.stock_movements m on m.item_id = i.id
    where i.id = v_item_id
    group by i.item_code, i.opening_qty;

    if tg_op = 'INSERT' then
      v_future := v_available + new.delta;
    elsif tg_op = 'DELETE' then
      v_future := v_available - old.delta;
    elsif old.item_id = new.item_id then
      v_future := v_available - old.delta + new.delta;
    elsif v_item_id = old.item_id then
      v_future := v_available - old.delta;
    else
      v_future := v_available + new.delta;
    end if;

    if v_future < 0 then
      raise exception 'Insufficient stock for %. Available: %, resulting balance: %',
        v_item_code, v_available, v_future
        using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_prevent_negative on public.stock_movements;
create trigger stock_movements_prevent_negative
  before insert or update or delete on public.stock_movements
  for each row execute function public.prevent_negative_inventory_balance();

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
    if not exists (
      select 1 from public.product_materials where product_id = v_product_id
    ) then
      raise exception 'Product % has no material BOM. Add its materials in Product Master before starting production',
        v_product_name using errcode = '23514';
    end if;

    -- Lock the whole BOM in a consistent order before reconciling ledger rows.
    perform 1
    from public.inventory_items i
    join public.product_materials pm on pm.inventory_item_id = i.id
    where pm.product_id = v_product_id
    order by i.id
    for update of i;
  end if;

  -- Reconcile rather than blindly post. Re-saving the same status is
  -- idempotent; changing quantity only posts the difference; moving an order
  -- back before production restores the previously issued materials.
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

drop trigger if exists orders_apply_materials on public.orders;
create trigger orders_apply_materials
  before insert or update of progress, quantity, product_name, client or delete on public.orders
  for each row execute function public.apply_order_materials();

create or replace function public.undo_capabilities()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'version', 4,
    'all_active_roles', true,
    'negative_stock_guard', true,
    'production_bom_usage', true,
    'entities', jsonb_build_array(
      'clients', 'products', 'orders', 'inventory_items', 'purchases',
      'stock_movements', 'product_materials', 'profiles'
    )
  );
$$;

revoke all on function public.undo_capabilities() from public, anon;
grant execute on function public.undo_capabilities() to authenticated;
