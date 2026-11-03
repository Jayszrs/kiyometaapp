-- product_materials.bom_no defaults to this sequence-backed function. The
-- function is SECURITY DEFINER and returns only the next public BOM number;
-- authenticated clients need EXECUTE for the column default to work through
-- PostgREST. Migration 018 revoked it along with trigger-only helpers, which
-- made every direct BOM insert fail with SQLSTATE 42501 / HTTP 403.
grant execute on function public.next_bom_no() to authenticated;
