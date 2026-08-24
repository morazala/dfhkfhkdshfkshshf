'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

let pool = null;

function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!databaseConfigured()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }
  return pool;
}

async function initDatabase() {
  const db = getPool();
  if (!db) return { configured: false, ready: false };
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      google_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      device_info TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS user_devices_user_id_idx ON user_devices(user_id);
  `);
  return { configured: true, ready: true };
}

function deviceFingerprint(deviceInfo, userAgent) {
  return crypto.createHash('sha256')
    .update(`${String(deviceInfo || '')}\n${String(userAgent || '')}`)
    .digest('hex');
}

async function upsertGoogleUser({ googleId, email, displayName, avatarUrl, deviceInfo, userAgent }) {
  const db = getPool();
  if (!db) throw new Error('DATABASE_URL chưa được cấu hình trên server.');
  const client = await db.connect();
  const fingerprint = deviceFingerprint(deviceInfo, userAgent);
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(`
      INSERT INTO users (id, email, google_id, display_name, avatar_url)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (google_id) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        last_login = NOW()
      RETURNING id, email, display_name, avatar_url, role, disabled, created_at, last_login
    `, [userId, email, googleId, displayName || '', avatarUrl || '']);
    const user = userResult.rows[0];
    if (user.disabled) {
      await client.query('ROLLBACK');
      const error = new Error('Tài khoản đã bị vô hiệu hoá.');
      error.code = 'USER_DISABLED';
      throw error;
    }
    await client.query(`
      INSERT INTO user_devices (id, user_id, fingerprint, device_info, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, fingerprint) DO UPDATE SET
        device_info = EXCLUDED.device_info,
        user_agent = EXCLUDED.user_agent,
        last_seen = NOW()
    `, [deviceId, user.id, fingerprint, String(deviceInfo || '').slice(0, 500), String(userAgent || '').slice(0, 1000)]);
    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function findUserById(id) {
  const db = getPool();
  if (!db) return null;
  const result = await db.query(`
    SELECT id, email, display_name, avatar_url, role, disabled, created_at, last_login
    FROM users WHERE id = $1
  `, [id]);
  return result.rows[0] || null;
}

async function listUsers() {
  const db = getPool();
  if (!db) throw new Error('DATABASE_URL chưa được cấu hình trên server.');
  const result = await db.query(`
    SELECT
      u.id, u.email, u.display_name, u.role, u.disabled, u.created_at, u.last_login,
      COALESCE(json_agg(json_build_object(
        'deviceInfo', d.device_info,
        'userAgent', d.user_agent,
        'firstSeen', d.first_seen,
        'lastSeen', d.last_seen
      ) ORDER BY d.last_seen DESC) FILTER (WHERE d.id IS NOT NULL), '[]') AS devices
    FROM users u
    LEFT JOIN user_devices d ON d.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
  return result.rows;
}

async function deleteUser(id) {
  const db = getPool();
  if (!db) throw new Error('DATABASE_URL chưa được cấu hình trên server.');
  const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id, email', [id]);
  return result.rows[0] || null;
}

module.exports = {
  databaseConfigured,
  getPool,
  initDatabase,
  upsertGoogleUser,
  findUserById,
  listUsers,
  deleteUser
};
