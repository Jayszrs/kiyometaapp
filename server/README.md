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

### 3. Database + auth setup (Supabase → SQL Editor)

1. Run the table DDL + RLS policies in [`QUICKSTART.md`](./QUICKSTART.md).
2. Run [`db/001_profiles.sql`](./db/001_profiles.sql) — adds the `profiles`
   table (role per user), the signup trigger, and role-assignment templates.

### 4. Create user accounts

Supabase dashboard → **Authentication → Users → Add user** (set
"Auto Confirm User"). Then in the SQL editor set each user's role:

```sql
update public.profiles p set role = 'admin', full_name = 'Dewi Anggraini'
from auth.users u where u.id = p.id and u.email = 'admin@yourco.com';
```

Roles: `operator` (Dasbor / Scan job / Produksi), `gudang` (Dasbor / Scan
material), `admin` (all).

### 5. Run development server

```bash
npm run dev
```

Server berjalan di `http://localhost:3000` → redirects to `/login` until signed in.

## Routes

| Route | Desc |
| --- | --- |
| `/` | Tablet app (Dasbor, Scan job, Produksi, Scan material). Requires login; the signed-in user's role + name are injected as `window.__FT_USER__`. |
| `/login` | Email + password sign-in |
| `/api/auth/signout` | Clears the session, redirects to `/login` |
| `/api/jobs` | GET list / POST upsert jobs — **401 without a session** |
| `/api/materials` | GET/POST material lots — 401 without a session |
| `/api/issues` | GET/POST issue reports — 401 without a session |

Auth is enforced in [`proxy.js`](./proxy.js) (Next 16's renamed middleware):
unauthenticated page requests redirect to `/login`, API requests get 401.

The app is a single page. Nav bar switches views client-side; deep links use a hash
(`/#job`, `/#progress`, `/#material`). Source: `../design/stitch/app.html`
(also runs standalone as a demo with role tabs when opened without the server).

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
