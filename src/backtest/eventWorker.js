import { parentPort, workerData } from 'node:worker_threads';

import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { wrapSharedColumnSet } from './columnStore.js';

try {
  const columnSet = wrapSharedColumnSet(workerData.sharedColumnSet);
  const runner = createGlsBacktestRunner(workerData.ast, workerData.params ?? {}, {
    executionMode: 'compiled-soa',
    fastRun: Boolean(workerData.fastRun),
    bookDepth: workerData.bookDepth ?? 25,
    limits: workerData.limits,
  });
  runner.bindColumnSet(columnSet);

  let ticksProcessed = 0;
  for (const eventIndex of workerData.eventIndices) {
    const ev = columnSet.events[eventIndex];
    if (!ev) continue;
    ticksProcessed += ev.endRow - ev.startRow;
    runner.beginEvent(ev);
    for (let i = ev.startRow; i < ev.endRow; i += 1) {
      runner.processIndex(i);
    }
    runner.endEvent(ev);
  }

  const result = runner.finish();
  parentPort?.postMessage({
    ok: true,
    eventIndexOffset: workerData.eventIndexOffset,
    result,
    ticksProcessed,
  });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err.message, stack: err.stack });
}
