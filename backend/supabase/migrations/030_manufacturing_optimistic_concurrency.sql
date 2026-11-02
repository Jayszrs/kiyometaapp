-- Protect shared manufacturing records from silent last-write-wins edits.
-- Existing rows start at version 1; callers update only the version they read.
alter table public.inventory_items add column if not exists version integer not null default 1;
alter table public.product_materials add column if not exists version integer not null default 1;
alter table public.manufacturing_operations add column if not exists version integer not null default 1;
alter table public.production_tasks add column if not exists version integer not null default 1;
alter table public.production_costs add column if not exists version integer not null default 1;

create or replace function public.bump_shared_record_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists inventory_items_bump_version on public.inventory_items;
create trigger inventory_items_bump_version before update on public.inventory_items
for each row execute function public.bump_shared_record_version();

drop trigger if exists product_materials_bump_version on public.product_materials;
create trigger product_materials_bump_version before update on public.product_materials
for each row execute function public.bump_shared_record_version();

drop trigger if exists manufacturing_operations_bump_version on public.manufacturing_operations;
create trigger manufacturing_operations_bump_version before update on public.manufacturing_operations
for each row execute function public.bump_shared_record_version();

drop trigger if exists production_tasks_bump_version on public.production_tasks;
create trigger production_tasks_bump_version before update on public.production_tasks
for each row execute function public.bump_shared_record_version();

drop trigger if exists production_costs_bump_version on public.production_costs;
create trigger production_costs_bump_version before update on public.production_costs
for each row execute function public.bump_shared_record_version();

-- FK-maintenance indexes confirmed absent in the live schema advisor.
create index if not exists orders_updated_by_idx on public.orders (updated_by) where updated_by is not null;
create index if not exists purchases_updated_by_idx on public.purchases (updated_by) where updated_by is not null;
