alter table public.clients add column if not exists version integer not null default 1;
alter table public.products add column if not exists version integer not null default 1;

drop trigger if exists clients_bump_shared_version on public.clients;
create trigger clients_bump_shared_version before update on public.clients
  for each row execute function public.bump_shared_record_version();
drop trigger if exists products_bump_shared_version on public.products;
create trigger products_bump_shared_version before update on public.products
  for each row execute function public.bump_shared_record_version();

notify pgrst, 'reload schema';
