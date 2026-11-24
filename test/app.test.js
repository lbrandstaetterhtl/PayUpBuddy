import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';

let server, base, dataDir, app;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-test-'));
  const ocr = async () => ({ items: [{ label: 'Pizza', cents: 950 }], totalCents: 950 });
  app = createApp({ dataDir, ocr, adminPassword: 'adminpass123', log: () => {} });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); app.locals.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function login(username, password) {
  const res = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, cookie };
}
const client = (cookie) => (url, opts = {}) => fetch(`${base}${url}`, {
  redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) },
});
const form = (obj) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj) });

test('full flow: admin creates users, bill is split, debtor sees debt, payer confirms', async () => {
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await login('admin', 'wrong')).status, 401);
  const admin = client((await login('admin', 'adminpass123')).cookie);

  // There is no registration: user management is admin-only.
  await admin('/users', form({ name: 'Anna', username: 'anna', password: 'annapass1' }));
  await admin('/users', form({ name: 'Ben', username: 'ben', password: 'benpass12' }));
  const anna = client((await login('anna', 'annapass1')).cookie);
  const ben = client((await login('ben', 'benpass12')).cookie);
  assert.equal((await anna('/users')).status, 403);
  assert.equal((await anna('/users', form({ name: 'X', username: 'x' }))).status, 403);

  const ids = Object.fromEntries(app.locals.db.prepare('SELECT username, id FROM users').all().map((u) => [u.username, u.id]));

  // OCR endpoint
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
  const ocrBody = new FormData();
  ocrBody.append('image', new Blob([png], { type: 'image/png' }), 'r.png');
  const ocrRes = await anna('/api/ocr', { method: 'POST', body: ocrBody });
  assert.deepEqual(await ocrRes.json(), { items: [{ label: 'Pizza', amount: '9,50' }], total: '9,50' });

  // Anna paid, Ben owes two items, Anna keeps one.
  const body = new FormData();
  body.append('title', 'Pizza-Abend');
  body.append('due_date', '2026-12-01');
  body.append('image', new Blob([png], { type: 'image/png' }), 'r.png');
  body.append('items', JSON.stringify([
    { label: 'Pizza', amount: '9,50', user: ids.ben },
    { label: 'Cola', amount: '3,50', user: ids.ben },
    { label: 'Salat', amount: '7', user: ids.anna },
  ]));
  const created = await anna('/bills', { method: 'POST', body });
  assert.equal(created.status, 302);
  const billUrl = created.headers.get('location');

  const shares = app.locals.db.prepare('SELECT user_id, amount_cents, label FROM shares ORDER BY user_id').all();
  assert.deepEqual(shares.map((s) => ({ ...s })), [
    { user_id: ids.anna, amount_cents: 700, label: 'Salat' },
    { user_id: ids.ben, amount_cents: 1300, label: 'Pizza, Cola' },
  ]);

  const benHome = await (await ben('/')).text();
  assert.match(benHome, /du schuldest 13,00/);
  assert.equal((await ben(`${billUrl}/image`)).status, 200);

  // Admin is not part of the bill but may view; an outsider without admin rights may not.
  await admin('/users', form({ name: 'Cleo', username: 'cleo', password: 'cleopass1' }));
  const cleo = client((await login('cleo', 'cleopass1')).cookie);
  assert.equal((await cleo(billUrl)).status, 404);
  assert.equal((await cleo(`${billUrl}/image`)).status, 404);

  // Only the payer can confirm a payment.
  const shareId = app.locals.db.prepare('SELECT id FROM shares WHERE user_id = ?').get(ids.ben).id;
  assert.equal((await ben(`/shares/${shareId}/paid`, form({}))).status, 404);
  assert.equal((await anna(`/shares/${shareId}/paid`, form({ back: billUrl }))).headers.get('location'), billUrl);
  assert.doesNotMatch(await (await ben('/')).text(), /du schuldest 13,00/);

  // Users with history can't be deleted.
  await admin(`/users/${ids.ben}/delete`, form({}));
  assert.ok(app.locals.db.prepare('SELECT 1 FROM users WHERE id = ?').get(ids.ben));
});

test('an item shared by several people is split equally', async () => {
  const anna = client((await login('anna', 'annapass1')).cookie);
  const ids = Object.fromEntries(app.locals.db.prepare('SELECT username, id FROM users').all().map((u) => [u.username, u.id]));
  const body = new FormData();
  body.append('title', 'Taxi');
  body.append('due_date', '2026-12-01');
  body.append('items', JSON.stringify([
    { label: 'Taxi', amount: '10,00', users: [ids.anna, ids.ben, ids.cleo] },
    { label: 'Snack', amount: '2,00', users: [ids.ben] },
  ]));
  const res = await anna('/bills', { method: 'POST', body });
  assert.equal(res.status, 302);
  const billId = Number(res.headers.get('location').split('/').pop());
  const shares = app.locals.db.prepare('SELECT user_id, amount_cents, label FROM shares WHERE bill_id = ? ORDER BY user_id').all(billId);
  assert.deepEqual(shares.map((s) => ({ ...s })), [
    { user_id: ids.anna, amount_cents: 334, label: 'Taxi (1/3)' },
    { user_id: ids.ben, amount_cents: 533, label: 'Taxi (1/3), Snack' },
    { user_id: ids.cleo, amount_cents: 333, label: 'Taxi (1/3)' },
  ]);

  const empty = new FormData();
  empty.append('title', 'Leer');
  empty.append('due_date', '2026-12-01');
  empty.append('items', JSON.stringify([{ label: 'x', amount: '5', users: [] }]));
  const bad = await anna('/bills', { method: 'POST', body: empty });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /mindestens eine Person/);
});

test('bill validation and CSRF protection', async () => {
  const anna = client((await login('anna', 'annapass1')).cookie);
  const me = app.locals.db.prepare("SELECT id FROM users WHERE username = 'anna'").get().id;
  const body = new FormData();
  body.append('title', 'Nur ich');
  body.append('due_date', '2026-12-01');
  body.append('items', JSON.stringify([{ label: 'x', amount: '5', user: me }]));
  const res = await anna('/bills', { method: 'POST', body });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /jemand anderem/);

  const evil = await anna('/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('static assets are versioned by content hash', async () => {
  const anna = client((await login('anna', 'annapass1')).cookie);
  const page = await (await anna('/bills/new')).text();
  const m = page.match(/\/static\/bill-form\.js\?v=([0-9a-f]{10})/);
  assert.ok(m, 'bill-form.js has a version');
  assert.match(page, /\/static\/style\.css\?v=[0-9a-f]{10}/);
  const res = await fetch(`${base}/static/bill-form.js?v=${m[1]}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /immutable/);
});
