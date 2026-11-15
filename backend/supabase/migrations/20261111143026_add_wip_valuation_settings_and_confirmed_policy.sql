create table if not exists public.wip_valuation_settings (
  id boolean primary key default true check (id),
  valuation_method text check (valuation_method in ('standard_time', 'actual_time')),
  actual_time_basis text check (actual_time_basis in ('per_unit', 'per_batch')),
  include_in_progress_operation boolean,
  material_issue_point text check (material_issue_point in ('issue', 'process_start', 'actual_consumption')),
  outsourcing_recognition text check (outsourcing_recognition in ('sent', 'received', 'invoiced')),
  stock_valuation_method text check (stock_valuation_method in ('fifo', 'weighted_average', 'standard_cost')),
  include_labor_cost boolean,
  include_machine_cost boolean,
  include_overhead_cost boolean,
  client_decisions jsonb not null default '{}'::jsonb check (jsonb_typeof(client_decisions) = 'object'),
  version integer not null default 1,
  configured_at timestamptz,
  configured_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.wip_valuation_settings enable row level security;
drop policy if exists "active users read WIP settings" on public.wip_valuation_settings;
create policy "active users read WIP settings" on public.wip_valuation_settings
  for select to authenticated using ((select public.is_active_user()));
drop policy if exists "administrators manage WIP settings" on public.wip_valuation_settings;
create policy "administrators manage WIP settings" on public.wip_valuation_settings
  for all to authenticated using ((select public.is_administrator()))
  with check ((select public.is_administrator()));
grant select on public.wip_valuation_settings to authenticated;
grant insert, update, delete on public.wip_valuation_settings to authenticated;
insert into public.wip_valuation_settings (id) values (true) on conflict (id) do nothing;

update public.wip_valuation_settings set
  valuation_method = 'standard_time',
  actual_time_basis = 'per_unit',
  include_in_progress_operation = false,
  include_labor_cost = true,
  include_machine_cost = true,
  include_overhead_cost = true,
  client_decisions = jsonb_set(
    jsonb_set(
      jsonb_set(coalesce(client_decisions, '{}'::jsonb), '{fullMachiningMode}', 'null'::jsonb, true),
      '{newStageScope}', '"production_orders_only"'::jsonb, true),
    '{notes}', to_jsonb(concat_ws(E'\n', nullif(client_decisions->>'notes',''),
      'Q01: The label “Pemrosesan selesai” is incorrect. The purpose of Full machining remains unconfirmed.',
      'Q02: Manufacturing processes apply to production orders. The client did not decide how new stages affect orders already in progress.')),
    true),
  version = version + 1
where id = true;

alter table public.wip_valuation_settings
  drop constraint if exists wip_valuation_settings_valuation_method_check,
  add constraint wip_valuation_settings_valuation_method_check
    check (valuation_method is null or valuation_method = 'standard_time'),
  drop constraint if exists wip_valuation_settings_actual_time_basis_check,
  add constraint wip_valuation_settings_actual_time_basis_check
    check (actual_time_basis is null or actual_time_basis = 'per_unit'),
  drop constraint if exists wip_valuation_settings_in_progress_confirmed_check,
  add constraint wip_valuation_settings_in_progress_confirmed_check
    check (include_in_progress_operation is null or include_in_progress_operation = false),
  drop constraint if exists wip_valuation_settings_labor_confirmed_check,
  add constraint wip_valuation_settings_labor_confirmed_check
    check (include_labor_cost is null or include_labor_cost = true),
  drop constraint if exists wip_valuation_settings_machine_confirmed_check,
  add constraint wip_valuation_settings_machine_confirmed_check
    check (include_machine_cost is null or include_machine_cost = true),
  drop constraint if exists wip_valuation_settings_overhead_confirmed_check,
  add constraint wip_valuation_settings_overhead_confirmed_check
    check (include_overhead_cost is null or include_overhead_cost = true);

alter table public.production_tasks add column if not exists actual_time_basis text;
alter table public.production_tasks add column if not exists processed_quantity numeric(14,3);
alter table public.production_tasks add column if not exists completed_quantity numeric(14,3);
alter table public.production_tasks alter column actual_time_basis set default 'per_unit';
alter table public.production_tasks drop constraint if exists production_tasks_actual_time_basis_check;
alter table public.production_tasks add constraint production_tasks_actual_time_basis_check
  check (actual_time_basis is null or actual_time_basis in ('per_unit', 'per_batch'));
alter table public.production_tasks drop constraint if exists production_task_quantity_order;
alter table public.production_tasks add constraint production_task_quantity_order
  check (completed_quantity is null or processed_quantity is null or completed_quantity <= processed_quantity);

create or replace function public.calculate_wip_valuation(p_as_of date default current_date)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare s public.wip_valuation_settings%rowtype;
begin
  if not public.is_active_user() then raise exception 'Active account required'; end if;
  if p_as_of is null then raise exception 'Valuation date is required'; end if;
  select * into s from public.wip_valuation_settings where id = true;
  if s.valuation_method is null or s.actual_time_basis is null or s.include_in_progress_operation is null
    or s.material_issue_point is null or s.outsourcing_recognition is null or s.stock_valuation_method is null
    or s.include_labor_cost is null or s.include_machine_cost is null or s.include_overhead_cost is null then
    return jsonb_build_object('configured', false, 'reason', 'WIP valuation policy is incomplete');
  end if;
  return jsonb_build_object('configured', false, 'policy_complete', true, 'as_of', p_as_of,
    'code', 'valuation_history_required',
    'reason', 'Policy saved. Operational WIP valuation requires dated cost snapshots, material recognition, outsourcing events and stock-category transfers. No accounting value was calculated.');
end;
$$;
revoke all on function public.calculate_wip_valuation(date) from public, anon;
grant execute on function public.calculate_wip_valuation(date) to authenticated;

notify pgrst, 'reload schema';
