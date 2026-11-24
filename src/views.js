import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCents } from './money.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const versions = new Map();
/** "/static/x.js" → "/static/x.js?v=<content hash>", so browsers fetch the new file after an update. */
function asset(url) {
  if (!versions.has(url)) {
    let v = 'dev';
    try {
      v = crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC_DIR, url.replace('/static/', '')))).digest('hex').slice(0, 10);
    } catch { /* missing file: leave unversioned */ }
    versions.set(url, v);
  }
  return `${url}?v=${versions.get(url)}`;
}

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) => ENT[c]);
}
/** Tagged template that escapes every interpolated value unless it is itself html``. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += esc(v) + strings[i + 1]; });
  return new Safe(out);
}

export function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
const money = (c) => formatCents(c);

function due(iso, paid) {
  if (paid) return html`<span class="muted">bezahlt</span>`;
  const t = today();
  if (iso < t) return html`<span class="overdue">fällig seit ${fmtDate(iso)}</span>`;
  if (iso === t) return html`<span class="overdue">heute fällig</span>`;
  return html`<span class="muted">bis ${fmtDate(iso)}</span>`;
}

export function layout({ title, user, flash, body, scripts = [] }) {
  const nav = user ? html`
    <nav>
      <a href="/" class="brand"><span class="logo">€</span><span class="brand-text">PayUpBuddy</span></a>
      <span class="spacer"></span>
      <a href="/bills/new" class="btn small">+ Rechnung</a>
      ${user.is_admin ? html`<a href="/users">Benutzer</a>` : ''}
      <a href="/account">Konto</a>
    </nav>` : '';
  return `<!doctype html>${html`
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title ? `${title} · ` : ''}PayUpBuddy</title>
  <link rel="stylesheet" href="${asset('/static/style.css')}">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230f766e'/%3E%3Ctext x='16' y='22' font-size='16' text-anchor='middle' fill='white' font-family='sans-serif'%3E€%3C/text%3E%3C/svg%3E">
</head>
<body>
  ${nav}
  <main>
    ${flash ? html`<p class="flash ${flash.type}">${flash.text}</p>` : ''}
    ${body}
  </main>
  ${['/static/app.js', ...scripts].map((s) => html`<script src="${asset(s)}" defer></script>`)}
</body>
</html>`}`;
}

export function loginPage({ error, username }) {
  return layout({
    title: 'Anmelden',
    body: html`
      <form method="post" action="/login" class="card narrow">
        <h1>PayUpBuddy</h1>
        <p class="muted">Bitte melde dich an.</p>
        ${error ? html`<p class="flash error">${error}</p>` : ''}
        <label>Benutzername <input name="username" value="${username}" autocomplete="username" autocapitalize="none" required autofocus></label>
        <label>Passwort <input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Anmelden</button>
      </form>`,
  });
}

/**
 * people: [{ id, name, net, items: [{ shareId, billId, title, cents, due_date, iOwe }] }]
 */
export function dashboardPage({ user, flash, totals, people, bills }) {
  const personBlock = (p) => html`
    <details class="person">
      <summary>
        <span>${p.name}</span>
        <span class="${p.net >= 0 ? 'plus' : 'minus'}">
          ${p.net >= 0 ? 'schuldet dir ' : 'du schuldest '}${money(Math.abs(p.net))}
        </span>
      </summary>
      <ul class="items">
        ${p.items.map((it) => html`
          <li>
            <a href="/bills/${it.billId}">${it.title}</a>
            <span class="${it.iOwe ? 'minus' : 'plus'}">${it.iOwe ? '−' : '+'}${money(it.cents)}</span>
            ${due(it.due_date, false)}
            ${it.iOwe ? '' : html`
              <form method="post" action="/shares/${it.shareId}/paid" class="inline">
                <input type="hidden" name="back" value="/">
                <button class="small ghost" title="Als bezahlt markieren">Erhalten ✓</button>
              </form>`}
          </li>`)}
      </ul>
      ${p.items.some((it) => !it.iOwe) ? html`
        <form method="post" action="/people/${p.id}/settle" class="inline">
          <button class="small ghost">Alles von ${p.name} erhalten</button>
        </form>` : ''}
    </details>`;

  return layout({
    title: 'Übersicht',
    user,
    flash,
    body: html`
      <section class="totals">
        <div><small>Du schuldest</small><strong class="${totals.owe ? 'minus' : 'muted'}">${money(totals.owe)}</strong></div>
        <div><small>Dir wird geschuldet</small><strong class="${totals.owed ? 'plus' : 'muted'}">${money(totals.owed)}</strong></div>
      </section>

      <h2>Offen</h2>
      ${people.length ? people.map(personBlock) : html`<p class="muted">Alles beglichen. 🎉</p>`}

      <h2>Rechnungen</h2>
      ${bills.length ? html`
        <ul class="list">
          ${bills.map((b) => html`
            <li>
              <a href="/bills/${b.id}">
                <span>${b.title}<br><small class="muted">${b.payer_name} · ${fmtDate(b.created_at)}</small></span>
                <span class="right">${money(b.total)}<br><small class="${b.open ? 'overdue-soft' : 'muted'}">${b.open ? 'offen' : 'erledigt'}</small></span>
              </a>
            </li>`)}
        </ul>` : html`<p class="muted">Noch keine Rechnungen. <a href="/bills/new">Erste Rechnung hochladen</a></p>`}`,
  });
}

export function newBillPage({ user, flash, users, values = {} }) {
  const people = [
    { id: user.id, name: `Ich (${user.name})`, short: 'Ich' },
    ...users.filter((u) => u.id !== user.id).map((u) => ({ id: u.id, name: u.name, short: u.name })),
  ];
  // Person picker: one or more people per item; several people share the amount equally.
  const who = (attrs = '') => html`
    <details class="who" ${attrs}>
      <summary>Wer?</summary>
      <div class="who-menu">
        ${people.map((p) => html`<label><input type="checkbox" value="${p.id}" data-name="${p.short}"> ${p.name}</label>`)}
      </div>
    </details>`;
  return layout({
    title: 'Neue Rechnung',
    user,
    flash,
    scripts: ['/static/bill-form.js'],
    body: html`
      <h1>Neue Rechnung</h1>
      <form method="post" action="/bills" enctype="multipart/form-data" id="bill-form" class="stack">
        <label class="drop" id="drop">
          <input type="file" name="image" accept="image/*" id="image">
          <img id="preview" alt="" hidden>
          <span id="drop-text">📷 Foto der Rechnung wählen</span>
        </label>
        <p id="ocr-status" class="muted" hidden></p>

        <div class="row2">
          <label>Titel <input name="title" value="${values.title}" placeholder="z. B. Einkauf, Pizza-Abend" required maxlength="80"></label>
          <label>Zahlen bis <input name="due_date" type="date" value="${values.due_date || addDays(today(), 14)}" required></label>
        </div>

        <div>
          <div class="items-head">
            <strong>Posten</strong>
            <div class="inline-label">Alle an ${who(html`id="assign-all"`)}</div>
          </div>
          <div id="rows"></div>
          <button type="button" class="ghost small" id="add-row">+ Posten</button>
        </div>

        <div class="summary" id="summary"></div>

        <template id="row-tpl">
          <div class="item-row">
            <input class="label" placeholder="Beschreibung" maxlength="80">
            <input class="amount" inputmode="decimal" placeholder="0,00" required>
            ${who()}
            <button type="button" class="ghost small remove" title="Entfernen" aria-label="Entfernen">×</button>
          </div>
        </template>

        <input type="hidden" name="items" id="items-json">
        <button type="submit">Speichern</button>
      </form>`,
  });
}

export function billPage({ user, flash, bill, shares }) {
  const isPayer = bill.payer_id === user.id;
  const total = shares.reduce((s, x) => s + x.amount_cents, 0);
  return layout({
    title: bill.title,
    user,
    flash,
    body: html`
      <a href="/" class="muted">← Übersicht</a>
      <h1>${bill.title}</h1>
      <p class="muted">Bezahlt von ${bill.payer_name} am ${fmtDate(bill.created_at)} · zahlen bis ${fmtDate(bill.due_date)}</p>
      ${bill.image ? html`<a href="/bills/${bill.id}/image" target="_blank"><img class="receipt" src="/bills/${bill.id}/image" alt="Rechnung"></a>` : ''}
      <ul class="list shares">
        ${shares.map((s) => {
          const own = s.user_id === bill.payer_id;
          return html`
          <li>
            <span>${s.user_name}${s.label ? html`<br><small class="muted">${s.label}</small>` : ''}</span>
            <span class="right">${money(s.amount_cents)}<br>
              <small>${own ? html`<span class="muted">eigener Anteil</span>` : due(bill.due_date, s.paid_at)}</small>
            </span>
            ${isPayer && !own ? html`
              <form method="post" action="/shares/${s.id}/${s.paid_at ? 'unpaid' : 'paid'}" class="inline">
                <input type="hidden" name="back" value="/bills/${bill.id}">
                <button class="small ghost">${s.paid_at ? 'Rückgängig' : 'Erhalten ✓'}</button>
              </form>` : ''}
          </li>`;
        })}
        <li class="total"><span>Gesamt</span><span class="right">${money(total)}</span></li>
      </ul>
      ${isPayer || user.is_admin ? html`
        <form method="post" action="/bills/${bill.id}/delete" data-confirm="Rechnung wirklich löschen?">
          <button class="ghost danger small">Rechnung löschen</button>
        </form>` : ''}`,
  });
}

export function usersPage({ user, flash, users }) {
  return layout({
    title: 'Benutzer',
    user,
    flash,
    body: html`
      <h1>Benutzer</h1>
      <ul class="list">
        ${users.map((u) => html`
          <li>
            <span>${u.name}${u.is_admin ? html` <small class="badge">Admin</small>` : ''}<br><small class="muted">${u.username}</small></span>
            <span class="actions">
              <form method="post" action="/users/${u.id}/reset" class="inline" data-confirm="Neues Passwort für ${u.name} erzeugen?">
                <button class="small ghost">Passwort neu</button>
              </form>
              ${u.id !== user.id && !u.in_use ? html`
                <form method="post" action="/users/${u.id}/delete" class="inline" data-confirm="${u.name} löschen?">
                  <button class="small ghost danger">Löschen</button>
                </form>` : ''}
            </span>
          </li>`)}
      </ul>

      <h2>Neuer Benutzer</h2>
      <form method="post" action="/users" class="card stack">
        <div class="row2">
          <label>Name <input name="name" required maxlength="40" placeholder="Anna"></label>
          <label>Benutzername <input name="username" required maxlength="40" pattern="[A-Za-z0-9._\\-]+" autocapitalize="none" placeholder="anna"></label>
        </div>
        <label>Passwort <input name="password" minlength="8" placeholder="leer lassen = automatisch erzeugen" autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" name="is_admin" value="1"> Admin</label>
        <button type="submit">Anlegen</button>
      </form>`,
  });
}

export function accountPage({ user, flash }) {
  return layout({
    title: 'Konto',
    user,
    flash,
    body: html`
      <h1>${user.name}</h1>
      <p class="muted">Angemeldet als ${user.username}</p>
      <form method="post" action="/account/password" class="card stack">
        <h2>Passwort ändern</h2>
        <label>Aktuelles Passwort <input name="current" type="password" required autocomplete="current-password"></label>
        <label>Neues Passwort <input name="next" type="password" minlength="8" required autocomplete="new-password"></label>
        <button type="submit">Speichern</button>
      </form>
      <form method="post" action="/logout">
        <button class="ghost">Abmelden</button>
      </form>`,
  });
}

export function messagePage({ user, title, text }) {
  return layout({ title, user, body: html`<h1>${title}</h1><p>${text}</p><p><a href="/">Zur Übersicht</a></p>` });
}
