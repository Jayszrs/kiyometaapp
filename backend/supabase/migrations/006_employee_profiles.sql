-- Employee self-service profiles and private profile images.
-- Run after 005_all_roles_safe_undo.sql.

alter table public.profiles add column if not exists avatar_path text not null default '';
alter table public.profiles add column if not exists employee_number text not null default '';
alter table public.profiles add column if not exists phone text not null default '';
alter table public.profiles add column if not exists department text not null default '';
alter table public.profiles add column if not exists position text not null default '';
alter table public.profiles add column if not exists birth_date date;
alter table public.profiles add column if not exists address text not null default '';
alter table public.profiles add column if not exists bio text not null default '';

-- Profile writes go through a narrow RPC. Users never receive permission to
-- update role, active state, username, or the internal login email.
create or replace function public.update_own_profile(
  p_display_name text,
  p_avatar_path text,
  p_employee_number text,
  p_phone text,
  p_department text,
  p_position text,
  p_birth_date date,
  p_address text,
  p_bio text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.profiles%rowtype;
  v_new public.profiles%rowtype;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Active account required';
  end if;
  if length(trim(coalesce(p_display_name, ''))) < 2 then
    raise exception 'Display name must contain at least 2 characters';
  end if;
  if length(p_display_name) > 100 or length(p_employee_number) > 40
     or length(p_phone) > 32 or length(p_department) > 100
     or length(p_position) > 100 or length(p_address) > 500
     or length(p_bio) > 1000 or length(p_avatar_path) > 500 then
    raise exception 'One or more profile fields exceed the maximum length';
  end if;

  select * into v_old from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'Profile not found'; end if;

  update public.profiles set
    display_name = trim(p_display_name),
    avatar_path = trim(coalesce(p_avatar_path, '')),
    employee_number = trim(coalesce(p_employee_number, '')),
    phone = trim(coalesce(p_phone, '')),
    department = trim(coalesce(p_department, '')),
    position = trim(coalesce(p_position, '')),
    birth_date = p_birth_date,
    address = trim(coalesce(p_address, '')),
    bio = trim(coalesce(p_bio, '')),
    updated_at = now()
  where id = auth.uid()
  returning * into v_new;

  insert into public.audit_logs(
    user_id, username, action, entity, entity_id, old_data, new_data, metadata
  ) values (
    auth.uid(), v_old.username, 'update', 'profiles', auth.uid()::text,
    jsonb_build_object(
      'id', v_old.id, 'display_name', v_old.display_name,
      'avatar_path', v_old.avatar_path, 'employee_number', v_old.employee_number,
      'phone', v_old.phone, 'department', v_old.department,
      'position', v_old.position, 'birth_date', v_old.birth_date,
      'address', v_old.address, 'bio', v_old.bio
    ),
    jsonb_build_object(
      'id', v_new.id, 'display_name', v_new.display_name,
      'avatar_path', v_new.avatar_path, 'employee_number', v_new.employee_number,
      'phone', v_new.phone, 'department', v_new.department,
      'position', v_new.position, 'birth_date', v_new.birth_date,
      'address', v_new.address, 'bio', v_new.bio
    ),
    jsonb_build_object('source', 'profile')
  );
  return v_new;
end;
$$;

revoke all on function public.update_own_profile(text, text, text, text, text, text, date, text, text)
  from public, anon;
grant execute on function public.update_own_profile(text, text, text, text, text, text, date, text, text)
  to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-images', 'profile-images', false, 3145728,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "active users read profile images" on storage.objects;
create policy "active users read profile images" on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-images' and public.is_active_user());

drop policy if exists "users upload own profile images" on storage.objects;
create policy "users upload own profile images" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-images'
    and public.is_active_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users update own profile images" on storage.objects;
create policy "users update own profile images" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'profile-images'
    and public.is_active_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'profile-images'
    and public.is_active_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete own profile images" on storage.objects;
create policy "users delete own profile images" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'profile-images'
    and public.is_active_user()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Preserve the already deployed operational undo routine behind a wrapper so
-- profile updates can participate in the same Undo button.
alter function public.undo_audit_entry(uuid) rename to undo_operational_audit_entry;
revoke all on function public.undo_operational_audit_entry(uuid) from public, anon, authenticated;

create or replace function public.undo_audit_entry(p_audit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log public.audit_logs%rowtype;
  v_affected integer;
begin
  select * into v_log from public.audit_logs where id = p_audit_id;
  if not found then raise exception 'Audit entry not found'; end if;

  if v_log.entity <> 'profiles' then
    perform public.undo_operational_audit_entry(p_audit_id);
    return;
  end if;

  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Active account required';
  end if;
  if not public.is_administrator() and v_log.user_id is distinct from auth.uid() then
    raise exception 'Operators can only undo their own activity';
  end if;
  if v_log.action <> 'update' or v_log.undone_at is not null then
    raise exception 'This profile action cannot be undone';
  end if;
  if exists (
    select 1 from public.audit_logs newer
    where newer.entity = 'profiles'
      and newer.entity_id is not distinct from v_log.entity_id
      and newer.created_at > v_log.created_at
      and newer.undone_at is null
      and newer.action = 'update'
  ) then
    raise exception 'A newer profile change exists. Undo the newest change first';
  end if;

  perform set_config('app.audit_source', 'undo:' || p_audit_id::text, true);
  update public.profiles set
    display_name = v_log.old_data->>'display_name',
    avatar_path = coalesce(v_log.old_data->>'avatar_path', ''),
    employee_number = coalesce(v_log.old_data->>'employee_number', ''),
    phone = coalesce(v_log.old_data->>'phone', ''),
    department = coalesce(v_log.old_data->>'department', ''),
    position = coalesce(v_log.old_data->>'position', ''),
    birth_date = nullif(v_log.old_data->>'birth_date', '')::date,
    address = coalesce(v_log.old_data->>'address', ''),
    bio = coalesce(v_log.old_data->>'bio', ''),
    updated_at = now()
  where id = (v_log.old_data->>'id')::uuid;
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then raise exception 'Profile no longer exists'; end if;

  update public.audit_logs set undone_at = now(), undone_by = auth.uid()
  where id = p_audit_id;
  insert into public.audit_logs(user_id, username, action, entity, entity_id, metadata)
  values (
    auth.uid(), public.current_audit_username(), 'undo', 'profiles',
    v_log.entity_id, jsonb_build_object('audit_id', p_audit_id, 'source', 'undo')
  );
end;
$$;

revoke all on function public.undo_audit_entry(uuid) from public, anon;
grant execute on function public.undo_audit_entry(uuid) to authenticated;

create or replace function public.undo_capabilities()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'version', 3,
    'all_active_roles', true,
    'entities', jsonb_build_array(
      'clients', 'products', 'orders', 'inventory_items', 'purchases',
      'stock_movements', 'product_materials', 'profiles'
    )
  );
$$;

revoke all on function public.undo_capabilities() from public, anon;
grant execute on function public.undo_capabilities() to authenticated;
