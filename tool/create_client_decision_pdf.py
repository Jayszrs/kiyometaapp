from pathlib import Path
import fitz
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, PageBreak

ROOT = Path(r"C:\Users\adel\Downloads\code\project\1. kiyometa\kiyometaapp")
OUT = ROOT / "output" / "pdf"
TMP = ROOT / "tmp" / "pdfs" / "client-decision-evidence"
OUT.mkdir(parents=True, exist_ok=True)
TMP.mkdir(parents=True, exist_ok=True)
REV = Path(r"D:\Downloads\Laporan_Terpadu_Manufacturing_ERP_Kiyometa_Revisi_2_1.pdf")
QNA = Path(r"D:\Downloads\Kiyometa_QnA_ERP_Terintegrasi_Bahasa_Indonesia.pdf")

def page_image(pdf_path, page_no, name):
    doc = fitz.open(pdf_path)
    pix = doc[page_no - 1].get_pixmap(matrix=fitz.Matrix(1.35, 1.35), alpha=False)
    path = TMP / f"{name}.png"
    pix.save(path)
    return str(path)

rev15 = page_image(REV, 15, "rev21-p15")
rev11 = page_image(REV, 11, "rev21-p11")
qna14 = page_image(QNA, 14, "qna-p14")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="TitleBlue", parent=styles["Title"], textColor=colors.HexColor("#17375E"), fontSize=21, leading=26, spaceAfter=12))
styles.add(ParagraphStyle(name="H", parent=styles["Heading2"], textColor=colors.HexColor("#17375E"), fontSize=14, leading=18, spaceBefore=8, spaceAfter=6))
styles.add(ParagraphStyle(name="Body2", parent=styles["BodyText"], fontSize=9.5, leading=14, spaceAfter=6))
styles.add(ParagraphStyle(name="Small", parent=styles["BodyText"], fontSize=8, leading=10, textColor=colors.HexColor("#475569")))
styles.add(ParagraphStyle(name="Question", parent=styles["BodyText"], fontSize=10, leading=14, textColor=colors.HexColor("#111827"), spaceAfter=4))
def P(text, style="Body2"): return Paragraph(text, styles[style])
def evidence(path, label): return [P(label, "Small"), Image(path, width=170*mm, height=108*mm, kind="proportional"), Spacer(1, 3)]
def footer(canvas, doc):
    canvas.saveState(); canvas.setFont("Helvetica", 8); canvas.setFillColor(colors.HexColor("#64748B"))
    canvas.drawString(18*mm, 10*mm, "Kiyometa - daftar keputusan yang perlu dikonfirmasi")
    canvas.drawRightString(192*mm, 10*mm, f"Halaman {doc.page}"); canvas.restoreState()

story = [
    P("Kiyometa - Keputusan yang Masih Dibutuhkan", "TitleBlue"),
    P("Dokumen ini menunjukkan sumber dokumen, halaman, potongan bukti, kondisi aplikasi saat ini, lalu pilihan jawaban. Mohon pilih satu opsi pada setiap nomor agar tidak ada keputusan yang menggantung."),
    P("Catatan", "H"),
    P("Angka pada gambar sumber adalah contoh. Opsi di bawah bukan jawaban yang diasumsikan benar. Pilihan klien akan menjadi aturan aplikasi."),
    P("Dokumen sumber", "H"),
    P("1. Laporan_Terpadu_Manufacturing_ERP_Kiyometa_Revisi_2_1.pdf (21 halaman).<br/>2. Kiyometa_QnA_ERP_Terintegrasi_Bahasa_Indonesia.pdf (15 halaman)."), PageBreak(),
    P("1. Arti Full machining", "H"),
    P("Sumber: Laporan_Terpadu_Manufacturing_ERP_Kiyometa_Revisi_2_1.pdf, halaman 15. Dokumen menyebut arti Full machining masih perlu dipilih."),
] + evidence(rev15, "Potongan halaman 15 - keputusan Full machining") + [
    P("Kondisi aplikasi sekarang: nama Full machining dilindungi, tetapi aplikasi belum menentukan apakah ia rangkuman atau operasi kerja tersendiri."),
    P("Mohon pilih satu:", "Question"),
    P("[ ] A. Hanya rangkuman dari tahap rinci; biaya tidak ditambahkan lagi.<br/>[ ] B. Tahap kerja tersendiri; operator mengisi progres dan biayanya.<br/>[ ] C. Aturan lain: ________________________________", "Question"), PageBreak(),
    P("2. Tahap baru pada pesanan yang sudah berjalan", "H"),
    P("Sumber: Kiyometa_QnA_ERP_Terintegrasi_Bahasa_Indonesia.pdf, halaman 14-15. Q02 menjawab proses berlaku untuk pesanan produksi, tetapi belum menjawab apakah pesanan lama ikut berubah."),
] + evidence(qna14, "Potongan halaman 14 - ringkasan Q02") + [
    P("Kondisi aplikasi sekarang: rute dibaca dari master produk. Perubahan rute master dapat mengubah tahap yang tampil pada pesanan produksi lama."),
    P("Mohon pilih satu:", "Question"),
    P("[ ] A. Hanya pesanan produksi baru.<br/>[ ] B. Semua pesanan produksi yang sedang berjalan.<br/>[ ] C. Hanya pesanan yang dipilih satu per satu.<br/>[ ] D. Aturan lain: ________________________________", "Question"), PageBreak(),
    P("3. WIP, bahan, outsourcing, dan nilai stok", "H"),
    P("Sumber: Laporan_Terpadu_Manufacturing_ERP_Kiyometa_Revisi_2_1.pdf, halaman 11-12. Dokumen membedakan tahap selesai dan tahap berjalan, serta meminta aturan perpindahan bahan, WIP, outsourcing, dan barang jadi."),
] + evidence(rev11, "Potongan halaman 11 - dua contoh perlakuan WIP") + [
    P("Kondisi aplikasi sekarang: waktu standar per unit, tarif yang mencakup tenaga kerja/mesin/listrik, dan pengakuan sampai tahap selesai sudah disimpan. Nilai WIP resmi belum dihitung jika histori biaya dan transaksi belum lengkap."),
    P("Mohon pilih atau isi:", "Question"),
    P("3a. Tahap berjalan: [ ] tidak masuk WIP [ ] masuk WIP [ ] aturan lain: ______<br/>3b. Bahan masuk WIP saat: [ ] dikeluarkan [ ] produksi dimulai [ ] benar-benar dipakai<br/>3c. Outsourcing diakui saat: [ ] dikirim [ ] diterima [ ] invoice diterima<br/>3d. Barang di vendor: [ ] tetap WIP [ ] kategori terpisah [ ] aturan lain: ______", "Question"), PageBreak(),
    P("4. BOM dan jumlah P1-P4 / x6", "H"),
    P("Sumber: Laporan_Terpadu_Manufacturing_ERP_Kiyometa_Revisi_2_1.pdf, halaman 15. Jumlah P1-P4 dan arti x6 belum diberikan; angka contoh tidak boleh dipakai sebagai data produksi."),
] + evidence(rev15, "Potongan halaman 15 - keputusan jumlah BOM") + [
    P("Kondisi aplikasi sekarang: struktur BOM dapat menyimpan jumlah per hubungan induk-anak dan mencegah siklus. Jumlah resmi belum diisi."),
    P("Mohon isi langsung:", "Question"),
    P("P1 per induk: ______  P2: ______  P3: ______  P4: ______<br/>x6 berarti: [ ] P1-1 dikali 6 [ ] komponen lain dikali 6 [ ] bukan perkalian jumlah<br/>Keterangan: ______________________________________________", "Question"), PageBreak(),
    P("5. Formulir dan laporan", "H"),
    P("Sumber: Kiyometa_QnA_ERP_Terintegrasi_Bahasa_Indonesia.pdf, halaman 13-14. Q11-Q12 belum mendapat jawaban perusahaan; dokumen hanya memberikan usulan."),
] + evidence(qna14, "Potongan halaman 14 - status Q11 dan Q12") + [
    P("Kondisi aplikasi sekarang: cetak persiapan sudah dapat memakai pesanan, identitas produk, BOM, rute, dan catatan operator. Format akhir belum dikunci."),
    P("Mohon pilih:", "Question"),
    P("5a. Isi: [ ] pesanan + BOM + proses + catatan operator [ ] isi lain: ______<br/>5b. Format: [ ] satu pesanan per formulir [ ] beberapa pesanan satu formulir [ ] keduanya<br/>5c. Keluaran: [ ] browser/PDF [ ] Excel [ ] keduanya<br/>5d. Jika lebih dari satu halaman: [ ] halaman lanjutan [ ] aturan lain: ______", "Question"), PageBreak(),
    P("6. Cara menjawab", "H"),
    P("Mohon isi tanda centang atau kolom kosong pada nomor 1-5. Setelah semua terisi, keputusan ini akan dipakai sebagai konfigurasi aplikasi. Operator lantai produksi tidak perlu memilih aturan biaya atau rute."),
    P("Nama penanggung jawab: ____________________________<br/>Tanggal: ____________________<br/>Catatan tambahan: ________________________________________________________________<br/>________________________________________________________________________________", "Question"),
    P("Status aplikasi saat ini", "H"),
    P("Penjelasan kondisi aplikasi pada setiap bagian berasal dari pemeriksaan branch main. Screenshot operasional tidak dimasukkan agar dokumen ini hanya memuat bukti layar yang dapat diverifikasi dan tidak menampilkan data uji atau data akun.", "Small")
]

doc = SimpleDocTemplate(str(OUT / "Kiyometa_Daftar_Keputusan_Klien_dengan_Bukti.pdf"), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=16*mm, bottomMargin=17*mm)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT / "Kiyometa_Daftar_Keputusan_Klien_dengan_Bukti.pdf")
