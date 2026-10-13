-- =============================================================================
-- 022: last-editor trace on purchases and orders
-- =============================================================================
--
-- The audit_logs table already records every change with the actor, but the
-- edit forms have no way to show it without reading history. These columns
-- carry the last editor so the form can display "edited by <user> (<role>)"
-- directly off the row. The trigger resolves the actor from the session at
-- write time (same source the audit trail uses), so a client cannot spoof it;
-- the SELECT from profiles is a primary-key lookup and is the only added cost.
-- Existing rows are backfilled from the audit history they already have.

alter table public.purchases
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_by_username text;

alter table public.orders
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_by_username text;

create or replace function public.set_updated_by_trace()
returns trigger
language plpgsql
set search_path = 'public'
as $$
begin
  new.updated_by = auth.uid();
  new.updated_by_username = public.current_audit_username();
  return new;
end$$;

drop trigger if exists purchases_set_updated_by on public.purchases;
create trigger purchases_set_updated_by
  before insert or update on public.purchases
  for each row execute function public.set_updated_by_trace();

drop trigger if exists orders_set_updated_by on public.orders;
create trigger orders_set_updated_by
  before insert or update on public.orders
  for each row execute function public.set_updated_by_trace();

-- Backfill from what the audit trail already knows, newest edit wins.
update public.purchases p
set updated_by = a.user_id, updated_by_username = a.username
from (
  select distinct on (entity_id) user_id, username, entity_id
  from public.audit_logs
  where entity = 'purchases' and action <> 'delete'
  order by entity_id, created_at desc
) a
where a.entity_id = p.id::text
  and (p.updated_by_username is null or p.updated_by_username is distinct from a.username);

update public.orders o
set updated_by = a.user_id, updated_by_username = a.username
from (
  select distinct on (entity_id) user_id, username, entity_id
  from public.audit_logs
  where entity = 'orders' and action <> 'delete'
  order by entity_id, created_at desc
) a
where a.entity_id = o.id::text
  and (o.updated_by_username is null or o.updated_by_username is distinct from a.username);

-- Resolve a live display label including the current role. SECURITY DEFINER
-- because the profiles row belongs to another user and is hidden from them by
-- RLS; the function only returns a short label, never profile data.
create or replace function public.user_label(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce(display_name, username, 'unregistered')
         || ' (' || coalesce(role, 'user') || ')'
  from public.profiles
  where id = p_user_id
$$;

revoke execute on function public.user_label(uuid) from public, anon;
grant execute on function public.user_label(uuid) to authenticated;