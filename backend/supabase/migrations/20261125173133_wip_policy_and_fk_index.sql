create index if not exists wip_valuation_settings_configured_by_idx
  on public.wip_valuation_settings(configured_by);

drop policy if exists "administrators manage WIP settings"
  on public.wip_valuation_settings;
create policy "administrators insert WIP settings"
  on public.wip_valuation_settings
  for insert to authenticated
  with check ((select private.is_administrator()));
create policy "administrators update WIP settings"
  on public.wip_valuation_settings
  for update to authenticated
  using ((select private.is_administrator()))
  with check ((select private.is_administrator()));
create policy "administrators delete WIP settings"
  on public.wip_valuation_settings
  for delete to authenticated
  using ((select private.is_administrator()));
