-- Safe undo for every active role and every operational input table.
-- Run after 004_business_number_permissions.sql.

-- Operators can inspect their own history. Administrators retain the full
-- cross-user audit view. The write surface remains the SECURITY DEFINER RPC.
drop policy if exists "administrators read audit" on public.audit_logs;
drop policy if exists "active users read permitted audit" on public.audit_logs;
create policy "active users read permitted audit" on public.audit_logs
  for select to authenticated
  using (
    public.is_active_user()
    and (user_id = auth.uid() or public.is_administrator())
  );

-- Avoid implicit cascade deletes that would turn one accidental click into
-- several deleted records. Dependent BOM/product rows must be removed first,
-- and each removal then receives its own undoable audit entry.
alter table public.products
  drop constraint if exists products_client_name_fkey;
alter table public.products
  add constraint products_client_name_fkey
  foreign key (client_name) references public.clients(name)
  on update cascade on delete restrict;

alter table public.product_materials
  drop constraint if exists product_materials_product_id_fkey;
alter table public.product_materials
  add constraint product_materials_product_id_fkey
  foreign key (product_id) references public.products(id)
  on delete restrict;

create index if not exists purchases_item_id_idx
  on public.purchases(item_id);
create index if not exists product_materials_inventory_item_id_idx
  on public.product_materials(inventory_item_id);

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

  -- Prevent an older edit from overwriting a newer user action on the same
  -- record. Undo must proceed newest-to-oldest for each record.
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
        select 1 from public.products
        where client_name = v_log.new_data->>'name'
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
  if v_affected <> 1 then
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

revoke all on function public.undo_audit_entry(uuid) from public, anon;
grant execute on function public.undo_audit_entry(uuid) to authenticated;

create or replace function public.undo_capabilities()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'version', 2,
    'all_active_roles', true,
    'entities', jsonb_build_array(
      'clients', 'products', 'orders', 'inventory_items',
      'purchases', 'stock_movements', 'product_materials'
    )
  );
$$;

revoke all on function public.undo_capabilities() from public, anon;
grant execute on function public.undo_capabilities() to authenticated;
