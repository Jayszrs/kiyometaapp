-- =============================================================================
-- 020: purchases optimistic concurrency
-- =============================================================================
--
-- Purchases were saved with a plain update and no precondition, so two
-- operators editing the same purchase produced a silent last-write-wins. The
-- nasty case is a status revert: reversing "received" re-posts an automatic
-- stock reversal even when the goods already moved out.
--
-- Mirror the orders guard from 011. The client reads `version` before editing
-- and resends it with the save; an update only applies when the value still
-- matches, and a mismatch is reported as a conflict instead of an overwrite.
-- Existing rows keep working because they start at version 1.

alter table public.purchases add column if not exists version integer not null default 1;

create index if not exists purchases_version_idx on public.purchases (version)
  where version is not null;