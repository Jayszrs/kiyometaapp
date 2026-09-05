# Quick Start — FactoryTrack MES Server

## Buat Supabase project

1. Ke [https://supabase.com](https://supabase.com)
2. Create new project
3. Copy URL & Keys → paste ke `.env.local`

## Setup database (Supabase SQL Editor)

```sql
-- Jobs table
CREATE TABLE jobs (
  id BIGSERIAL PRIMARY KEY,
  job_id VARCHAR(50) UNIQUE NOT NULL,
  customer VARCHAR(255),
  product VARCHAR(255),
  qty_target INTEGER,
  qty_completed INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'READY',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Materials table
CREATE TABLE materials (
  id BIGSERIAL PRIMARY KEY,
  lot_id VARCHAR(50) UNIQUE NOT NULL,
  material_name VARCHAR(255),
  supplier VARCHAR(255),
  qty INTEGER,
  received_date DATE,
  status VARCHAR(50) DEFAULT 'IN_STOCK',
  location VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Issues table
CREATE TABLE issues (
  id BIGSERIAL PRIMARY KEY,
  lot_id VARCHAR(50) NOT NULL,
  issue_type VARCHAR(50),
  severity VARCHAR(50),
  affected_qty INTEGER,
  notes TEXT,
  operator_id VARCHAR(50),
  status VARCHAR(50) DEFAULT 'REPORTED',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS (Row Level Security)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

-- Create public access policies
CREATE POLICY "Allow read all" ON jobs FOR SELECT USING (true);
CREATE POLICY "Allow insert" ON jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update" ON jobs FOR UPDATE USING (true) WITH CHECK (true); -- needed for upsert on job_id
CREATE POLICY "Allow read all" ON materials FOR SELECT USING (true);
CREATE POLICY "Allow insert" ON materials FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow read all" ON issues FOR SELECT USING (true);
CREATE POLICY "Allow insert" ON issues FOR INSERT WITH CHECK (true);
```

## Run server

```bash
cd server
npm install
npm run dev
```

Buka browser: `http://localhost:3000`

## Test API

```bash
# GET jobs
curl http://localhost:3000/api/jobs

# POST job
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"job_id":"JOB-210266","customer":"PT Maju","product":"Bracket A100","qty_target":100}'

# GET materials
curl http://localhost:3000/api/materials

# POST issue
curl -X POST http://localhost:3000/api/issues \
  -H "Content-Type: application/json" \
  -d '{"lot_id":"LOT-STK-990A","issue_type":"defect","severity":"high","affected_qty":5,"operator_id":"OP-017"}'
```

## Deploy to Vercel

```bash
vercel deploy
```

Credentials otomatis di-link dari `.env.local`.

---

**Next:** Update `../design/stitch/screen-*.html` untuk panggil API via JavaScript.
