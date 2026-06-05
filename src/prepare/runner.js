import { resolveDataRequest } from '../query/dataMode.js';
import {
  createPrepareJob,
  getNextQueuedPrepareJob,
  markPrepareJobCompleted,
  markPrepareJobFailed,
  markPrepareJobRunning,
} from '../state/prepareJobs.js';
import { executePreparationActions } from './executor.js';

export function createPrepareJobRunner({ config, db, executeActions = executePreparationActions }) {
  let running = false;
  let idleResolvers = [];

  function enqueue({ request, mode = 'prepare', dryRun = true }) {
    const plan = resolveDataRequest(db, request, mode);
    const job = createPrepareJob(db, { request, mode, dryRun, plan });
    queueMicrotask(() => runNext());
    return job;
  }

  async function runNext() {
    if (running) return;
    const job = getNextQueuedPrepareJob(db);
    if (!job) return resolveIdle();

    running = true;
    markPrepareJobRunning(db, job.id);
    try {
      const result = job.plan.ready || !job.plan.preparation.length
        ? { ready: job.plan.ready, actions: [] }
        : {
          ready: false,
          actions: await executeActions({ config, db, actions: job.plan.preparation, dryRun: job.dry_run }),
        };
      markPrepareJobCompleted(db, job.id, result);
    } catch (err) {
      markPrepareJobFailed(db, job.id, err);
    } finally {
      running = false;
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

  return { enqueue, waitForIdle };
}
