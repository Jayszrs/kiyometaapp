-- Manufacturing operation catalogue, per-order stage progress, internal product
-- aliases, and explicit links from BOM components to separately produced items.
-- WIP valuation is intentionally not implemented: the client has not approved
-- the accounting recognition method yet.

alter table public.products
  add column if not exists internal_company_name text not null default '';

alter table public.product_materials
  add column if not exists component_product_id uuid
  references public.products(id) on delete restrict;

create index if not exists products_internal_company_name_idx
  on public.products (lower(internal_company_name));
create index if not exists product_materials_component_product_idx
  on public.product_materials (component_product_id)
  where component_product_id is not null;

create table if not exists public.manufacturing_operations (
  id                    uuid primary key default gen_random_uuid(),
  operation_code        text not null unique,
  operation_name        text not null,
  operation_name_ja     text not null default '',
  base_time_charge_jpy  numeric(14,2) not null default 0 check (base_time_charge_jpy >= 0),
  default_minutes       numeric(8,2) check (default_minutes is null or default_minutes >= 0),
  sequence              integer not null default 0 check (sequence >= 0),
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.production_tasks (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  operation_id    uuid not null references public.manufacturing_operations(id) on delete restrict,
  status          text not null default 'pending'
                  check (status in ('pending', 'in_progress', 'completed', 'issue')),
  actual_minutes  numeric(10,2) check (actual_minutes is null or actual_minutes >= 0),
  operator_id     uuid references auth.users(id) on delete set null default auth.uid(),
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (order_id, operation_id)
);

create table if not exists public.production_costs (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders(id) on delete cascade,
  outsourcing_cost_jpy  numeric(14,2) not null default 0 check (outsourcing_cost_jpy >= 0),
  notes                 text not null default '',
  created_by            uuid references auth.users(id) on delete set null default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists manufacturing_operations_active_sequence_idx
  on public.manufacturing_operations (is_active, sequence, operation_name);
create index if not exists production_tasks_order_idx
  on public.production_tasks (order_id, operation_id);
create index if not exists production_tasks_operation_status_idx
  on public.production_tasks (operation_id, status);
create index if not exists production_costs_order_idx
  on public.production_costs (order_id);

drop trigger if exists manufacturing_operations_set_updated_at on public.manufacturing_operations;
create trigger manufacturing_operations_set_updated_at before update on public.manufacturing_operations
  for each row execute function public.set_updated_at();
drop trigger if exists production_tasks_set_updated_at on public.production_tasks;
create trigger production_tasks_set_updated_at before update on public.production_tasks
  for each row execute function public.set_updated_at();
drop trigger if exists production_costs_set_updated_at on public.production_costs;
create trigger production_costs_set_updated_at before update on public.production_costs
  for each row execute function public.set_updated_at();

create or replace function public.prevent_component_product_cycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.component_product_id is null then return new; end if;
  if new.component_product_id = new.product_id then
    raise exception 'A product cannot be its own BOM component';
  end if;

  if exists (
    with recursive descendants(product_id) as (
      select pm.component_product_id
      from public.product_materials pm
      where pm.product_id = new.component_product_id
        and pm.component_product_id is not null
        and pm.id <> new.id
      union
      select pm.component_product_id
      from public.product_materials pm
      join descendants d on pm.product_id = d.product_id
      where pm.component_product_id is not null
        and pm.id <> new.id
    )
    select 1 from descendants where product_id = new.product_id
  ) then
    raise exception 'BOM component product would create a cycle';
  end if;
  return new;
end;
$$;

drop trigger if exists product_materials_prevent_component_product_cycle on public.product_materials;
create trigger product_materials_prevent_component_product_cycle
  before insert or update of product_id, component_product_id on public.product_materials
  for each row execute function public.prevent_component_product_cycle();

alter table public.manufacturing_operations enable row level security;
alter table public.production_tasks enable row level security;
alter table public.production_costs enable row level security;

create policy "active users read manufacturing operations"
  on public.manufacturing_operations for select to authenticated
  using ((select public.is_active_user()));
create policy "administrators create manufacturing operations"
  on public.manufacturing_operations for insert to authenticated
  with check ((select public.is_administrator()));
create policy "administrators update manufacturing operations"
  on public.manufacturing_operations for update to authenticated
  using ((select public.is_administrator()))
  with check ((select public.is_administrator()));
create policy "administrators delete manufacturing operations"
  on public.manufacturing_operations for delete to authenticated
  using ((select public.is_administrator()));

create policy "active users read production tasks"
  on public.production_tasks for select to authenticated
  using ((select public.is_active_user()));
create policy "active users create production tasks"
  on public.production_tasks for insert to authenticated
  with check ((select public.is_active_user()));
create policy "active users update production tasks"
  on public.production_tasks for update to authenticated
  using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete production tasks"
  on public.production_tasks for delete to authenticated
  using ((select public.is_administrator()));

create policy "active users read production costs"
  on public.production_costs for select to authenticated
  using ((select public.is_active_user()));
create policy "active users create production costs"
  on public.production_costs for insert to authenticated
  with check ((select public.is_active_user()));
create policy "active users update production costs"
  on public.production_costs for update to authenticated
  using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete production costs"
  on public.production_costs for delete to authenticated
  using ((select public.is_administrator()));

grant select on public.manufacturing_operations to authenticated;
grant insert, update, delete on public.manufacturing_operations to authenticated;
grant select, insert, update on public.production_tasks to authenticated;
grant delete on public.production_tasks to authenticated;
grant select, insert, update on public.production_costs to authenticated;
grant delete on public.production_costs to authenticated;

revoke execute on function public.prevent_component_product_cycle() from public, anon, authenticated;

-- Preserve the existing atomic Excel import and extend only its BOM payload.
-- Calling the original function from this wrapper stays in the same database
-- transaction, so an invalid subassembly link rolls back the whole workbook.
create or replace function public.import_manufacturing_rows(p_rows jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_entry jsonb;
  v_payload jsonb;
  v_count integer;
begin
  v_count := public.import_inventory_rows(p_rows);
  for v_entry in select value from jsonb_array_elements(p_rows)
  loop
    if v_entry->>'kind' <> 'bom' then continue; end if;
    v_payload := v_entry->'payload';
    update public.product_materials
    set component_product_id = nullif(v_payload->>'componentProductId', '')::uuid
    where id = (v_payload->>'id')::uuid;
    if not found then
      raise exception 'BOM item % was not imported', v_payload->>'id' using errcode = 'P0002';
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.import_manufacturing_rows(jsonb) from public, anon;
grant execute on function public.import_manufacturing_rows(jsonb) to authenticated;

drop trigger if exists audit_manufacturing_operations on public.manufacturing_operations;
create trigger audit_manufacturing_operations after insert or update or delete on public.manufacturing_operations
  for each row execute function public.audit_row_change();
drop trigger if exists audit_production_tasks on public.production_tasks;
create trigger audit_production_tasks after insert or update or delete on public.production_tasks
  for each row execute function public.audit_row_change();
drop trigger if exists audit_production_costs on public.production_costs;
create trigger audit_production_costs after insert or update or delete on public.production_costs
  for each row execute function public.audit_row_change();

insert into public.manufacturing_operations
  (operation_code, operation_name, operation_name_ja, default_minutes, sequence)
values
  ('FULL_MACHINING', 'Full machining', '全加工', null, 10),
  ('LASER',          'Laser cutting',  'レーザー', 5, 20),
  ('DEBURRING',      'Deburring',      'バリ取り', 1, 30),
  ('BENDING',        'Bending',        '曲げ', 3, 40),
  ('WELDING',        'Welding',        '溶接', 6, 50),
  ('ACID_PICKLING',  'Acid pickling',  '酸洗', 5, 60)
on conflict (operation_code) do update set
  operation_name = excluded.operation_name,
  operation_name_ja = excluded.operation_name_ja,
  default_minutes = excluded.default_minutes,
  sequence = excluded.sequence;
