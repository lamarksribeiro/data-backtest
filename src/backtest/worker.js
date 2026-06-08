import { parentPort, workerData } from 'node:worker_threads';

import { runBacktest } from './engine.js';
import { openStateDatabase, closeStateDatabase } from '../state/sqlite.js';
import { completeBacktestRun, failBacktestRun, updateBacktestRunProgress } from '../state/backtestRuns.js';

const db = openStateDatabase(workerData.stateDbPath);

try {
  const result = await runBacktest(db, workerData.request, {
    onProgress: (progress) => updateBacktestRunProgress(db, workerData.runId, progress),
  });
  const run = completeBacktestRun(db, workerData.runId, {
    request: workerData.request,
    result,
    strategyMeta: workerData.request.strategyMeta ?? null,
    startedAt: workerData.startedAt,
  });
  parentPort?.postMessage({ ok: true, runId: run.id });
} catch (err) {
  const failedResult = err.partialResult || {
    strategy: workerData.request.strategyLabel || workerData.request.strategy,
    source: 'lakehouse',
    underlying: workerData.request.underlying,
    interval: workerData.request.interval,
    bookDepth: workerData.request.bookDepth,
    from: new Date(workerData.request.from).toISOString(),
    to: new Date(workerData.request.to).toISOString(),
    ticks: 0,
    batches: 0,
    summary: { failed: true, error: err.message },
    events: [],
    equity: [],
    log: [],
  };
  failBacktestRun(db, workerData.runId, {
    request: workerData.request,
    result: failedResult,
    strategyMeta: workerData.request.strategyMeta ?? null,
    error: err.message,
    startedAt: workerData.startedAt,
  });
  parentPort?.postMessage({ ok: false, runId: workerData.runId, error: err.message });
} finally {
  closeStateDatabase(db);
}
