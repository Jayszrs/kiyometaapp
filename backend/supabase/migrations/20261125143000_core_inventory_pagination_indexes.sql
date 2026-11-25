-- Supports server-side search and stable page ordering for large company data sets.
create extension if not exists pg_trgm with schema extensions;

create index if not exists clients_name_trgm_idx
  on public.clients using gin (name extensions.gin_trgm_ops);
create index if not exists clients_name_id_idx
  on public.clients (name, id);

create index if not exists products_name_trgm_idx
  on public.products using gin (product_name extensions.gin_trgm_ops);
create index if not exists products_number_trgm_idx
  on public.products using gin (product_number extensions.gin_trgm_ops);
create index if not exists products_name_id_idx
  on public.products (product_name, id);

create index if not exists orders_number_trgm_idx
  on public.orders using gin (order_number extensions.gin_trgm_ops);
create index if not exists orders_product_name_trgm_idx
  on public.orders using gin (product_name extensions.gin_trgm_ops);
create index if not exists orders_delivery_id_idx
  on public.orders (delivery_date, id);

create index if not exists inventory_items_name_trgm_idx
  on public.inventory_items using gin (item_name extensions.gin_trgm_ops);
create index if not exists inventory_items_code_trgm_idx
  on public.inventory_items using gin (item_code extensions.gin_trgm_ops);
create index if not exists inventory_items_code_id_idx
  on public.inventory_items (item_code, id);

create index if not exists purchases_date_id_idx
  on public.purchases (purchase_date desc, id);
create index if not exists stock_movements_created_id_idx
  on public.stock_movements (created_at desc, id);
create index if not exists product_materials_product_id_id_idx
  on public.product_materials (product_id, id);
