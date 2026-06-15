import { Worker } from 'node:worker_threads';

import {
  clearRunJobDependency,
  completeBacktestRun,
  createQueuedBacktestRun,
  failBacktestRun,
  getBacktestRun,
  listBacktestRunsWaitingForJob,
  listQueuedBacktestRuns,
  markBacktestRunRunning,
  updateBacktestRunProgress,
} from '../state/backtestRuns.js';

export function createBacktestQueue({ config, db, onEvent }) {
  const maxConcurrent = config.maxConcurrentBacktests ?? 1;
  const activeWorkers = new Map();
  const pendingRequests = new Map();
  const terminalRuns = new Set();
  let draining = false;

  function emit(type, payload) {
    onEvent?.({ type, ...payload });
  }

  function enqueue({ request, strategyMeta, totalTicks, startedAt, dependsOnJob = null }) {
    const run = createQueuedBacktestRun(db, { request, strategyMeta, totalTicks, dependsOnJob });
    terminalRuns.delete(run.id);
    pendingRequests.set(run.id, request);
    const position = listQueuedBacktestRuns(db).findIndex((r) => r.id === run.id) + 1;
    emit('run:queued', { runId: run.id, queuePosition: position });
    drain();
    const latest = getBacktestRun(db, run.id, { includeResult: false, includeEquity: false }) || run;
    return { ...latest, queuePosition: position };
  }

  const waiters = new Map();

  function enqueueAndWait(params) {
    const run = enqueue(params);
    return new Promise((resolve, reject) => {
      waiters.set(run.id, { resolve, reject });
    });
  }

  function settleWaiter(runId, outcome) {
    const waiter = waiters.get(runId);
    if (!waiter) return;
    waiters.delete(runId);
    if (outcome.error) waiter.reject(outcome.error);
    else waiter.resolve(outcome.run);
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (activeWorkers.size < maxConcurrent) {
        const queued = listQueuedBacktestRuns(db).find((r) => !r.progress?.depends_on_job);
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
    const running = markBacktestRunRunning(db, run.id, { startedAt });
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
        if (terminalRuns.has(run.id)) return;
        const current = safeGetBacktestRun(db, run.id);
        if (!current || current.status !== 'running') {
          if (current && !['running', 'queued'].includes(current.status)) terminalRuns.add(run.id);
          return;
        }
        if (!safeUpdateBacktestRunProgress(db, run.id, msg.progress)) return;
        emit('run:progress', { runId: run.id, progress: msg.progress });
        return;
      }
      if (msg?.ok === true) {
        terminalRuns.add(run.id);
        const completed = safeGetBacktestRun(db, run.id);
        if (!completed) return;
        emit('run:completed', { runId: run.id, run: completed });
        return;
      }
      if (msg?.ok === false) {
        terminalRuns.add(run.id);
        const failed = safeGetBacktestRun(db, run.id);
        if (!failed) return;
        emit('run:failed', { runId: run.id, run: failed, error: msg.error });
      }
    });

    worker.on('error', (err) => {
      handleFailure(run.id, request, startedAt, err.message);
    });

    worker.on('exit', (code) => {
      activeWorkers.delete(run.id);
      const current = safeGetBacktestRun(db, run.id);
      const waiter = waiters.get(run.id);
      if (waiter) {
        if (current && !['running', 'queued'].includes(current.status)) {
          settleWaiter(run.id, { run: current });
        } else if (code !== 0) {
          settleWaiter(run.id, { error: new Error(`Worker exited with code ${code}`), run: current });
        }
      }
      if (code !== 0 && current?.status === 'running') {
        handleFailure(run.id, request, startedAt, `Worker exited with code ${code}`);
      }
      if (current && !['running', 'queued'].includes(current.status)) terminalRuns.add(run.id);
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
    let run = null;
    try {
      run = failBacktestRun(db, runId, {
        request,
        result: failedResult,
        strategyMeta: request.strategyMeta ?? null,
        error,
        startedAt,
      });
    } catch (err) {
      if (!isClosedDbError(err)) throw err;
    }
    terminalRuns.add(runId);
    if (run) emit('run:failed', { runId, run, error });
    const waiter = waiters.get(runId);
    if (waiter) settleWaiter(runId, { error: new Error(error), run });
  }

  function onWorkerComplete(runId, request, startedAt) {
    const run = getBacktestRun(db, runId);
    emit(run?.status === 'completed' ? 'run:completed' : 'run:failed', { runId, run });
  }

  function cancel(runId) {
    terminalRuns.add(runId);
    const worker = activeWorkers.get(runId);
    if (worker) {
      worker.terminate();
      activeWorkers.delete(runId);
    }
  }

  function activeCount() {
    return activeWorkers.size;
  }

  function releaseWaitingRuns(jobId) {
    const waiting = listBacktestRunsWaitingForJob(db, jobId);
    for (const run of waiting) {
      clearRunJobDependency(db, run.id);
    }
    if (waiting.length) drain();
    return waiting.length;
  }

  return { enqueue, enqueueAndWait, drain, cancel, activeCount, onWorkerComplete, releaseWaitingRuns };
}

function safeGetBacktestRun(db, runId) {
  try {
    return getBacktestRun(db, runId);
  } catch (err) {
    if (isClosedDbError(err)) return null;
    throw err;
  }
}

function safeUpdateBacktestRunProgress(db, runId, progress) {
  try {
    updateBacktestRunProgress(db, runId, progress);
    return true;
  } catch (err) {
    if (isClosedDbError(err)) return false;
    throw err;
  }
}

function isClosedDbError(err) {
  return err?.code === 'ERR_INVALID_STATE' && /database is not open/i.test(err.message || '');
}
