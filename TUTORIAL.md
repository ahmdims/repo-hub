# Tutorial: Menjalankan Repo Hub dan Menyambungkan GitLab

Panduan singkat dari nol sampai GitLab (dan GitHub) tersambung dan siap dipakai.

## 1. Menjalankan aplikasi

**Pakai file .exe** (tanpa Node/npm):

```
D:\Program Files\Documents\Me\repo-hub\dist\Repo Hub-win32-x64\repo-hub.exe
```

Klik dua kali. Jangan pindahkan `repo-hub.exe` sendirian: seluruh folder `Repo Hub-win32-x64` harus ikut. Untuk akses cepat, buat shortcut ke `.exe` itu.

Folder `dist/` tidak ikut git (ada di `.gitignore`), jadi `.exe` tidak muncul di repo. Kalau belum ada atau sudah lama, buat ulang:

```powershell
npm run package
```

**Mode dev** (untuk mengembangkan aplikasinya):

```powershell
npm start
```

## 2. Hubungkan GitHub

Aplikasi memakai login `gh` (GitHub CLI) dan tidak menyimpan token GitHub.

1. Pasang [GitHub CLI](https://cli.github.com/) bila belum ada.
2. Di terminal, jalankan sekali:
   ```powershell
   gh auth login
   ```
3. Di aplikasi buka **Pengaturan**. Klik **Periksa ulang** bila status belum berubah. Hasil yang benar: badge hijau **Terhubung** dengan nama akun GitHub kamu.

## 3. Hubungkan GitLab

> **Urutannya penting.** Kartu GitLab di Pengaturan **tidak** punya kolom "host". Daftar host dibuat otomatis dari repo yang sudah ditambahkan. Kalau belum ada repo dengan remote GitLab, kamu hanya akan melihat tulisan *"Belum ada repo dengan GitLab"*. Jadi tambahkan repo dulu (langkah 3.1), baru isi token (langkah 3.3).

### 3.1 Tambahkan repo

1. Buka **Repositori**.
2. Pilih salah satu:
   - **Tambah dari folder**: pilih satu folder repo.
   - **Pindai folder induk**: pilih folder yang berisi banyak repo, misalnya `D:\Program Files\Documents\SEVIMA\Foxtrot`, lalu centang yang mau dikelola.
3. Remote GitHub/GitLab, branch default, dan branch deploy terdeteksi otomatis dari `git remote`. Periksa, koreksi bila perlu, lalu simpan.

Setelah repo dengan remote GitLab tersimpan, host-nya (misalnya `gitlab.sevima.com`) muncul di **Pengaturan → GitLab**.

### 3.2 Buat Personal Access Token di GitLab

1. Login ke `https://gitlab.sevima.com`.
2. Klik avatar → **Edit profile** → **Access tokens** (atau buka langsung `https://gitlab.sevima.com/-/user_settings/personal_access_tokens`).
3. Klik **Add new token**:
   - **Token name**: `repo-hub`
   - **Expiration date**: sesuai kebijakan (GitLab biasanya mewajibkan tanggal kedaluwarsa)
   - **Scopes**: centang **`api`**
4. Klik **Create personal access token** lalu **salin tokennya** (diawali `glpat-`). Token hanya tampil sekali.

### 3.3 Tempel token di Repo Hub

1. Buka **Pengaturan → GitLab**.
2. Di kartu host `gitlab.sevima.com`, tempel token ke kolom **"Tempel token baru (glpat-…)"**.
3. Klik **Simpan**. Muncul notifikasi *"Token disimpan (terenkripsi)"*.

Token disimpan terenkripsi memakai Windows DPAPI di folder data pengguna aplikasi, dan tidak pernah ditulis ke log Aktivitas.

### 3.4 Pastikan sudah nyambung

Di kartu host tampil:

| Tampilan | Artinya |
| --- | --- |
| Badge hijau **Terhubung: `<username>`** dan *"Token dari: aplikasi"* | Berhasil. |
| Badge kuning **Butuh token** | Token belum tersimpan. Ulangi langkah 3.3. |
| Badge kuning **Token tidak berfungsi** | Token ditolak (salah, kedaluwarsa, atau scope bukan `api`). Buat token baru dan simpan ulang. |

Untuk mencabut token, klik **Hapus token** pada kartu yang sama.

## 4. Cara lain memberi token GitLab (opsional)

Aplikasi mencari token dengan urutan berikut dan memakai yang pertama ketemu:

1. **Variabel lingkungan** `HUB_GITLAB_TOKEN` atau `GITLAB_TOKEN`. Berguna kalau penyimpanan aman OS tidak tersedia. Atur lewat PowerShell lalu buka ulang aplikasi:
   ```powershell
   [Environment]::SetEnvironmentVariable('GITLAB_TOKEN', 'glpat-xxxx', 'User')
   ```
2. **Token yang disimpan di aplikasi** (langkah 3.3).
3. **Kredensial git** yang sudah tersimpan di Git Credential Manager. Ini hanya berhasil jika kata sandi yang tersimpan itu memang *personal access token*, bukan password akun. Opsi ini bisa dimatikan lewat kotak centang di **Pengaturan → GitLab**.

## 5. Pemecahan masalah

| Gejala | Penyebab / solusi |
| --- | --- |
| *"Belum ada repo dengan GitLab"* di Pengaturan | Belum ada repo dengan remote GitLab. Lakukan langkah 3.1. |
| *"Token GitLab ditolak (401)"* | Token salah atau sudah kedaluwarsa. Buat token baru (3.2) dan simpan ulang (3.3). |
| *"Token GitLab untuk … belum diatur"* | Token belum ada untuk host itu. Lakukan 3.3. |
| Kolom token dan tombol **Simpan** nonaktif, ada peringatan *"Penyimpanan aman OS tidak tersedia"* | Pakai variabel lingkungan `GITLAB_TOKEN` (bagian 4). |
| GitHub tidak terhubung | Jalankan `gh auth login`, lalu klik **Periksa ulang**. |
| Aplikasi tidak bisa dibuka dari `dist/` | Pastikan seluruh folder `Repo Hub-win32-x64` utuh, atau bangun ulang dengan `npm run package`. |

## 6. Lokasi data aplikasi

```
C:\Users\<nama-user>\AppData\Roaming\Repo Hub\
```

Berisi `config.json` (daftar repo, pengaturan, token terenkripsi) dan `activity.json` (log aktivitas). Lokasi pastinya juga tampil di **Pengaturan → Tentang**. Menghapus entri repo di aplikasi hanya menghapus catatan di sini, bukan folder repo-nya.
