-- Decisions marked by the client in Japan 2.pdf.
-- Full machining stays null because the client wrote that its meaning is unclear.
alter table public.wip_valuation_settings
  drop constraint if exists wip_valuation_settings_in_progress_confirmed_check;

update public.wip_valuation_settings
set include_in_progress_operation = true,
    material_issue_point = 'process_start',
    outsourcing_recognition = 'received',
    client_decisions = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(coalesce(client_decisions, '{}'::jsonb), '{newStageScope}', '"active_orders"'::jsonb, true),
                '{preparationLayout}', '"per_order"'::jsonb, true),
              '{preparationBom}', '"include"'::jsonb, true),
            '{preparationOperatorLog}', '"include"'::jsonb, true),
          '{reportOutput}', '"both"'::jsonb, true),
        '{bomQuantities}', '{"P1":1,"P2":1,"P3":1,"P4":1}'::jsonb, true),
      '{bomMultiplierNote}', '"x6 applies to another part; exact part identity remains to be mapped"'::jsonb, true),
    version = version + 1,
    updated_at = now()
where id = true;

update public.wip_valuation_settings
set client_decisions = jsonb_set(
  client_decisions,
  '{notes}',
  to_jsonb(concat_ws(E'\n', nullif(client_decisions->>'notes',''),
    'Japan 2.pdf: new stages apply to active production orders.',
    'Japan 2.pdf: WIP includes in-progress operations; material recognition at production start; outsourcing at receipt; vendor-held goods remain WIP.',
    'Japan 2.pdf: P1-P4 quantities are 1 each. x6 applies to another part; exact part identity remains to be mapped.',
    'Japan 2.pdf: preparation print includes order+BOM+process+operator notes; one order per form; browser/PDF and Excel; continuation pages.')),
  true),
  version = version + 1,
  updated_at = now()
where id = true;

alter table public.wip_valuation_settings
  add constraint wip_valuation_settings_in_progress_confirmed_check
  check (include_in_progress_operation is null or include_in_progress_operation = true);

notify pgrst, 'reload schema';
