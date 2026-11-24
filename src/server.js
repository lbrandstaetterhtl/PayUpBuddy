import path from 'node:path';
import { createApp } from './app.js';
import { recognizeReceipt, shutdownOcr } from './ocr.js';

const port = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.DATA_DIR || 'data');

const app = createApp({ dataDir, ocr: recognizeReceipt, adminPassword: process.env.ADMIN_PASSWORD });
const server = app.listen(port, () => console.log(`PayUpBuddy läuft auf http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await shutdownOcr();
    app.locals.db.close();
    process.exit(0);
  });
}
