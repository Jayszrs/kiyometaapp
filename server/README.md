# FactoryTrack MES Web Server

Next.js server untuk serve MES screens dengan Supabase/PostgreSQL backend.

## Setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Configure database

Copy `.env.local.example` ke `.env.local` dan isi credentials:

```bash
cp .env.local.example .env.local
```

### Supabase

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

The publishable key is all the app needs — auth and every DB call run through
it, gated by RLS. A `sb_secret_...` key is optional (`SUPABASE_SECRET_KEY`).

### 3. Database setup (Supabase → SQL Editor)

Paste each file's contents into the SQL Editor and Run. They are **PostgreSQL**
(`.pgsql` extension so editors don't lint them as T-SQL). All are idempotent and
the app degrades gracefully if one hasn't been run yet.

1. Table DDL + RLS policies in [`QUICKSTART.md`](./QUICKSTART.md).
2. [`db/002_jobs_columns.pgsql`](./db/002_jobs_columns.pgsql) — order_no,
   product_type, operation_type, route on `jobs` (needed by the "Buat job" form).
3. [`db/003_steps_and_events.pgsql`](./db/003_steps_and_events.pgsql) — `steps`
   column + `job_events` table (step tracking + Dasbor activity log).
4. [`db/001_profiles.pgsql`](./db/001_profiles.pgsql) — *optional*; only if you
   want to manage roles in a table instead of on the user (single-role now, so
   not required).

### 4. Create the login account

Supabase dashboard → **Authentication → Users → Add user** (tick
"Auto Confirm User"). One account is enough — every account has full access
(single role). Current dev account: `operator@kiyometa.app` / `operator1234`.

### 5. Run development server

```bash
npm run dev
```

Server berjalan di `http://localhost:3000` → redirects to `/login` until signed in.

## Routes

| Route | Desc |
| --- | --- |
| `/` | Tablet app. Requires login; the user's name/station are injected as `window.__FT_USER__`. |
| `/login` | Email + password sign-in (two-panel) |
| `/api/auth/signout` | Clears the session, redirects to `/login` |
| `/api/jobs` | GET list / POST create-or-update (partial updates preserve other fields) |
| `/api/events` | GET recent activity / POST append an event |
| `/api/materials` | GET/POST material lots |
| `/api/issues` | GET/POST issue reports |

All `/api/*` return **401 without a session**. Auth is enforced in
[`proxy.js`](./proxy.js) (Next 16's renamed middleware). The API routes verify
the session then use the service-role client ([`utils/supabase/api.js`](./utils/supabase/api.js)
`admin`) so DB writes aren't gated by RLS.

The app is one page. Nav switches views client-side; deep links use a hash
(`/#job`, `/#progress`, `/#material`, `/#create`). Source:
`../design/stitch/app.html` (runs standalone as a demo when opened without the server).

## Database Schema

### jobs

```sql
id, job_id, customer, product, qty_target, qty_completed, status, created_at, updated_at
```

### materials

```sql
id, lot_id, material_name, supplier, qty, received_date, status, location, created_at
```

### issues

```sql
id, lot_id, issue_type, severity, affected_qty, notes, operator_id, status, created_at
```

## Build & Deploy

```bash
npm run build
npm run start
```

For production, deploy to Vercel, Railway, or your own server.
