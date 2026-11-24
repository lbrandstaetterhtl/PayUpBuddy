import crypto from 'node:crypto';

const SESSION_DAYS = 30;
export const COOKIE = 'pub_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function randomPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, maxAge: SESSION_DAYS * 24 * 3600 * 1000 };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userForToken(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.username, u.is_admin
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now()) ?? null;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Creates the first admin account if the database has no users yet.
 * Returns the generated password (or null if nothing was created).
 */
export function ensureAdmin(db, { username = 'admin', password } = {}) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return null;
  const pw = password || randomPassword();
  db.prepare('INSERT INTO users (name, username, password_hash, is_admin) VALUES (?, ?, ?, 1)')
    .run('Admin', username, hashPassword(pw));
  return { username, password: pw };
}
