-- =============================================================================
-- 021: performance advisor cleanup
-- =============================================================================
--
-- The Supabase performance advisor currently reports:
--   duplicate_index (WARN): inventory_items {pkey, item_code_key} and
--     purchases {pkey, purchase_no_key} are identical unique indexes.
--   no_primary_key (INFO): maintenance.products_tank_backup_20261013.
--
-- The primary keys are on item_code / purchase_no, so the older *_key unique
-- constraints created with the tables are redundant and cost one extra write
-- index each. Dropping a constraint removes its backing index; the `drop
-- index if exists` below covers the case where one was standalone (raw
-- CREATE UNIQUE INDEX without a constraint). No observable behaviour changes:
-- uniqueness and every foreign key stay satisfied by the remaining indexes.
--

alter table public.inventory_items drop constraint if exists inventory_items_item_code_key;
drop index if exists inventory_items_item_code_key;

alter table public.purchases drop constraint if exists purchases_purchase_no_key;
drop index if exists purchases_purchase_no_key;

-- The tank-merge backup is unindexed. Give it a primary key so the advisor
-- stops flagging it; the rows stay intact as the merge record. Guarded with a
-- DO block because Postgres has no "add constraint if not exists".
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'maintenance.products_tank_backup_20261013'::regclass
      and contype = 'p'
  ) then
    alter table maintenance.products_tank_backup_20261013
      add constraint products_tank_backup_pkey primary key (id);
  end if;
end$$;