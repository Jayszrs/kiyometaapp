-- FactoryTrack — extra columns on `jobs` for the manual "Buat job" form.
-- Run once in Supabase → SQL Editor (after QUICKSTART.md tables exist).

alter table public.jobs add column if not exists order_no        text;
alter table public.jobs add column if not exists product_type    text;
alter table public.jobs add column if not exists operation_type   text;
alter table public.jobs add column if not exists route            jsonb default '[]'::jsonb;

-- `route` holds the ordered operation list, e.g. ["Cutting","Drilling","Welding"].
