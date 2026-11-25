-- Keep the BOM number generator outside the PostgREST-exposed schema. The
-- table default still works for authenticated inserts through the private
-- function, while the public RPC can no longer consume sequence values.
create or replace function private.next_bom_no()
returns text
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select 'BOM-' || lpad(nextval('public.bom_no_seq')::text, 6, '0');
$$;

revoke all on function private.next_bom_no() from public, anon;
grant execute on function private.next_bom_no() to authenticated;
alter table public.product_materials
  alter column bom_no set default private.next_bom_no();
revoke all on function public.next_bom_no() from authenticated;

-- The UI already shows the username stored on the purchase row. This lookup
-- can obey profile RLS and falls back to that username for other operators.
alter function public.user_label(uuid) security invoker;
