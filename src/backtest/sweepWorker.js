import { parentPort, workerData } from 'node:worker_threads';

import { runBacktestSweep } from './sweep.js';
import { closeStateDatabase, openStateDatabase } from '../state/sqlite.js';

const db = openStateDatabase(workerData.stateDbPath);

try {
  const sweep = await runBacktestSweep(db, workerData.request, workerData.variants);
  parentPort?.postMessage({ ok: true, sweep });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err?.message || String(err) });
} finally {
  closeStateDatabase(db);
}
