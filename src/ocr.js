import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { parseReceipt } from './receipt.js';

const require = createRequire(import.meta.url);
// German language data ships with the npm package, so OCR works fully offline.
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/deu/package.json')), '4.0.0_best_int');

// Tesseract reads best when a line of text is roughly this many pixels high.
const TARGET_WORD_HEIGHT = 36;
const MAX_SIDE = 4000;
// Page segmentation modes: 3 = automatic layout (paper receipts), 4 = single column and
// 6 = uniform block (both keep prices next to their item in app screenshots with product images).
const PSM_PASSES = ['3', '4', '6'];
const AMOUNTISH = /\d[.,]\d{2}/;

let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
  workerPromise ??= createWorker('deu', 1, { langPath: LANG_PATH, cacheMethod: 'none' })
    .then(async (worker) => {
      await worker.setParameters({ preserve_interword_spaces: '1' });
      return worker;
    })
    .catch((err) => { workerPromise = null; throw err; });
  return workerPromise;
}

/** Grayscale, normalized image with dark text on light background, scaled to `width`. */
async function prepare(buffer, width) {
  const stats = await sharp(buffer, { failOn: 'none' }).grayscale().stats();
  let img = sharp(buffer, { failOn: 'none' }).rotate().resize({ width: Math.round(width) }).grayscale();
  // Tesseract expects dark text on a light background: invert dark-mode screenshots.
  if (stats.channels[0].mean < 110) img = img.negate({ alpha: false });
  return img.normalize().sharpen().png().toBuffer();
}

function collectWords(blocks) {
  const words = [];
  for (const b of blocks || []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        for (const w of l.words) {
          const text = w.text.trim();
          if (text) words.push({ text, conf: w.confidence, ...w.bbox });
        }
      }
    }
  }
  return words;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Typical height of confidently read words, used to normalize the text size. */
function wordHeight(words) {
  return median(words.filter((w) => w.conf > 60 && /\p{L}{2}|\d/u.test(w.text)).map((w) => w.y1 - w.y0));
}

/**
 * Rebuilds text lines from word positions, independent of Tesseract's own block layout.
 * A price in a right-hand column ends up on the same line as the item to its left.
 * Low-confidence words without digits (usually noise from product photos) are dropped.
 */
export function rebuildLines(words) {
  const kept = words.filter((w) => w.conf >= 45 || AMOUNTISH.test(w.text));
  const h = wordHeight(kept) || median(kept.map((w) => w.y1 - w.y0)) || 1;
  const rows = [];
  for (const w of [...kept].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const yc = (w.y0 + w.y1) / 2;
    const row = rows.find((r) => Math.abs(r.yc - yc) <= h * 0.45);
    if (row) {
      row.words.push(w);
      row.yc = (row.yc * (row.words.length - 1) + yc) / row.words.length;
    } else {
      rows.push({ yc, words: [w] });
    }
  }
  return rows
    .sort((a, b) => a.yc - b.yc)
    .map((r) => r.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' '))
    .join('\n');
}

/** Higher is better: items that add up to the printed total win, otherwise more items and a smaller gap. */
export function score({ items, totalCents }) {
  const sum = items.reduce((a, i) => a + i.cents, 0);
  if (items.length && totalCents !== null && sum === totalCents) return 1e6 + items.length;
  const gap = totalCents === null ? 0 : Math.abs(totalCents - sum) / Math.max(totalCents, 1);
  return items.length * 10 + (totalCents !== null ? 5 : 0) - gap * 10;
}

/** Reads a receipt image and returns { text, items, totalCents }. Calls are serialized. */
export function recognizeReceipt(buffer) {
  const run = queue.then(async () => {
    const worker = await getWorker();
    const meta = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
    const srcWidth = meta.autoOrient?.width ?? meta.width ?? 1600;
    const srcHeight = meta.autoOrient?.height ?? meta.height ?? 1600;
    const limit = MAX_SIDE / Math.max(srcWidth, srcHeight);

    let best = null;
    const consider = (text) => {
      const result = { text, ...parseReceipt(text) };
      result.score = score(result);
      if (!best || result.score > best.score) best = result;
      return best.score >= 1e6; // items match the total: good enough
    };

    let scale = Math.min(srcWidth < 1200 ? 1600 / srcWidth : 1, limit);
    let input = await prepare(buffer, srcWidth * scale);
    let rescaled = false;
    for (const psm of PSM_PASSES) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(input, {}, { text: true, blocks: true });
      const words = collectWords(data.blocks);
      if (consider(data.text) || consider(rebuildLines(words))) break;

      // After the first pass we know how big the text is: rescale once so it has the ideal height.
      const h = wordHeight(words);
      if (!rescaled && h && (h < TARGET_WORD_HEIGHT * 0.75 || h > TARGET_WORD_HEIGHT * 1.4)) {
        rescaled = true;
        scale = Math.min(scale * (TARGET_WORD_HEIGHT / h), limit);
        input = await prepare(buffer, srcWidth * scale);
        const again = await worker.recognize(input, {}, { text: true, blocks: true });
        if (consider(again.data.text) || consider(rebuildLines(collectWords(again.data.blocks)))) break;
      }
    }
    const { score: _, ...result } = best;
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  await worker?.terminate();
}
