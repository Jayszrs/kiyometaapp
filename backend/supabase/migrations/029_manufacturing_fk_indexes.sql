-- Cover user foreign keys reported by the database performance advisor.
create index if not exists production_tasks_operator_idx
  on public.production_tasks (operator_id)
  where operator_id is not null;
create index if not exists production_costs_created_by_idx
  on public.production_costs (created_by)
  where created_by is not null;
