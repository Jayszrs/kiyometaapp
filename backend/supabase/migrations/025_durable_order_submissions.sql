-- A retry after a lost response must not duplicate a write, stock movement or
-- audit event. Receipt and order mutation commit in the same transaction.
create table public.order_submission_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);
alter table public.order_submission_receipts enable row level security;
create policy "own submission receipts" on public.order_submission_receipts
  for all to authenticated using (owner_id = (select auth.uid()) and (select public.is_active_user()))
  with check (owner_id = (select auth.uid()) and (select public.is_active_user()));
grant select, insert on public.order_submission_receipts to authenticated;

create function public.submit_order_once(p_request_id uuid, p_order jsonb, p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_receipt public.order_submission_receipts;
  v_existing public.orders;
  v_input public.orders;
  v_saved public.orders;
  v_payload jsonb := jsonb_build_object('order', p_order, 'expected_version', p_expected_version);
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  -- Serialize matching retries across tabs/devices before testing the receipt.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_request_id::text, 0));
  select * into v_receipt from public.order_submission_receipts
    where owner_id = auth.uid() and request_id = p_request_id;
  if found then
    if v_receipt.payload <> v_payload then
      raise exception 'Submission identifier reused with different fields' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;
  v_input := jsonb_populate_record(null::public.orders, p_order);
  if v_input.id is null then raise exception 'Order identifier required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_input.id::text, 0));
  select * into v_existing from public.orders where id = v_input.id for update;
  if found then
    if p_expected_version is null or v_existing.version <> p_expected_version then
      return jsonb_build_object('conflict', true, 'latest', to_jsonb(v_existing));
    end if;
    update public.orders set
      order_date=v_input.order_date, delivery_date=v_input.delivery_date, client=v_input.client,
      order_number=v_input.order_number, product_name=v_input.product_name, quantity=v_input.quantity,
      order_amount=v_input.order_amount, progress=v_input.progress, required_manhours=v_input.required_manhours,
      worked_manhours=v_input.worked_manhours, production_end_date=v_input.production_end_date,
      order_contact=v_input.order_contact, contact_contents=v_input.contact_contents,
      finish_task=v_input.finish_task, has_contact=v_input.has_contact, completed_tasks=v_input.completed_tasks,
      version=p_expected_version+1
      where id=v_input.id returning * into v_saved;
  else
    if p_expected_version is not null then
      raise exception 'This order was deleted. Review the draft before creating a new order.' using errcode = 'P0002';
    end if;
    insert into public.orders (id,order_date,delivery_date,client,order_number,product_name,quantity,
      order_amount,progress,required_manhours,worked_manhours,production_end_date,order_contact,
      contact_contents,finish_task,has_contact,completed_tasks,version)
      values (v_input.id,v_input.order_date,v_input.delivery_date,v_input.client,v_input.order_number,
      v_input.product_name,v_input.quantity,v_input.order_amount,v_input.progress,v_input.required_manhours,
      v_input.worked_manhours,v_input.production_end_date,v_input.order_contact,v_input.contact_contents,
      v_input.finish_task,v_input.has_contact,v_input.completed_tasks,1) returning * into v_saved;
  end if;
  insert into public.order_submission_receipts(owner_id,request_id,payload,result)
    values (auth.uid(),p_request_id,v_payload,to_jsonb(v_saved));
  return to_jsonb(v_saved);
end;
$$;
revoke all on function public.submit_order_once(uuid,jsonb,integer) from public, anon;
grant execute on function public.submit_order_once(uuid,jsonb,integer) to authenticated;
