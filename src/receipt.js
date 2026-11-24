import { parseCents } from './money.js';

// Amount at the end of a line, with an optional currency before or after it and an optional tax code
// ("1,29 B", "9,50 €", "-0,25 A", "€12.00", "-€1.00", "EUR 5,31"; OCR sometimes reads € as < or «).
const AMOUNT_AT_END = /(?:^|\s)(?:(-)[€<«]|[€<«]|EUR)?\s?(-?\d{1,5}(?:[.,]\d{3})*[.,]\d{2})\s*(?:€|EUR)?\s*(?:[A-Z0-9*]{1,2})?\s*$/i;
const ANY_AMOUNT = /\d+[.,]\d{2}\b/g;

const TOTAL = /\b(summe|gesamt(?:betrag|summe)?|total|zu\s*zahlen|endbetrag|rechnungsbetrag|betrag)\b/i;
const SUBTOTAL = /\b(zwischensumme|zw\.?\s*summe|sub\s*-?\s*tot\w*)\b/i;
const IGNORE = new RegExp([
  'mwst', '\\bm\\.\\s*w\\.\\s*st', '\\bust\\b', 'steuer', '\\bnetto\\b', '\\bbrutto\\b',
  'r[üu]e?ckgeld', 'wechselgeld', 'gegeben', '\\bgeg\\.', '\\bbar\\b', 'ec[-\\s]?cash', 'girocard',
  'kartenzahlung', '\\bkarte\\b', '\\bvisa\\b', 'mastercard', 'maestro', 'kontaktlos',
  '\\bdatum\\b', 'uhrzeit', '\\bbeleg\\b', '\\bkasse\\b', 'bon[-\\s]?nr', 'terminal', '\\btse\\b', '\\bst\\.?-?nr', '\\btel\\b',
].join('|'), 'i');
const TAX_ROW = /^\s*[A-Z0-9]\s*[=:]?\s*\d{1,2}(?:[.,]\d+)?\s*%/i;
const QTY_DETAIL = /^\s*\d+(?:[.,]\d+)?\s*(?:stk\.?|st\.?|kg|x)?\s*[x×*]\s*-?\d/i;
const DATE = /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/;

function cleanLabel(text) {
  return text
    .replace(/[|_~=<>{}[\]]+/g, ' ')
    .replace(/\b(EUR|€)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})%]+$/gu, '')
    .replace(/^[[(]?\s*1\s*[xX×]\s*[\])]?\s+/, '') // "1x", "[1x]", "(1X)" quantity badges
    .replace(/^[^\p{L}\p{N}(]+/u, '')
    .replace(/^(?:[^\p{N}\s][^\p{L}\p{N}\s]?\s+)+(?=\p{L})/u, '') // stray OCR characters like "s " or "A, "
    .trim();
}

const letters = (s) => (s.match(/\p{L}/gu) || []).length;
// "- Small", "— Extra Käse": an option line printed under the item name.
const SUB_OPTION = /(^|\s)[-—–]\s/;

/**
 * Extracts line items and the receipt total from OCR text.
 * @returns {{ items: {label: string, cents: number}[], totalCents: number|null }}
 */
export function parseReceipt(text) {
  const items = [];
  let totalCents = null;
  let pendingLabel = null; // previous text line without an amount, e.g. an item name above its price

  for (const raw of String(text || '').split(/\r?\n/)) {
    // Repair OCR artifacts such as "1 ,29" or "1, 29".
    const line = raw
      .replace(/(\d)\s*([.,])\s*(\d{2})(?!\d)/g, '$1$2$3')
      // Noise glued to the currency sign, e.g. "<€45.18", "€<€45.18", "c€45.18", "€©0.69".
      .replace(/\S*€[^\d\s-]*(?=-?\d)/g, (m) => (/-€/.test(m) ? ' -€' : ' €'))
      .trim();
    if (!line) continue;

    const m = line.match(AMOUNT_AT_END);
    if (!m) {
      if (SUB_OPTION.test(line) && pendingLabel) continue; // keep the item name, skip its option line
      const text = cleanLabel(line);
      pendingLabel = letters(text) >= 2 && !IGNORE.test(line) && !TOTAL.test(line) ? text : null;
      continue;
    }
    const previous = pendingLabel;
    pendingLabel = null;
    const cents = parseCents((m[1] || '') + m[2]);
    if (cents === null || cents === 0) continue;
    let label = cleanLabel(line.slice(0, m.index));
    if (previous && (letters(label) < 2 || SUB_OPTION.test(line.slice(0, m.index)))) label = previous;

    if (SUBTOTAL.test(line)) continue;
    if (TOTAL.test(line)) {
      if (totalCents === null && cents > 0) totalCents = cents;
      continue;
    }
    if (IGNORE.test(line) || TAX_ROW.test(line) || QTY_DETAIL.test(line) || DATE.test(line)) continue;
    if ((line.match(ANY_AMOUNT) || []).length >= 3) continue; // tax tables
    if (letters(label) < 2) continue; // needs a readable description
    if (Math.abs(cents) > 100000_00) continue;

    items.push({ label: label.slice(0, 80), cents });
  }

  return { items, totalCents };
}
