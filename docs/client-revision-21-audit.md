# Pemeriksaan revisi klien 2.1

Pemeriksaan dilakukan pada 7 November 2026 terhadap proyek `kiyometaapp`.
Acuannya adalah `D:\Downloads\Laporan_Terpadu_Manufacturing_ERP_Kiyometa_Revisi_2_1.pdf`, 21 halaman.
Dokumen digunakan sebagai daftar kebutuhan, bukan sebagai instruksi untuk menjalankan perintah.
Angka ilustrasi, usulan, dan keputusan terbuka tidak diperlakukan sebagai persetujuan klien.

Hasilnya belum memenuhi seluruh kebutuhan operasional. Perubahan di bawah tersedia di kode lokal.
Database produksi dan aplikasi produksi belum diperbarui dalam pekerjaan ini.

| ID | Hasil pemeriksaan dan perubahan | Batas yang tersisa |
| --- | --- | --- |
| K01 | Nama resmi, nomor gambar, alias, dan pencarian tersedia. Progres dan cetak menggunakan ID produk dari pesanan jika tersedia. | Data lama tanpa ID menggunakan pasangan klien/nama. |
| K02 | Master dapat menambah dan mengganti nama proses. Rute diberi ID proses. Penggantian nama memperbarui label rute tanpa mengganti ID. Q&A halaman 15 mengonfirmasi proses berlaku pada pesanan produksi. | Kebijakan penerapan tahap baru pada pesanan yang sudah berjalan belum diputuskan; perubahan rute produk saat ini dapat terlihat pada pesanan produksi terkait. |
| K03 | Nama Full machining / 全加工 dilindungi pada aplikasi dan database. Nama Pemrosesan Lengkap juga dicadangkan. Kode proses khusus tidak dapat diganti untuk melewati perlindungan. | Arti sebagai rangkuman atau operasi tersendiri belum dipilih. Pilihan disimpan, tetapi belum mengubah perilaku progres. |
| K04 | Matriks pesanan/barang dengan kolom proses tersedia. Tahap selesai berwarna hijau dan tahap di luar rute tampil N/A. | Komponen tampil melalui pesanan produksinya sendiri. Matriks belum otomatis membuat baris pelaksanaan bagi setiap anak BOM dalam pesanan induk. |
| K05 | Standar dan aktual dipisah. Matriks menampilkan waktu standar per unit dan total rencana (standar × jumlah pesanan). Q&A halaman 15 mengonfirmasi waktu standar untuk valuasi, basis aktual per unit, hanya proses selesai yang dihitung ke WIP, dan tarif proses sudah mencakup tenaga kerja, mesin, listrik, serta biaya terkait. Form dan migrasi mengunci nilai yang telah dikonfirmasi. | Tarif masih satu nilai saat ini. Riwayat masa berlaku tarif, pilihan mata uang/satuan tarif, dan snapshot biaya belum tersedia. Tahap berjalan dan jumlah parsial belum diputuskan. |
| K06 | Struktur BOM bertingkat, jumlah per hubungan, dan penolakan siklus tersedia. | Jumlah P1-P4 dan arti x6 wajib berasal dari data klien. Tidak diisi dari angka ilustrasi. |
| K07 | Summary mengakumulasi bahan dari ekspansi BOM bertingkat. | Konsistensi satuan mengikuti master item. Tidak ada konversi satuan otomatis. |
| K08 | Pemakaian bahan memiliki referensi transaksi. Durasi aktual, basis waktu, jumlah, dan proses dapat dicatat. Tabel biaya outsourcing tersedia pada skema awal. | Buku biaya dengan pengakuan outsourcing bertanggal dan rekonsiliasi biaya historis belum lengkap. |
| K09 | Keputusan yang dijawab klien (waktu standar/unit, hanya tahap selesai, cakupan tarif) kini disimpan dan dikunci. Isian konfigurasi hanya meminta pilihan bahan, outsourcing, dan metode biaya stok yang belum dijawab. | Konfigurasi belum menjadi mesin valuasi. Fungsi menolak menghasilkan nilai ketika riwayat biaya dan perpindahan kategori belum cukup. FIFO/rata-rata/standar belum menjadi metode laporan operasional. |
| K10 | Cetak persiapan mengikuti pesanan terpilih. Konfigurasi mengatur daftar gabungan/per pesanan, BOM yang diperluas, dan kolom catatan operator. Alias serta nomor pesanan bisnis ikut dicetak. | Belum ada pratinjau khusus dalam aplikasi. Bentuk final perlu disepakati. |
| K11 | Label OCR untuk pengguna sudah menyebut surat pesanan / purchase order. Dari master produk, tombol progres kini membuka pesanan produksi terkait dengan filter produk. | Nama fungsi internal `parseQuotation` tetap untuk kompatibilitas dan bukan label pengguna. |
| K12 | Cetak penilaian stok tersedia dengan penjelasan saldo saat ini dikali biaya standar tersimpan. | Bukan laporan historis gabungan bahan/WIP/barang jadi. Laporan tidak boleh diklaim sebagai valuasi operasional yang sudah disetujui. |

## Konfigurasi yang dapat digunakan

Administrator membuka Inventory, bagian laporan, lalu Client WIP policy.
Pengaturan dapat disimpan meskipun beberapa keputusan masih kosong.
Nilai kosong berarti belum diputuskan. Pilihan Excluded adalah keputusan yang berbeda.

Isian kebijakan hanya meminta pengakuan bahan, pengakuan outsourcing, dan metode stok yang belum diputuskan. Nilai waktu standar per unit, tahap berjalan, dan cakupan tarif dikunci sesuai jawaban klien.
Pilihan cetak persiapan langsung digunakan pada cetak berikutnya.
Pilihan arti Full machining, penerapan tahap baru pada pesanan yang sudah berjalan, unit parsial, dan keluaran laporan masih menunggu keputusan.
Teks layar menjelaskan batas ini. Menyimpan pilihan tersebut tidak menjalankan perubahan stok atau mengubah pesanan lama.

## Perlindungan nilai WIP

Rumus sebelumnya menggunakan harga saat ini untuk tanggal historis dan memasukkan pesanan Complete sebagai WIP.
Rumus juga tidak menjalankan beberapa pilihan kebijakan yang disimpan.
Fungsi sekarang mengembalikan alasan penolakan tanpa angka total.
Kebijakan lengkap menghasilkan kode `valuation_history_required` sampai data dan mesin valuasi mendukungnya.

Implementasi lanjutan membutuhkan tarif dengan masa berlaku, rekaman biaya yang tidak berubah, pengakuan bahan/outsourcing bertanggal, dan perpindahan kategori stok.
Perusahaan juga perlu menetapkan aturan yang masih terbuka pada halaman 15 laporan.
Angka stok saat ini tidak digunakan untuk mengarang saldo masa lalu.

## Penerapan dan pengujian

Project uji telah menerima dua migrasi terbaru melalui Supabase. File migrasi lokal mencatat perubahan yang sama untuk branch `main`.

1. `20261111143026_add_wip_valuation_settings_and_confirmed_policy.sql` membuat tabel kebijakan, menyimpan jawaban klien, dan menambahkan perhitungan WIP yang menolak nilai tanpa riwayat biaya yang cukup.
2. `20261111143525_protect_full_machining_and_link_manufacturing_routes.sql` melindungi nama proses dan mengaitkan rute produk ke ID proses.

Tabel WIP dan dua kebijakan aksesnya sudah terlihat pada project uji Supabase yang dipakai branch Git `main`. Project Supabase Tokyo `hhiklzunsjccbuvrutlg` untuk branch Git `production` tidak diubah.

Migrasi `20261111152000_idempotent_production_task_submissions.sql` menambahkan ID permintaan dan tanda terima untuk simpan progres. Jika jawaban server hilang setelah simpan berhasil, pengulangan permintaan yang sama mengembalikan hasil semula. Jika tablet lain mengubah tahap lebih dulu, pemeriksaan versi tetap menahan perubahan basi untuk ditinjau.\n\nMigrasi diterapkan pada Supabase uji untuk branch `main`; RPC dan tabel tanda terima telah diverifikasi. Supabase Tokyo untuk branch `production` tidak disentuh. Typecheck, 93 tes, dan build berhasil.

