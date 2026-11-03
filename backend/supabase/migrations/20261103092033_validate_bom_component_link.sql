-- Validate that a linked BOM subassembly corresponds to the stock item on the
-- same row. This mirrors the UI's dynamic options and protects REST/Excel RPC
-- writes from creating orphaned product-to-stock relationships.
create or replace function public.prevent_component_product_cycle()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_code_matches integer;
  v_name_matches integer;
begin
  if new.component_product_id is null then return new; end if;

  if new.component_product_id = new.product_id then
    raise exception 'A product cannot be its own BOM component' using errcode = '23514';
  end if;

  select * into v_item from public.inventory_items where id = new.inventory_item_id;
  if not found or v_item.category not in ('component', 'finished_good') or v_item.procurement_type <> 'make' then
    raise exception 'A linked subassembly must use a make-type component or finished-good inventory item'
      using errcode = '23514';
  end if;

  select count(*) into v_code_matches
  from public.products p
  where lower(btrim(p.product_number)) = lower(btrim(v_item.item_code));

  if v_code_matches > 0 then
    if v_code_matches <> 1 or not exists (
      select 1 from public.products p where p.id = new.component_product_id
        and lower(btrim(p.product_number)) = lower(btrim(v_item.item_code))
    ) then
      raise exception 'The linked subassembly does not uniquely match this inventory item code'
        using errcode = '23514';
    end if;
  else
    select count(*) into v_name_matches
    from public.products p
    where lower(regexp_replace(btrim(p.product_name), '\s+', ' ', 'g')) =
          lower(regexp_replace(btrim(v_item.item_name), '\s+', ' ', 'g'));
    if v_name_matches <> 1 or not exists (
      select 1 from public.products p where p.id = new.component_product_id
        and lower(regexp_replace(btrim(p.product_name), '\s+', ' ', 'g')) =
            lower(regexp_replace(btrim(v_item.item_name), '\s+', ' ', 'g'))
    ) then
      raise exception 'The linked subassembly must be the unique product matching this inventory item code or name'
        using errcode = '23514';
    end if;
  end if;

  if exists (
    with recursive descendants(product_id) as (
      select pm.component_product_id
      from public.product_materials pm
      where pm.product_id = new.component_product_id
        and pm.component_product_id is not null
        and pm.id <> new.id
      union
      select pm.component_product_id
      from public.product_materials pm
      join descendants d on pm.product_id = d.product_id
      where pm.component_product_id is not null
        and pm.id <> new.id
    )
    select 1 from descendants where product_id = new.product_id
  ) then
    raise exception 'BOM component product would create a cycle' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_component_product_cycle() from public, anon, authenticated;
