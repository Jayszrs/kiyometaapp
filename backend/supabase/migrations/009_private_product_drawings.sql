-- Kiyometa Order Management — make product drawings private.
-- Run once in Supabase -> SQL Editor, after 008_order_management_constraints.sql.
--
-- Why this file exists: 001 created the product-drawings bucket with
-- public = true and a "public read drawings" policy that had no `to` clause,
-- so every drawing in the bucket was readable by anyone who knew or guessed
-- the URL. Because those reads bypassed RLS entirely, no policy could log
-- them and no user deactivation could revoke them.
--
-- The real exposure was permanence rather than guessability. The object key is
-- <product_id>/<epoch_ms>-<index>.<ext>, which contains enough entropy to make
-- brute forcing impractical, but getPublicUrl() returns a URL that never
-- expires. A drawing URL copied into an email, a chat, a printed spec sheet or
-- a screenshot stayed a permanent unauthenticated copy of a commercially
-- sensitive drawing, with no access log and no way to revoke it.
--
-- Migration 006 already established the correct pattern for profile-images:
-- public = false plus createSignedUrl(). This file applies the same treatment
-- to product drawings, so reads are authenticated, time limited and auditable.

-- 1. Close anonymous read access ---------------------------------------------
-- Flipping the bucket flag is what actually stops the reads. A policy cannot
-- override public = true: the storage API serves public-bucket objects to
-- anon without consulting storage.objects policies at all.
update storage.buckets
   set public = false
 where id = 'product-drawings';

-- 2. Drop the policy that allowed it ----------------------------------------
drop policy if exists "public read drawings" on storage.objects;

-- 3. Reassert the authenticated policy --------------------------------------
-- 002 already created "active users manage drawings" as `for all`, which
-- covers SELECT as well as writes, so step 1 and 2 are sufficient on their own.
-- It is recreated here so this migration is self contained and does not depend
-- on 002 having been applied, and so the access rule for drawings is stated in
-- one place rather than being inherited implicitly.
--
-- is_active_user() checks that the caller's profile exists and is active, so a
-- deactivated employee loses access to drawings immediately even while holding
-- a still-valid access token.
drop policy if exists "active users manage drawings" on storage.objects;
create policy "active users manage drawings" on storage.objects
  for all
  using (bucket_id = 'product-drawings' and public.is_active_user())
  with check (bucket_id = 'product-drawings' and public.is_active_user());

-- 4. Note on existing rows ---------------------------------------------------
-- No data backfill is included, deliberately.
--
-- products.drawings stores one entry per slot as {"path", "url"}. The web app
-- now reads and writes only "path" and mints a short lived signed URL when a
-- product is opened, so the stored "url" is simply ignored. Leaving it in place
-- is harmless: with step 1 applied those URLs no longer resolve.
--
-- Stripping the column was considered and rejected. persistDrawings() used to
-- write {"path": "", "url": <url>} for any drawing it did not re-upload, so
-- every product re-saved after its drawing was added already has a blank path.
-- A rewrite would therefore either destroy the only pointer some rows still
-- hold, or silently blank out slots in rows that have none to begin with. Rows
-- with a usable path keep working; rows without one are reported separately so
-- the decision to recover them from Storage listing is made on real data.

-- 5. Verify ------------------------------------------------------------------
-- public must be false:
--   select id, public from storage.buckets where id = 'product-drawings';
--
-- No policy may grant read without an authenticated user:
--   select policyname, cmd, qual
--     from pg_policies
--    where tablename = 'objects' and bucket_id = 'product-drawings';
--
-- Confirm an old public URL is dead and a signed URL works: open a product in
-- the app, copy the image URL, then reload the page. The image must still load
-- because the app re-signs on open, while the old stored url from step 4 must
-- return 400/404.
