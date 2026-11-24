/**
 * Parses a user- or OCR-supplied amount into integer cents.
 * Accepts "12,50", "12.50", "1.234,56", "1,234.56", "12" and "12,5".
 * Returns null for anything that is not a positive amount.
 */
export function parseCents(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = String(input ?? '').trim().replace(/[€\s]/g, '').replace(/EUR$/i, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const negative = s.startsWith('-');
  s = s.replace(/^-/, '');
  const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let intPart = s;
  let fracPart = '';
  // A separator followed by 1-2 digits is the decimal separator; otherwise it groups thousands.
  if (lastSep >= 0 && s.length - lastSep - 1 <= 2) {
    intPart = s.slice(0, lastSep);
    fracPart = s.slice(lastSep + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (intPart === '' && fracPart === '') return null;
  const cents = Number(intPart || '0') * 100 + Number(fracPart.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

export function formatCents(cents) {
  return fmt.format((cents || 0) / 100);
}

/** "12,50" style without currency, for prefilling inputs. */
export function centsToInput(cents) {
  return ((cents || 0) / 100).toFixed(2).replace('.', ',');
}

/**
 * Splits an amount into n parts that add up exactly; the first parts get the leftover cents.
 * splitCents(1000, 3) → [334, 333, 333]
 */
export function splitCents(cents, n) {
  const base = Math.trunc(cents / n);
  let rest = cents - base * n;
  return Array.from({ length: n }, () => {
    const step = Math.sign(rest);
    rest -= step;
    return base + step;
  });
}
