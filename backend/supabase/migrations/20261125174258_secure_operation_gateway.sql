-- One private-to-the-browser gateway calls the existing transactional RPCs.
-- Only the service-role Edge Function may execute this dispatcher.
create or replace function public.execute_user_operation(
  p_action text,
  p_actor_id uuid,
  p_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  v_stock public.stock_movements%rowtype;
  v_profile public.profiles%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted service role required' using errcode = '42501';
  end if;
  if p_actor_id is null or not exists (
    select 1 from public.profiles where id = p_actor_id and active = true
  ) then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'Operation data must be an object' using errcode = '22023';
  end if;

  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_actor_id,
    'role', 'authenticated'
  )::text, true);

  case p_action
    when 'record-stock-movement' then
      v_stock := public.record_stock_movement(
        nullif(p_input->>'movementDate', '')::date,
        p_input->>'movementType',
        p_input->>'referenceId',
        nullif(p_input->>'itemId', '')::uuid,
        nullif(p_input->>'quantity', '')::numeric,
        nullif(p_input->>'delta', '')::numeric,
        p_input->>'pic',
        p_input->>'notes',
        nullif(p_input->>'idempotencyKey', '')::uuid
      );
      return to_jsonb(v_stock);
    when 'save-production-task' then
      return public.save_production_task_once(
        nullif(p_input->>'requestId', '')::uuid,
        nullif(p_input->>'existingId', '')::uuid,
        nullif(p_input->>'expectedVersion', '')::integer,
        nullif(p_input->>'orderId', '')::uuid,
        nullif(p_input->>'operationId', '')::uuid,
        p_input->>'status',
        nullif(p_input->>'actualMinutes', '')::numeric,
        p_input->>'actualTimeBasis',
        nullif(p_input->>'processedQuantity', '')::numeric,
        nullif(p_input->>'completedQuantity', '')::numeric,
        nullif(p_input->>'completedAt', '')::timestamptz,
        nullif(p_input->>'operatorId', '')::uuid
      );
    when 'undo-audit-entry' then
      perform public.undo_audit_entry(nullif(p_input->>'auditId', '')::uuid);
      return jsonb_build_object('ok', true);
    when 'update-own-profile' then
      v_profile := public.update_own_profile(
        p_input->>'displayName',
        p_input->>'avatarPath',
        p_input->>'employeeNumber',
        p_input->>'phone',
        p_input->>'department',
        p_input->>'position',
        nullif(p_input->>'birthDate', '')::date,
        p_input->>'address',
        p_input->>'bio'
      );
      return to_jsonb(v_profile);
    else
      raise exception 'Unsupported operation' using errcode = '22023';
  end case;
end;
$$;

revoke all on function public.execute_user_operation(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.execute_user_operation(text, uuid, jsonb)
  to service_role;
