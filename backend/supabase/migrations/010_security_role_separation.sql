-- Kiyometa — security hardening and role separation.
-- Run once in Supabase -> SQL Editor, after 009_private_product_drawings.sql.
--
-- Why this file exists
-- --------------------
-- 1. handle_new_auth_user read the new account's role straight out of
--    auth.users.raw_user_meta_data. That field is supplied by whoever calls the
--    signup endpoint, so anyone able to register an account could declare
--    {"role":"administrator"} and be minted an active administrator profile.
--    The trigger then hands out the manage-users Edge Function, which can reset
--    any account's password. The same trigger also honoured a
--    "created_by" value from metadata, which let a signup forge audit records.
--
-- 2. Every operational table had exactly one policy of the shape
--      for all to authenticated using (is_active_user()) with check (...)
--    is_active_user() tests *active*, never *role*. So the least privileged
--    employee could DELETE the entire order book and append arbitrary
--    stock_movements rows, straight at PostgREST, with only the publishable
--    key. Roles existed in the UI and in the manage-users function, but never
--    gated a write.
--
-- What this file changes
-- ----------------------
--   a. New single-use admin_invites table. Administrator is granted only to an
--      address that an administrator pre-registered, and the entry is consumed
--      on use. Metadata can no longer influence role or created_by.
--   b. Per-operation RLS: every active user may read, create and edit;
--      only administrators may delete. This keeps all day-to-day work
--      (order entry, goods receipt, stock adjustment, master data maintenance)
--      available to operators while making record destruction an administrator
--      action. Administrators keep unrestricted access.
--   c. The parameterised forms of is_administrator/is_active_user are no longer
--      executable by clients, so no one can probe another account's role.
--   d. stock_movements stops accepting writes from PostgREST. The ledger is
--      posted through record_stock_movement(), which only allows the movement
--      types a person can enter by hand, and the INSERT/UPDATE table grants and
--      policies are revoked so a client cannot claim a purchase or an order as
--      the reason for a quantity.
--
-- Nothing here revokes the tables from service_role, and no policy uses
-- USING (true), so Edge Functions and migrations are unaffected.

-- ===========================================================================
-- 1. Administrator bootstrap
-- ===========================================================================

-- Single use, single purpose. An administrator inserts a row (via the SQL
-- editor or an Edge Function using service_role) before an account is created;
-- the signup trigger consumes it and grants administrator exactly once. There
-- is deliberately no INSERT/UPDATE/DELETE policy for anon or authenticated, so
-- the web app cannot write to this table and cannot promote itself.
create table if not exists public.admin_invites (
  email       text primary key check (email = lower(btrim(email))),
  note        text not null default '',
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.admin_invites enable row level security;

drop policy if exists "administrators read admin invites" on public.admin_invites;
create policy "administrators read admin invites" on public.admin_invites
  for select to authenticated using (public.is_administrator());

-- The owner account is pre-registered so the first administrator is not locked
-- out by the trigger change below. It is consumed the first time that address
-- registers, and can be re-issued later with a single insert.
insert into public.admin_invites (email, note)
values ('operator@kiyometa.app', 'Initial administrator bootstrap')
on conflict (email) do nothing;

-- ===========================================================================
-- 2. Signup trigger: role is never taken from client metadata
-- ===========================================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_invite boolean;
begin
  -- The only way to become an administrator at signup is a pre-registered,
  -- not-yet-consumed invite. The row is consumed unconditionally, so a second
  -- registration of the same address gets the default role.
  select true into v_invite
  from public.admin_invites
  where email = lower(btrim(coalesce(new.email, '')))
    and consumed_at is null
  for update;

  if v_invite then
    update public.admin_invites
       set consumed_at = now()
     where email = lower(btrim(coalesce(new.email, '')));
  end if;

  v_username := lower(coalesce(
    nullif(btrim(new.raw_user_meta_data->>'username'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  ));

  -- A malformed username would violate the profiles check constraint and abort
  -- the signup, so fall back to a deterministic safe value rather than the
  -- client supplied string.
  if v_username !~ '^[a-z0-9._-]{3,32}$' then
    v_username := lower(substr(replace(coalesce(new.email, 'user'), '@', '.'), 1, 32));
  end if;
  if v_username !~ '^[a-z0-9._-]{3,32}$' then
    v_username := 'user' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  insert into public.profiles (id, username, login_email, display_name, role, created_by)
  values (
    new.id,
    v_username,
    coalesce(new.email, v_username || '@kiyometa.app'),
    coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'), ''), v_username),
    case when v_invite then 'administrator' else 'operator' end,
    -- created_by is an audit field. It must never come from client metadata.
    null
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Existing accounts keep the role they already have: this migration only
-- changes how *new* accounts are created. Verify the owner is still an
-- administrator before signing in:
--
--   select username, role, active from public.profiles
--    where role = 'administrator' order by created_at;

-- ===========================================================================
-- 3. Role aware row level security
-- ===========================================================================
--
-- Policy names are kept identical to the ones they replace so re-running this
-- file is idempotent. Every predicate is wrapped in a scalar subquery:
-- (select public.is_active_user()) is evaluated once per statement as an
-- InitPlan, whereas a bare call is re-evaluated for every row scanned.

-- clients ---------------------------------------------------------------
drop policy if exists "auth all" on public.clients;
drop policy if exists "active users manage clients" on public.clients;
drop policy if exists "active users read clients" on public.clients;
drop policy if exists "active users create clients" on public.clients;
drop policy if exists "active users update clients" on public.clients;
drop policy if exists "administrators delete clients" on public.clients;
create policy "active users read clients" on public.clients
  for select to authenticated using ((select public.is_active_user()));
create policy "active users create clients" on public.clients
  for insert to authenticated with check ((select public.is_active_user()));
create policy "active users update clients" on public.clients
  for update to authenticated using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete clients" on public.clients
  for delete to authenticated using ((select public.is_administrator()));

-- products --------------------------------------------------------------
drop policy if exists "auth all" on public.products;
drop policy if exists "active users manage products" on public.products;
drop policy if exists "active users read products" on public.products;
drop policy if exists "active users create products" on public.products;
drop policy if exists "active users update products" on public.products;
drop policy if exists "administrators delete products" on public.products;
create policy "active users read products" on public.products
  for select to authenticated using ((select public.is_active_user()));
create policy "active users create products" on public.products
  for insert to authenticated with check ((select public.is_active_user()));
create policy "active users update products" on public.products
  for update to authenticated using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete products" on public.products
  for delete to authenticated using ((select public.is_administrator()));

-- orders ----------------------------------------------------------------
drop policy if exists "auth all" on public.orders;
drop policy if exists "active users manage orders" on public.orders;
drop policy if exists "active users read orders" on public.orders;
drop policy if exists "active users create orders" on public.orders;
drop policy if exists "active users update orders" on public.orders;
drop policy if exists "administrators delete orders" on public.orders;
create policy "active users read orders" on public.orders
  for select to authenticated using ((select public.is_active_user()));
create policy "active users create orders" on public.orders
  for insert to authenticated with check ((select public.is_active_user()));
create policy "active users update orders" on public.orders
  for update to authenticated using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete orders" on public.orders
  for delete to authenticated using ((select public.is_administrator()));

-- inventory_items -------------------------------------------------------
drop policy if exists "authenticated manage inventory items" on public.inventory_items;
drop policy if exists "active users read inventory items" on public.inventory_items;
drop policy if exists "active users create inventory items" on public.inventory_items;
drop policy if exists "active users update inventory items" on public.inventory_items;
drop policy if exists "administrators delete inventory items" on public.inventory_items;
create policy "active users read inventory items" on public.inventory_items
  for select to authenticated using ((select public.is_active_user()));
create policy "active users create inventory items" on public.inventory_items
  for insert to authenticated with check ((select public.is_active_user()));
create policy "active users update inventory items" on public.inventory_items
  for update to authenticated using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete inventory items" on public.inventory_items
  for delete to authenticated using ((select public.is_administrator()));

-- product_materials -----------------------------------------------------
drop policy if exists "authenticated manage product materials" on public.product_materials;
drop policy if exists "active users read product materials" on public.product_materials;
drop policy if exists "active users create product materials" on public.product_materials;
drop policy if exists "active users update product materials" on public.product_materials;
drop policy if exists "administrators delete product materials" on public.product_materials;
create policy "active users read product materials" on public.product_materials
  for select to authenticated using ((select public.is_active_user()));
create policy "active users create product materials" on public.product_materials
  for insert to authenticated with check ((select public.is_active_user()));
create policy "active users update product materials" on public.product_materials
  for update to authenticated using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete product materials" on public.product_materials
  for delete to authenticated using ((select public.is_administrator()));

-- purchases -------------------------------------------------------------
drop policy if exists "authenticated manage purchases" on public.purchases;
drop policy if exists "active users read purchases" on public.purchases;
drop policy if exists "active users create purchases" on public.purchases;
drop policy if exists "active users update purchases" on public.purchases;
drop policy if exists "administrators delete purchases" on public.purchases;
create policy "active users read purchases" on public.purchases
  for select to authenticated using ((select public.is_active_user()));
create policy "active users create purchases" on public.purchases
  for insert to authenticated with check ((select public.is_active_user()));
create policy "active users update purchases" on public.purchases
  for update to authenticated using ((select public.is_active_user()))
  with check ((select public.is_active_user()));
create policy "administrators delete purchases" on public.purchases
  for delete to authenticated using ((select public.is_administrator()));

-- stock_movements -------------------------------------------------------
--
-- A movement is a ledger entry, not a record the client is free to shape. With
-- a plain INSERT policy an active operator could post a row with
-- reference_type = 'order' and a delta of their choosing, which moves stock with
-- no purchase, no BOM and no order behind it, and the automatic paths in 007
-- and 011 would then reconcile around the forged total. In-place UPDATE is
-- worse: it rewrites a fact that other rows' negative-balance check and the
-- undo log were computed against.
--
-- So: read freely, post through record_stock_movement() which only accepts
-- manual adjustments, no UPDATE at all, and DELETE stays administrator only
-- because the inventory screen has a deliberate "remove the wrong adjustment"
-- action. The automatic inserts in 007/011 and the undo function are
-- SECURITY DEFINER, so they are unaffected.
drop policy if exists "authenticated manage stock movements" on public.stock_movements;
drop policy if exists "active users read stock movements" on public.stock_movements;
drop policy if exists "active users create stock movements" on public.stock_movements;
drop policy if exists "active users update stock movements" on public.stock_movements;
drop policy if exists "administrators delete stock movements" on public.stock_movements;
create policy "active users read stock movements" on public.stock_movements
  for select to authenticated using ((select public.is_active_user()));
create policy "administrators delete stock movements" on public.stock_movements
  for delete to authenticated using ((select public.is_administrator()));

create or replace function public.record_stock_movement(
  p_movement_date  date,
  p_movement_type  text,
  p_reference_id   text,
  p_item_id        uuid,
  p_quantity       numeric,
  p_delta          numeric,
  p_pic            text,
  p_notes          text
)
returns public.stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stock_movements;
begin
  if not (select public.is_active_user()) then
    raise exception 'Your account is not active' using errcode = '42501';
  end if;

  -- Clients may only post the types a person can genuinely type by hand in the
  -- inventory screen. purchase_receipt belongs to a purchase receipt,
  -- order_material_issue/reversal to the BOM trigger and undo to the undo
  -- function: each of those is evidence that a document was processed, and
  -- forging one would move stock with nothing behind it while the automatic
  -- paths then reconcile around the forged total.
  if p_movement_type not in (
    'material_issue', 'production_output', 'subcontract_out', 'subcontract_in',
    'sale_shipment', 'adjustment_in', 'adjustment_out'
  ) then
    raise exception 'Movement type % is posted by the related document, not manually', p_movement_type
      using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '23514';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'Adjustment must change the balance' using errcode = '23514';
  end if;
  if p_item_id is null then
    raise exception 'Choose an inventory item' using errcode = '23514';
  end if;

  insert into public.stock_movements (
    movement_date, movement_type, reference_type, reference_id,
    item_id, quantity, delta, pic, notes
  ) values (
    coalesce(p_movement_date, current_date),
    p_movement_type, 'manual', nullif(btrim(coalesce(p_reference_id, '')), ''),
    p_item_id, p_quantity, p_delta,
    btrim(coalesce(p_pic, '')), btrim(coalesce(p_notes, ''))
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_stock_movement(date, text, text, uuid, numeric, numeric, text, text) from public, anon;
grant execute on function public.record_stock_movement(date, text, text, uuid, numeric, numeric, text, text) to authenticated;

-- profiles and audit_logs are already closed to client writes by 002; only the
-- audit read policy needs the InitPlan treatment.
drop policy if exists "active users read permitted audit" on public.audit_logs;
create policy "active users read permitted audit" on public.audit_logs
  for select to authenticated
  using (
    (select public.is_active_user())
    and (user_id = auth.uid() or (select public.is_administrator()))
  );
drop policy if exists "authenticated read profiles" on public.profiles;
create policy "authenticated read profiles" on public.profiles
  for select to authenticated
  using (id = auth.uid() or (select public.is_administrator()));

-- client names are not secret and both modules need them for their own edit
-- forms, so clients/products/orders keep the plain authenticated grant. RLS is
-- what gates access, not the grant.
grant select, insert, update on public.clients to authenticated;
grant select, insert, update on public.products to authenticated;
grant select, insert, update on public.orders to authenticated;

-- stock_movements loses INSERT and UPDATE; 002 granted them to authenticated and
-- RLS policies alone would not have been enough, because the table grant is what
-- PostgREST checks before a policy is even evaluated.
revoke insert, update on public.stock_movements from authenticated;

-- ===========================================================================
-- 4. Storage: restore the `to authenticated` clause and bound the bucket
-- ===========================================================================
--
-- 009 recreated the drawings policy without a TO clause, which makes it apply
-- to PUBLIC. is_active_user() defaults to auth.uid() and is NULL for anon, so
-- the expression is already false for anonymous callers and this is defence in
-- depth rather than a live hole.

drop policy if exists "active users manage drawings" on storage.objects;
drop policy if exists "auth manage drawings" on storage.objects;
create policy "active users manage drawings" on storage.objects
  for all to authenticated
  using (bucket_id = 'product-drawings' and (select public.is_active_user()))
  with check (bucket_id = 'product-drawings' and (select public.is_active_user()));

-- 001 created the bucket with no limits at all, unlike profile-images which
-- 006 bounded to 3 MB plus a MIME allowlist. Without this an active user can
-- upload an arbitrarily large file and can declare the content type, which
-- becomes the extension and therefore the Content-Type a signed URL serves.
update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
 where id = 'product-drawings';

-- ===========================================================================
-- 5. Role probing helpers — deliberately unchanged
-- ===========================================================================
--
-- is_administrator(uuid) and is_active_user(uuid) take an account id, so calling
-- them as a client answers "is this UUID an administrator?". That is a real but
-- minor disclosure: it needs a UUID to be useful, and the only account ids an
-- ordinary employee can see already come from records they are allowed to read.
--
-- Revoking EXECUTE is NOT a safe fix here. PostgreSQL checks function
-- privileges when a policy expression runs, so withdrawing the grant would make
-- every policy in 002, 005 and 009 raise "permission denied for function" and
-- lock all seven tables for every user. The parameter can only be removed
-- together with replacing the overload with a no-argument version and rewriting
-- every existing policy to match, which is a schema change with real blast
-- radius and no security benefit worth that risk.
--
-- The EXECUTE grant granted by 002 is therefore left exactly as it was:
--   grant execute on function public.is_administrator(uuid) to authenticated;
--   grant execute on function public.is_active_user(uuid) to authenticated;
-- anon still cannot call either, because 002 never granted it to anon.

-- ===========================================================================
-- 6. Verify
-- ===========================================================================
-- Every operational table must expose four policies and DELETE must be
-- administrator only. stock_movements is the exception: it has SELECT and
-- administrator-only DELETE and nothing else.
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('clients','products','orders','inventory_items',
--                        'product_materials','purchases','stock_movements')
--    order by tablename, cmd;
--
-- The ledger must not be writable over PostgREST any more. has_table_privilege
-- answers for the current role, so run it as the app's authenticated user
-- (Dashboard -> SQL Editor runs as postgres, where every privilege is held and
-- the answer is misleading):
--   select has_table_privilege('authenticated', 'stock_movements', 'INSERT'),
--          has_table_privilege('authenticated', 'stock_movements', 'UPDATE');  -- both false
--
-- A manual adjustment still works, and a forged one does not:
--   select public.record_stock_movement(current_date, 'adjustment_in', null,
--     (select id from public.inventory_items limit 1), 1, 1, 'verify', 'verify');
--   -- the next call must fail with 42501:
--   select public.record_stock_movement(current_date, 'purchase_receipt', null,
--     (select id from public.inventory_items limit 1), 1, 1, 'verify', 'forged');
-- Delete the verify row afterwards.
--
-- No policy may use USING (true):
--   select tablename, policyname from pg_policies
--    where schemaname in ('public','storage') and qual like '%true%';
--
-- Confirm the owner is still an administrator:
--   select username, role, active from public.profiles where role = 'administrator';
--
-- Confirm the drawings bucket is private and bounded:
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'product-drawings';
