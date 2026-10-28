-- Match the client workbook: one BOM level per production operation.
-- Existing order snapshots and historical stock movements stay unchanged.

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
        select 1 from public.product_materials where product_id = v_product_id and parent_bom_no is null
      ) then
        raise exception 'Product % has no material BOM. Add its materials in Product Master before starting production',
          v_product_name using errcode = '23514';
      end if;

      insert into public.order_material_issues (order_id, inventory_item_id, quantity_per_unit)
      -- Each production operation issues only its immediate components.
      -- Subassemblies are produced separately against their own product BOM.
      select v_order_id, inventory_item_id, sum(quantity_per_unit)
      from public.product_materials
      where product_id = v_product_id and parent_bom_no is null
      group by inventory_item_id
      on conflict (order_id, inventory_item_id) do update
        set quantity_per_unit = excluded.quantity_per_unit;

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
revoke all on function public.apply_order_materials() from public, anon, authenticated;
