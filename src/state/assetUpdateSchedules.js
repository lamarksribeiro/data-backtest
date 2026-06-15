import { normalizeInterval } from '../source/postgres.js';
import { nextDailyRunAt, parseScheduleTime, resolveSchedulerTimezone } from '../scheduler/scheduleTime.js';

const VALID_FREQUENCIES = new Set(['daily', 'every_hours']);
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

export function listAssetUpdateSchedules(db) {
  const rows = db.prepare('SELECT * FROM asset_update_schedules ORDER BY enabled DESC, id DESC').all();
  return rows.map((row) => enrichSchedule(db, toApiSchedule(row)));
}

export function getAssetUpdateSchedule(db, id) {
  const row = db.prepare('SELECT * FROM asset_update_schedules WHERE id = ?').get(id);
  return row ? enrichSchedule(db, toApiSchedule(row)) : null;
}

export function createAssetUpdateSchedule(db, input, { config, now = new Date() } = {}) {
  const normalized = normalizeScheduleInput(input, config);
  const nextRunAt = normalized.enabled
    ? computeNextRunAt({ ...normalized, created_at: now.toISOString() }, now, { config })
    : null;
  const result = db.prepare(`
    INSERT INTO asset_update_schedules (
      name, enabled, underlying, interval, book_depth, start_date,
      frequency, time_utc, every_hours, next_run_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(
    normalized.name,
    normalized.enabled ? 1 : 0,
    normalized.underlying,
    normalized.interval,
    normalized.book_depth,
    normalized.start_date,
    normalized.frequency,
    normalized.time_utc,
    normalized.every_hours,
    nextRunAt,
  );
  return getAssetUpdateSchedule(db, result.lastInsertRowid);
}

export function updateAssetUpdateSchedule(db, id, patch, { config, now = new Date() } = {}) {
  const current = getAssetUpdateSchedule(db, id);
  if (!current) return null;
  const normalized = normalizeScheduleInput({ ...current, ...patch }, config);
  const nextRunAt = normalized.enabled
    ? computeNextRunAt({ ...current, ...normalized }, now, { config })
    : null;
  db.prepare(`
    UPDATE asset_update_schedules
    SET name = ?, enabled = ?, underlying = ?, interval = ?, book_depth = ?, start_date = ?,
        frequency = ?, time_utc = ?, every_hours = ?, next_run_at = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    normalized.name,
    normalized.enabled ? 1 : 0,
    normalized.underlying,
    normalized.interval,
    normalized.book_depth,
    normalized.start_date,
    normalized.frequency,
    normalized.time_utc,
    normalized.every_hours,
    nextRunAt,
    id,
  );
  return getAssetUpdateSchedule(db, id);
}

export function deleteAssetUpdateSchedule(db, id) {
  const result = db.prepare('DELETE FROM asset_update_schedules WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listDueAssetUpdateSchedules(db, now = new Date(), { limit = 5 } = {}) {
  const nowIso = toDate(now).toISOString();
  return db.prepare(`
    SELECT * FROM asset_update_schedules
    WHERE enabled = 1
      AND next_run_at IS NOT NULL
      AND next_run_at <= ?
    ORDER BY next_run_at ASC, id ASC
    LIMIT ?
  `).all(nowIso, Math.max(1, Number.parseInt(String(limit), 10) || 5)).map(toApiSchedule);
}

export function hasActiveAssetUpdateRun(db, scheduleId) {
  const row = db.prepare(`
    SELECT r.id, r.status, r.prepare_job_id, j.status AS prepare_status
    FROM asset_update_schedule_runs r
    LEFT JOIN prepare_jobs j ON j.id = r.prepare_job_id
    WHERE r.schedule_id = ?
      AND r.status IN ('queued', 'running')
    ORDER BY r.id DESC
    LIMIT 1
  `).get(scheduleId);
  if (!row) return null;
  if (row.prepare_status && !ACTIVE_RUN_STATUSES.has(row.prepare_status)) return null;
  return toApiRun(row);
}

export function createAssetUpdateRun(db, input) {
  const result = db.prepare(`
    INSERT INTO asset_update_schedule_runs (
      schedule_id, prepare_job_id, status, from_date, to_date, message, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    positiveInt(input.schedule_id ?? input.scheduleId, 'schedule_id'),
    input.prepare_job_id ?? input.prepareJobId ?? null,
    normalizeRunStatus(input.status || 'queued'),
    normalizeDateOnly(input.from_date ?? input.fromDate, 'from_date'),
    normalizeDateOnly(input.to_date ?? input.toDate, 'to_date'),
    input.message == null ? null : String(input.message),
    input.started_at ?? input.startedAt ?? null,
    input.completed_at ?? input.completedAt ?? null,
  );
  return getAssetUpdateRun(db, result.lastInsertRowid);
}

export function getAssetUpdateRun(db, id) {
  const row = db.prepare(`
    SELECT r.*, j.status AS prepare_status
    FROM asset_update_schedule_runs r
    LEFT JOIN prepare_jobs j ON j.id = r.prepare_job_id
    WHERE r.id = ?
  `).get(id);
  return row ? toApiRun(row) : null;
}

export function markAssetUpdateScheduleAttempt(db, id, {
  now = new Date(),
  nextRunAt,
  jobId = null,
  success = null,
  error = null,
  clearError = false,
} = {}) {
  const nowIso = toDate(now).toISOString();
  db.prepare(`
    UPDATE asset_update_schedules
    SET last_run_at = ?,
        last_job_id = COALESCE(?, last_job_id),
        next_run_at = ?,
        last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
        last_error = CASE WHEN ? = 1 THEN NULL WHEN ? = 1 THEN NULL WHEN ? IS NOT NULL THEN ? ELSE last_error END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    nowIso,
    jobId,
    nextRunAt ?? null,
    success === true ? 1 : 0,
    nowIso,
    success === true ? 1 : 0,
    clearError ? 1 : 0,
    error,
    error,
    id,
  );
  return getAssetUpdateSchedule(db, id);
}

export function finishAssetUpdateRunByJobId(db, jobId, status, message = null, { now = new Date() } = {}) {
  if (!jobId) return null;
  const runRow = db.prepare(`
    SELECT * FROM asset_update_schedule_runs
    WHERE prepare_job_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(jobId);
  if (!runRow) return null;
  const finalStatus = normalizeCompletionStatus(status);
  const completedAt = toDate(now).toISOString();
  db.prepare(`
    UPDATE asset_update_schedule_runs
    SET status = ?, completed_at = ?, message = COALESCE(?, message)
    WHERE id = ?
  `).run(finalStatus, completedAt, message, runRow.id);
  db.prepare(`
    UPDATE asset_update_schedules
    SET last_success_at = CASE WHEN ? = 'completed' THEN ? ELSE last_success_at END,
        last_error = CASE WHEN ? = 'completed' THEN NULL ELSE COALESCE(?, last_error, 'job failed') END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(finalStatus, completedAt, finalStatus, message, runRow.schedule_id);
  return getAssetUpdateRun(db, runRow.id);
}

export function reconcileAssetUpdateSchedules(db, config, now = new Date()) {
  const rows = db.prepare('SELECT * FROM asset_update_schedules WHERE enabled = 1').all();
  for (const row of rows) {
    const schedule = toApiSchedule(row);
    const nextRunAt = computeNextRunAt(schedule, now, { config });
    if (nextRunAt !== schedule.next_run_at) {
      db.prepare(`
        UPDATE asset_update_schedules
        SET next_run_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(nextRunAt, schedule.id);
    }
  }
}

export function recoverStaleAssetUpdateRuns(db) {
  const result = db.prepare(`
    UPDATE asset_update_schedule_runs
    SET status = 'failed',
        message = COALESCE(message, 'interrupted on restart'),
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('queued', 'running')
  `).run();
  return result.changes;
}

export function computeNextRunAt(schedule, now = new Date(), { config } = {}) {
  if (schedule.enabled === false || schedule.enabled === 0) return null;
  const current = toDate(now);
  if (schedule.frequency === 'every_hours') {
    const hours = Math.min(Math.max(Number.parseInt(String(schedule.every_hours || 24), 10) || 24, 1), 168);
    const base = validDate(schedule.last_run_at) || validDate(schedule.created_at) || current;
    let next = new Date(base.getTime() + hours * 60 * 60 * 1000);
    while (next <= current) next = new Date(next.getTime() + hours * 60 * 60 * 1000);
    return next.toISOString();
  }

  const timeZone = resolveSchedulerTimezone(config);
  return nextDailyRunAt(schedule.time_utc || '03:00', current, timeZone, {
    after: schedule.last_run_at,
  });
}

function enrichSchedule(db, schedule) {
  return {
    ...schedule,
    active_run: activeRunForSchedule(db, schedule.id),
    recent_runs: recentRunsForSchedule(db, schedule.id),
  };
}

function activeRunForSchedule(db, scheduleId) {
  const row = db.prepare(`
    SELECT r.*, j.status AS prepare_status
    FROM asset_update_schedule_runs r
    LEFT JOIN prepare_jobs j ON j.id = r.prepare_job_id
    WHERE r.schedule_id = ?
      AND r.status IN ('queued', 'running')
    ORDER BY r.id DESC
    LIMIT 1
  `).get(scheduleId);
  if (!row) return null;
  const run = toApiRun(row);
  return ACTIVE_RUN_STATUSES.has(run.status) ? run : null;
}

function recentRunsForSchedule(db, scheduleId) {
  return db.prepare(`
    SELECT r.*, j.status AS prepare_status
    FROM asset_update_schedule_runs r
    LEFT JOIN prepare_jobs j ON j.id = r.prepare_job_id
    WHERE r.schedule_id = ?
    ORDER BY r.id DESC
    LIMIT 5
  `).all(scheduleId).map(toApiRun);
}

function normalizeScheduleInput(input, config = {}) {
  const frequency = String(input.frequency || 'daily').trim();
  if (!VALID_FREQUENCIES.has(frequency)) throw new Error('frequency must be daily or every_hours');
  const bookDepth = positiveInt(input.book_depth ?? input.bookDepth ?? config.backtestBookDepth ?? 25, 'book_depth');
  const underlying = String(input.underlying || '').trim().toUpperCase();
  if (!underlying) throw new Error('underlying is required');
  return {
    name: normalizeName(input.name),
    enabled: input.enabled !== false && input.enabled !== 0 && input.enabled !== '0',
    underlying,
    interval: normalizeInterval(String(input.interval || '').trim()),
    book_depth: bookDepth,
    start_date: normalizeDateOnly(input.start_date ?? input.startDate, 'start_date'),
    frequency,
    time_utc: normalizeTimeUtc(input.time_utc ?? input.timeUtc ?? '03:00'),
    every_hours: Math.min(Math.max(positiveInt(input.every_hours ?? input.everyHours ?? 24, 'every_hours'), 1), 168),
  };
}

function normalizeName(value) {
  const text = String(value || '').trim();
  if (!text) return 'Atualização automática';
  return text.slice(0, 120);
}

function normalizeDateOnly(value, field) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${field} must be YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${field} must be a valid date`);
  }
  return text;
}

function normalizeTimeUtc(value) {
  const text = String(value || '').trim();
  parseScheduleTime(text);
  return text;
}

function positiveInt(value, field) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function normalizeRunStatus(value) {
  const status = String(value || '').trim();
  if (!['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped'].includes(status)) {
    throw new Error('invalid schedule run status');
  }
  return status;
}

function normalizeCompletionStatus(value) {
  if (value === 'completed') return 'completed';
  if (value === 'cancelled') return 'cancelled';
  return 'failed';
}

function toApiSchedule(row) {
  return {
    id: Number(row.id),
    name: row.name,
    enabled: Boolean(row.enabled),
    underlying: row.underlying,
    interval: row.interval,
    book_depth: Number(row.book_depth),
    start_date: row.start_date,
    frequency: row.frequency,
    time_utc: row.time_utc,
    every_hours: Number(row.every_hours),
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_success_at: row.last_success_at,
    last_error: row.last_error,
    last_job_id: row.last_job_id == null ? null : Number(row.last_job_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toApiRun(row) {
  const status = ACTIVE_RUN_STATUSES.has(row.prepare_status) ? row.prepare_status : row.status;
  return {
    id: Number(row.id),
    schedule_id: Number(row.schedule_id),
    prepare_job_id: row.prepare_job_id == null ? null : Number(row.prepare_job_id),
    status,
    from_date: row.from_date,
    to_date: row.to_date,
    message: row.message,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  return date;
}
