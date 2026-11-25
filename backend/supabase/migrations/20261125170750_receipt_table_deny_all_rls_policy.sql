-- The receipt table is an internal idempotency ledger. Client roles must use
-- save_production_task_once(), which validates the authenticated operator.
-- Keep direct table access denied even if a future grant is added by mistake.
create policy "No direct access to production submission receipts"
  on public.production_task_submission_receipts
  for all
  to anon, authenticated
  using (false)
  with check (false);
