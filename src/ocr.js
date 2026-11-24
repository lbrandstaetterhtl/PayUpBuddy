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

/** Reads a receipt image and returns { text, items, totalCents }. Calls are serialized. */
export function recognizeReceipt(buffer) {
  const run = queue.then(async () => {
    const [worker, input] = await Promise.all([getWorker(), prepare(buffer)]);
    const { data } = await worker.recognize(input);
    return { text: data.text, ...parseReceipt(data.text) };
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
