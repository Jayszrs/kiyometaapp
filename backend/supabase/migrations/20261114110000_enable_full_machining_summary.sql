-- Client accepted the recommended treatment: Full machining is a derived,
-- read-only summary and is not a separately editable production operation.
update public.wip_valuation_settings
set client_decisions = jsonb_set(
      coalesce(client_decisions, '{}'::jsonb),
      '{fullMachiningMode}',
      '"summary"'::jsonb,
      true
    ),
    updated_at = now(),
    version = version + 1
where id = true;
