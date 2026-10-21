# Status Implementasi NUCLEA ERP Integrated v2

Tanggal build: 19 Oktober 2026

Paket ini adalah perubahan nyata pada source aplikasi dasar, bukan hanya dokumen blueprint. Namun paket ini **belum dapat diklaim sebagai ERP tervalidasi untuk penggunaan GMP/radiofarmaka**.

## Sudah diimplementasikan pada kode
- Modular service `modules/erp-integrated.js` dan `modules/roadmap-erp.js` untuk fitur integrasi baru.
- Konfigurasi PostgreSQL dan sesi menggunakan environment variables, contoh di `.env.example`.
- Hash password/PIN berbasis `scrypt` dengan kompatibilitas migrasi pada login untuk password lama.
- Registrasi akun baru mendapat role `Pending User`; role tidak dapat diubah lewat formulir profil.
- Menu dan halaman kerja untuk ERP overview, BOM, e-BMR/e-BPR & parameter, QC result/verification, sign-off, inventory adjustment, label jobs, e-DO, pengukuran radiasi, driver GPS, e-POD, reverse logistics, audit events, dan role administration.
- Eksekusi work order memerlukan BOM aktif dan mengeluarkan material RELEASED secara FEFO dalam transaksi database; setiap movement tercatat.
- Batch step timestamp dan sequential locking, QC range evaluation, separation of duties untuk beberapa sign-off, hash dokumen dan audit events.
- Dispatch ditahan sampai QA Release, radiation measurement verification, 13 item checklist armada, checklist serah-terima internal, customer Qualified dan leadpot/shielding asset tersedia terpenuhi.
- Syntax check Node.js dan compile EJS template dijalankan pada source paket.
- Roadmap Manufacturing: Work Order berbasis `IMS.PD.005-F-01`, multi-customer calendar, parameter Production, cancellation audit, concentration mCi/mL + MBq/mL, kebutuhan material, SCM issue transaction dan BMR/BPR live tracking.
- Batch Record choices use extracted source tables from the three supplied BMR files and the common BPR file. Printing is a reconstruction of source form content, not an exact reproduction.
- Inventory: Goods Receipt starts in quarantine; QC inspection and supervisor release require separate users and the uploaded CoA; only released lot quantities count as usable.
- Customer/vendor QA qualification, source document checklist, asset mutation/disposal approvals, IMS.SC.006-F-01 Material Requisition and profile signature upload.
- Distribution form fields aligned to IMS.SC.007-F-03 and internal product handover aligned to IMS.SC.007-F-02; the dropdown now permits assigning an available leadpot when the Work Order plan does not already have one.
- Dashboard mock yield/location charts have been replaced with operational queue counts from the database.

## Belum boleh diasumsikan selesai
- Koneksi seluruh form lama ke alur data baru perlu diuji melalui database nyata dan UAT lintas departemen.
- Tidak ada instance PostgreSQL pada lingkungan build ini, jadi migrasi/startup/query workflow tidak dapat diuji end-to-end secara langsung. Pemeriksaan paket yang berjalan adalah syntax check JavaScript dan compile untuk 54 template EJS; itu bukan bukti bahwa seluruh query SQL dan interaksi UI lulus UAT.
- Data saldo pembukaan harus direkonsiliasi per material/lot/status/expiry. Stock deduction baru menggunakan lot-level balance yang nyata; stok agregat tanpa lot RELEASED tidak otomatis dibuat menjadi lot.
- Master BOM harus dikonfigurasi dan diverifikasi per produk sebelum `Execute Production` bisa dijalankan.
- Label vial/leadpot dan form print e-BMR/e-BPR/e-DO merupakan template pengembangan/rekonstruksi dan harus disetujui QA/Regulatory, termasuk payload yang wajib dicantumkan, revisi efektif, ukuran/layout, pagination dan kontrol cetaknya.
- GPS lewat browser PWA butuh pengujian background-location pada ponsel nyata; browser dapat menghentikan tracking ketika aplikasi tidak aktif.
- e-signature yang tersedia merupakan approval elektronik internal berbasis akun/PIN dan audit; jangan menganggapnya otomatis sebagai tanda tangan elektronik tersertifikasi atau bukti legal tanpa persetujuan QA/Legal.
- TI, kategori label radiasi, dose limits, spesifikasi QC, kalkulasi peluruhan dan semua hard safety limits tetap harus diverifikasi terhadap SOP/ketentuan terbaru oleh QA/QC/PPR.
- Security hardening tambahan dibutuhkan sebelum production: persistent session store, rate limit/CSRF, private document storage, log retention, backup/restore, monitoring, and privilege review.

## Cara validasi lokal
1. Salin `.env.example` menjadi `.env` dan isi koneksi PostgreSQL lokal.
2. Buat backup database yang ada.
3. Jalankan `npm install` dan `npm run check`.
4. Jalankan di database DEVELOPMENT/STAGING dahulu dengan `npm start`.
5. Periksa log sinkronisasi skema, login, migration fields, overview, BOM, inventory, BMR/BPR, QC, labels, e-DO, GPS, POD, return, audit.
6. Jalankan UAT dan test negative path sebelum data terkendali dipakai.

Lihat juga [`ROADMAP_IMPLEMENTATION.md`](ROADMAP_IMPLEMENTATION.md) untuk pemetaan formulir sumber, gate antar-modul, peran, dan kriteria penerimaan sebelum go-live.
