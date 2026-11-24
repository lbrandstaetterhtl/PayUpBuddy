import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { openDb, tx } from './db.js';
import {
  COOKIE, createSession, destroySession, ensureAdmin, hashPassword, parseCookies,
  randomPassword, userForToken, verifyPassword,
} from './auth.js';
import { centsToInput, formatCents, parseCents } from './money.js';
import * as views from './views.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {object} opts
 * @param {string} opts.dataDir   where the database and uploaded images live
 * @param {(buf: Buffer) => Promise<{items, totalCents}>} opts.ocr  receipt recognizer
 * @param {string} [opts.adminPassword]
 */
export function createApp({ dataDir, ocr, adminPassword, log = console.log }) {
  const db = openDb(dataDir);
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const created = ensureAdmin(db, { password: adminPassword });
  if (created) {
    log(adminPassword
      ? `Erster Admin angelegt → Benutzername: ${created.username} (Passwort aus ADMIN_PASSWORD)`
      : `Erster Admin angelegt → Benutzername: ${created.username}  Passwort: ${created.password}`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
  });

  // ---------- helpers ----------
  const q = (sql) => db.prepare(sql);

  function setFlash(req, type, text) {
    if (req.token) q('UPDATE sessions SET flash = ? WHERE token = ?').run(JSON.stringify({ type, text }), req.token);
  }
  function takeFlash(req) {
    const row = q('SELECT flash FROM sessions WHERE token = ?').get(req.token);
    if (!row?.flash) return null;
    q('UPDATE sessions SET flash = NULL WHERE token = ?').run(req.token);
    return JSON.parse(row.flash);
  }
  const page = (req, res, view, data = {}) => res.send(views[view]({ user: req.user, flash: takeFlash(req), ...data }));
  const safeBack = (v) => (typeof v === 'string' && /^\/[a-z0-9/]*$/i.test(v) ? v : '/');
  const id = (v) => (/^\d+$/.test(String(v)) ? Number(v) : -1);

  function canSee(bill, user) {
    if (!bill) return false;
    if (user.is_admin || bill.payer_id === user.id) return true;
    return !!q('SELECT 1 FROM shares WHERE bill_id = ? AND user_id = ?').get(bill.id, user.id);
  }

  // ---------- global middleware ----------
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    // Reject cross-site form posts (in addition to SameSite cookies).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let host = null;
      try { host = new URL(req.headers.origin).host; } catch { /* invalid origin */ }
      if (host !== req.headers.host) return res.status(403).send('Forbidden');
    }
    next();
  });
  app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use((req, res, next) => {
    req.token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = userForToken(db, req.token);
    if (req.user) req.user.is_admin = !!req.user.is_admin;
    next();
  });

  // ---------- login ----------
  const failures = new Map(); // ip -> { n, until }
  app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.send(views.loginPage({}))));
  app.post('/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const f = failures.get(req.ip);
    if (f && f.n >= 10 && f.until > Date.now()) {
      return res.status(429).send(views.loginPage({ username, error: 'Zu viele Versuche. Bitte später erneut probieren.' }));
    }
    const row = q('SELECT id, password_hash FROM users WHERE username = ?').get(username);
    if (!row || !verifyPassword(String(req.body.password || ''), row.password_hash)) {
      const cur = f && f.until > Date.now() ? f : { n: 0 };
      failures.set(req.ip, { n: cur.n + 1, until: Date.now() + 15 * 60 * 1000 });
      return res.status(401).send(views.loginPage({ username, error: 'Benutzername oder Passwort falsch.' }));
    }
    failures.delete(req.ip);
    const { token, maxAge } = createSession(db, row.id);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    destroySession(db, req.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect('/login');
  });

  // Everything below requires a logged-in user.
  app.use((req, res, next) => {
    if (req.user) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nicht angemeldet' });
    res.redirect('/login');
  });
  const adminOnly = (req, res, next) => (req.user.is_admin ? next() : res.status(403).send(views.messagePage({ user: req.user, title: 'Kein Zugriff', text: 'Nur für Admins.' })));

  // ---------- dashboard ----------
  app.get('/', (req, res) => {
    const me = req.user.id;
    const open = q(`
      SELECT s.id AS shareId, s.amount_cents AS cents, s.user_id, b.id AS billId, b.title, b.due_date, b.payer_id
      FROM shares s JOIN bills b ON b.id = s.bill_id
      WHERE s.paid_at IS NULL AND s.user_id != b.payer_id AND (s.user_id = ? OR b.payer_id = ?)
      ORDER BY b.due_date, b.id`).all(me, me);
    const names = new Map(q('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    const people = new Map();
    const totals = { owe: 0, owed: 0 };
    for (const r of open) {
      const iOwe = r.user_id === me;
      const other = iOwe ? r.payer_id : r.user_id;
      if (!people.has(other)) people.set(other, { id: other, name: names.get(other) ?? '?', net: 0, items: [] });
      const p = people.get(other);
      p.items.push({ ...r, iOwe });
      p.net += iOwe ? -r.cents : r.cents;
      totals[iOwe ? 'owe' : 'owed'] += r.cents;
    }
    const bills = q(`
      SELECT b.id, b.title, b.created_at, u.name AS payer_name,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM shares WHERE bill_id = b.id) AS total,
        EXISTS (SELECT 1 FROM shares WHERE bill_id = b.id AND paid_at IS NULL AND user_id != b.payer_id) AS open
      FROM bills b JOIN users u ON u.id = b.payer_id
      WHERE b.payer_id = ? OR EXISTS (SELECT 1 FROM shares WHERE bill_id = b.id AND user_id = ?)
      ORDER BY b.created_at DESC, b.id DESC LIMIT 30`).all(me, me);
    page(req, res, 'dashboardPage', { totals, people: [...people.values()], bills });
  });

  // ---------- bills ----------
  const allUsers = () => q('SELECT id, name FROM users ORDER BY name COLLATE NOCASE').all();

  app.get('/bills/new', (req, res) => page(req, res, 'newBillPage', { users: allUsers() }));

  app.post('/api/ocr', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Kein Bild erhalten.' });
    try {
      const { items, totalCents } = await ocr(req.file.buffer);
      res.json({
        items: items.map((i) => ({ label: i.label, amount: centsToInput(i.cents) })),
        total: totalCents == null ? null : centsToInput(totalCents),
      });
    } catch (err) {
      log('OCR-Fehler:', err?.message || err);
      res.status(422).json({ error: 'Text konnte nicht gelesen werden.' });
    }
  });

  app.post('/bills', upload.single('image'), async (req, res) => {
    const users = allUsers();
    const known = new Set(users.map((u) => u.id));
    const title = String(req.body.title || '').trim().slice(0, 80);
    const dueDate = String(req.body.due_date || '');
    const fail = (text) => res.status(400).send(views.newBillPage({
      user: req.user, users, flash: { type: 'error', text }, values: { title, due_date: dueDate },
    }));

    if (!title) return fail('Bitte einen Titel angeben.');
    if (!DATE_RE.test(dueDate)) return fail('Bitte ein gültiges Datum angeben.');

    let rows;
    try { rows = JSON.parse(req.body.items || '[]'); } catch { rows = null; }
    if (!Array.isArray(rows) || rows.length === 0) return fail('Bitte mindestens einen Posten erfassen.');

    // One share per person; several items for the same person are summed up.
    const perUser = new Map();
    for (const r of rows.slice(0, 200)) {
      const cents = parseCents(r?.amount);
      const uid = Number(r?.user);
      if (cents === null || cents === 0) return fail(`Ungültiger Betrag: „${String(r?.amount ?? '').slice(0, 20)}“`);
      if (!known.has(uid)) return fail('Unbekannter Benutzer in den Posten.');
      const entry = perUser.get(uid) ?? { cents: 0, labels: [] };
      entry.cents += cents;
      const label = String(r?.label || '').trim();
      if (label) entry.labels.push(label);
      perUser.set(uid, entry);
    }
    for (const [uid, e] of perUser) {
      if (e.cents <= 0) return fail(`Der Anteil von ${users.find((u) => u.id === uid).name} ist nicht positiv.`);
    }
    if (![...perUser.keys()].some((uid) => uid !== req.user.id)) {
      return fail('Weise mindestens einen Posten jemand anderem zu.');
    }

    let image = null;
    if (req.file) {
      try {
        image = `${crypto.randomBytes(12).toString('hex')}.jpg`;
        await sharp(req.file.buffer, { failOn: 'none' }).rotate()
          .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 }).toFile(path.join(uploadDir, image));
      } catch {
        return fail('Das Bild konnte nicht verarbeitet werden.');
      }
    }

    const billId = tx(db, () => {
      const { lastInsertRowid } = q('INSERT INTO bills (title, payer_id, image, due_date) VALUES (?, ?, ?, ?)')
        .run(title, req.user.id, image, dueDate);
      const ins = q('INSERT INTO shares (bill_id, user_id, label, amount_cents) VALUES (?, ?, ?, ?)');
      for (const [uid, e] of perUser) ins.run(lastInsertRowid, uid, e.labels.join(', ').slice(0, 300), e.cents);
      return Number(lastInsertRowid);
    });
    setFlash(req, 'ok', 'Rechnung gespeichert.');
    res.redirect(`/bills/${billId}`);
  });

  const getBill = (billId) => q(`
    SELECT b.*, u.name AS payer_name FROM bills b JOIN users u ON u.id = b.payer_id WHERE b.id = ?`).get(billId);

  app.get('/bills/:id', (req, res) => {
    const bill = getBill(id(req.params.id));
    if (!canSee(bill, req.user)) return res.status(404).send(views.messagePage({ user: req.user, title: 'Nicht gefunden', text: 'Diese Rechnung gibt es nicht.' }));
    const shares = q(`
      SELECT s.*, u.name AS user_name FROM shares s JOIN users u ON u.id = s.user_id
      WHERE s.bill_id = ? ORDER BY (s.user_id = ?) , u.name COLLATE NOCASE`).all(bill.id, bill.payer_id);
    page(req, res, 'billPage', { bill, shares });
  });

  app.get('/bills/:id/image', (req, res) => {
    const bill = getBill(id(req.params.id));
    if (!canSee(bill, req.user) || !bill.image) return res.sendStatus(404);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(uploadDir, path.basename(bill.image)));
  });

  app.post('/bills/:id/delete', (req, res) => {
    const bill = getBill(id(req.params.id));
    if (!bill || (bill.payer_id !== req.user.id && !req.user.is_admin)) return res.sendStatus(404);
    q('DELETE FROM bills WHERE id = ?').run(bill.id);
    if (bill.image) fs.rm(path.join(uploadDir, path.basename(bill.image)), { force: true }, () => {});
    setFlash(req, 'ok', 'Rechnung gelöscht.');
    res.redirect('/');
  });

  // ---------- payments (only the person who is owed the money can confirm) ----------
  function setPaid(req, res, paid) {
    const share = q(`
      SELECT s.id, b.payer_id FROM shares s JOIN bills b ON b.id = s.bill_id WHERE s.id = ?`).get(id(req.params.id));
    if (!share || share.payer_id !== req.user.id) return res.sendStatus(404);
    q(`UPDATE shares SET paid_at = ${paid ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(share.id);
    res.redirect(safeBack(req.body.back));
  }
  app.post('/shares/:id/paid', (req, res) => setPaid(req, res, true));
  app.post('/shares/:id/unpaid', (req, res) => setPaid(req, res, false));

  app.post('/people/:id/settle', (req, res) => {
    const other = id(req.params.id);
    const { changes } = q(`
      UPDATE shares SET paid_at = datetime('now')
      WHERE paid_at IS NULL AND user_id = ? AND bill_id IN (SELECT id FROM bills WHERE payer_id = ?)`).run(other, req.user.id);
    if (changes) setFlash(req, 'ok', `${changes} Posten als erhalten markiert.`);
    res.redirect('/');
  });

  // ---------- account ----------
  app.get('/account', (req, res) => page(req, res, 'accountPage'));
  app.post('/account/password', (req, res) => {
    const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const next = String(req.body.next || '');
    if (!verifyPassword(String(req.body.current || ''), row.password_hash)) {
      setFlash(req, 'error', 'Aktuelles Passwort ist falsch.');
    } else if (next.length < 8) {
      setFlash(req, 'error', 'Das neue Passwort braucht mindestens 8 Zeichen.');
    } else {
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
      q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
      setFlash(req, 'ok', 'Passwort geändert.');
    }
    res.redirect('/account');
  });

  // ---------- user management (admins only, no self-registration) ----------
  app.get('/users', adminOnly, (req, res) => {
    const users = q(`
      SELECT u.id, u.name, u.username, u.is_admin,
        EXISTS (SELECT 1 FROM bills WHERE payer_id = u.id) OR EXISTS (SELECT 1 FROM shares WHERE user_id = u.id) AS in_use
      FROM users u ORDER BY u.name COLLATE NOCASE`).all();
    page(req, res, 'usersPage', { users });
  });

  app.post('/users', adminOnly, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 40);
    const username = String(req.body.username || '').trim().slice(0, 40);
    let password = String(req.body.password || '');
    if (!name || !/^[A-Za-z0-9._-]+$/.test(username)) {
      setFlash(req, 'error', 'Name und Benutzername (Buchstaben, Zahlen, . _ -) angeben.');
      return res.redirect('/users');
    }
    if (password && password.length < 8) {
      setFlash(req, 'error', 'Das Passwort braucht mindestens 8 Zeichen.');
      return res.redirect('/users');
    }
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) {
      setFlash(req, 'error', `Der Benutzername „${username}“ ist schon vergeben.`);
      return res.redirect('/users');
    }
    const generated = !password;
    if (generated) password = randomPassword();
    q('INSERT INTO users (name, username, password_hash, is_admin) VALUES (?, ?, ?, ?)')
      .run(name, username, hashPassword(password), req.body.is_admin ? 1 : 0);
    setFlash(req, 'ok', generated
      ? `${name} angelegt. Benutzername: ${username} · Passwort: ${password}`
      : `${name} angelegt.`);
    res.redirect('/users');
  });

  app.post('/users/:id/reset', adminOnly, (req, res) => {
    const u = q('SELECT id, name, username FROM users WHERE id = ?').get(id(req.params.id));
    if (!u) return res.sendStatus(404);
    const password = randomPassword();
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    if (u.id !== req.user.id) q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    setFlash(req, 'ok', `Neues Passwort für ${u.name} (${u.username}): ${password}`);
    res.redirect('/users');
  });

  app.post('/users/:id/delete', adminOnly, (req, res) => {
    const uid = id(req.params.id);
    const inUse = q('SELECT 1 FROM bills WHERE payer_id = ? UNION SELECT 1 FROM shares WHERE user_id = ?').get(uid, uid);
    if (uid === req.user.id || inUse) {
      setFlash(req, 'error', 'Dieser Benutzer kann nicht gelöscht werden.');
    } else if (q('DELETE FROM users WHERE id = ?').run(uid).changes) {
      setFlash(req, 'ok', 'Benutzer gelöscht.');
    }
    res.redirect('/users');
  });

  // ---------- errors ----------
  app.use((req, res) => res.status(404).send(views.messagePage({ user: req.user, title: 'Nicht gefunden', text: 'Diese Seite gibt es nicht.' })));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const tooBig = err?.code === 'LIMIT_FILE_SIZE';
    if (!tooBig) log(err);
    const text = tooBig ? 'Das Bild ist zu groß (max. 15 MB).' : 'Da ist etwas schiefgelaufen.';
    if (req.path.startsWith('/api/')) return res.status(tooBig ? 413 : 500).json({ error: text });
    res.status(tooBig ? 413 : 500).send(views.messagePage({ user: req.user, title: 'Fehler', text }));
  });

  app.locals.db = db;
  app.locals.formatCents = formatCents;
  return app;
}
