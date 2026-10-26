-- Structured parent-child BOMs and retirement of the intermediate Receipt state.
-- Legacy Receipt orders remain readable and are normalized to Order request by the client.

alter table public.product_materials add column if not exists parent_bom_no text;

-- BOM numbers are globally unique, and this composite key also ensures a parent
-- belongs to the same product as its child.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'product_materials_bom_product_key') then
    alter table public.product_materials add constraint product_materials_bom_product_key unique (bom_no, product_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'product_materials_parent_product_fkey') then
    alter table public.product_materials add constraint product_materials_parent_product_fkey
      foreign key (parent_bom_no, product_id)
      references public.product_materials (bom_no, product_id) on delete cascade;
  end if;
end $$;

alter table public.product_materials drop constraint if exists product_materials_product_id_inventory_item_id_key;
create unique index if not exists product_materials_branch_item_key
  on public.product_materials (product_id, coalesce(parent_bom_no, ''), inventory_item_id);

create or replace function public.prevent_bom_cycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.parent_bom_no is null then return new; end if;
  if new.parent_bom_no = new.bom_no then raise exception 'A BOM component cannot be its own parent'; end if;
  if exists (
    with recursive ancestors(bom_no, parent_bom_no) as (
      select bom_no, parent_bom_no from public.product_materials
       where bom_no = new.parent_bom_no and product_id = new.product_id
      union all
      select p.bom_no, p.parent_bom_no from public.product_materials p
       join ancestors a on p.bom_no = a.parent_bom_no
      where p.product_id = new.product_id
    ) select 1 from ancestors where bom_no = new.bom_no
  ) then raise exception 'BOM parent would create a cycle'; end if;
  return new;
end $$;
drop trigger if exists product_materials_prevent_bom_cycle on public.product_materials;
create trigger product_materials_prevent_bom_cycle before insert or update of parent_bom_no, product_id
  on public.product_materials for each row execute function public.prevent_bom_cycle();


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

  if new.progress = 'Receipt' and old.progress <> 'Receipt' then
    raise exception 'Receipt is retired; use Order request' using errcode = '23514';
  end if;

  v_old_rank := case old.progress
    when 'Order request' then 1
    when 'Receipt' then 1
    when 'In preparation' then 2
    when 'Preparation complete' then 3
    when 'In production' then 4
    when 'Complete' then 5
    when 'Shipped' then 6
    else 0
  end;
  v_rank := case new.progress
    when 'Order request' then 1
    when 'Receipt' then 1
    when 'In preparation' then 2
    when 'Preparation complete' then 3
    when 'In production' then 4
    when 'Complete' then 5
    when 'Shipped' then 6
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
revoke all on function public.enforce_order_progress_transition() from public, anon, authenticated;

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
      with recursive tree(bom_no, product_id, inventory_item_id, extended_qty) as (
        select bom_no, product_id, inventory_item_id, quantity_per_unit
        from public.product_materials
        where product_id = v_product_id and parent_bom_no is null
        union all
        select child.bom_no, child.product_id, child.inventory_item_id,
               tree.extended_qty * child.quantity_per_unit
        from public.product_materials child
        join tree on child.parent_bom_no = tree.bom_no and child.product_id = tree.product_id
      ), leaves as (
        select tree.inventory_item_id, sum(tree.extended_qty) as quantity_per_unit
        from tree
        where not exists (select 1 from public.product_materials child
          where child.parent_bom_no = tree.bom_no and child.product_id = tree.product_id)
        group by tree.inventory_item_id
      )
      select v_order_id, inventory_item_id, quantity_per_unit from leaves
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
        parent_bom_no=nullif(v_log.old_data->>'parent_bom_no', ''),
        notes=v_log.old_data->>'notes'
      where id = (v_log.old_data->>'id')::uuid;
    else
      insert into public.product_materials (
        bom_no, id, product_id, inventory_item_id, quantity_per_unit, parent_bom_no, notes
      ) values (
        coalesce(nullif(v_log.old_data->>'bom_no', ''), public.next_bom_no()),
        (v_log.old_data->>'id')::uuid,
        (v_log.old_data->>'product_id')::uuid,
        (v_log.old_data->>'inventory_item_id')::uuid,
        (v_log.old_data->>'quantity_per_unit')::numeric,
        nullif(v_log.old_data->>'parent_bom_no', ''),
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
create or replace function public.import_inventory_rows(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_payload jsonb;
  v_kind text;
  v_existing_id uuid;
  v_count integer := 0;
begin
  if not (select public.is_active_user()) then
    raise exception 'Your account is not active' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Import rows must be an array' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_kind := v_row->>'kind';
    v_payload := v_row->'payload';
    v_existing_id := nullif(v_row->>'existingId', '')::uuid;

    if v_kind = 'inventory' then
      if v_existing_id is null then
        insert into public.inventory_items (
          id, item_name, category, procurement_type, unit, opening_qty,
          minimum_qty, target_qty, supplier_name, unit_cost, active
        ) values (
          (v_payload->>'id')::uuid, btrim(v_payload->>'itemName'), v_payload->>'category',
          v_payload->>'procurementType', btrim(v_payload->>'unit'), (v_payload->>'openingQty')::numeric,
          (v_payload->>'minimumQty')::numeric, (v_payload->>'targetQty')::numeric,
          btrim(coalesce(v_payload->>'supplierName', '')), (v_payload->>'unitCost')::numeric,
          (v_payload->>'active')::boolean
        );
      else
        update public.inventory_items set
          item_name = btrim(v_payload->>'itemName'), category = v_payload->>'category',
          procurement_type = v_payload->>'procurementType', unit = btrim(v_payload->>'unit'),
          opening_qty = (v_payload->>'openingQty')::numeric,
          minimum_qty = (v_payload->>'minimumQty')::numeric,
          target_qty = (v_payload->>'targetQty')::numeric,
          supplier_name = btrim(coalesce(v_payload->>'supplierName', '')),
          unit_cost = (v_payload->>'unitCost')::numeric,
          active = (v_payload->>'active')::boolean, updated_at = now()
        where id = v_existing_id;
        if not found then raise exception 'Inventory item % was changed or removed', v_existing_id using errcode = 'P0002'; end if;
      end if;
    elsif v_kind = 'purchases' then
      if v_existing_id is null then
        insert into public.purchases (
          id, purchase_date, supplier_name, item_id, ordered_qty, received_qty,
          unit_price, due_date, status, pic, notes
        ) values (
          (v_payload->>'id')::uuid, (v_payload->>'purchaseDate')::date,
          btrim(v_payload->>'supplierName'), (v_payload->>'itemId')::uuid,
          (v_payload->>'orderedQty')::numeric, (v_payload->>'receivedQty')::numeric,
          (v_payload->>'unitPrice')::numeric, nullif(v_payload->>'dueDate', '')::date,
          v_payload->>'status', btrim(coalesce(v_payload->>'pic', '')),
          btrim(coalesce(v_payload->>'notes', ''))
        );
      else
        update public.purchases set
          purchase_date = (v_payload->>'purchaseDate')::date,
          supplier_name = btrim(v_payload->>'supplierName'), item_id = (v_payload->>'itemId')::uuid,
          ordered_qty = (v_payload->>'orderedQty')::numeric,
          received_qty = (v_payload->>'receivedQty')::numeric,
          unit_price = (v_payload->>'unitPrice')::numeric,
          due_date = nullif(v_payload->>'dueDate', '')::date, status = v_payload->>'status',
          pic = btrim(coalesce(v_payload->>'pic', '')), notes = btrim(coalesce(v_payload->>'notes', '')),
          updated_at = now()
        where id = v_existing_id;
        if not found then raise exception 'Purchase % was changed or removed', v_existing_id using errcode = 'P0002'; end if;
      end if;
    elsif v_kind = 'movements' then
      perform public.record_stock_movement(
        (v_payload->>'movementDate')::date, v_payload->>'movementType', v_payload->>'referenceId',
        (v_payload->>'itemId')::uuid, (v_payload->>'quantity')::numeric,
        (v_payload->>'delta')::numeric, v_payload->>'pic', v_payload->>'notes',
        (v_payload->>'idempotencyKey')::uuid
      );
    elsif v_kind = 'bom' then
      if v_existing_id is null then
        insert into public.product_materials (id, product_id, inventory_item_id, quantity_per_unit, parent_bom_no, notes)
        values ((v_payload->>'id')::uuid, (v_payload->>'productId')::uuid,
          (v_payload->>'inventoryItemId')::uuid, (v_payload->>'quantityPerUnit')::numeric,
          nullif(v_payload->>'parentBomNo', ''), btrim(coalesce(v_payload->>'notes', '')));
      else
        update public.product_materials set
          product_id = (v_payload->>'productId')::uuid,
          inventory_item_id = (v_payload->>'inventoryItemId')::uuid,
          quantity_per_unit = (v_payload->>'quantityPerUnit')::numeric,
          parent_bom_no = nullif(v_payload->>'parentBomNo', ''),
          notes = btrim(coalesce(v_payload->>'notes', ''))
        where id = v_existing_id;
        if not found then raise exception 'BOM item % was changed or removed', v_existing_id using errcode = 'P0002'; end if;
      end if;
    else
      raise exception 'Unsupported import row kind: %', coalesce(v_kind, '<missing>') using errcode = '22023';
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
create or replace function public.undo_capabilities()
returns jsonb language sql security definer set search_path = public stable
as $$
  select jsonb_build_object(
    'version', 8, 'all_active_roles', true, 'negative_stock_guard', true,
    'production_bom_usage', true, 'security_role_separation', true,
    'order_optimistic_concurrency', true, 'manual_movement_idempotency', true,
    'realtime_postgres_changes', true, 'atomic_inventory_import', true,
    'entities', jsonb_build_array('clients', 'products', 'orders', 'inventory_items',
      'purchases', 'stock_movements', 'product_materials', 'profiles')
  );
$$;
revoke all on function public.import_inventory_rows(jsonb) from public, anon;
grant execute on function public.import_inventory_rows(jsonb) to authenticated;
revoke all on function public.undo_audit_entry(uuid) from public, anon;
grant execute on function public.undo_audit_entry(uuid) to authenticated;
revoke all on function public.undo_capabilities() from public, anon;
grant execute on function public.undo_capabilities() to authenticated;
