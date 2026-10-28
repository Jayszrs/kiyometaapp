-- The BEFORE order trigger captures requirements before a newly inserted
-- production order is visible. Enforce its parent FK at transaction completion.
alter table public.order_material_issues
  alter constraint order_material_issues_order_id_fkey
  deferrable initially deferred;
