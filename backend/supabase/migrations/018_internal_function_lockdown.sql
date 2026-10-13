-- These functions run only through database triggers or other definer code.
-- Application users do not need to invoke them through PostgREST.

revoke execute on function public.apply_order_materials() from authenticated;
revoke execute on function public.apply_purchase_receipt() from authenticated;
revoke execute on function public.audit_row_change() from authenticated;
revoke execute on function public.current_audit_username() from authenticated;
revoke execute on function public.enforce_order_progress_transition() from authenticated;
revoke execute on function public.freeze_opening_quantity() from authenticated;
revoke execute on function public.guard_product_identity_change() from authenticated;
revoke execute on function public.handle_new_auth_user() from authenticated;
revoke execute on function public.next_bom_no() from authenticated;
revoke execute on function public.next_inventory_item_no() from authenticated;
revoke execute on function public.next_purchase_no() from authenticated;
revoke execute on function public.next_stock_movement_no() from authenticated;
revoke execute on function public.prevent_negative_inventory_balance() from authenticated;
revoke execute on function public.rls_auto_enable() from authenticated;
