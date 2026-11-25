-- Keep Activity Audit search and sorted pagination on indexed database paths.
create extension if not exists pg_trgm with schema extensions;

create index if not exists audit_logs_username_trgm_idx
  on public.audit_logs using gin (username extensions.gin_trgm_ops);
create index if not exists audit_logs_action_trgm_idx
  on public.audit_logs using gin (action extensions.gin_trgm_ops);
create index if not exists audit_logs_entity_trgm_idx
  on public.audit_logs using gin (entity extensions.gin_trgm_ops);

create index if not exists audit_logs_username_created_at_idx
  on public.audit_logs (username, created_at desc);
create index if not exists audit_logs_action_created_at_idx
  on public.audit_logs (action, created_at desc);
create index if not exists audit_logs_entity_id_created_at_idx
  on public.audit_logs (entity_id, created_at desc)
  where entity_id is not null;

-- Rollback keeps the audit rows and removes only these access paths:
-- drop index if exists public.audit_logs_username_trgm_idx;
-- drop index if exists public.audit_logs_action_trgm_idx;
-- drop index if exists public.audit_logs_entity_trgm_idx;
-- drop index if exists public.audit_logs_username_created_at_idx;
-- drop index if exists public.audit_logs_action_created_at_idx;
-- drop index if exists public.audit_logs_entity_id_created_at_idx;
