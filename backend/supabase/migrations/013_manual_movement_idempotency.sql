-- Make retried manual stock writes exactly-once and enforce ledger invariants.

alter table public.stock_movements
  add column if not exists idempotency_key uuid;

alter table public.stock_movements
  drop constraint if exists stock_movements_idempotency_key_key;
alter table public.stock_movements
  add constraint stock_movements_idempotency_key_key unique (idempotency_key);

alter table public.stock_movements
  drop constraint if exists stock_movements_quantity_matches_delta;
alter table public.stock_movements
  add constraint stock_movements_quantity_matches_delta
  check (quantity = abs(delta)) not valid;
alter table public.stock_movements
  validate constraint stock_movements_quantity_matches_delta;

create or replace function public.record_stock_movement(
  p_movement_date date,
  p_movement_type text,
  p_reference_id text,
  p_item_id uuid,
  p_quantity numeric,
  p_delta numeric,
  p_pic text,
  p_notes text,
  p_idempotency_key uuid
)
returns public.stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stock_movements;
  v_date date := coalesce(p_movement_date, current_date);
  v_reference_id text := nullif(btrim(coalesce(p_reference_id, '')), '');
  v_pic text := btrim(coalesce(p_pic, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
begin
  if not (select public.is_active_user()) then
    raise exception 'Your account is not active' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'A request id is required' using errcode = '23514';
  end if;
  if p_movement_type not in (
    'material_issue', 'production_output', 'subcontract_out', 'subcontract_in',
    'sale_shipment', 'adjustment_in', 'adjustment_out'
  ) then
    raise exception 'Movement type % is posted by the related document, not manually', p_movement_type
      using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_delta is null or p_delta = 0
     or p_quantity <> abs(p_delta) then
    raise exception 'Quantity must be positive and equal the absolute adjustment' using errcode = '23514';
  end if;
  if (p_movement_type in ('production_output', 'subcontract_in', 'adjustment_in') and p_delta < 0)
     or (p_movement_type in ('material_issue', 'subcontract_out', 'sale_shipment', 'adjustment_out') and p_delta > 0) then
    raise exception 'Adjustment direction does not match movement type' using errcode = '23514';
  end if;
  if p_item_id is null then
    raise exception 'Choose an inventory item' using errcode = '23514';
  end if;

  insert into public.stock_movements (
    movement_date, movement_type, reference_type, reference_id, item_id,
    quantity, delta, pic, notes, idempotency_key
  ) values (
    v_date, p_movement_type, 'manual', v_reference_id, p_item_id,
    p_quantity, p_delta, v_pic, v_notes, p_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row
    from public.stock_movements
    where idempotency_key = p_idempotency_key;

    if v_row.movement_date is distinct from v_date
       or v_row.movement_type is distinct from p_movement_type
       or v_row.reference_type is distinct from 'manual'
       or v_row.reference_id is distinct from v_reference_id
       or v_row.item_id is distinct from p_item_id
       or v_row.quantity is distinct from p_quantity
       or v_row.delta is distinct from p_delta
       or v_row.pic is distinct from v_pic
       or v_row.notes is distinct from v_notes then
      raise exception 'Request id was already used for different movement data' using errcode = '23505';
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.record_stock_movement(date, text, text, uuid, numeric, numeric, text, text) from authenticated;
revoke all on function public.record_stock_movement(date, text, text, uuid, numeric, numeric, text, text, uuid) from public, anon;
grant execute on function public.record_stock_movement(date, text, text, uuid, numeric, numeric, text, text, uuid) to authenticated;

create or replace function public.undo_capabilities()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'version', 5,
    'all_active_roles', true,
    'negative_stock_guard', true,
    'production_bom_usage', true,
    'security_role_separation', true,
    'order_optimistic_concurrency', true,
    'manual_movement_idempotency', true,
    'entities', jsonb_build_array(
      'clients', 'products', 'orders', 'inventory_items', 'purchases',
      'stock_movements', 'product_materials', 'profiles'
    )
  );
$$;

revoke all on function public.undo_capabilities() from public, anon;
grant execute on function public.undo_capabilities() to authenticated;
