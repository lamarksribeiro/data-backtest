import { Worker } from 'node:worker_threads';

import {
  completeBacktestRun,
  createQueuedBacktestRun,
  failBacktestRun,
  getBacktestRun,
  listQueuedBacktestRuns,
  markBacktestRunRunning,
  updateBacktestRunProgress,
} from '../state/backtestRuns.js';

export function createBacktestQueue({ config, db, onEvent }) {
  const maxConcurrent = config.maxConcurrentBacktests ?? 1;
  const activeWorkers = new Map();
  const pendingRequests = new Map();
  let draining = false;

  function emit(type, payload) {
    onEvent?.({ type, ...payload });
  }

  function enqueue({ request, strategyMeta, totalTicks, startedAt }) {
    const run = createQueuedBacktestRun(db, { request, strategyMeta, totalTicks });
    pendingRequests.set(run.id, request);
    const position = listQueuedBacktestRuns(db).findIndex((r) => r.id === run.id) + 1;
    emit('run:queued', { runId: run.id, queuePosition: position });
    drain();
    const latest = getBacktestRun(db, run.id, { includeResult: false, includeEquity: false }) || run;
    return { ...latest, queuePosition: position };
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (activeWorkers.size < maxConcurrent) {
        const queued = listQueuedBacktestRuns(db)[0];
        if (!queued) break;
        startWorker(queued);
      }
    } finally {
      draining = false;
    }
  }

  function startWorker(run) {
    const startedAt = Date.now();
    const request = pendingRequests.get(run.id) || JSON.parse(run.dataset_request_json || '{}');
    pendingRequests.delete(run.id);
    const running = markBacktestRunRunning(db, run.id);
    if (!running) return;

    emit('run:progress', { runId: run.id, progress: running.progress });

    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: {
        stateDbPath: config.stateDbPath,
        runId: run.id,
        request: {
          ...request,
          strategyMeta: run.strategy_snapshot_json ? JSON.parse(run.strategy_snapshot_json) : null,
        },
        startedAt,
        fastRun: Boolean(request.fastRun),
      },
    });

    activeWorkers.set(run.id, worker);

    worker.on('message', (msg) => {
      if (msg?.type === 'progress') {
        updateBacktestRunProgress(db, run.id, msg.progress);
        emit('run:progress', { runId: run.id, progress: msg.progress });
        return;
      }
      if (msg?.ok === true) {
        const completed = getBacktestRun(db, run.id);
        emit('run:completed', { runId: run.id, run: completed });
        return;
      }
      if (msg?.ok === false) {
        const failed = getBacktestRun(db, run.id);
        emit('run:failed', { runId: run.id, run: failed, error: msg.error });
      }
    });

    worker.on('error', (err) => {
      handleFailure(run.id, request, startedAt, err.message);
    });

    worker.on('exit', (code) => {
      activeWorkers.delete(run.id);
      if (code !== 0 && getBacktestRun(db, run.id)?.status === 'running') {
        handleFailure(run.id, request, startedAt, `Worker exited with code ${code}`);
      }
      queueMicrotask(() => drain());
    });

    worker.unref();
  }

  function handleFailure(runId, request, startedAt, error) {
    const failedResult = {
      strategy: request.strategyLabel || request.strategy,
      source: 'lakehouse',
      underlying: request.underlying,
      interval: request.interval,
      bookDepth: request.bookDepth,
      from: new Date(request.from).toISOString(),
      to: new Date(request.to).toISOString(),
      ticks: 0,
      batches: 0,
      summary: { failed: true, error },
      events: [],
      equity: [],
      log: [],
    };
    const run = failBacktestRun(db, runId, {
      request,
      result: failedResult,
      strategyMeta: request.strategyMeta ?? null,
      error,
      startedAt,
    });
    emit('run:failed', { runId, run, error });
  }

  function onWorkerComplete(runId, request, startedAt) {
    const run = getBacktestRun(db, runId);
    emit(run?.status === 'completed' ? 'run:completed' : 'run:failed', { runId, run });
  }

  function cancel(runId) {
    const worker = activeWorkers.get(runId);
    if (worker) {
      worker.terminate();
      activeWorkers.delete(runId);
    }
  }

  function activeCount() {
    return activeWorkers.size;
  }

  return { enqueue, drain, cancel, activeCount, onWorkerComplete };
}
