-- Resolve the duplicate Product Master identity that blocked
-- unique(client_name, product_name) -- migration 011 step 4b.
--
-- Production held two products for one client with the same display name:
--   NHD-F1772-11  the oldest row, carrying the 4-row BOM the orders consume
--   NHS-F1968-00  a newer row with an empty BOM and no order meant for it
-- apply_order_materials resolves the BOM by (client, product_name) with an
-- "oldest wins" tie-break, so the duplicate was a latent wrong-BOM hazard:
-- had the empty row ever been older, the orders would have consumed nothing.
--
-- Keep NHD-F1772-11, remove the empty duplicate, then enforce uniqueness.
-- The removed row was snapshotted to maintenance.products_tank_backup_20261013
-- on the host that performed the repair; a fresh database deletes nothing.

do $$
declare
  v_client text;
begin
  select client_name into v_client
  from public.products
  where product_number = 'NHD-F1772-11';

  if v_client is not null and exists (
    select 1 from public.products
    where product_number = 'NHS-F1968-00' and client_name = v_client
  ) then
    execute 'alter table public.products disable trigger products_guard_identity';
    delete from public.products
    where product_number = 'NHS-F1968-00' and client_name = v_client;
    execute 'alter table public.products enable trigger products_guard_identity';
  end if;
end;
$$;

alter table public.products
  drop constraint if exists products_client_name_product_name_key;
alter table public.products
  add constraint products_client_name_product_name_key
  unique (client_name, product_name);

-- Security advisor note (accepted, not suppressed):
-- lint 0029 lists 9 SECURITY DEFINER functions callable by `authenticated`
-- (import_inventory_rows, is_active_user, is_administrator, record_audit_event,
-- record_stock_movement, resolve_login_email, undo_audit_entry,
-- undo_capabilities, update_own_profile) and lint 0028 lists resolve_login_email
-- for `anon`. Each is an intentional application RPC that must bypass RLS or run
-- before authentication; 017/018 already deny EXECUTE to every trigger-only
-- helper. Do not switch these to SECURITY INVOKER without replacing the
-- privilege they perform, or login, RLS helpers and manual movements break.
