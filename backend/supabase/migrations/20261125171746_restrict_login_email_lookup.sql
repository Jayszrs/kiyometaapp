-- Username lookup runs before authentication. Keep that pre-login grant and
-- remove the redundant authenticated-role grant.
revoke execute on function public.resolve_login_email(text) from authenticated;
grant execute on function public.resolve_login_email(text) to anon;
