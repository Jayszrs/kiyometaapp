-- Kiyometa Order Management V2 — clients, products, orders
-- Run once in Supabase -> SQL Editor.
-- Same project as FactoryTrack (jobs/issues/profiles); separate table
-- namespace, no overlap. Auth: any authenticated user (single role, same
-- as 001_profiles.pgsql's tightened-policy note) can read/write everything.

-- 1. Clients -----------------------------------------------------------
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  phone       text not null default '',
  email       text not null default '',
  postal_code text not null default '',
  address     text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2. Products ------------------------------------------------------------
-- client_name references clients(name) rather than a surrogate client_id:
-- the app matches products to clients by display name (OrderRecord.client /
-- Product.clientName are both plain strings), so this keeps referential
-- integrity without reshaping the front-end's existing join logic.
create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  client_name    text not null references public.clients (name) on update cascade on delete cascade,
  product_name   text not null,
  product_number text not null,
  unit_price     integer not null default 0,
  tasks          jsonb not null default '[]',    -- [{content, time}, ...] x54
  drawings       jsonb not null default '[]',    -- [{path, url}, ...] (Supabase Storage refs)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (client_name, product_number)
);

-- 3. Orders ----------------------------------------------------------------
create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  order_date           date not null,
  delivery_date        date not null,
  client               text not null references public.clients (name) on update cascade on delete restrict,
  order_number         text not null default '',
  product_name         text not null,
  quantity             integer not null default 1,
  order_amount         integer not null default 0,
  progress             text not null default 'Order request'
                       check (progress in (
                         'Order request', 'Receipt', 'In preparation',
                         'Preparation complete', 'In production',
                         'Complete', 'Shipped'
                       )),
  required_manhours    integer not null default 0,
  worked_manhours      integer not null default 0,
  production_end_date  date,
  order_contact        text not null default '',
  contact_contents     text not null default '',
  finish_task          boolean not null default false,
  has_contact          boolean not null default false,
  completed_tasks      jsonb not null default '[]',   -- bool[54]
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists orders_delivery_date_idx on public.orders (delivery_date);
create index if not exists orders_client_idx on public.orders (client);
create index if not exists products_client_name_idx on public.products (client_name);

-- 4. updated_at trigger (shared) --------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clients_set_updated_at on public.clients;
create trigger clients_set_updated_at before update on public.clients
  for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

-- 5. RLS — signed-in users only, full CRUD (single-role app, same as the
--    tightened policies noted in 001_profiles.pgsql) -----------------------
alter table public.clients  enable row level security;
alter table public.products enable row level security;
alter table public.orders   enable row level security;

drop policy if exists "auth all" on public.clients;
create policy "auth all" on public.clients
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "auth all" on public.products;
create policy "auth all" on public.products
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "auth all" on public.orders;
create policy "auth all" on public.orders
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- 6. Storage bucket for product drawings ------------------------------------
insert into storage.buckets (id, name, public)
values ('product-drawings', 'product-drawings', true)
on conflict (id) do nothing;

drop policy if exists "auth manage drawings" on storage.objects;
create policy "auth manage drawings" on storage.objects
  for all using (bucket_id = 'product-drawings' and auth.role() = 'authenticated')
  with check (bucket_id = 'product-drawings' and auth.role() = 'authenticated');

drop policy if exists "public read drawings" on storage.objects;
create policy "public read drawings" on storage.objects
  for select using (bucket_id = 'product-drawings');

-- 7. Seed data (same demo rows as the prototype's in-memory INIT_* arrays) --
insert into public.clients (name, phone, email, postal_code, address) values
  ('Shinwa Technos Co., Ltd.', '0266-28-0105', 'info@shinwa.co.jp', '393-0011', 'Nagano-ken Suwa-gun Shimosuwa-machi 4611-90'),
  ('Masuda Corp. Sheet Metal Dept.', '0265-85-2100', 'sheetmetal@masuda.co.jp', '399-4301', 'Nagano-ken Kamiina-gun Miyada-mura 6623-2'),
  ('Tsubaki Manufacturing Ltd.', '03-5678-9012', 'orders@tsubaki-mfg.co.jp', '140-0002', 'Tokyo-to Shinagawa-ku Higashishinagawa 2-3-8')
on conflict (name) do nothing;

insert into public.products (client_name, product_name, product_number, unit_price, tasks) values
  ('Shinwa Technos Co., Ltd.', 'Tank', 'NHD-F1772-11', 5000,
    '[{"content":"Cutting","time":15},{"content":"Bending","time":20},{"content":"Welding","time":30},{"content":"Grinding","time":10},{"content":"Inspection","time":5}]'::jsonb),
  ('Masuda Corp. Sheet Metal Dept.', 'Tank (TOP)', 'NSQ-F0124-05', 6000,
    '[{"content":"Cutting","time":12},{"content":"Pressing","time":18},{"content":"Welding","time":25},{"content":"Surface treatment","time":15}]'::jsonb),
  ('Tsubaki Manufacturing Ltd.', 'Frame assembly', 'TBK-R3341-02', 12000,
    '[{"content":"Laser cut","time":30},{"content":"Bending x6","time":45},{"content":"Assembly weld","time":60},{"content":"Finishing","time":20}]'::jsonb)
on conflict (client_name, product_number) do nothing;

insert into public.orders (order_date, delivery_date, client, order_number, product_name, quantity, order_amount, progress, required_manhours, worked_manhours, production_end_date) values
  ('2025-11-04', '2025-11-06', 'Shinwa Technos Co., Ltd.', '199987', 'Tank', 2, 10000, 'Shipped', 40, 40, '2025-11-05'),
  ('2025-11-04', '2025-11-07', 'Shinwa Technos Co., Ltd.', '199988', 'Tank', 2, 10000, 'Shipped', 40, 40, '2025-11-06'),
  ('2025-11-02', '2025-11-07', 'Shinwa Technos Co., Ltd.', '199901', 'Frame assembly', 6, 42648, 'Shipped', 155, 155, '2025-11-06'),
  ('2025-11-01', '2025-11-07', 'Masuda Corp. Sheet Metal Dept.', 'MS294541', 'Tank (TOP)', 1, 4650, 'Shipped', 30, 30, '2025-11-05'),
  ('2025-11-01', '2025-11-07', 'Masuda Corp. Sheet Metal Dept.', 'MS294542', 'Tank (TOP)', 1, 4650, 'In production', 30, 12, '2025-11-06'),
  ('2025-10-28', '2025-11-03', 'Tsubaki Manufacturing Ltd.', 'TBK-8812', 'Frame assembly', 2, 24000, 'Complete', 310, 310, '2025-11-02')
on conflict do nothing;
