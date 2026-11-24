(() => {
  const form = document.getElementById('bill-form');
  const rows = document.getElementById('rows');
  const tpl = document.getElementById('row-tpl');
  const fileInput = document.getElementById('image');
  const preview = document.getElementById('preview');
  const dropText = document.getElementById('drop-text');
  const status = document.getElementById('ocr-status');
  const summary = document.getElementById('summary');
  const assignAll = document.getElementById('assign-all');
  let recognizedTotal = null;

  const toCents = (v) => {
    let s = String(v || '').trim().replace(/[€\s]/g, '');
    if (!/^-?[\d.,]+$/.test(s)) return null;
    const neg = s.startsWith('-');
    s = s.replace('-', '');
    const i = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    let int = s, frac = '';
    if (i >= 0 && s.length - i - 1 <= 2) { int = s.slice(0, i); frac = s.slice(i + 1); }
    const c = Number(int.replace(/[.,]/g, '') || 0) * 100 + Number(frac.padEnd(2, '0') || 0);
    return neg ? -c : c;
  };
  const fmt = (c) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

  // Same rule as the server: equal parts, the first people get the leftover cents.
  const split = (cents, n) => {
    const base = Math.trunc(cents / n);
    let rest = cents - base * n;
    return Array.from({ length: n }, () => { const s = Math.sign(rest); rest -= s; return base + s; });
  };

  // ---------- person picker ----------
  const checked = (who) => [...who.querySelectorAll('input:checked')];
  const selectedIds = (who) => checked(who).map((i) => i.value);
  function setSelected(who, ids) {
    who.querySelectorAll('input').forEach((i) => { i.checked = ids.includes(i.value); });
    refreshLabel(who);
  }
  function refreshLabel(who) {
    const names = checked(who).map((i) => i.dataset.name);
    const summaryEl = who.querySelector('summary');
    const short = names.length > 2 ? `${names[0]} + ${names.length - 1}` : names.join(' + ');
    summaryEl.textContent = names.length ? short : (who === assignAll ? '–' : 'Wer?');
    summaryEl.title = names.join(' + ');
    who.classList.toggle('empty', !names.length);
    who.classList.remove('missing');
  }
  // Only one picker open at a time; clicking elsewhere closes it.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.who[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });

  // ---------- rows ----------
  function addRow({ label = '', amount = '' } = {}) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.querySelector('.label').value = label;
    row.querySelector('.amount').value = amount;
    setSelected(row.querySelector('.who'), selectedIds(assignAll));
    rows.append(row);
    return row;
  }

  function update() {
    const per = new Map(); // name -> cents
    let sum = 0;
    for (const row of rows.children) {
      const amountEl = row.querySelector('.amount');
      const c = toCents(amountEl.value);
      amountEl.classList.toggle('invalid', amountEl.value !== '' && (c === null || c === 0));
      if (!c) continue;
      sum += c;
      const names = checked(row.querySelector('.who')).map((i) => i.dataset.name);
      if (!names.length) {
        per.set('nicht zugeordnet', (per.get('nicht zugeordnet') || 0) + c);
        continue;
      }
      split(c, names.length).forEach((part, k) => per.set(names[k], (per.get(names[k]) || 0) + part));
    }
    summary.replaceChildren();
    const total = document.createElement('div');
    total.className = 'sum';
    total.textContent = `Summe ${fmt(sum)}`;
    if (recognizedTotal !== null && recognizedTotal !== sum) {
      const hint = document.createElement('small');
      hint.className = 'overdue';
      hint.textContent = ` · laut Rechnung ${fmt(recognizedTotal)}`;
      total.append(hint);
    }
    summary.append(total);
    for (const [name, c] of per) {
      const d = document.createElement('div');
      d.className = name === 'nicht zugeordnet' ? 'overdue' : 'muted';
      d.textContent = `${name}: ${fmt(c)}`;
      summary.append(d);
    }
  }

  // ---------- OCR ----------
  async function recognize(file) {
    status.hidden = false;
    status.className = 'muted';
    status.textContent = 'Beträge werden erkannt …';
    form.classList.add('busy');
    try {
      const body = new FormData();
      body.append('image', file);
      const res = await fetch('/api/ocr', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fehler');
      recognizedTotal = data.total ? toCents(data.total) : null;
      const hasInput = [...rows.children].some((r) => r.querySelector('.amount').value);
      if (!hasInput) rows.replaceChildren();
      if (data.items.length) {
        data.items.forEach((it) => addRow(it));
        status.textContent = `${data.items.length} Posten erkannt – bitte prüfen und zuordnen.`;
      } else if (data.total) {
        addRow({ label: 'Gesamt', amount: data.total });
        status.textContent = 'Nur der Gesamtbetrag wurde erkannt.';
      } else {
        if (!rows.children.length) addRow();
        status.textContent = 'Keine Beträge erkannt – bitte manuell eintragen.';
      }
    } catch (err) {
      status.className = 'overdue';
      status.textContent = `Automatisches Lesen fehlgeschlagen (${err.message}). Bitte Beträge manuell eintragen.`;
      if (!rows.children.length) addRow();
    } finally {
      form.classList.remove('busy');
      update();
    }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
    dropText.textContent = 'Anderes Foto wählen';
    recognize(file);
  });

  document.getElementById('add-row').addEventListener('click', () => { addRow().querySelector('.label').focus(); update(); });
  rows.addEventListener('click', (e) => {
    if (!e.target.classList.contains('remove')) return;
    e.target.closest('.item-row').remove();
    update();
  });
  rows.addEventListener('input', update);
  rows.addEventListener('change', (e) => {
    const who = e.target.closest('.who');
    if (who) refreshLabel(who);
    update();
  });
  assignAll.addEventListener('change', () => {
    refreshLabel(assignAll);
    const ids = selectedIds(assignAll);
    rows.querySelectorAll('.who').forEach((w) => setSelected(w, ids));
    update();
  });

  form.addEventListener('submit', (e) => {
    const fail = (text) => {
      e.preventDefault();
      status.hidden = false;
      status.className = 'overdue';
      status.textContent = text;
    };
    if (form.classList.contains('busy')) return fail('Bitte warten, die Beträge werden noch erkannt …');
    const filled = [...rows.children].filter((r) => r.querySelector('.amount').value.trim() !== '');
    if (!filled.length) return fail('Bitte mindestens einen Betrag eintragen.');
    const missing = filled.filter((r) => !selectedIds(r.querySelector('.who')).length);
    if (missing.length) {
      missing.forEach((r) => r.querySelector('.who').classList.add('missing'));
      missing[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      return fail('Bitte jedem Posten mindestens eine Person zuordnen.');
    }
    document.getElementById('items-json').value = JSON.stringify(filled.map((r) => ({
      label: r.querySelector('.label').value,
      amount: r.querySelector('.amount').value,
      users: selectedIds(r.querySelector('.who')),
    })));
  });

  refreshLabel(assignAll);
  addRow();
  update();
})();
