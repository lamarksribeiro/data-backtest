import { resolveDataRequest } from '../query/dataMode.js';
import {
  createPrepareJob,
  getNextQueuedPrepareJob,
  getPrepareJob,
  markPrepareJobCancelled,
  markPrepareJobCompleted,
  markPrepareJobFailed,
  markPrepareJobRunning,
  updatePrepareJobProgress,
} from '../state/prepareJobs.js';
import { executePreparationActions } from './executor.js';
import { PrepareJobCancelledError } from './errors.js';
import { computePrepareJobPercent } from './progress.js';

export function createPrepareJobRunner({ config, db, executeActions = executePreparationActions, onEvent }) {
  let running = false;
  let idleResolvers = [];
  let currentJobId = null;
  let cancelRequested = false;

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
      return { ok: true, status: 'cancelling' };
    }
    return { ok: false, reason: 'not_cancellable', status: job.status };
  }

  function createProgressReporter(job, emitEvent) {
    const startedAt = job.started_at || new Date().toISOString();
    let progress = {
      started_at: startedAt,
      updated_at: startedAt,
      actions_total: job.plan?.preparation?.length || 0,
      action_index: 0,
      partitions_total: 0,
      partitions_done: 0,
      files: [],
      current: null,
    };

    let lastPersistMs = 0;
    return (patch) => {
      const nextFiles = patch.files ? [...progress.files, ...patch.files] : progress.files;
      progress = {
        ...progress,
        ...patch,
        files: nextFiles,
        current: patch.current === undefined ? progress.current : patch.current,
        updated_at: new Date().toISOString(),
      };
      progress.percent = computePrepareJobPercent(progress);
      const now = Date.now();
      const force = Boolean(patch.files?.length)
        || patch.current?.phase === 'done'
        || patch.current === null
        || patch.partitions_done != null && patch.current == null;
      if (!force && now - lastPersistMs < 1000) return;
      lastPersistMs = now;
      updatePrepareJobProgress(db, job.id, progress);
      emitEvent?.({ type: 'job:progress', jobId: job.id, status: 'running', progress });
    };
  }

  async function runNext() {
    if (running) return;
    const job = getNextQueuedPrepareJob(db);
    if (!job) return resolveIdle();

    running = true;
    currentJobId = job.id;
    cancelRequested = false;
    markPrepareJobRunning(db, job.id);
    const reportProgress = createProgressReporter(job, onEvent);

    try {
      if (cancelRequested) throw new PrepareJobCancelledError();

      const result = job.plan.ready || !job.plan.preparation.length
        ? { ready: job.plan.ready, actions: [] }
        : {
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
      markPrepareJobCompleted(db, job.id, result);
      onEvent?.({ type: 'job:completed', jobId: job.id, status: 'completed' });
    } catch (err) {
      if (err instanceof PrepareJobCancelledError || cancelRequested) {
        markPrepareJobCancelled(db, job.id, err.message || 'cancelado pelo operador');
        onEvent?.({ type: 'job:completed', jobId: job.id, status: 'cancelled' });
      } else {
        markPrepareJobFailed(db, job.id, err);
        onEvent?.({ type: 'job:failed', jobId: job.id, status: 'failed', error: err.message });
      }
    } finally {
      running = false;
      currentJobId = null;
      cancelRequested = false;
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
