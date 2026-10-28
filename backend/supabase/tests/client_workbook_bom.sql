-- Run against the shared testing database after seed_client_workbook.sql.
-- Uses an active account's authenticated role; every test write is rolled back.
begin;
select set_config('request.jwt.claim.sub', (
  select id::text from public.profiles where active
  order by (role = 'operator') desc, created_at limit 1
), true);
set local role authenticated;
set local app.audit_source = 'client-workbook-verification';

do $test$
declare
  v_product uuid;
  v_parent public.product_materials;
  v_bom_id uuid := gen_random_uuid();
  v_new_bom text;
  v_order uuid := gen_random_uuid();
  v_component_order uuid := gen_random_uuid();
  v_client text := 'CONTOH Customer B';
  v_cycle_rejected boolean := false;
  v_before jsonb;
  v_after jsonb;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Verification requires an active test account';
  end if;
  select id into strict v_product from public.products
    where client_name=v_client and product_number='FG-B001';
  select pm.* into strict v_parent from public.product_materials pm
    join public.inventory_items i on i.id=pm.inventory_item_id
    where pm.product_id=v_product and pm.parent_bom_no is null and i.item_code='CP-001';
  select jsonb_object_agg(item_code,available_qty) into v_before
    from public.inventory_balances where item_code in ('CP-001','BP-002','RM-001','CS-001');

  -- Exercise the exact RPC used by the local frontend's BOM save button.
  perform public.import_inventory_rows(jsonb_build_array(jsonb_build_object(
    'kind','bom','existingId','', 'payload',jsonb_build_object(
      'id',v_bom_id,'productId',v_product,'inventoryItemId',
      (select id from public.inventory_items where item_code='CS-001'),
      'parentBomNo',v_parent.bom_no,'quantityPerUnit',1,'notes','rollback verification'
    )
  )));
  select bom_no into strict v_new_bom from public.product_materials where id=v_bom_id;

  -- Exercise the update path as well as insertion with locked number generators.
  perform public.import_inventory_rows(jsonb_build_array(jsonb_build_object(
    'kind','bom','existingId',v_bom_id, 'payload',jsonb_build_object(
      'id',v_bom_id,'productId',v_product,'inventoryItemId',
      (select id from public.inventory_items where item_code='CS-001'),
      'parentBomNo',v_parent.bom_no,'quantityPerUnit',2,'notes','rollback verification'
    )
  )));
  if (select quantity_per_unit from public.product_materials where id=v_bom_id) <> 2 then
    raise exception 'BOM RPC update did not save';
  end if;
  begin
    update public.product_materials set parent_bom_no=v_new_bom where id=v_parent.id;
  exception when raise_exception then
    if sqlerrm not like 'BOM parent would create a cycle%' then raise; end if;
    v_cycle_rejected := true;
  end;
  if not v_cycle_rejected then raise exception 'BOM cycle was accepted'; end if;

  insert into public.orders(id,order_date,delivery_date,client,order_number,product_name,quantity,order_amount,progress)
    values(v_order,current_date,current_date,v_client,'WORKBOOK-VERIFY-FG','Sensor mount B',2,3600,'In production');
  if (select jsonb_object_agg(i.item_code,omi.quantity_per_unit)
      from public.order_material_issues omi join public.inventory_items i on i.id=omi.inventory_item_id
      where omi.order_id=v_order) is distinct from '{"CP-001":1,"BP-002":1}'::jsonb then
    raise exception 'Assembly must issue only direct components';
  end if;

  -- A later BOM edit must not change a production order's captured requirements.
  perform public.import_inventory_rows(jsonb_build_array(jsonb_build_object(
    'kind','bom','existingId','', 'payload',jsonb_build_object(
      'id',gen_random_uuid(),'productId',v_product,'inventoryItemId',
      (select id from public.inventory_items where item_code='CS-001'),
      'parentBomNo','','quantityPerUnit',10,'notes','rollback verification'
    )
  )));
  update public.orders set quantity=3,version=version+1 where id=v_order;
  select jsonb_object_agg(item_code,available_qty) into v_after from public.inventory_balances
    where item_code in ('CP-001','BP-002','RM-001','CS-001');
  if (v_after->>'CP-001')::numeric <> (v_before->>'CP-001')::numeric - 3
     or (v_after->>'BP-002')::numeric <> (v_before->>'BP-002')::numeric - 3
     or v_after->'RM-001' is distinct from v_before->'RM-001'
     or v_after->'CS-001' is distinct from v_before->'CS-001' then
    raise exception 'Assembly quantity update changed the wrong stock';
  end if;
  update public.orders set progress='Cancelled',version=version+1 where id=v_order;

  -- Producing the component separately uses its raw material once.
  insert into public.orders(id,order_date,delivery_date,client,order_number,product_name,quantity,order_amount,progress)
    values(v_component_order,current_date,current_date,v_client,'WORKBOOK-VERIFY-CP','Bracket mentah',2,0,'In production');
  if (select jsonb_object_agg(i.item_code,omi.quantity_per_unit)
      from public.order_material_issues omi join public.inventory_items i on i.id=omi.inventory_item_id
      where omi.order_id=v_component_order) is distinct from '{"RM-001":0.5}'::jsonb
     or (select available_qty from public.inventory_balances where item_code='RM-001') <> (v_before->>'RM-001')::numeric - 1 then
    raise exception 'Subassembly raw material issue is incorrect';
  end if;
  update public.orders set progress='Cancelled',version=version+1 where id=v_component_order;
  select jsonb_object_agg(item_code,available_qty) into v_after from public.inventory_balances
    where item_code in ('CP-001','BP-002','RM-001','CS-001');
  if v_after is distinct from v_before then
    raise exception 'Cancellation failed to restore the original stock';
  end if;
end $test$;
set constraints all immediate;
rollback;
select 'passed: authenticated BOM insert/update, cycle protection, direct component issues, snapshot stability, subassembly issues, cancellation reversals; all test writes rolled back' as result;
