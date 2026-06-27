# Nexus — Login/Register + Admin Dashboard (Express + PostgreSQL + Vercel)

Aplikasi login/register dengan dashboard admin. Data pengguna disimpan di **PostgreSQL** (via Neon, gratis) sehingga benar-benar tersentralisasi — siapa pun yang register dari device manapun akan otomatis muncul di dashboard admin, dan aplikasi ini bisa di-deploy ke **Vercel** (serverless) tanpa masalah, karena tidak lagi mengandalkan file database lokal atau session di memori.

## Kenapa versi ini berbeda dari sebelumnya

Versi sebelumnya pakai SQLite (`better-sqlite3`) dan `express-session` dengan memory store — keduanya **tidak cocok untuk Vercel** karena platform serverless punya filesystem read-only/ephemeral dan setiap request bisa ditangani instance berbeda yang tidak berbagi memori. Versi ini memperbaikinya dengan:

- **Database**: PostgreSQL (Neon) — eksternal, persisten, bisa diakses dari instance mana pun.
- **Sesi login**: JWT yang disimpan di httpOnly cookie — *stateless*, tidak butuh memori server, jadi cocok untuk serverless.

## 1. Siapkan database gratis di Neon

1. Buka **https://neon.tech**, daftar gratis (bisa pakai akun GitHub).
2. Buat project baru (pilih region terdekat, misalnya Singapore).
3. Di dashboard project, salin **Connection string** (mirip `postgresql://user:pass@host/dbname?sslmode=require`).
4. Simpan dulu — ini akan dipakai sebagai `DATABASE_URL`.

## 2. Jalankan lokal (opsional, untuk testing sebelum deploy)

```bash
cd nexus-app
npm install
```

Buat file `.env` di root folder (jangan di-commit ke git):
```
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
JWT_SECRET=ganti-dengan-string-acak-yang-panjang
```

Lalu jalankan dengan env var ter-load (pakai package seperti `dotenv`, atau export manual):
```bash
export $(cat .env | xargs) && npm start
```

Buka **http://localhost:3000**.

## 3. Deploy ke Vercel

1. Push folder project ini ke repo GitHub.
2. Buka **https://vercel.com**, login, klik **Add New → Project**, pilih repo tersebut.
3. Di langkah **Environment Variables**, tambahkan:
   - `DATABASE_URL` → connection string dari Neon (langkah 1)
   - `JWT_SECRET` → string acak yang panjang (boleh generate di https://generate-secret.vercel.app/32)
4. Klik **Deploy**.
5. Setelah selesai, buka URL yang diberikan Vercel (misalnya `https://nexus-app.vercel.app`).

Tabel `users` dan akun admin default akan otomatis dibuat saat pertama kali ada request masuk (lihat `ensureSchema()` di `database.js`).

### Akun admin default
- **Username:** `Xiaoli`
- **Password:** `0507`

## Struktur project

```
nexus-app/
├── server.js        # Express app (juga jadi entry point serverless function di Vercel)
├── database.js      # Koneksi PostgreSQL (pg) + schema + seed admin
├── vercel.json       # Konfigurasi routing Vercel
├── package.json
└── index.html        # Frontend (auth, home, dashboard) — satu file, fetch ke /api/*
```

**Penting saat push ke GitHub:** semua file di atas (`server.js`, `database.js`, `index.html`, dst) harus berada **langsung di root repo**, bukan di dalam subfolder. Kalau repo Anda punya folder pembungkus (misalnya `nexus-app/` yang berisi semua file ini), set **Root Directory** di Vercel project settings ke nama folder itu, atau pindahkan semua isi folder ke root repo.

## Endpoint API

| Method | Endpoint | Keterangan |
|---|---|---|
| POST | `/api/register` | Daftar akun baru |
| POST | `/api/login` | Login (body: `identifier`, `password`) |
| POST | `/api/logout` | Keluar |
| GET | `/api/me` | Cek sesi user yang sedang login |
| GET | `/api/admin/users` | Lihat semua user (admin only) |
| POST | `/api/admin/users` | Tambah user manual (admin only) |
| PATCH | `/api/admin/users/:id/role` | Ubah role user (admin only) |
| DELETE | `/api/admin/users/:id` | Hapus user (admin only) |

## Troubleshooting

**Login selalu gagal / invalid setelah deploy:**
Cek di Vercel dashboard → project → tab **Logs**. Kalau muncul error soal koneksi database, kemungkinan `DATABASE_URL` belum diset atau salah format. Pastikan juga connection string Neon menyertakan `?sslmode=require`.

**Error "Database belum siap":**
Berarti `ensureSchema()` gagal — biasanya karena `DATABASE_URL` salah atau Neon project sedang sleep (tier gratis Neon auto-suspend setelah idle, tapi otomatis bangun lagi saat ada koneksi masuk — coba ulang setelah beberapa detik).

**Sesi tidak ke-detect padahal baru login:**
Pastikan frontend selalu mengirim `credentials: 'include'` di setiap `fetch()` (sudah diatur di `public/index.html`), dan domain frontend+backend sama (karena ini satu aplikasi, seharusnya otomatis sama).

## Catatan keamanan (penting untuk dibaca)

Project ini dibuat untuk **belajar/demo**, bukan untuk produksi nyata:

- Password disimpan **plain text** di database agar admin bisa melihatnya langsung di dashboard (sesuai permintaan). Di aplikasi sungguhan, password **selalu di-hash** (misalnya dengan `bcrypt`) dan **tidak pernah** ditampilkan ke siapa pun, termasuk admin.
- `JWT_SECRET` harus diganti dengan string acak yang panjang dan dirahasiakan — jangan pakai nilai contoh di dokumentasi ini untuk deployment publik.
- Tidak ada rate-limiting untuk percobaan login — di produksi sebaiknya ditambahkan agar tidak rawan brute-force.
