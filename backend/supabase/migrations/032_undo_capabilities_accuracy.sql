-- Profile changes are managed through manage-users and the current undo RPC
-- intentionally does not support reverting auth/profile state.
create or replace function public.undo_capabilities()
returns jsonb language sql security definer set search_path = public stable
as $$
  select jsonb_build_object(
    'version', 10, 'all_active_roles', true, 'negative_stock_guard', true,
    'production_bom_usage', true, 'security_role_separation', true,
    'order_optimistic_concurrency', true, 'manual_movement_idempotency', true,
    'realtime_postgres_changes', true, 'atomic_inventory_import', true,
    'entities', jsonb_build_array('clients','products','orders','inventory_items','purchases',
      'stock_movements','product_materials','production_tasks','manufacturing_operations','production_costs')
  );
$$;
