-- Kiyometa Order Management — defence in depth.
-- Run once in Supabase -> SQL Editor, after 004_order_management.pgsql.
--
-- Why this file exists: the web app validates in React, but the browser is not
-- a trust boundary. Anyone holding the publishable key can POST straight to
-- PostgREST and skip every check in App.tsx. These constraints are the only
-- guard that cannot be bypassed from the client, so they mirror validateOrder,
-- validateClient and validateProduct exactly. When the app is stricter the user
-- sees a form error; when the app is stricter than this file the database is the
-- backstop.
--
-- Every constraint is added NOT VALID first so this file never locks the tables
-- for a full scan on a large database. Step 2 then validates them and will fail
-- loudly, naming the offending rows, if any existing data already breaks a rule.

-- 1. Report rows that already violate the new rules -----------------------
-- Run this first. Empty results mean step 2 will succeed. If it returns rows,
-- fix them in the Supabase table editor before continuing.
select id, order_date, delivery_date, quantity, order_amount,
       required_manhours, worked_manhours, production_end_date
from public.orders
where delivery_date < order_date
   or quantity < 1
   or order_amount < 0
   or required_manhours < 0
   or worked_manhours < 0
   or worked_manhours > required_manhours
   or (production_end_date is not null
       and (production_end_date < order_date or production_end_date > delivery_date))
   or char_length(order_number) > 50
   or char_length(order_contact) > 500;

select id, name from public.clients where btrim(name) = '' or char_length(name) > 100;
select id, product_name, product_number from public.products
where btrim(product_name) = '' or btrim(product_number) = '';

-- 2. Add the constraints ---------------------------------------------------
-- drop constraint if exists first so the file is safe to re-run.

alter table public.orders drop constraint if exists orders_quantity_range;
alter table public.orders add constraint orders_quantity_range
  check (quantity between 1 and 99999) not valid;

alter table public.orders drop constraint if exists orders_amount_range;
alter table public.orders add constraint orders_amount_range
  check (order_amount between 0 and 999999999) not valid;

alter table public.orders drop constraint if exists orders_manhours_range;
alter table public.orders add constraint orders_manhours_range
  check (required_manhours between 0 and 9999 and worked_manhours between 0 and 9999) not valid;

alter table public.orders drop constraint if exists orders_manhours_not_over;
alter table public.orders add constraint orders_manhours_not_over
  check (worked_manhours <= required_manhours) not valid;

alter table public.orders drop constraint if exists orders_date_order;
alter table public.orders add constraint orders_date_order
  check (delivery_date >= order_date) not valid;

alter table public.orders drop constraint if exists orders_production_end_in_window;
alter table public.orders add constraint orders_production_end_in_window
  check (production_end_date is null
         or (production_end_date >= order_date and production_end_date <= delivery_date)) not valid;

alter table public.orders drop constraint if exists orders_order_number_length;
alter table public.orders add constraint orders_order_number_length
  check (char_length(order_number) <= 50) not valid;

alter table public.orders drop constraint if exists orders_contact_length;
alter table public.orders add constraint orders_contact_length
  check (char_length(order_contact) <= 500) not valid;

-- Orders reference the masters by name, so a blank or untrimmed name would
-- break the foreign key or create a second invisible record for the same client.
alter table public.orders drop constraint if exists orders_client_not_blank;
alter table public.orders add constraint orders_client_not_blank
  check (btrim(client) <> '') not valid;

alter table public.orders drop constraint if exists orders_product_name_not_blank;
alter table public.orders add constraint orders_product_name_not_blank
  check (btrim(product_name) <> '') not valid;

alter table public.clients drop constraint if exists clients_name_clean;
alter table public.clients add constraint clients_name_clean
  check (btrim(name) <> '' and char_length(btrim(name)) <= 100) not valid;

alter table public.clients drop constraint if exists clients_phone_format;
alter table public.clients add constraint clients_phone_format
  check (char_length(phone) <= 20 and phone ~ '^[0-9-]*$') not valid;

alter table public.clients drop constraint if exists clients_postal_format;
alter table public.clients add constraint clients_postal_format
  check (postal_code = '' or postal_code ~ '^[0-9]{3}-[0-9]{4}$') not valid;

alter table public.clients drop constraint if exists clients_address_length;
alter table public.clients add constraint clients_address_length
  check (char_length(address) <= 255) not valid;

alter table public.products drop constraint if exists products_name_clean;
alter table public.products add constraint products_name_clean
  check (btrim(product_name) <> '' and char_length(btrim(product_name)) <= 100) not valid;

alter table public.products drop constraint if exists products_number_clean;
alter table public.products add constraint products_number_clean
  check (btrim(product_number) <> ''
         and char_length(btrim(product_number)) <= 50
         and btrim(product_number) ~ '^[a-zA-Z0-9_-]+$') not valid;

alter table public.products drop constraint if exists products_unit_price_range;
alter table public.products add constraint products_unit_price_range
  check (unit_price between 0 and 99999999) not valid;

-- 3. Enforce them against existing data ------------------------------------
-- Each statement fails with the offending primary keys if step 1 returned rows.

alter table public.orders   validate constraint orders_quantity_range;
alter table public.orders   validate constraint orders_amount_range;
alter table public.orders   validate constraint orders_manhours_range;
alter table public.orders   validate constraint orders_manhours_not_over;
alter table public.orders   validate constraint orders_date_order;
alter table public.orders   validate constraint orders_production_end_in_window;
alter table public.orders   validate constraint orders_order_number_length;
alter table public.orders   validate constraint orders_contact_length;
alter table public.orders   validate constraint orders_client_not_blank;
alter table public.orders   validate constraint orders_product_name_not_blank;
alter table public.clients  validate constraint clients_name_clean;
alter table public.clients  validate constraint clients_phone_format;
alter table public.clients  validate constraint clients_postal_format;
alter table public.clients  validate constraint clients_address_length;
alter table public.products validate constraint products_name_clean;
alter table public.products validate constraint products_number_clean;
alter table public.products validate constraint products_unit_price_range;
