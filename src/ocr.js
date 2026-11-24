import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { parseReceipt } from './receipt.js';

const require = createRequire(import.meta.url);
// German language data ships with the npm package, so OCR works fully offline.
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/deu/package.json')), '4.0.0_best_int');

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

/** Grayscale, normalized, upscaled-if-small image tuned for receipt OCR. */
async function prepare(buffer) {
  const img = sharp(buffer, { failOn: 'none' }).rotate();
  const [{ width = 0 }, stats] = await Promise.all([img.metadata(), sharp(buffer, { failOn: 'none' }).grayscale().stats()]);
  const target = width < 1200 ? 1600 : Math.min(width, 2400);
  let out = img.resize({ width: target, withoutEnlargement: false }).grayscale();
  // Tesseract expects dark text on a light background: invert dark-mode screenshots.
  if (stats.channels[0].mean < 110) out = out.negate({ alpha: false });
  return out.normalize().sharpen().png().toBuffer();
}

// Page segmentation modes to try: 3 = automatic layout (best for paper receipts),
// 4 = single column (keeps prices next to their item in app screenshots with product images),
// 6 = single uniform block.
const PSM_PASSES = ['3', '4', '6'];

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
    const [worker, input] = await Promise.all([getWorker(), prepare(buffer)]);
    let best = null;
    for (const psm of PSM_PASSES) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(input);
      const result = { text: data.text, ...parseReceipt(data.text) };
      result.score = score(result);
      if (!best || result.score > best.score) best = result;
      if (best.score >= 1e6) break; // items match the total: good enough
    }
    return best;
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
