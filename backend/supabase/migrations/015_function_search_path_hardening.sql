-- Pin trigger-function name resolution to the application schema.

alter function public.set_updated_at() set search_path = public;
alter function public.prevent_business_number_change() set search_path = public;
