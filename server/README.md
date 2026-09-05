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

**Option A: Supabase (Recommended)**

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-key
```

**Option B: PostgreSQL Direct**

```env
DATABASE_URL=postgresql://user:password@localhost:5432/factorytrack_mes
```

### 3. Run development server

```bash
npm run dev
```

Server berjalan di `http://localhost:3000`

## Routes

| Route | Desc |
| --- | --- |
| `/` | Screen selector |
| `/screens/1` | Home Dashboard |
| `/screens/2` | Scan Job |
| `/screens/3` | Production Progress |
| `/screens/4` | Scan Material Issue |
| `/api/jobs` | GET/POST jobs |
| `/api/materials` | GET/POST material lots |
| `/api/issues` | GET/POST issue reports |

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
