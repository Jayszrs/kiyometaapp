-- Kiyometa Order Management V2 - clients, products, orders
-- Run once in Supabase -> SQL Editor.
-- Authenticated users can manage the order-management tables.

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

-- 5. RLS - signed-in users only, full CRUD -------------------------------
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

-- Production schema migration: do not seed client, product, or order records.
