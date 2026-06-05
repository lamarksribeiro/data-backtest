export function createPrepareJob(db, { request, mode, dryRun, plan }) {
  const result = db.prepare(`
    INSERT INTO prepare_jobs (status, mode, dry_run, request_json, plan_json)
    VALUES ('queued', ?, ?, ?, ?)
  `).run(mode, dryRun ? 1 : 0, JSON.stringify(request), JSON.stringify(plan));
  return getPrepareJob(db, result.lastInsertRowid);
}

export function getPrepareJob(db, id) {
  const row = db.prepare('SELECT * FROM prepare_jobs WHERE id = ?').get(id);
  return row ? toApiJob(row) : null;
}

export function listPrepareJobs(db, { limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
  return db.prepare('SELECT * FROM prepare_jobs ORDER BY id DESC LIMIT ?').all(safeLimit).map(toApiJob);
}

export function getNextQueuedPrepareJob(db) {
  const row = db.prepare("SELECT * FROM prepare_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1").get();
  return row ? toApiJob(row) : null;
}

export function markPrepareJobRunning(db, id) {
  db.prepare(`
    UPDATE prepare_jobs
    SET status = 'running', started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ?
  `).run(id);
  return getPrepareJob(db, id);
}

export function markPrepareJobCompleted(db, id, result) {
  db.prepare(`
    UPDATE prepare_jobs
    SET status = 'completed', result_json = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(JSON.stringify(result), id);
  return getPrepareJob(db, id);
}

export function markPrepareJobFailed(db, id, error) {
  db.prepare(`
    UPDATE prepare_jobs
    SET status = 'failed', error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(error?.message || String(error), id);
  return getPrepareJob(db, id);
}

function toApiJob(row) {
  return {
    id: Number(row.id),
    status: row.status,
    mode: row.mode,
    dry_run: Boolean(row.dry_run),
    request: JSON.parse(row.request_json),
    plan: JSON.parse(row.plan_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}
