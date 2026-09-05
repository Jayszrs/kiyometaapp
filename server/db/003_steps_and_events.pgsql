-- FactoryTrack — step tracking + activity log (Fase C).
-- Run once in Supabase → SQL Editor.

-- 1. Per-job operation progress (array of {name,status,started,finished,operator}).
alter table public.jobs add column if not exists steps jsonb default '[]'::jsonb;

-- 2. Append-only activity feed (Dasbor "Aktivitas terakhir").
create table if not exists public.job_events (
  id         bigserial primary key,
  job_id     text not null,
  event      text not null,
  operator   text,
  qty        integer,
  created_at timestamptz not null default now()
);

create index if not exists job_events_created_idx on public.job_events (created_at desc);

alter table public.job_events enable row level security;

drop policy if exists "read events"   on public.job_events;
drop policy if exists "insert events" on public.job_events;
create policy "read events"   on public.job_events for select using (true);
create policy "insert events" on public.job_events for insert with check (true);
