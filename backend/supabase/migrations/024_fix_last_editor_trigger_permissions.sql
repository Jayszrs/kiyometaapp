-- 024: Restore editor tracing without exposing the internal audit helper.
-- 018 intentionally revoked authenticated EXECUTE on current_audit_username.
-- The newer trace trigger was SECURITY INVOKER, so otherwise valid writes
-- failed with 42501 before any data/version change reached the database.
alter function public.set_updated_by_trace() security definer;
alter function public.set_updated_by_trace() set search_path = public;
revoke execute on function public.set_updated_by_trace() from public, anon, authenticated;
-- Parent table RLS still checks the caller. Trigger execution uses its owner
-- only to resolve auth.uid()/the internal username; no table grants change.
