import { manifestRowToJson } from '../backup/catalog.js';

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

export function listActiveTelegramBackupRuns(db) {
  return db.prepare(`
    SELECT * FROM telegram_backup_runs
    WHERE status IN ('queued', 'running')
    ORDER BY created_at DESC
  `).all().map(toApiRun);
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
      run_id, underlying, dataset, interval, book_depth, dt, sha256, file_sha256, bytes,
      chunk_index, chunk_count, telegram_message_id, telegram_file_id,
      catalog_message_id, skipped, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.runId,
    artifact.underlying,
    artifact.dataset,
    artifact.interval,
    artifact.bookDepth ?? null,
    artifact.dt,
    artifact.sha256,
    artifact.fileSha256 ?? null,
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

export function getLatestFileShaForPartition(db, { underlying, dataset, interval, bookDepth, dt }) {
  const row = db.prepare(`
    SELECT COALESCE(file_sha256, sha256) AS file_sha
    FROM telegram_backup_artifacts
    WHERE underlying = ? AND dataset = ? AND interval = ?
      AND COALESCE(book_depth, -1) = COALESCE(?, -1)
      AND dt = ? AND skipped = 0 AND chunk_index = 0
    ORDER BY created_at DESC
    LIMIT 1
  `).get(underlying, dataset, interval, bookDepth ?? null, dt);
  return row?.file_sha ?? null;
}

/** @deprecated use getLatestFileShaForPartition */
export function getLatestArtifactShaForPartition(db, params) {
  return getLatestFileShaForPartition(db, params);
}

export function getLatestPartitionUploadArtifacts(db, { underlying, dataset, interval, bookDepth, dt }) {
  const rows = db.prepare(`
    SELECT * FROM telegram_backup_artifacts
    WHERE underlying = ? AND dataset = ? AND interval = ?
      AND COALESCE(book_depth, -1) = COALESCE(?, -1)
      AND dt = ? AND skipped = 0
    ORDER BY created_at DESC
  `).all(underlying, dataset, interval, bookDepth ?? null, dt);
  if (!rows.length) return [];

  const latestRunId = rows[0].run_id;
  return rows
    .filter((row) => row.run_id === latestRunId)
    .sort((a, b) => a.chunk_index - b.chunk_index);
}

export function buildSkippedPartitionCatalogEntry(db, manifestRow, fileInfo) {
  const chunks = getLatestPartitionUploadArtifacts(db, {
    underlying: manifestRow.underlying,
    dataset: 'backtest_ticks',
    interval: manifestRow.interval,
    bookDepth: manifestRow.book_depth,
    dt: manifestRow.dt,
  });
  if (!chunks.length || !chunks[0].telegram_file_id) return null;

  const chunkCount = chunks[0].chunk_count ?? 1;
  const fileSha = chunks[0].file_sha256
    ?? (chunkCount === 1 ? chunks[0].sha256 : fileInfo.sha256);

  const base = {
    dt: manifestRow.dt,
    sha256: fileSha,
    bytes: fileInfo.bytes,
    manifest_row: manifestRowToJson(manifestRow),
    skipped: true,
    reason: 'unchanged',
  };

  if (chunkCount > 1) {
    return {
      ...base,
      chunks: chunks.map((row) => ({
        chunk_index: row.chunk_index,
        sha256: row.sha256,
        telegram: telegramRefFromArtifactRow(row),
      })),
    };
  }

  return {
    ...base,
    telegram: telegramRefFromArtifactRow(chunks[0]),
  };
}

export function getLastCompletedAssetCatalog(db, underlying) {
  const target = String(underlying || '').toUpperCase();
  const runs = listTelegramBackupRuns(db, { limit: 50 });
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    const asset = run.result?.asset_catalogs?.find((item) => item.underlying === target);
    if (asset?.catalog?.file_id) return asset;
  }
  return null;
}

export function getLastCompletedMasterCatalog(db) {
  const run = getLastCompletedTelegramBackupRun(db);
  return run?.result?.master_catalog ?? null;
}

function telegramRefFromArtifactRow(row) {
  if (!row?.telegram_file_id) return null;
  return {
    file_id: row.telegram_file_id,
    message_id: row.telegram_message_id ?? null,
  };
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

export function countTelegramBackupLocalRecords(db) {
  const runs = db.prepare('SELECT COUNT(*) AS c FROM telegram_backup_runs').get().c;
  const artifacts = db.prepare('SELECT COUNT(*) AS c FROM telegram_backup_artifacts').get().c;
  return { runs, artifacts };
}

export function cancelTelegramBackupRunRecord(db, runId, progress = null) {
  const run = getTelegramBackupRun(db, runId);
  updateTelegramBackupRun(db, runId, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: 'Cancelado pelo usuário',
    progressJson: {
      ...(progress || run?.progress || {}),
      phase: 'cancelled',
    },
  });
  return getTelegramBackupRun(db, runId);
}

export function clearTelegramBackupLocalRecords(db) {
  const before = countTelegramBackupLocalRecords(db);
  db.exec('DELETE FROM telegram_backup_artifacts');
  db.exec('DELETE FROM telegram_backup_runs');
  db.prepare(`
    UPDATE telegram_backup_settings
    SET last_schedule_run_date = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `).run();
  return {
    runs_removed: before.runs,
    artifacts_removed: before.artifacts,
  };
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
