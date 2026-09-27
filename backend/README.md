# Backend

This directory contains every server-side resource required by the Kiyometa
frontend. Nothing in this directory is bundled into the browser application.

## Layout

- `supabase/migrations/` contains the PostgreSQL schema, RLS policies, audit
  functions, automatic inventory reconciliation, and seed data.
- `supabase/functions/manage-users/` contains the protected account-management
  Edge Function. The service-role key stays in Supabase and is never exposed to
  the frontend.

## Deploy

Run every file in `supabase/migrations/` in numeric order (`001` through
`007`) in the Supabase SQL Editor, or deploy the linked migrations with the
Supabase CLI. Then deploy the Edge Function from this `backend` directory:

```powershell
npx supabase login
npx supabase functions deploy manage-users --project-ref YOUR_PROJECT_REF
```

Do not commit access tokens, service-role keys, or the generated
`supabase/.temp/` directory.
