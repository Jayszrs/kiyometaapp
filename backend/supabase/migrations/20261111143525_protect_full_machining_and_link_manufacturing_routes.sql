create or replace function public.protect_full_machining_name()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.operation_code <> 'FULL_MACHINING' and (
      lower(btrim(new.operation_name)) in ('full machining', 'pemrosesan lengkap')
      or btrim(new.operation_name_ja) = '全加工') then
      raise exception 'The Full machining process name is reserved';
    end if;
    return new;
  end if;
  if old.operation_code = 'FULL_MACHINING'
    and (new.operation_name is distinct from old.operation_name
      or new.operation_name_ja is distinct from old.operation_name_ja
      or new.operation_code is distinct from old.operation_code) then
    raise exception 'The Full machining process name is protected';
  end if;
  if old.operation_code <> 'FULL_MACHINING' and (
    new.operation_code = 'FULL_MACHINING'
    or lower(btrim(new.operation_name)) in ('full machining', 'pemrosesan lengkap')
    or btrim(new.operation_name_ja) = '全加工') then
    raise exception 'The Full machining process name is reserved';
  end if;
  return new;
end;
$$;
drop trigger if exists manufacturing_operations_protect_full_machining_name on public.manufacturing_operations;
create trigger manufacturing_operations_protect_full_machining_name
  before insert or update of operation_name, operation_name_ja, operation_code
  on public.manufacturing_operations for each row execute function public.protect_full_machining_name();
revoke execute on function public.protect_full_machining_name() from public, anon, authenticated;

update public.products p set tasks = (
  select coalesce(jsonb_agg(case when op.id is null then e.task
    else e.task || jsonb_build_object('operationId', op.id) end order by e.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p.tasks) with ordinality as e(task, ordinality)
  left join lateral (
    select (array_agg(m.id))[1] as id from public.manufacturing_operations m
    where m.operation_name = e.task->>'content' or m.operation_name_ja = e.task->>'content'
    having count(*) = 1
  ) op on true
) where jsonb_typeof(p.tasks) = 'array';

create or replace function public.link_product_route_operations()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if jsonb_typeof(new.tasks) <> 'array' then return new; end if;
  new.tasks := (
    select coalesce(jsonb_agg(case when op.id is null then e.task - 'operationId'
      else e.task || jsonb_build_object('operationId', op.id) end order by e.ordinality), '[]'::jsonb)
    from jsonb_array_elements(new.tasks) with ordinality as e(task, ordinality)
    left join lateral (
      select (array_agg(m.id))[1] as id from public.manufacturing_operations m
      where m.operation_name = e.task->>'content' or m.operation_name_ja = e.task->>'content'
      having count(*) = 1
    ) op on true
  );
  return new;
end;
$$;
drop trigger if exists products_link_route_operations on public.products;
create trigger products_link_route_operations before insert or update of tasks
  on public.products for each row execute function public.link_product_route_operations();
revoke all on function public.link_product_route_operations() from public, anon, authenticated;

create or replace function public.sync_renamed_operation_routes()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  update public.products p set tasks = (
    select coalesce(jsonb_agg(case
      when e.task->>'operationId' = old.id::text
      then e.task || jsonb_build_object('operationId', new.id, 'content', new.operation_name)
      else e.task end order by e.ordinality), '[]'::jsonb)
    from jsonb_array_elements(p.tasks) with ordinality as e(task, ordinality)
  ) where jsonb_typeof(p.tasks) = 'array' and exists (
    select 1 from jsonb_array_elements(p.tasks) e where e->>'operationId' = old.id::text
  );
  return new;
end;
$$;
drop trigger if exists manufacturing_operation_sync_routes on public.manufacturing_operations;
create trigger manufacturing_operation_sync_routes
  after update of operation_name, operation_name_ja on public.manufacturing_operations
  for each row when (old.operation_name is distinct from new.operation_name
    or old.operation_name_ja is distinct from new.operation_name_ja)
  execute function public.sync_renamed_operation_routes();
revoke all on function public.sync_renamed_operation_routes() from public, anon, authenticated;

notify pgrst, 'reload schema';
