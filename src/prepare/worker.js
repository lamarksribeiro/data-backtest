import { parentPort, workerData } from 'node:worker_threads';

import { executePreparationActions } from './executor.js';
import { PrepareJobCancelledError } from './errors.js';
import { createProgressReporter } from './progressReporter.js';
import {
  getPrepareJob,
  markPrepareJobCancelled,
  markPrepareJobCompleted,
  markPrepareJobFailed,
} from '../state/prepareJobs.js';
import { closeStateDatabase, openStateDatabase } from '../state/sqlite.js';

let cancelRequested = false;

parentPort?.on('message', (msg) => {
  if (msg?.type === 'cancel') cancelRequested = true;
});

const db = openStateDatabase(workerData.stateDbPath);
const config = workerData.config;
const jobId = workerData.jobId;

try {
  const job = getPrepareJob(db, jobId);
  if (!job) throw new Error(`Prepare job ${jobId} not found`);

  const reportProgress = createProgressReporter(db, job, (event) => {
    parentPort?.postMessage({ type: 'progress', progress: event.progress });
  });

  if (cancelRequested) throw new PrepareJobCancelledError();

  const result = job.plan.ready || !job.plan.preparation.length
    ? { ready: job.plan.ready, actions: [] }
    : {
      ready: false,
      actions: await executePreparationActions({
        config,
        db,
        actions: job.plan.preparation,
        dryRun: job.dry_run,
        onProgress: reportProgress,
        shouldCancel: () => cancelRequested,
      }),
    };

  markPrepareJobCompleted(db, jobId, result);
  parentPort?.postMessage({ type: 'completed', jobId, status: 'completed' });
} catch (err) {
  if (err instanceof PrepareJobCancelledError || cancelRequested) {
    markPrepareJobCancelled(db, jobId, err.message || 'cancelado pelo operador');
    parentPort?.postMessage({ type: 'cancelled', jobId, status: 'cancelled' });
  } else {
    markPrepareJobFailed(db, jobId, err);
    parentPort?.postMessage({
      type: 'failed',
      jobId,
      status: 'failed',
      error: err?.message || String(err),
    });
  }
} finally {
  closeStateDatabase(db);
}
