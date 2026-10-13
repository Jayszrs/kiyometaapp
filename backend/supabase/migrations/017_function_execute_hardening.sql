-- Trigger and internal helper functions are not public APIs.

revoke execute on function public.apply_order_materials() from public, anon;
revoke execute on function public.apply_purchase_receipt() from public, anon;
revoke execute on function public.audit_row_change() from public, anon;
revoke execute on function public.current_audit_username() from public, anon;
revoke execute on function public.enforce_order_progress_transition() from public, anon;
revoke execute on function public.freeze_opening_quantity() from public, anon;
revoke execute on function public.guard_product_identity_change() from public, anon;
revoke execute on function public.handle_new_auth_user() from public, anon;
revoke execute on function public.prevent_negative_inventory_balance() from public, anon;
revoke execute on function public.rls_auto_enable() from public, anon;

-- RLS helpers are required by signed-in users, never anonymous callers.
revoke execute on function public.is_active_user(uuid) from public, anon;
revoke execute on function public.is_administrator(uuid) from public, anon;
grant execute on function public.is_active_user(uuid) to authenticated;
grant execute on function public.is_administrator(uuid) to authenticated;

-- Session audit events require an authenticated identity.
revoke execute on function public.record_audit_event(text, text, text, jsonb) from public, anon;
grant execute on function public.record_audit_event(text, text, text, jsonb) to authenticated;

-- Username lookup is intentionally the sole anonymous SECURITY DEFINER RPC,
-- because it runs before password authentication.
revoke execute on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;

alter default privileges in schema public revoke execute on functions from public;
