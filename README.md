# Repo Hub

Aplikasi desktop (Electron) untuk **push, sinkronisasi, review, merge, dan rilis ke banyak repo sekaligus** — GitHub dan GitLab — dengan tampilan yang sama seperti KarirKit (dibangun langsung di atas design system KarirKit).

Pikirkan seperti halaman GitHub/GitLab, tetapi satu layar untuk semua repo kamu.

## Fitur

| Halaman | Fungsinya |
| --- | --- |
| **Dasbor** | Status semua repo (branch, perubahan lokal, ahead/behind, kesamaan GitHub ↔ GitLab). Pilih beberapa repo lalu **Push** atau **Sinkronkan GitLab** sekaligus. |
| **Pull Request** | PR GitHub + MR GitLab dari semua repo dalam satu tabel. Filter, cari, lihat detail (check, commit, diff, diskusi), **Approve**, **Request changes**, komentar, **Merge**, tutup, dan **Buat PR/MR**. Approve/merge massal. |
| **Rilis** | Alur sekali klik, mis. `karirkit/<versi>` → `master` → `karirkit/vercel`: buat/pakai PR, tunggu check hijau, merge, sinkron GitLab, pantau deployment. Berhenti di kegagalan pertama. Bisa dibatalkan. |
| **Repositori** | Daftar repo yang kamu kelola — **bisa diubah sendiri**: tambah dari folder, pindai folder induk, ubah, hapus dari daftar. Tiap repo punya alur rilisnya sendiri. |
| **Aktivitas** | Catatan semua aksi (push, merge, review, rilis…). Token tidak pernah dicatat. |
| **Pengaturan** | Koneksi GitHub (lewat `gh`), token GitLab per host, ukuran buffer git. |

## Menjalankan

Prasyarat: Node.js 20+, Git, dan [GitHub CLI](https://cli.github.com/) (`gh`).

```bash
npm install
npm start          # build aset lalu buka aplikasi
npm test           # tes backend (13) — tes UI: node test/ui.e2e.cjs
npm run package    # aplikasi mandiri di dist/Repo Hub-win32-x64/repo-hub.exe
```

### Login

- **GitHub**: jalankan `gh auth login` sekali. Aplikasi memakai login `gh` itu, tidak menyimpan token GitHub.
- **GitLab**: buat *personal access token* (scope `api`), lalu tempel di **Pengaturan → GitLab**. Token disimpan terenkripsi oleh sistem operasi (Electron `safeStorage`). Alternatif: variabel lingkungan `GITLAB_TOKEN` / `HUB_GITLAB_TOKEN`, atau (opsional) kata sandi yang sudah tersimpan di git credential manager bila isinya memang token.

### Menambah repo

**Repositori → Tambah dari folder** (atau **Pindai folder induk** untuk menemukan banyak repo sekaligus). Remote GitHub/GitLab, branch default, dan branch deploy dideteksi otomatis dari `git remote` (termasuk `pushurl` ganda) lalu bisa kamu koreksi di form.

### Alur rilis per repo

Di form repo, bagian **Alur rilis** berisi langkah `dari → ke`. `$BRANCH` diganti branch rilis yang dipilih di halaman Rilis. Bawaan:

1. `$BRANCH` → `master`
2. `master` → `karirkit/vercel`

Opsi: metode merge (`merge`/`squash`/`rebase`), tunggu check hijau, sinkron GitLab setelah rilis, pantau deployment.

## Jaminan keamanan

- **Tidak ada force-push**, **tidak ada penghapusan branch/tag**, **tidak ada penghapusan folder**. Menghapus repo dari daftar hanya menghapus entri di aplikasi.
- Setiap aksi yang mengubah sesuatu butuh konfirmasi di UI **dan** ditolak oleh proses utama bila datang tanpa `confirmed: true`.
- Mirror GitLab hanya membuat ref baru atau fast-forward; tag yang sudah ada tidak pernah dipindah.
- Perintah `git`/`gh` dijalankan tanpa shell (`execFile`); semua nama ref divalidasi.
- Renderer terisolasi: `contextIsolation`, `sandbox`, tanpa `nodeIntegration`, CSP tanpa skrip inline. Satu channel IPC dengan daftar putih; semua teks dari luar (judul PR, nama branch, pesan commit) di-escape.
- Aturan GitHub tetap berlaku: kamu tidak bisa meng-approve PR milikmu sendiri (tombol dinonaktifkan).

## Struktur

```
main/       proses utama: git, GitHub (gh), GitLab (REST), alur rilis, penyimpanan, IPC
preload/    jembatan sempit ke renderer
renderer/   UI (HTML + JS modul) — gaya dari design system KarirKit
src/        app.css → dibangun Tailwind ke renderer/vendor/
scripts/    build-assets.mjs (CSS + aset), package.mjs (aplikasi mandiri)
test/       tes backend (repo sementara + dua remote bare) dan tes UI Electron (Playwright)
```

Data aplikasi (daftar repo, pengaturan, log aktivitas, token terenkripsi) ada di folder data pengguna Electron; lokasinya tampil di **Pengaturan → Tentang**.

## Catatan: dependensi design system

`package.json` memakai `"@foxtrot-sevima/karirkit": "file:../../SEVIMA/Foxtrot/design-system"` — tautan lokal ke repo design system di komputer ini. Sebelum repo ini di-clone di komputer lain (atau dipasang di CI), ganti dengan versi dari registry paket (mis. `"^1.3.4"` plus `.npmrc` untuk registry-nya). Aplikasi hasil `npm run package` tidak butuh dependensi ini lagi karena CSS, font, logo, dan helper JS sudah disalin ke `renderer/`.

## Variabel lingkungan (untuk tes/debug)

`HUB_USER_DATA` (folder data), `HUB_GH_BIN` (ganti `gh`), `HUB_POLL_MS` (interval tunggu check), `HUB_GITLAB_TOKEN`, `HUB_PICK_FOLDER` (lewati dialog pilih folder).
