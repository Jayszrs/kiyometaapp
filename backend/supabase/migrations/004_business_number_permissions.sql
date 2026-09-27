-- Supabase project default privileges may grant newly-created routines and
-- sequences directly to anon. Automatic business numbers are an authenticated
-- application concern, so anonymous callers must not be able to consume them.

revoke all on function public.next_inventory_item_no() from public, anon;
revoke all on function public.next_purchase_no() from public, anon;
revoke all on function public.next_stock_movement_no() from public, anon;
revoke all on function public.next_bom_no() from public, anon;

grant execute on function public.next_inventory_item_no() to authenticated, service_role;
grant execute on function public.next_purchase_no() to authenticated, service_role;
grant execute on function public.next_stock_movement_no() to authenticated, service_role;
grant execute on function public.next_bom_no() to authenticated, service_role;

revoke all on sequence public.inventory_item_no_seq from public, anon, authenticated;
revoke all on sequence public.purchase_no_seq from public, anon, authenticated;
revoke all on sequence public.stock_movement_no_seq from public, anon, authenticated;
revoke all on sequence public.bom_no_seq from public, anon, authenticated;
grant usage, select on sequence public.inventory_item_no_seq to service_role;
grant usage, select on sequence public.purchase_no_seq to service_role;
grant usage, select on sequence public.stock_movement_no_seq to service_role;
grant usage, select on sequence public.bom_no_seq to service_role;
