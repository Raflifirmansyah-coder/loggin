// server.js — Express server: serve frontend statis + REST API untuk auth & admin
// Database: PostgreSQL (Neon). Sesi login: JWT di httpOnly cookie (stateless, cocok serverless/Vercel).
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const { pool, ensureSchema } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'nexus-demo-secret-change-me';
const COOKIE_NAME = 'nexus_token';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

// Pastikan schema & seed admin sudah siap sebelum request apa pun diproses.
// Penting untuk serverless: setiap cold start akan memanggil ini, tapi karena
// idempotent (CREATE TABLE IF NOT EXISTS + cek existing sebelum insert), aman.
app.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error('Schema init error:', err);
    res.status(500).json({ error: 'Database belum siap. Periksa konfigurasi DATABASE_URL.' });
  }
});

// ---------- Helpers ----------
function genId() {
  return crypto.randomBytes(8).toString('hex');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    createdAt: u.created_at
  };
}

function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, userId) {
  const token = signToken(userId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 hari
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

async function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Belum login.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesi tidak valid atau sudah berakhir.' });
  }
}

async function requireAdmin(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Belum login.' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Sesi tidak valid atau sudah berakhir.' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.uid]);
  const user = rows[0];
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Akses ditolak. Hanya admin yang boleh mengakses ini.' });
  }
  req.currentUser = user;
  next();
}

// ====================== AUTH ROUTES ======================

// Register
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body || {};

  const cleanUsername = (username || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!cleanUsername || cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username minimal 3 karakter.' });
  }
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Masukkan alamat email yang valid.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Kata sandi minimal 6 karakter.' });
  }

  try {
    const emailExists = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (emailExists.rows.length > 0) {
      return res.status(409).json({ error: 'Email ini sudah terdaftar. Coba masuk, atau gunakan email lain.' });
    }
    const usernameExists = await pool.query('SELECT id FROM users WHERE LOWER(username) = $1', [cleanUsername.toLowerCase()]);
    if (usernameExists.rows.length > 0) {
      return res.status(409).json({ error: 'Username sudah dipakai. Pilih username lain.' });
    }

    const id = genId();
    await pool.query(
      `INSERT INTO users (id, username, email, password, role, created_at)
       VALUES ($1, $2, $3, $4, 'user', now())`,
      [id, cleanUsername, cleanEmail, password]
    );

    res.json({ ok: true, message: `Pendaftaran berhasil! Selamat datang, ${cleanUsername}.` });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server. Coba lagi.' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  const cleanIdentifier = (identifier || '').trim().toLowerCase();

  if (!cleanIdentifier) {
    return res.status(400).json({ error: 'Masukkan username atau email.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Kata sandi tidak boleh kosong.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR LOWER(username) = $1',
      [cleanIdentifier]
    );
    const user = rows[0];

    if (!user || user.password !== password) {
      const message = user
        ? 'Kata sandi salah. Periksa kembali dan coba lagi.'
        : 'Username/email atau kata sandi tidak cocok dengan data terdaftar.';
      return res.status(401).json({ error: message });
    }

    setAuthCookie(res, user.id);
    res.json({ ok: true, user: toPublicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server. Coba lagi.' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// Sesi saat ini
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = rows[0];
    if (!user) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Sesi tidak valid.' });
    }
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// ====================== ADMIN ROUTES ======================

// Lihat semua user (termasuk password — hanya untuk admin)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    const users = rows.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      password: u.password,
      role: u.role,
      createdAt: u.created_at
    }));
    res.json({ users });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// Tambah user manual dari dashboard
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, email, password, role } = req.body || {};
  const cleanUsername = (username || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanRole = role === 'admin' ? 'admin' : 'user';

  if (!cleanUsername || cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username minimal 3 karakter.' });
  }
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Masukkan alamat email yang valid.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Kata sandi minimal 6 karakter.' });
  }

  try {
    const emailExists = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (emailExists.rows.length > 0) return res.status(409).json({ error: 'Email sudah digunakan pengguna lain.' });
    const usernameExists = await pool.query('SELECT id FROM users WHERE LOWER(username) = $1', [cleanUsername.toLowerCase()]);
    if (usernameExists.rows.length > 0) return res.status(409).json({ error: 'Username sudah dipakai.' });

    const id = genId();
    await pool.query(
      `INSERT INTO users (id, username, email, password, role, created_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, cleanUsername, cleanEmail, password, cleanRole]
    );

    res.json({ ok: true, message: `Pengguna ${cleanUsername} berhasil ditambahkan.` });
  } catch (err) {
    console.error('Add user error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// Ubah role user
app.patch('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });

    if (target.id === req.currentUser.id && target.role === 'admin') {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND id != $1`,
        [id]
      );
      if (countRows[0].c === 0) {
        return res.status(400).json({ error: 'Tidak bisa menurunkan peran ini — minimal harus ada satu admin.' });
      }
    }

    const newRole = target.role === 'admin' ? 'user' : 'admin';
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [newRole, id]);
    res.json({ ok: true, role: newRole });
  } catch (err) {
    console.error('Toggle role error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// Hapus user
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });

    if (target.role === 'admin') {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND id != $1`,
        [id]
      );
      if (countRows[0].c === 0) {
        return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir.' });
      }
    }

    await pool.query('DELETE FROM users WHERE id = $1', [id]);

    const selfDeleted = req.currentUser.id === id;
    if (selfDeleted) clearAuthCookie(res);

    res.json({ ok: true, username: target.username, selfDeleted });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// ====================== EPISODE ROUTES (video yang admin upload sendiri) ======================
// Setiap episode terhubung ke satu judul anime (diidentifikasi lewat anime_mal_id dari Jikan API).
// Poster & metadata anime diambil langsung dari Jikan di sisi frontend — kita hanya simpan
// videoUrl + info ringkas yang perlu ditampilkan di halaman tonton.

// Lihat semua episode untuk satu anime tertentu (siapa pun yang sudah login boleh lihat)
app.get('/api/episodes', requireAuth, async (req, res) => {
  const malId = parseInt(req.query.malId, 10);
  try {
    let result;
    if (malId) {
      result = await pool.query(
        'SELECT * FROM episodes WHERE anime_mal_id = $1 ORDER BY episode_number ASC',
        [malId]
      );
    } else {
      result = await pool.query('SELECT * FROM episodes ORDER BY created_at DESC');
    }
    const episodes = result.rows.map(e => ({
      id: e.id,
      animeMalId: e.anime_mal_id,
      animeTitle: e.anime_title,
      animePoster: e.anime_poster,
      episodeNumber: e.episode_number,
      episodeTitle: e.episode_title,
      videoUrl: e.video_url,
      createdAt: e.created_at
    }));
    res.json({ episodes });
  } catch (err) {
    console.error('List episodes error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// Daftar anime unik yang sudah punya episode (untuk ditampilkan di grid "tersedia untuk ditonton")
app.get('/api/episodes/anime-list', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT anime_mal_id, anime_title, anime_poster, COUNT(*)::int AS episode_count, MAX(created_at) AS last_added
      FROM episodes
      GROUP BY anime_mal_id, anime_title, anime_poster
      ORDER BY last_added DESC
    `);
    const animeList = rows.map(r => ({
      malId: r.anime_mal_id,
      title: r.anime_title,
      poster: r.anime_poster,
      episodeCount: r.episode_count
    }));
    res.json({ animeList });
  } catch (err) {
    console.error('Anime list error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// Tambah episode baru (admin only) — videoUrl harus link ke video yang sudah di-hosting sendiri
app.post('/api/admin/episodes', requireAdmin, async (req, res) => {
  const { animeMalId, animeTitle, animePoster, episodeNumber, episodeTitle, videoUrl } = req.body || {};

  const cleanAnimeTitle = (animeTitle || '').trim();
  const cleanVideoUrl = (videoUrl || '').trim();
  const malId = parseInt(animeMalId, 10);
  const epNum = parseInt(episodeNumber, 10);

  if (!malId) {
    return res.status(400).json({ error: 'Anime belum dipilih.' });
  }
  if (!cleanAnimeTitle) {
    return res.status(400).json({ error: 'Judul anime tidak boleh kosong.' });
  }
  if (!epNum || epNum < 1) {
    return res.status(400).json({ error: 'Nomor episode harus berupa angka lebih dari 0.' });
  }
  if (!cleanVideoUrl) {
    return res.status(400).json({ error: 'URL video tidak boleh kosong.' });
  }

  try {
    const id = genId();
    await pool.query(
      `INSERT INTO episodes (id, anime_mal_id, anime_title, anime_poster, episode_number, episode_title, video_url, added_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [id, malId, cleanAnimeTitle, (animePoster || '').trim(), epNum, (episodeTitle || '').trim(), cleanVideoUrl, req.currentUser.id]
    );
    res.json({ ok: true, id });
  } catch (err) {
    console.error('Add episode error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// Hapus episode (admin only)
app.delete('/api/admin/episodes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM episodes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete episode error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// Fallback: serve index.html untuk semua route non-API (single page app)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Saat dijalankan lokal (node server.js), buka port seperti biasa.
// Saat di Vercel, file ini diimpor sebagai serverless function (lihat module.exports di bawah),
// jadi app.listen() tidak akan pernah dipanggil oleh runtime Vercel.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nexus app berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
