# Panduan membaca log Kiyometa

Panduan ini dimulai dari satu row di `Role Management > Activity Audit`. User tidak perlu memahami log. Minta user mengirim waktu kejadian, username, nama aktivitas, `entity_id` atau UUID pada row, dan screenshot error jika ada. Jangan minta password, token, isi dokumen, atau file customer.

## Cara berpikirnya

`entity_id` adalah ID data yang dibuat atau diubah. `lifecycle_id` menghubungkan seluruh riwayat satu data bisnis. `process_id` menghubungkan satu proses user, misalnya `order.submit`. `parent_process_id` menghubungkan proses utama dengan proses turunannya. `request_id` menunjuk satu request ke service. `event_id` menunjuk satu baris log.

Gunakan `lifecycle_id` untuk melihat riwayat satu order, BOM, produk, atau data lain. Gunakan `process_id` untuk melihat satu percobaan user. Keduanya berbeda.

Contoh:

```text
User membuat order
└─ process_id: P1, operation: order.submit
   ├─ request ke Supabase dimulai
   ├─ order dibuat, entity_id: O1
   ├─ BOM atau stock movement ikut dibuat
   └─ proses selesai atau gagal
```

Jika BOM di-upload sebelum order, upload BOM memiliki `process_id` sendiri. Row audit order tetap menjadi titik awal. `lifecycle_id` membantu mencari aktivitas terkait.

## Langkah 1: mulai dari Activity Audit

Buka Supabase Singapore, lalu pilih SQL Editor. Ganti nilai `ENTITY_ID_DARI_ACTIVITY_AUDIT` dengan UUID dari row yang user kirim.

```sql
select
  created_at,
  username,
  action,
  entity,
  entity_id,
  metadata->>'process_id' as process_id,
  metadata->>'parent_process_id' as parent_process_id,
  metadata->>'request_id' as request_id,
  metadata->>'lifecycle_id' as lifecycle_id,
  metadata->>'operation' as operation,
  metadata->>'idempotency_key' as idempotency_key,
  metadata->>'related_lifecycle_ids' as related_lifecycle_ids,
  undone_at
from public.audit_logs
where entity_id = 'ENTITY_ID_DARI_ACTIVITY_AUDIT'
   or metadata->>'lifecycle_id' = 'ENTITY_ID_DARI_ACTIVITY_AUDIT'
   or metadata->>'related_lifecycle_ids' like '%ENTITY_ID_DARI_ACTIVITY_AUDIT%'
order by created_at asc;
```

Catat `process_id`, `parent_process_id`, `request_id`, `lifecycle_id`, `operation`, dan `created_at`. Jika `process_id` kosong, gunakan waktu row. Cari log lima menit sebelum dan sesudah waktu tersebut.

## Langkah 2: cari semua log di server

Login ke server aplikasi, lalu jalankan:

```sh
cd /srv/kiyometa/logs
ls -lah
```

File yang tersedia:

| File | Isi |
|---|---|
| `web.log` | Aktivitas browser dan error frontend |
| `supabase.log` | Request aplikasi ke Supabase |
| `ocr.log` | Request dan tahap OCR |
| `deploy.log` | Build dan restart deployment |

Cari satu proses di semua file dan arsip:

```sh
PROCESS_ID='GANTI_DENGAN_PROCESS_ID'
grep -R -F "$PROCESS_ID" /srv/kiyometa/logs
```

Cari request turunannya:

```sh
REQUEST_ID='GANTI_DENGAN_REQUEST_ID'
grep -R -F "$REQUEST_ID" /srv/kiyometa/logs
```

## Langkah 3: baca urutannya

Setiap baris adalah satu JSON object. Field utama:

```text
timestamp     waktu event
source        web, supabase, ocr, atau deploy
operation     nama operasi, misalnya order.submit
stage         process.start, request.start, request.end, atau process.end
rc            kode hasil
http_status   status HTTP jika ada
duration_ms   durasi request jika ada
```

Urutan berhasil:

```text
web       process.start  rc=00
supabase  request.start  rc=00
supabase  request.end    rc=00 http_status=200
web       process.end    rc=00
```

Urutan gagal:

```text
web       process.start  rc=00
supabase  request.start  rc=00
supabase  request.end    rc=TXN-001
```

Gunakan `process_id` untuk menyatukan semua baris. Gunakan `request_id` untuk request yang tepat.

## Menentukan sumber masalah

| Temuan | Kesimpulan awal |
|---|---|
| Tidak ada `process.start` | Browser belum menjalankan logging terbaru atau aksi belum tercatat |
| Ada `web`, tidak ada `supabase` | Browser gagal sebelum request mencapai Supabase |
| `supabase request.end` memiliki `NET-001` sampai `NET-003` | Request terganggu jaringan atau timeout |
| `supabase request.end` memiliki `TXN-001` | Hasil write tidak dapat dipastikan. Cek audit dan data sebelum retry |
| HTTP 4xx | Periksa input, session, izin, dan aturan bisnis |
| HTTP 5xx atau `SVC-001` | Service gagal atau tidak tersedia |
| Audit row ada dan data benar | Database menyimpan data. Periksa tampilan atau cache |
| Audit row tidak ada | Perubahan belum tercatat sebagai commit |
| `ocr` memiliki `OCR-001` atau `OCR-002` | Periksa file dan hasil OCR dengan `job_id` |

Log menunjukkan lokasi masalah. Log tidak menggantikan pengecekan data. Untuk `TXN-001`, jangan langsung meminta user mengulang.

## Kode yang paling sering dipakai

| Kode | Arti | Tindakan |
|---|---|---|
| `00` | Langkah berhasil dicatat | Lanjutkan membaca proses |
| `VAL-001` | Field wajib kosong | Periksa field tersebut |
| `VAL-002` | Input tidak valid | Periksa nilai dan format |
| `DATA-001` | Data tidak ditemukan | Periksa ID dan row terkait |
| `DATA-002` | Data duplikat | Cari data yang sudah ada |
| `BIZ-001` | Aturan bisnis menolak aksi | Baca pesan aplikasi dan data terkait |
| `AUTH-001` | Session hilang atau kedaluwarsa | Login ulang |
| `AUTH-002` | Akun tidak punya izin | Periksa role akun |
| `NET-001` | Device offline | Sambungkan jaringan lalu retry |
| `NET-002` | Request tidak mencapai service | Periksa jaringan dan service |
| `NET-003` | Request timeout | Pastikan status data sebelum retry |
| `TXN-001` | Hasil write tidak dapat dipastikan | Cek audit dan data sebelum retry |
| `SVC-001` | Service internal gagal | Periksa log service |
| `SVC-002` | Service sibuk atau membatasi request | Tunggu job selesai |
| `OCR-001` | File tidak dapat diproses OCR | Periksa format dan isi file |
| `OCR-002` | Hasil OCR perlu diperiksa | Review hasil sebelum simpan |
| `SYS-001` | Error aplikasi | Gunakan process, request, dan error fingerprint |

`rc=00` hanya berarti langkah tersebut tercatat berhasil. Row audit dan data Supabase membuktikan apakah perubahan tersimpan.

## Template laporan internal

```text
Laporan: order tidak muncul setelah disimpan
User: @operator
Waktu: 2026-11-19 18:23 WIB
Entity: orders
Entity ID: <dari Activity Audit>
Process ID: <dari query audit_logs>
Request ID: <dari query audit_logs>
Lifecycle ID: <dari query audit_logs>
Temuan: supabase request.end rc=TXN-001
Kesimpulan awal: write belum terbukti commit. Data harus dicek sebelum retry.
```

## Batas penyimpanan

File log berada di `/srv/kiyometa/logs`. Satu file aktif maksimal 10 MiB. Total file aktif dan arsip per sumber maksimal 100 MiB. Arsip lebih lama dari 90 hari dihapus. Browser menyimpan maksimal 500 event selama 30 hari. Browser mengirim batch maksimal 50 event saat koneksi tersedia. Event offline dikirim setelah koneksi pulih dan user memiliki session.

## Aturan support

1. Mulai dari satu row Activity Audit.
2. Simpan `entity_id`, `lifecycle_id`, `process_id`, dan `request_id` pada tiket.
3. Gunakan `grep -R -F` untuk mencari ID.
4. Gunakan waktu hanya jika ID belum tersedia.
5. Jangan kirim password, token, dokumen customer, atau isi payload bisnis.

