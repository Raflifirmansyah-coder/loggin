// database.js — koneksi PostgreSQL (Neon) + setup schema + seed admin
// Membutuhkan environment variable DATABASE_URL (connection string dari Neon).
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[FATAL] Environment variable DATABASE_URL belum diset.');
  console.error('Buat database gratis di https://neon.tech, lalu set DATABASE_URL di Vercel project settings.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon mewajibkan SSL
});

// Setup schema (dipanggil sekali, idempotent — aman dipanggil berkali-kali)
let initPromise = null;
async function ensureSchema() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        anime_mal_id INTEGER NOT NULL,
        anime_title TEXT NOT NULL,
        anime_poster TEXT,
        episode_number INTEGER NOT NULL,
        episode_title TEXT,
        video_url TEXT NOT NULL,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        cover_url TEXT NOT NULL DEFAULT '',
        video_url TEXT NOT NULL,
        genre TEXT NOT NULL DEFAULT '',
        added_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Seed akun admin default: Xiaoli / 0507 (hanya jika belum ada)
    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = $1',
      ['xiaoli']
    );
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO users (id, username, email, password, role, created_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        ['admin-xiaoli', 'Xiaoli', 'xiaoli@nexus.local', '0507', 'admin']
      );
      console.log('[seed] Akun admin default "Xiaoli" dibuat.');
    }
  })();

  return initPromise;
}

module.exports = { pool, ensureSchema };
