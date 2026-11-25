-- Session events do not need SECURITY DEFINER access. RLS ties each inserted
-- row to the active caller and rejects business-event fields.
create policy "active users add own session audit events"
  on public.audit_logs
  for insert to authenticated
  with check (
    (select private.is_active_user())
    and user_id = (select auth.uid())
    and username = (select p.username from public.profiles p where p.id = auth.uid())
    and action in ('login', 'logout')
    and entity = 'session'
    and entity_id is null
    and old_data is null
    and new_data is null
    and undone_at is null
    and undone_by is null
    and metadata->>'source' = 'webapp'
  );
grant insert on public.audit_logs to authenticated;

alter function public.record_audit_event(text, text, text, jsonb)
  security invoker;
