import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { openDatabase } from '../database.ts';
import { BlobStore } from '../storage/blobs.ts';
import { PreviewWorker } from './preview-worker.ts';

// Explicit paths only: no legacy database discovery or production activation.
const args = process.argv.slice(2);
if (![2,4].includes(args.length) || !args.slice(0,2).every(isAbsolute) || (args.length === 4 && (args[2] !== '--office-root' || !isAbsolute(args[3])))) {
  console.error('Usage: npm run worker -- /absolute/new-yourwiki-v2.sqlite3 /absolute/private-storage [--office-root /absolute/libreoffice]');
  process.exitCode = 1;
} else {
  try {
    if (!(await stat(args[0])).isFile() || !(await stat(args[1])).isDirectory()) throw new Error('Missing initialized workspace');
    const db = openDatabase(args[0]);
    try {
      const store = await BlobStore.open(args[1]);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        console.info('Yourwiki preview worker started (one conversion slot).');
        await new PreviewWorker(db, store, { office: args[3] ? { officeRoot: args[3] } : undefined }).run(controller.signal);
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    } finally { db.close(); }
  } catch {
    console.error('Preview worker stopped: workspace initialization or worker execution failed.');
    process.exitCode = 1;
  }
}
