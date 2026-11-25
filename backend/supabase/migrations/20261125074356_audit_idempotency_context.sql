-- Keep retry/idempotency keys separate from parent-process relationships.
create or replace function public.attach_audit_request_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  headers jsonb;
  row_data jsonb;
  lifecycle text;
  related jsonb;
begin
  begin
    headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  exception when others then headers := '{}'::jsonb;
  end;

  row_data := coalesce(new.new_data, new.old_data, '{}'::jsonb);
  lifecycle := case new.entity
    when 'products' then new.entity_id
    when 'product_materials' then coalesce(row_data->>'product_id', new.entity_id)
    when 'clients' then new.entity_id
    when 'orders' then new.entity_id
    when 'production_tasks' then coalesce(row_data->>'order_id', new.entity_id)
    when 'inventory_items' then new.entity_id
    when 'stock_movements' then coalesce(row_data->>'order_id', row_data->>'item_id', new.entity_id)
    when 'purchases' then new.entity_id
    when 'profiles' then coalesce(row_data->>'id', new.entity_id)
    else coalesce(new.metadata->>'lifecycle_id', new.entity_id)
  end;

  select coalesce(jsonb_agg(to_jsonb(value)), '[]'::jsonb)
    into related
    from unnest(array[
      row_data->>'client_id', row_data->>'product_id', row_data->>'order_id',
      row_data->>'item_id', row_data->>'purchase_id', row_data->>'component_product_id'
    ]) as ids(value)
   where value is not null and value <> lifecycle;

  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'process_id', left(headers->>'x-process-id', 64),
    'parent_process_id', left(headers->>'x-parent-process-id', 64),
    'idempotency_key', left(headers->>'x-idempotency-key', 128),
    'request_id', left(headers->>'x-request-id', 64),
    'operation', left(headers->>'x-process-operation', 120),
    'session_id', coalesce(auth.jwt()->>'session_id', left(headers->>'x-session-id', 64)),
    'device_id', left(headers->>'x-device-id', 64),
    'release_id', left(headers->>'x-app-release', 100),
    'lifecycle_id', lifecycle,
    'related_lifecycle_ids', related
  ));
  return new;
end;
$$;
revoke all on function public.attach_audit_request_context() from public, anon, authenticated;
create index if not exists audit_logs_idempotency_key_idx on public.audit_logs ((metadata->>'idempotency_key'));

-- Rollback: drop index audit_logs_idempotency_key_idx and restore the function
-- body from 20261125071841_audit_request_context.sql.
