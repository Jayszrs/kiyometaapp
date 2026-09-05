import { createServerClient, serializeCookieHeader } from '@supabase/ssr';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Supabase client for the Pages Router server side — `getServerSideProps`
 * contexts and `pages/api/*` route handlers. Both receive `req` / `res`.
 *
 * Reads the session from the request cookies and writes refreshed session
 * cookies back onto the response.
 */
export function createClient(req, res) {
  return createServerClient(url, key, {
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
