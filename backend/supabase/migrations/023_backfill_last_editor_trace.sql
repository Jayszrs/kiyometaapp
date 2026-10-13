-- =============================================================================
-- 023: re-run the last-editor backfill with the correct match
-- =============================================================================
--
-- 022 compared `updated_by is distinct from a.user_id`, which skipped every
-- historical row whose audit actor is "system" (user_id null, because the
-- demo data was seeded outside an authenticated session). The actor label is
-- still meaningful there, so match on the label instead. Idempotent: a second
-- run finds the label already set and changes nothing.

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