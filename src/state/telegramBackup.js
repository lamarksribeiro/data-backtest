export function createTelegramBackupRun(db, run) {
  db.prepare(`
    INSERT INTO telegram_backup_runs (id, status, mode, underlying, request_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.status ?? 'queued',
    run.mode ?? 'incremental',
    run.underlying ?? null,
    run.requestJson ? JSON.stringify(run.requestJson) : null,
    run.createdAt ?? new Date().toISOString(),
  );
  return getTelegramBackupRun(db, run.id);
}

export function getTelegramBackupRun(db, id) {
  const row = db.prepare('SELECT * FROM telegram_backup_runs WHERE id = ?').get(id);
  return row ? toApiRun(row) : null;
}

export function listTelegramBackupRuns(db, { limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 200);
  return db.prepare(`
    SELECT * FROM telegram_backup_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit).map(toApiRun);
}

export function updateTelegramBackupRun(db, id, patch) {
  const sets = [];
  const values = [];
  if (patch.status != null) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.startedAt != null) {
    sets.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.completedAt != null) {
    sets.push('completed_at = ?');
    values.push(patch.completedAt);
  }
  if (patch.resultJson != null) {
    sets.push('result_json = ?');
    values.push(JSON.stringify(patch.resultJson));
  }
  if (patch.progressJson != null) {
    sets.push('progress_json = ?');
    values.push(JSON.stringify(patch.progressJson));
  }
  if (patch.error != null) {
    sets.push('error = ?');
    values.push(patch.error);
  }
  if (!sets.length) return getTelegramBackupRun(db, id);
  values.push(id);
  db.prepare(`UPDATE telegram_backup_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getTelegramBackupRun(db, id);
}

export function insertTelegramBackupArtifact(db, artifact) {
  const result = db.prepare(`
    INSERT INTO telegram_backup_artifacts (
      run_id, underlying, dataset, interval, book_depth, dt, sha256, bytes,
      chunk_index, chunk_count, telegram_message_id, telegram_file_id,
      catalog_message_id, skipped, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.runId,
    artifact.underlying,
    artifact.dataset,
    artifact.interval,
    artifact.bookDepth ?? null,
    artifact.dt,
    artifact.sha256,
    artifact.bytes,
    artifact.chunkIndex ?? 0,
    artifact.chunkCount ?? 1,
    artifact.telegramMessageId ?? null,
    artifact.telegramFileId ?? null,
    artifact.catalogMessageId ?? null,
    artifact.skipped ? 1 : 0,
    artifact.createdAt ?? new Date().toISOString(),
  );
  return result.lastInsertRowid;
}

export function getLatestArtifactShaForPartition(db, { underlying, dataset, interval, bookDepth, dt }) {
  const row = db.prepare(`
    SELECT sha256 FROM telegram_backup_artifacts
    WHERE underlying = ? AND dataset = ? AND interval = ?
      AND COALESCE(book_depth, -1) = COALESCE(?, -1)
      AND dt = ? AND skipped = 0 AND chunk_index = 0
    ORDER BY created_at DESC
    LIMIT 1
  `).get(underlying, dataset, interval, bookDepth ?? null, dt);
  return row?.sha256 ?? null;
}

export function getLastCompletedTelegramBackupRun(db) {
  const row = db.prepare(`
    SELECT * FROM telegram_backup_runs
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `).get();
  return row ? toApiRun(row) : null;
}

function toApiRun(row) {
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    underlying: row.underlying,
    request: row.request_json ? JSON.parse(row.request_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    progress: row.progress_json ? JSON.parse(row.progress_json) : null,
    error: row.error,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}
