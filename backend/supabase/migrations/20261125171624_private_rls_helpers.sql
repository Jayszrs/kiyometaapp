-- Keep the RLS bypass helpers outside the PostgREST-exposed public schema.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles where id = auth.uid() and active = true
  );
$$;

create or replace function private.is_administrator()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'administrator' and active = true
  );
$$;

revoke all on function private.is_active_user() from public, anon;
revoke all on function private.is_administrator() from public, anon;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_administrator() to authenticated;

-- Point policies at the private helpers before changing the public wrappers.
do $$
declare
  p record;
  v_qual text;
  v_check text;
  v_sql text;
begin
  for p in
    select schemaname, tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'is_(active_user|administrator)'
  loop
    v_qual := p.qual;
    v_check := p.with_check;
    if v_qual is not null then
      v_qual := replace(v_qual, 'public.is_active_user(auth.uid())', 'private.is_active_user()');
      v_qual := replace(v_qual, 'public.is_administrator(auth.uid())', 'private.is_administrator()');
      v_qual := replace(v_qual, 'public.is_active_user()', 'private.is_active_user()');
      v_qual := replace(v_qual, 'public.is_administrator()', 'private.is_administrator()');
      v_qual := regexp_replace(v_qual, '(^|[^.[:alnum:]_])is_active_user\(\)', '\1private.is_active_user()', 'g');
      v_qual := regexp_replace(v_qual, '(^|[^.[:alnum:]_])is_administrator\(\)', '\1private.is_administrator()', 'g');
    end if;
    if v_check is not null then
      v_check := replace(v_check, 'public.is_active_user(auth.uid())', 'private.is_active_user()');
      v_check := replace(v_check, 'public.is_administrator(auth.uid())', 'private.is_administrator()');
      v_check := replace(v_check, 'public.is_active_user()', 'private.is_active_user()');
      v_check := replace(v_check, 'public.is_administrator()', 'private.is_administrator()');
      v_check := regexp_replace(v_check, '(^|[^.[:alnum:]_])is_active_user\(\)', '\1private.is_active_user()', 'g');
      v_check := regexp_replace(v_check, '(^|[^.[:alnum:]_])is_administrator\(\)', '\1private.is_administrator()', 'g');
    end if;

    if v_qual is not null and v_check is not null then
      v_sql := format('alter policy %I on %I.%I using (%s) with check (%s)', p.policyname, p.schemaname, p.tablename, v_qual, v_check);
    elsif v_qual is not null then
      v_sql := format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, v_qual);
    else
      v_sql := format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, v_check);
    end if;
    execute v_sql;
  end loop;
end;
$$;

-- Public compatibility functions no longer bypass RLS. They only report the
-- status of the current session, even if a caller supplies another user id.
alter function public.is_active_user(uuid) security invoker;
alter function public.is_administrator(uuid) security invoker;
