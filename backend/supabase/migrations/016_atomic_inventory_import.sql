-- Apply a validated Excel batch in one transaction. Any failing row rolls back all rows.

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
        insert into public.product_materials (id, product_id, inventory_item_id, quantity_per_unit, notes)
        values ((v_payload->>'id')::uuid, (v_payload->>'productId')::uuid,
          (v_payload->>'inventoryItemId')::uuid, (v_payload->>'quantityPerUnit')::numeric,
          btrim(coalesce(v_payload->>'notes', '')));
      else
        update public.product_materials set
          product_id = (v_payload->>'productId')::uuid,
          inventory_item_id = (v_payload->>'inventoryItemId')::uuid,
          quantity_per_unit = (v_payload->>'quantityPerUnit')::numeric,
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

revoke all on function public.import_inventory_rows(jsonb) from public, anon;
grant execute on function public.import_inventory_rows(jsonb) to authenticated;

create or replace function public.undo_capabilities()
returns jsonb language sql security definer set search_path = public stable
as $$
  select jsonb_build_object(
    'version', 7, 'all_active_roles', true, 'negative_stock_guard', true,
    'production_bom_usage', true, 'security_role_separation', true,
    'order_optimistic_concurrency', true, 'manual_movement_idempotency', true,
    'realtime_postgres_changes', true, 'atomic_inventory_import', true,
    'entities', jsonb_build_array('clients', 'products', 'orders', 'inventory_items',
      'purchases', 'stock_movements', 'product_materials', 'profiles')
  );
$$;
revoke all on function public.undo_capabilities() from public, anon;
grant execute on function public.undo_capabilities() to authenticated;
