# Laporan Biaya Deployment — Kiyometa

**Tanggal:** 3 November 2026
**Mata uang:** USD (harga list vendor) → IDR
**Kurs:** 1 USD = Rp 18.144,90 (sumber: open.er-api.com, 3 Nov 2026 00:02 UTC)

Semua angka di bawah diambil langsung dari halaman harga resmi vendor. Tidak ada markup,
tidak ada biaya tersembunyi. Link sumber dicantumkan di setiap baris.

---

## 1. Ringkasan

| Item | Biaya/bulan (USD) | Biaya/bulan (IDR) |
|---|---:|---:|
| Fly.io — server aplikasi (Tokyo) | $16,61 | Rp 301.387 |
| Supabase Pro — database, login, file (Tokyo) | $25,00 | Rp 453.623 |
| Monitoring uptime | $0,00 | Rp 0 |
| Domain | $0,00 (pakai subdomain gratis) | Rp 0 |
| **Total** | **$41,61** | **Rp 755.010** |

Dengan cadangan kurs/biaya kartu 3%: **$42,86 / Rp 777.660 per bulan.**

Biaya satu kali: akun Google Play Console **$25** (Rp 453.623) — hanya jika aplikasi
didistribusikan lewat Play Store.

---

## 2. Fly.io — server aplikasi

**Link harga:** https://fly.io/pricing
**Tabel harga per region:** https://docs.fly.io/about/pricing

### Kegunaan

Satu mesin di Tokyo yang menjalankan dua hal sekaligus:

1. **Web app** (hasil build React/Vite) — disajikan lewat Caddy.
2. **OCR service** (Python/FastAPI + ONNX) — di-proxy di path `/ocr` pada domain yang sama.

Karena keduanya satu domain, tidak ada masalah CORS dan APK cukup diarahkan ke satu URL.

### Perhitungan

| Komponen | Harga list | Perhitungan | Subtotal |
|---|---|---:|---:|
| Mesin `shared-cpu-1x`, 256 MB (harga dasar) | $2,19/bln | 1 mesin | $2,19 |
| Tambahan RAM 1,75 GB | $6,00/GB/bln | 1,75 × $6,00 | $10,50 |
| Subtotal harga region dasar (iad) | | | $12,69 |
| Faktor region Tokyo (`nrt`) | ×1,308 | $12,69 × 1,308 | **$16,60** |
| Egress (data keluar) | $0,04/GB (Asia Pasifik) | 0,3 GB | $0,01 |
| Volume penyimpanan | $0,15/GB/bln | 0 GB (tidak perlu) | $0,00 |
| IPv4 | $2/bln (dedicated) | pakai shared IPv4 | $0,00 |
| Sertifikat TLS | gratis (10 hostname pertama) | 1 hostname | $0,00 |
| **Total Fly.io** | | | **$16,61** |

### Spesifikasi yang dibayar

| Parameter | Nilai |
|---|---|
| Region | Tokyo (`nrt`) |
| CPU | 1 shared vCPU |
| RAM | 2.048 MB |
| Storage | 0 GB (model OCR sudah di dalam image) |
| Bandwidth keluar | ~0,3 GB/bulan (plafon aman 30 GB) |
| IPv4 | Shared (gratis) + IPv6 |
| HTTPS | Otomatis, gratis |

### Kenapa 2 GB RAM

OCR memuat model ONNX (RapidOCR) + OpenCV + PyMuPDF, dan dapat memproses 2 dokumen
bersamaan. 1 GB berisiko kehabisan memori (proses berhenti, pekerjaan hilang).

### Kenapa tidak ada Volume / database di Fly

- Model OCR sudah dibundel di dalam image, tidak perlu disk persisten.
- Database disimpan di Supabase, bukan di Fly (lihat bagian 3).

### Catatan tagihan

- Fly menagih per detik selama mesin menyala. Mesin diset menyala 24/7
  (`min_machines_running = 1`), karena mematikan mesin membuat OCR pertama lambat
  10–30 detik saat memuat model.
- Fly tidak menyediakan free tier untuk organisasi baru; kartu kredit diperlukan.

---

## 3. Supabase Pro — database & autentikasi

**Link harga:** https://supabase.com/pricing

### Kegunaan

| Fitur | Dipakai untuk |
|---|---|
| Postgres | Seluruh data order, inventory, BOM, audit trail |
| Auth | Login karyawan (username + password), JWT |
| Row Level Security | Pembatasan akses per role (operator, admin, dll.) |
| Storage | Foto profil karyawan, gambar produk/privat |
| Edge Function | `manage-users` — pembuatan akun & reset password oleh admin |
| Backup harian | Pemulihan data 7 hari ke belakang |

### Perhitungan

| Komponen | Harga list | Perhitungan | Subtotal |
|---|---|---:|---:|
| Paket Pro | $25,00/bln | 1 organisasi | $25,00 |
| Compute Micro | $10,00/bln | sudah termasuk kredit $10 di paket Pro | $0,00 |
| Database 8 GB | termasuk | pemakaian saat ini jauh di bawah 8 GB | $0,00 |
| Egress 250 GB | termasuk | perkiraan pemakaian < 5 GB | $0,00 |
| Storage 100 GB | termasuk | perkiraan pemakaian < 1 GB | $0,00 |
| Backup harian 7 hari | termasuk | — | $0,00 |
| **Total Supabase** | | | **$25,00** |

### Kenapa Pro, bukan Free

| | Free | Pro |
|---|---|---|
| Harga | $0 | $25/bln |
| Project pause jika tidak aktif | Ya, setelah 1 minggu | Tidak pernah |
| Backup otomatis | Tidak ada | Harian, disimpan 7 hari |
| Batas database | 500 MB | 8 GB |
| Batas egress | 5 GB | 250 GB |
| Support | Komunitas | Email |

Aplikasi ini dipakai harian, tetapi risiko kehilangan data tanpa backup tidak sepadan
dengan penghematan $25. Paket Pro juga memiliki **spend cap aktif secara default**,
sehingga tagihan tidak dapat melebihi batas tanpa persetujuan.

Alasan utama memilih Pro bukan kapasitas, melainkan **backup otomatis harian** dan
**project tidak pernah di-pause karena tidak aktif**. Rincian mekanismenya ada di
bagian 4.

### Kenapa Supabase, bukan database di Fly

Kode aplikasi sudah memakai Supabase Auth, RLS, dan Edge Function. Memindahkan database
ke Postgres biasa berarti menulis ulang autentikasi dan seluruh kebijakan akses — pekerjaan
berhari-hari tanpa manfaat biaya (Postgres terkelola Fly $38/bln, lebih mahal dari Supabase Pro).

### Region

Project Supabase dibuat di region **Tokyo** agar berada di lokasi yang sama dengan server
aplikasi. Latensi aplikasi → database sekitar 1–5 ms. Jika diletakkan di Singapore,
tambahan 60–70 ms terjadi pada setiap query.

---

## 4. Backup dan pemulihan data

### 4.1 Apa yang dimaksud "backup" di Supabase

Backup harian Supabase adalah **salinan fisik** (physical backup) dari direktori database
Postgres, disimpan di penyimpanan objek terpisah dari server produksi. Ini **bukan**
server cadangan yang menyala dan siap mengambil alih, dan **bukan** duplikat baris data
yang bisa dibuka seperti tabel biasa. Backup hanya bisa dipulihkan (restore) melalui
Dashboard atau Management API.

Untuk mendapatkan berkas salinan yang bisa dibaca dan disimpan di luar Supabase,
digunakan perintah `supabase db dump` (lihat 4.4).

### 4.2 Frekuensi, retensi, dan cakupan (paket Pro)

| Parameter | Nilai |
|---|---|
| Frekuensi | 1 kali per hari, otomatis |
| Retensi | 7 hari terakhir |
| Cakupan | seluruh skema dan data PostgreSQL |
| Titik pulih (RPO) | hingga 24 jam terakhir dapat hilang |
| Downtime saat restore | project tidak dapat diakses selama proses berlangsung |
| Lokasi penyimpanan | penyimpanan objek Supabase, terpisah dari server database |

Yang **tidak** termasuk dalam backup harian:

| Tidak termasuk | Konsekuensi | Mitigasi |
|---|---|---|
| Objek Storage (foto profil, gambar produk) | Menghapus file tidak bisa dibatalkan lewat restore database | Export bucket bulanan (4.4) |
| Password role kustom | Harus di-reset setelah restore | Catat prosedur reset |
| Subscription / replication slot | Harus dibuat ulang setelah restore | Catat di runbook |

### 4.3 Opsional: Point-in-Time Recovery (PITR)

| Parameter | Nilai |
|---|---|
| Biaya | $100/bln untuk retensi 7 hari |
| Syarat | compute minimal Small ($15/bln; Micro $10 sudah tertutup kredit Pro) |
| Frekuensi | WAL diarsipkan tiap ±2 menit |
| RPO | ±2 menit |
| Catatan | Jika PITR aktif, backup harian dihentikan karena PITR lebih rapat |

PITR relevan jika kehilangan transaksi satu hari tidak dapat diterima. Untuk 5 pengguna
dengan volume input seperti saat ini, backup harian ditambah dump harian ke storage
eksternal sudah memadai.

### 4.4 Backup tambahan di luar Supabase (disarankan)

| Langkah | Frekuensi | Biaya |
|---|---|---|
| `pg_dump` seluruh database → Cloudflare R2 / Backblaze B2 | Harian, retensi 30 hari | $0 (kuota gratis 10 GB) |
| Export bucket Storage (foto, gambar) → R2 | Bulanan | $0 |
| Uji restore di project dev | Tiap kuartal | $0 |
| Monitor status Supabase + alert | Berkelanjutan | $0 |

Fungsi dump eksternal: menghasilkan salinan yang **independen dari Supabase**. Jika
terjadi masalah pada akun atau platform Supabase, data tetap dapat dipulihkan ke
PostgreSQL lain dalam hitungan jam.

### 4.5 Skenario gangguan dan waktu pemulihan

| Skenario | Data hilang | Waktu pulih | Sumber pemulihan |
|---|---|---|---|
| Salah hapus / bug (masih dalam 7 hari) | hingga 24 jam | 10–60 menit | Backup harian Supabase |
| Data rusak bertahap (beberapa hari) | hingga 24 jam | 10–60 menit | Backup harian Supabase |
| Butuh titik waktu tepat (PITR aktif) | ± 2 menit | 10–60 menit | PITR |
| Region Supabase bermasalah | 0 (data aman) | menunggu vendor; operasional berhenti sementara | — |
| Project / akun terhapus | hingga 24 jam | 1–3 jam | Dump eksternal ke Postgres baru |

Catatan penting: paket Pro **tidak memiliki SLA uptime** (SLA tersedia pada paket
Enterprise) dan project berjalan pada satu instance Postgres, bukan cluster dengan
failover otomatis. Artinya: data terlindungi oleh backup, tetapi ketersediaan layanan
bergantung pada uptime vendor. Mitigasinya adalah dump eksternal (4.4) dan prosedur
pemulihan yang sudah diuji, bukan asumsi bahwa layanan tidak akan pernah berhenti.

---

## 5. Item tanpa biaya

| Item | Biaya | Keterangan |
|---|---:|---|
| Domain | $0 | Menggunakan subdomain gratis `kiyometa.fly.dev` (HTTPS otomatis) |
| Sertifikat SSL/TLS | $0 | Disediakan Fly dan Supabase |
| Monitoring uptime | $0 | Health check bawaan Fly + notifikasi email |
| Container registry | $0 | GitHub Container Registry (paket publik/privat gratis) |
| CI/CD (auto-deploy) | $0 | GitHub Actions free tier |

Domain kustom (mis. `kiyometa.app`) bersifat opsional: sekitar **$12/tahun (± Rp 18.145/bulan)**.
Manfaatnya hanya satu — alamat API dapat dipindahkan ke server lain tanpa merilis ulang APK.

---

## 6. Rincian biaya menurut skenario pemakaian

| Skenario | Fly.io | Supabase | Total USD | Total IDR |
|---|---:|---:|---:|---:|
| 5 pengguna, 250 dokumen OCR/hari | $16,61 | $25,00 | **$41,61** | **Rp 755.010** |
| Pemakaian berat, egress 30 GB | $17,80 | $25,00 | $42,80 | Rp 776.600 |
| Versi hemat (Supabase Free) | $16,61 | $0,00 | $16,61 | Rp 301.387 |
| Alternatif Northflank Tokyo | $26,00 | $25,00 | $51,00 | Rp 925.390 |
| Dengan PITR (RPO ±2 menit) | $16,61 | $25 + $5 + $100 | $146,61 | Rp 2.660.200 |

Skenario 1 adalah perkiraan yang dipakai. Skenario 2 adalah batas atas yang masih wajar.

---

## 7. Yang tidak termasuk

1. **Pajak.** Supabase menerapkan PPN/PPh sesuai alamat penagihan apabila diwajibkan.
   Fly.io menagih tanpa PPN Indonesia. Keduanya belum termasuk pajak.
2. **Biaya kartu.** Kurs kartu kredit/debit umumnya 2–3% di atas kurs tengah
   (sudah dicadangkan pada baris "cadangan 3%").
3. **Play Store.** $25 satu kali untuk akun developer Google.
4. **Pengembangan.** Laporan ini hanya biaya operasional bulanan.

---

## 8. Dasar perhitungan

| Data | Nilai | Sumber |
|---|---|---|
| Harga mesin Fly `shared-cpu-1x` 256 MB | $2,19/bln | https://fly.io/pricing |
| Tambahan RAM Fly | $6,00/GB/bln | https://fly.io/pricing |
| Faktor region Tokyo | 1,308 | https://fly.io/pricing (tabel "compute by region") |
| Egress Asia Pasifik | $0,04/GB | https://docs.fly.io/about/pricing |
| Volume Fly | $0,15/GB/bln | https://docs.fly.io/about/pricing |
| IPv4 dedicated Fly | $2/bln | https://docs.fly.io/about/pricing |
| Supabase Pro | $25/bln | https://supabase.com/pricing |
| Compute Micro Supabase | $10/bln (tertutup kredit) | https://supabase.com/pricing |
| Backup harian & PITR Supabase | 7 hari; PITR ~$100/bln | https://supabase.com/docs/guides/platform/backups |
| Kurs USD→IDR | Rp 18.144,90 | open.er-api.com, 3 Nov 2026 |
