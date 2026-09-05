-- FactoryTrack — auth profiles
-- Run once in Supabase → SQL Editor (after the tables in QUICKSTART.md).

-- 1. Profile per auth user: full name, role, home station.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  role       text not null default 'operator'
             check (role in ('operator', 'gudang', 'admin')),
  station    text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- 2. Auto-create a profile row whenever a user is added.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Backfill profiles for users that already exist.
insert into public.profiles (id, full_name)
select id, coalesce(raw_user_meta_data ->> 'full_name', email)
from auth.users
on conflict (id) do nothing;

-- 4. Set roles for your accounts (edit the emails):
-- update public.profiles p set role = 'admin',  full_name = 'Dewi Anggraini', station = 'ADMIN PRODUKSI'
--   from auth.users u where u.id = p.id and u.email = 'admin@example.com';
-- update public.profiles p set role = 'gudang', full_name = 'Bagus Setiawan'
--   from auth.users u where u.id = p.id and u.email = 'gudang@example.com';
-- update public.profiles p set role = 'operator', full_name = 'Rizky Pratama', station = 'LINE 02 · STASIUN W-04'
--   from auth.users u where u.id = p.id and u.email = 'operator@example.com';

-- 5. (Optional) Tighten the wide-open policies from QUICKSTART.md so only
--    signed-in users can read/write the operational tables:
-- drop policy if exists "Allow read all" on public.jobs;
-- drop policy if exists "Allow insert"   on public.jobs;
-- drop policy if exists "Allow update"   on public.jobs;
-- create policy "auth read"   on public.jobs for select using (auth.role() = 'authenticated');
-- create policy "auth insert" on public.jobs for insert with check (auth.role() = 'authenticated');
-- create policy "auth update" on public.jobs for update using (auth.role() = 'authenticated');
-- (repeat for public.materials and public.issues)
