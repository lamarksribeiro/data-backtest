import { Worker } from 'node:worker_threads';

import { resolveDataRequest } from '../query/dataMode.js';
import {
  createPrepareJob,
  getNextQueuedPrepareJob,
  getPrepareJob,
  markPrepareJobCancelled,
  markPrepareJobCompleted,
  markPrepareJobFailed,
  markPrepareJobRunning,
} from '../state/prepareJobs.js';
import { executePreparationActions } from './executor.js';
import { PrepareJobCancelledError } from './errors.js';
import { createProgressReporter } from './progressReporter.js';
import { serializeWorkerConfig } from '../config.js';

export function createPrepareJobRunner({ config, db, executeActions = executePreparationActions, onEvent }) {
  const useWorker = config.prepareRunner !== 'inline';
  let running = false;
  let idleResolvers = [];
  let currentJobId = null;
  let cancelRequested = false;
  let activeWorker = null;

  function enqueue({ request, mode = 'prepare', dryRun = true }) {
    const plan = resolveDataRequest(db, request, mode);
    const job = createPrepareJob(db, { request, mode, dryRun, plan });
    queueMicrotask(() => runNext());
    return job;
  }

  function cancel(jobId) {
    const job = getPrepareJob(db, jobId);
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.status === 'queued') {
      markPrepareJobCancelled(db, jobId);
      return { ok: true, status: 'cancelled' };
    }
    if (job.status === 'running' && currentJobId === jobId) {
      cancelRequested = true;
      activeWorker?.postMessage?.({ type: 'cancel' });
      return { ok: true, status: 'cancelling' };
    }
    return { ok: false, reason: 'not_cancellable', status: job.status };
  }

  async function runInline(job) {
    const reportProgress = createProgressReporter(db, job, onEvent);
    if (cancelRequested) throw new PrepareJobCancelledError();

    if (job.plan.ready || !job.plan.preparation.length) {
      return { ready: job.plan.ready, actions: [] };
    }

    return {
      ready: false,
      actions: await executeActions({
        config,
        db,
        actions: job.plan.preparation,
        dryRun: job.dry_run,
        onProgress: reportProgress,
        shouldCancel: () => cancelRequested,
      }),
    };
  }

  function runInWorker(job) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: {
          stateDbPath: config.stateDbPath,
          jobId: job.id,
          config: serializeWorkerConfig(config),
        },
      });
      activeWorker = worker;

      worker.on('message', (msg) => {
        if (msg?.type === 'progress') {
          onEvent?.({ type: 'job:progress', jobId: job.id, status: 'running', progress: msg.progress });
          return;
        }
        if (msg?.type === 'completed') {
          finish(() => resolve({ status: 'completed' }));
          return;
        }
        if (msg?.type === 'cancelled') {
          finish(() => resolve({ status: 'cancelled' }));
          return;
        }
        if (msg?.type === 'failed') {
          finish(() => reject(new Error(msg.error || 'prepare job failed')));
        }
      });

      worker.on('error', (err) => finish(() => reject(err)));
      worker.on('exit', (code) => {
        activeWorker = null;
        if (!settled && code !== 0) {
          finish(() => reject(new Error(`Prepare worker exited with code ${code}`)));
        }
      });

      worker.unref();
    });
  }

  async function runNext() {
    if (running) return;
    const job = getNextQueuedPrepareJob(db);
    if (!job) return resolveIdle();

    running = true;
    currentJobId = job.id;
    cancelRequested = false;
    markPrepareJobRunning(db, job.id);

    try {
      if (useWorker) {
        const outcome = await runInWorker(job);
        if (outcome.status === 'completed') {
          onEvent?.({ type: 'job:completed', jobId: job.id, status: 'completed' });
        } else {
          onEvent?.({ type: 'job:completed', jobId: job.id, status: 'cancelled' });
        }
      } else {
        const result = await runInline(job);
        markPrepareJobCompleted(db, job.id, result);
        onEvent?.({ type: 'job:completed', jobId: job.id, status: 'completed' });
      }
    } catch (err) {
      if (err instanceof PrepareJobCancelledError || cancelRequested) {
        if (!useWorker) {
          markPrepareJobCancelled(db, job.id, err.message || 'cancelado pelo operador');
        }
        onEvent?.({ type: 'job:completed', jobId: job.id, status: 'cancelled' });
      } else if (!useWorker) {
        markPrepareJobFailed(db, job.id, err);
        onEvent?.({ type: 'job:failed', jobId: job.id, status: 'failed', error: err.message });
      } else {
        onEvent?.({ type: 'job:failed', jobId: job.id, status: 'failed', error: err.message });
      }
    } finally {
      running = false;
      currentJobId = null;
      cancelRequested = false;
      activeWorker = null;
      queueMicrotask(() => runNext());
      resolveIdle();
    }
  }

  function waitForIdle() {
    if (!running && !getNextQueuedPrepareJob(db)) return Promise.resolve();
    return new Promise((resolve) => idleResolvers.push(resolve));
  }

  function resolveIdle() {
    if (running || getNextQueuedPrepareJob(db)) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  return { enqueue, cancel, waitForIdle };
}
