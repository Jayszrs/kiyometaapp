import { createClient } from "@supabase/supabase-js";
import { loadingFetch } from "./loading";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !key) {
  throw new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY (see .env.local.example)");
}

// Do not let the SDK silently replay writes. Order submissions and manual
// movements already have server idempotency keys; other edits surface errors
// so the user can retry against the latest version.
export const supabase = createClient(url, key, { db: { retry: false }, global: { fetch: loadingFetch } });
