-- Keep orders attached to their product record even if its display name changes.
alter table public.orders add column if not exists product_id uuid;

do $$
begin
  perform set_config('app.audit_source', 'migration:031', true);
  update public.orders o
  set product_id = p.id
  from public.products p
  where p.client_name = o.client
    and p.product_name = o.product_name
    and o.product_id is null;

  if exists (select 1 from public.orders where product_id is null) then
    raise exception 'Cannot link every existing order to a product master row';
  end if;
end;
$$;

alter table public.orders alter column product_id set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_product_id_fkey') then
    alter table public.orders add constraint orders_product_id_fkey
      foreign key (product_id) references public.products(id) on delete restrict;
  end if;
end;
$$;
create index if not exists orders_product_id_idx on public.orders(product_id);

create or replace function public.resolve_order_product()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_product_id uuid;
begin
  if tg_op = 'INSERT' then
    select p.id into v_product_id from public.products p
    where p.client_name = new.client and p.product_name = new.product_name;
    if new.product_id is not null and new.product_id is distinct from v_product_id then
      raise exception 'Selected product does not match the order client and product name' using errcode = '23503';
    end if;
    new.product_id := v_product_id;
  elsif new.product_id is distinct from old.product_id then
    if not exists (select 1 from public.products p where p.id = new.product_id
      and p.client_name = new.client and p.product_name = new.product_name) then
      raise exception 'Selected product does not match the order client and product name' using errcode = '23503';
    end if;
  elsif new.client is distinct from old.client or new.product_name is distinct from old.product_name then
    select p.id into v_product_id from public.products p
    where p.client_name = new.client and p.product_name = new.product_name;
    new.product_id := v_product_id;
  end if;

  if new.product_id is null then
    raise exception 'Product % for client % was not found in Product Master', new.product_name, new.client using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_resolve_product on public.orders;
create trigger orders_resolve_product before insert or update of client, product_name, product_id
on public.orders for each row execute function public.resolve_order_product();
revoke all on function public.resolve_order_product() from public, anon, authenticated;

-- Material issuance now follows the immutable product FK instead of matching
-- mutable client/product labels. Keep the current direct-component BOM rules.
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
  v_product_name text;
  v_quantity numeric(14,3);
  v_should_apply boolean;
begin
  if tg_op = 'DELETE' then
    v_order_id := old.id;
    v_order_number := old.order_number;
    v_product_id := old.product_id;
    v_product_name := old.product_name;
    v_quantity := old.quantity;
    v_should_apply := false;
  else
    v_order_id := new.id;
    v_order_number := new.order_number;
    v_product_id := new.product_id;
    v_product_name := new.product_name;
    v_quantity := new.quantity;
    v_should_apply := new.progress in ('In production', 'Complete', 'Shipped');
  end if;

  if v_should_apply then
    if not exists (select 1 from public.products where id = v_product_id) then
      raise exception 'Product for order % was not found in Product Master', v_order_number using errcode = '23503';
    end if;
    if not exists (select 1 from public.order_material_issues where order_id = v_order_id) then
      if not exists (select 1 from public.product_materials where product_id = v_product_id and parent_bom_no is null) then
        raise exception 'Product % has no material BOM. Add its materials in Product Master before starting production',
          v_product_name using errcode = '23514';
      end if;
      insert into public.order_material_issues (order_id, inventory_item_id, quantity_per_unit)
      select v_order_id, inventory_item_id, sum(quantity_per_unit)
      from public.product_materials
      where product_id = v_product_id and parent_bom_no is null
      group by inventory_item_id
      on conflict (order_id, inventory_item_id) do update
        set quantity_per_unit = excluded.quantity_per_unit;
      if not exists (select 1 from public.order_material_issues where order_id = v_order_id) then
        raise exception 'Product % has no material BOM. Add its materials in Product Master before starting production',
          v_product_name using errcode = '23514';
      end if;
    end if;
    perform 1 from public.inventory_items i
    join public.order_material_issues omi on omi.inventory_item_id = i.id
    where omi.order_id = v_order_id order by i.id for update of i;
  end if;

  for v_row in
    with current_totals as (
      select item_id, coalesce(sum(delta), 0)::numeric as current_delta
      from public.stock_movements
      where reference_type = 'order' and reference_id = v_order_id::text
        and movement_type in ('order_material_issue', 'order_material_reversal')
      group by item_id
    ), desired as (
      select omi.inventory_item_id as item_id, -(omi.quantity_per_unit * v_quantity)::numeric as desired_delta
      from public.order_material_issues omi where v_should_apply and omi.order_id = v_order_id
    )
    select coalesce(c.item_id, d.item_id) as item_id,
      coalesce(d.desired_delta, 0) - coalesce(c.current_delta, 0) as adjustment
    from current_totals c full join desired d on d.item_id = c.item_id
    order by coalesce(c.item_id, d.item_id)
  loop
    if v_row.adjustment <> 0 then
      insert into public.stock_movements(movement_date, movement_type, reference_type, reference_id,
        item_id, quantity, delta, pic, notes)
      values (current_date,
        case when v_row.adjustment < 0 then 'order_material_issue' else 'order_material_reversal' end,
        'order', v_order_id::text, v_row.item_id, abs(v_row.adjustment), v_row.adjustment,
        public.current_audit_username(), 'Automatic BOM reconciliation for order ' || v_order_number);
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  new.inventory_stock_applied := v_should_apply;
  return new;
end;
$$;
revoke all on function public.apply_order_materials() from public, anon, authenticated;

-- Extend the existing safe undo implementation without weakening its checks.
alter function public.undo_audit_entry(uuid) rename to undo_audit_entry_legacy;
revoke all on function public.undo_audit_entry_legacy(uuid) from public, anon, authenticated;

create function public.undo_audit_entry(p_audit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log public.audit_logs%rowtype;
  v_affected integer;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Active account required'; end if;
  select * into v_log from public.audit_logs where id = p_audit_id for update;
  if not found then raise exception 'Audit entry not found'; end if;
  if not public.is_administrator() and v_log.user_id is distinct from auth.uid() then
    raise exception 'Operators can only undo their own activity';
  end if;
  if v_log.undone_at is not null then raise exception 'This action was already undone'; end if;
  if v_log.action not in ('insert', 'update', 'delete') then raise exception 'This audit action cannot be undone'; end if;
  if coalesce(v_log.metadata->>'source', '') like 'undo:%' then raise exception 'An undo-generated change cannot be undone again'; end if;

  if v_log.entity in ('production_tasks', 'manufacturing_operations', 'production_costs') then
    if exists (
      select 1 from public.audit_logs newer
      where newer.entity = v_log.entity and newer.entity_id is not distinct from v_log.entity_id
        and newer.created_at > v_log.created_at and newer.undone_at is null
        and newer.action in ('insert', 'update', 'delete')
        and coalesce(newer.metadata->>'source', '') not like 'undo:%'
    ) then raise exception 'A newer change exists for this record. Undo the newest change first'; end if;

    perform set_config('app.audit_source', 'undo:' || p_audit_id::text, true);
    if v_log.entity = 'production_tasks' then
      if v_log.action = 'insert' then
        delete from public.production_tasks where id = (v_log.new_data->>'id')::uuid;
      elsif v_log.action = 'update' then
        update public.production_tasks set order_id=(v_log.old_data->>'order_id')::uuid,
          operation_id=(v_log.old_data->>'operation_id')::uuid, status=v_log.old_data->>'status',
          actual_minutes=nullif(v_log.old_data->>'actual_minutes','')::numeric,
          operator_id=nullif(v_log.old_data->>'operator_id','')::uuid,
          completed_at=nullif(v_log.old_data->>'completed_at','')::timestamptz
        where id=(v_log.old_data->>'id')::uuid;
      else
        insert into public.production_tasks(id,order_id,operation_id,status,actual_minutes,operator_id,completed_at,created_at)
        values ((v_log.old_data->>'id')::uuid,(v_log.old_data->>'order_id')::uuid,
          (v_log.old_data->>'operation_id')::uuid,v_log.old_data->>'status',
          nullif(v_log.old_data->>'actual_minutes','')::numeric,nullif(v_log.old_data->>'operator_id','')::uuid,
          nullif(v_log.old_data->>'completed_at','')::timestamptz,coalesce(nullif(v_log.old_data->>'created_at','')::timestamptz,now()));
      end if;
    elsif v_log.entity = 'manufacturing_operations' then
      if v_log.action = 'insert' then
        delete from public.manufacturing_operations where id=(v_log.new_data->>'id')::uuid;
      elsif v_log.action = 'update' then
        update public.manufacturing_operations set operation_code=v_log.old_data->>'operation_code',
          operation_name=v_log.old_data->>'operation_name', operation_name_ja=v_log.old_data->>'operation_name_ja',
          base_time_charge_jpy=(v_log.old_data->>'base_time_charge_jpy')::numeric,
          default_minutes=nullif(v_log.old_data->>'default_minutes','')::numeric,
          sequence=(v_log.old_data->>'sequence')::integer, is_active=(v_log.old_data->>'is_active')::boolean
        where id=(v_log.old_data->>'id')::uuid;
      else
        insert into public.manufacturing_operations(id,operation_code,operation_name,operation_name_ja,
          base_time_charge_jpy,default_minutes,sequence,is_active,created_at)
        values ((v_log.old_data->>'id')::uuid,v_log.old_data->>'operation_code',v_log.old_data->>'operation_name',
          coalesce(v_log.old_data->>'operation_name_ja',''),(v_log.old_data->>'base_time_charge_jpy')::numeric,
          nullif(v_log.old_data->>'default_minutes','')::numeric,(v_log.old_data->>'sequence')::integer,
          (v_log.old_data->>'is_active')::boolean,coalesce(nullif(v_log.old_data->>'created_at','')::timestamptz,now()));
      end if;
    else
      if v_log.action = 'insert' then
        delete from public.production_costs where id=(v_log.new_data->>'id')::uuid;
      elsif v_log.action = 'update' then
        update public.production_costs set order_id=(v_log.old_data->>'order_id')::uuid,
          outsourcing_cost_jpy=(v_log.old_data->>'outsourcing_cost_jpy')::numeric,
          notes=coalesce(v_log.old_data->>'notes',''), created_by=nullif(v_log.old_data->>'created_by','')::uuid
        where id=(v_log.old_data->>'id')::uuid;
      else
        insert into public.production_costs(id,order_id,outsourcing_cost_jpy,notes,created_by,created_at)
        values ((v_log.old_data->>'id')::uuid,(v_log.old_data->>'order_id')::uuid,
          (v_log.old_data->>'outsourcing_cost_jpy')::numeric,coalesce(v_log.old_data->>'notes',''),
          nullif(v_log.old_data->>'created_by','')::uuid,coalesce(nullif(v_log.old_data->>'created_at','')::timestamptz,now()));
      end if;
    end if;
    get diagnostics v_affected = row_count;
    if coalesce(v_affected,0) <> 1 then raise exception 'The target record no longer matches this audit entry'; end if;
    update public.audit_logs set undone_at=now(), undone_by=auth.uid() where id=p_audit_id;
    insert into public.audit_logs(user_id,username,action,entity,entity_id,metadata)
    values (auth.uid(),public.current_audit_username(),'undo',v_log.entity,v_log.entity_id,
      jsonb_build_object('audit_id',p_audit_id,'source','undo'));
    return;
  end if;

  perform public.undo_audit_entry_legacy(p_audit_id);
  -- The legacy routine predates these columns. Restore them in the same
  -- transaction; its audit_source makes these follow-up writes non-undoable.
  if v_log.entity = 'products' and v_log.action = 'update' then
    update public.products set internal_company_name=coalesce(v_log.old_data->>'internal_company_name','')
    where id=(v_log.old_data->>'id')::uuid;
  elsif v_log.entity = 'product_materials' and v_log.action = 'update' then
    update public.product_materials set component_product_id=nullif(v_log.old_data->>'component_product_id','')::uuid
    where id=(v_log.old_data->>'id')::uuid;
  end if;
end;
$$;

revoke all on function public.undo_audit_entry(uuid) from public, anon;
grant execute on function public.undo_audit_entry(uuid) to authenticated;

create or replace function public.undo_capabilities()
returns jsonb language sql security definer set search_path = public stable
as $$
  select jsonb_build_object(
    'version', 9, 'all_active_roles', true, 'negative_stock_guard', true,
    'production_bom_usage', true, 'security_role_separation', true,
    'order_optimistic_concurrency', true, 'manual_movement_idempotency', true,
    'realtime_postgres_changes', true, 'atomic_inventory_import', true,
    'entities', jsonb_build_array('clients','products','orders','inventory_items','purchases',
      'stock_movements','product_materials','profiles','production_tasks','manufacturing_operations','production_costs')
  );
$$;
