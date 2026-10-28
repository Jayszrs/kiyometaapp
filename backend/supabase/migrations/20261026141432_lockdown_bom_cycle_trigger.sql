-- Trigger execution does not require direct client permission on its function.
-- Keep the SECURITY DEFINER cycle check callable only through the table trigger.
revoke all on function public.prevent_bom_cycle() from public, anon, authenticated;

-- Support the composite parent lookup and cascading parent deletes.
create index if not exists product_materials_parent_product_idx
  on public.product_materials (parent_bom_no, product_id);
