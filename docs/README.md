# Dokumentasi Kiyometa

Mulai dari [README utama](../README.md) jika Anda ingin memahami apa itu Kiyometa, modulnya, technology stack, setup, dan cara menjalankan project.

Gunakan file ini setelah itu. File ini adalah daftar isi untuk dokumentasi developer, support, OCR, database, logging, dan deployment.

## Pilih jalur sesuai kebutuhan

| Jika Anda ingin... | Buka |
|---|---|
| Memahami produk dan menjalankan aplikasi | [README utama](../README.md) |
| Mencari dokumen yang tepat | Bagian navigasi di file ini |
| Menelusuri error dari Activity Audit | [logging-developer.md](logging-developer.md) |
| Memahami kode error | [result-codes.md](result-codes.md) |
| Menjalankan atau mengubah Supabase | [backend/README.md](../backend/README.md) |
| Menjalankan atau menguji OCR | [ocr-service/README.md](../ocr-service/README.md) |
| Deploy ke server | [deploy/production/README.md](../deploy/production/README.md) |

Pilih dokumen berdasarkan pekerjaan yang ingin dilakukan.

## Memahami aplikasi

- [README utama](../README.md) menjelaskan tujuan, modul, teknologi, dan cara menjalankan project.
- [User Guide](Kiyometa_User_Guide.docx) menjelaskan penggunaan aplikasi.
- [Japanese User Guide](Kiyometa_User_Guide_JA.docx) berisi panduan Bahasa Jepang.

## Menjalankan atau mengubah aplikasi

- [Backend README](../backend/README.md) menjelaskan migration dan Edge Functions.
- [OCR README](../ocr-service/README.md) menjelaskan install, API, test, dan deployment OCR.
- [Production deployment README](../deploy/production/README.md) menjelaskan file deployment dan lokasi server.
- [Recovery guide](recovery.md) menjelaskan draft, offline queue, dan recovery.

## Menerima laporan error

Mulai dari satu row di Role Management > Activity Audit. Ambil entity_id atau UUID pada row. Cari process_id dan lifecycle_id di Supabase. Cari ID penuh dengan grep -R -F di /srv/kiyometa/logs. Baca web.log, supabase.log, atau ocr.log sesuai sumbernya. Gunakan request_id untuk request yang tepat.

Panduan lengkap: [logging-developer.md](logging-developer.md).

## Result code

Buka [result-codes.md](result-codes.md) untuk arti VAL-001, NET-003, TXN-001, SVC-001, OCR-001, dan kode lain.

## Lokasi log

| Kebutuhan | Panduan atau lokasi |
|---|---|
| Web dan Supabase request | logging-developer.md, lalu /srv/kiyometa/logs/web.log dan supabase.log |
| OCR request | ocr-service/README.md, lalu /srv/kiyometa/logs/ocr.log |
| Deployment | deploy/production/README.md, lalu /srv/kiyometa/logs/deploy.log |
| Activity Audit | logging-developer.md |
| Result code | result-codes.md |

## Aturan singkat

- ID pendek hanya untuk tampilan.
- Log dan tiket troubleshooting memakai ID penuh.
- Jangan masukkan password, token, dokumen customer, atau isi payload bisnis ke tiket.
- rc=00 bukan bukti database commit. Baca row audit dan data saat ini.

