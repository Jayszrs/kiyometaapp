import { createServerClient, serializeCookieHeader } from '@supabase/ssr';
import { createClient as createSbClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

/**
 * Cookie-bound client — reads/refreshes the user's session. Use its
 * `auth.getUser()` to authenticate an API request or getServerSideProps.
 */
export function createClient(req, res) {
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return Object.entries(req.cookies || {}).map(([name, value]) => ({
          name,
          value,
        }));
      },
      setAll(cookiesToSet) {
        res.setHeader(
          'Set-Cookie',
          cookiesToSet.map(({ name, value, options }) =>
            serializeCookieHeader(name, value, options)
          )
        );
      },
    },
  });
}

/**
 * Service-role client — NO user session, bypasses RLS. Use for DB reads/writes
 * in API routes AFTER `createClient(...).auth.getUser()` has confirmed the
 * caller is signed in. Falls back to the publishable client when no secret key
 * is set (then RLS applies).
 */
export const admin = createSbClient(url, secretKey || publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
