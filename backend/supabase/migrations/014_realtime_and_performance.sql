-- Cover foreign-key maintenance and enable low-latency multi-user refreshes.

create index if not exists audit_logs_undone_by_idx on public.audit_logs (undone_by);
create index if not exists order_material_issues_inventory_item_idx on public.order_material_issues (inventory_item_id);
create index if not exists profiles_created_by_idx on public.profiles (created_by);
create index if not exists purchases_created_by_idx on public.purchases (created_by);
create index if not exists stock_movements_created_by_idx on public.stock_movements (created_by);

drop policy if exists "active users read permitted audit" on public.audit_logs;
create policy "active users read permitted audit" on public.audit_logs
  for select to authenticated
  using (
    (select public.is_active_user())
    and (user_id = (select auth.uid()) or (select public.is_administrator()))
  );

drop policy if exists "authenticated read profiles" on public.profiles;
create policy "authenticated read profiles" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_administrator()));

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'clients', 'products', 'orders', 'inventory_items', 'purchases',
    'stock_movements', 'product_materials', 'order_material_issues'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

create or replace function public.undo_capabilities()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'version', 6,
    'all_active_roles', true,
    'negative_stock_guard', true,
    'production_bom_usage', true,
    'security_role_separation', true,
    'order_optimistic_concurrency', true,
    'manual_movement_idempotency', true,
    'realtime_postgres_changes', true,
    'entities', jsonb_build_array(
      'clients', 'products', 'orders', 'inventory_items', 'purchases',
      'stock_movements', 'product_materials', 'profiles'
    )
  );
$$;

revoke all on function public.undo_capabilities() from public, anon;
grant execute on function public.undo_capabilities() to authenticated;
