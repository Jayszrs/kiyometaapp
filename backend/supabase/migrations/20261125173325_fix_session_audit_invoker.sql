-- An invoker cannot call the internal SECURITY DEFINER username helper after
-- its execute grant was removed. Read only the caller's own profile instead.
create or replace function public.record_audit_event(
  p_action text,
  p_entity text,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_username text;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  if p_action not in ('login', 'logout') or p_entity <> 'session' or p_entity_id is not null
    or coalesce(p_metadata, '{}'::jsonb) <> '{"source":"webapp"}'::jsonb then
    raise exception 'Only application session events can be recorded' using errcode = '42501';
  end if;

  select p.username into v_username
  from public.profiles p
  where p.id = auth.uid();
  if v_username is null then
    raise exception 'Active profile required' using errcode = '42501';
  end if;

  insert into public.audit_logs(user_id, username, action, entity, entity_id, metadata)
  values (auth.uid(), v_username, p_action, p_entity, null, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
