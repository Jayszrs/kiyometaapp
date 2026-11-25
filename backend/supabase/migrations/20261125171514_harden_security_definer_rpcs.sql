-- Narrow SECURITY DEFINER helper behavior to the authenticated session.
create or replace function public.is_active_user(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and active = true
    );
$$;

create or replace function public.is_administrator(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'administrator' and active = true
    );
$$;

-- This RPC returns only static feature flags, so it does not need elevated
-- privileges or SECURITY DEFINER execution.
alter function public.undo_capabilities() security invoker;

-- The manufacturing import wrapper calls this function as its owner. Clients
-- must use the wrapper so the import path has one permission and validation
-- boundary.
revoke all on function public.import_inventory_rows(jsonb)
  from public, anon, authenticated;
grant execute on function public.import_inventory_rows(jsonb) to service_role;

-- Reject sessions whose profile was deactivated after their access token was
-- issued, even though the operator id matches auth.uid().
create or replace function public.save_production_task_once(
  p_request_id uuid,
  p_existing_id uuid,
  p_expected_version integer,
  p_order_id uuid,
  p_operation_id uuid,
  p_status text,
  p_actual_minutes numeric,
  p_actual_time_basis text,
  p_processed_quantity numeric,
  p_completed_quantity numeric,
  p_completed_at timestamptz,
  p_operator_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner uuid := auth.uid();
  v_payload jsonb;
  v_receipt public.production_task_submission_receipts%rowtype;
  v_task public.production_tasks%rowtype;
  v_latest public.production_tasks%rowtype;
  v_result jsonb;
begin
  if v_owner is null or p_operator_id is distinct from v_owner
    or not public.is_active_user() then
    raise exception 'Authenticated active operator required' using errcode = '42501';
  end if;
  if p_status not in ('pending','in_progress','completed','issue') then
    raise exception 'Invalid production status';
  end if;
  if (p_actual_minutes is not null and p_actual_minutes < 0)
    or (p_processed_quantity is not null and p_processed_quantity < 0)
    or (p_completed_quantity is not null and p_completed_quantity < 0)
    or (p_processed_quantity is not null and p_completed_quantity is not null and p_completed_quantity > p_processed_quantity) then
    raise exception 'Invalid production time or quantity';
  end if;

  v_payload := jsonb_build_object(
    'existing_id',p_existing_id,'expected_version',p_expected_version,'order_id',p_order_id,
    'operation_id',p_operation_id,'status',p_status,'actual_minutes',p_actual_minutes,
    'actual_time_basis',p_actual_time_basis,'processed_quantity',p_processed_quantity,
    'completed_quantity',p_completed_quantity,'completed_at',p_completed_at,'operator_id',p_operator_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text || p_request_id::text, 0));
  select * into v_receipt from public.production_task_submission_receipts
    where owner_id=v_owner and request_id=p_request_id;
  if found then
    if v_receipt.payload is distinct from v_payload then raise exception 'Request ID was reused with different production data'; end if;
    return v_receipt.result;
  end if;

  if p_existing_id is null then
    begin
      insert into public.production_tasks(order_id,operation_id,status,actual_minutes,actual_time_basis,
        processed_quantity,completed_quantity,operator_id,completed_at,version)
      values (p_order_id,p_operation_id,p_status,p_actual_minutes,p_actual_time_basis,
        p_processed_quantity,p_completed_quantity,p_operator_id,
        case when p_status='completed' then coalesce(p_completed_at,now()) else null end,1)
      returning * into v_task;
    exception when unique_violation then
      select * into v_latest from public.production_tasks where order_id=p_order_id and operation_id=p_operation_id;
      return jsonb_build_object('ok',false,'conflict',true,'latest',to_jsonb(v_latest));
    end;
  else
    update public.production_tasks set status=p_status,actual_minutes=p_actual_minutes,
      actual_time_basis=p_actual_time_basis,processed_quantity=p_processed_quantity,
      completed_quantity=p_completed_quantity,operator_id=p_operator_id,
      completed_at=case when p_status='completed' then coalesce(p_completed_at,completed_at,now()) else null end
      where id=p_existing_id and version=p_expected_version
      returning * into v_task;
    if not found then
      select * into v_latest from public.production_tasks where id=p_existing_id;
      return jsonb_build_object('ok',false,'conflict',true,'latest',case when found then to_jsonb(v_latest) else null end);
    end if;
  end if;

  v_result := jsonb_build_object('ok',true,'task',to_jsonb(v_task));
  insert into public.production_task_submission_receipts(owner_id,request_id,payload,result)
    values (v_owner,p_request_id,v_payload,v_result);
  return v_result;
end;
$function$;

revoke all on function public.save_production_task_once(uuid,uuid,integer,uuid,uuid,text,numeric,text,numeric,numeric,timestamptz,uuid)
  from public, anon;
grant execute on function public.save_production_task_once(uuid,uuid,integer,uuid,uuid,text,numeric,text,numeric,numeric,timestamptz,uuid)
  to authenticated;
