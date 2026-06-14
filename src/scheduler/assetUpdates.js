import { runDataFix } from '../data/fixPipeline.js';
import {
  computeNextRunAt,
  createAssetUpdateRun,
  getAssetUpdateSchedule,
  hasActiveAssetUpdateRun,
  listDueAssetUpdateSchedules,
  markAssetUpdateScheduleAttempt,
} from '../state/assetUpdateSchedules.js';

const DEFAULT_POLL_MS = 60_000;

export function createAssetUpdateScheduler({ db, config, prepareRunner, pollMs = DEFAULT_POLL_MS, autoStart = false, now = () => new Date() }) {
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const current = now();
      const due = listDueAssetUpdateSchedules(db, current, { limit: 5 });
      for (const schedule of due) {
        await runAssetUpdateSchedule({ db, config, prepareRunner, schedule, now: current });
      }
    } catch (err) {
      console.warn('[asset-update-scheduler] tick failed:', err.message);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => void tick(), pollMs);
    timer.unref?.();
    queueMicrotask(() => void tick());
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  if (autoStart) start();

  return {
    start,
    stop,
    tick,
    runNow: (scheduleId) => {
      const schedule = getAssetUpdateSchedule(db, scheduleId);
      if (!schedule) return { ok: false, code: 'NOT_FOUND', message: 'Schedule not found' };
      return runAssetUpdateSchedule({ db, config, prepareRunner, schedule, manual: true, now: now() });
    },
  };
}

export async function runAssetUpdateSchedule({ db, config, prepareRunner, schedule, manual = false, now = new Date() }) {
  const current = now instanceof Date ? now : new Date(now);
  const nowIso = current.toISOString();
  const activeRun = hasActiveAssetUpdateRun(db, schedule.id);
  if (activeRun) {
    return { ok: false, code: 'ALREADY_RUNNING', message: 'Schedule already has an active update run', run: activeRun };
  }

  const toDate = lastClosedUtcDate(current);
  const nextRunAt = schedule.enabled
    ? computeNextRunAt({ ...schedule, last_run_at: nowIso }, current)
    : null;

  if (toDate < schedule.start_date) {
    const run = createAssetUpdateRun(db, {
      schedule_id: schedule.id,
      status: 'skipped',
      from_date: schedule.start_date,
      to_date: toDate,
      message: 'A data inicial ainda está após o último dia fechado.',
      started_at: nowIso,
      completed_at: nowIso,
    });
    const updated = markAssetUpdateScheduleAttempt(db, schedule.id, { now: current, nextRunAt, success: true });
    return { ok: true, skipped: true, schedule: updated, run };
  }

  const request = {
    dataset: 'backtest_ticks',
    from: schedule.start_date,
    to: toDate,
    underlying: schedule.underlying,
    interval: schedule.interval,
    book_depth: schedule.book_depth,
  };

  try {
    const result = runDataFix(db, config, { body: { request }, prepareRunner, dryRun: false });
    if (!result.ok) {
      const run = createAssetUpdateRun(db, {
        schedule_id: schedule.id,
        status: 'failed',
        from_date: schedule.start_date,
        to_date: toDate,
        message: result.message || result.error?.message || 'Falha ao planejar atualização automática.',
        started_at: nowIso,
        completed_at: nowIso,
      });
      const updated = markAssetUpdateScheduleAttempt(db, schedule.id, {
        now: current,
        nextRunAt,
        error: run.message,
      });
      return { ok: false, code: result.code || 'RUN_FAILED', message: run.message, schedule: updated, run };
    }

    if (result.ready) {
      const run = createAssetUpdateRun(db, {
        schedule_id: schedule.id,
        status: 'completed',
        from_date: schedule.start_date,
        to_date: toDate,
        message: result.summary || 'Período já estava pronto.',
        started_at: nowIso,
        completed_at: nowIso,
      });
      const updated = markAssetUpdateScheduleAttempt(db, schedule.id, { now: current, nextRunAt, success: true });
      return { ok: true, ready: true, schedule: updated, run, target_to_date: toDate };
    }

    const jobId = result.job?.id ?? null;
    const run = createAssetUpdateRun(db, {
      schedule_id: schedule.id,
      prepare_job_id: jobId,
      status: 'queued',
      from_date: schedule.start_date,
      to_date: toDate,
      message: result.summary || 'Atualização automática enfileirada.',
      started_at: nowIso,
    });
    const updated = markAssetUpdateScheduleAttempt(db, schedule.id, {
      now: current,
      nextRunAt,
      jobId,
      success: null,
      clearError: true,
    });
    return { ok: true, ready: false, manual, schedule: updated, run, job: result.job, target_to_date: toDate };
  } catch (err) {
    const run = createAssetUpdateRun(db, {
      schedule_id: schedule.id,
      status: 'failed',
      from_date: schedule.start_date,
      to_date: toDate,
      message: err.message,
      started_at: nowIso,
      completed_at: nowIso,
    });
    const updated = markAssetUpdateScheduleAttempt(db, schedule.id, {
      now: current,
      nextRunAt,
      error: err.message,
    });
    return { ok: false, code: 'RUN_FAILED', message: err.message, schedule: updated, run };
  }
}

export function lastClosedUtcDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const closed = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  closed.setUTCDate(closed.getUTCDate() - 1);
  return closed.toISOString().slice(0, 10);
}
