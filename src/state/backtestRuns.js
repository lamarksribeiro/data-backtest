import { persistEventTraces } from '../backtestStudio/state/eventTraces.js';

export function createBacktestRun(db, { request, result, strategyMeta = null, status = 'completed', error = null, durationMs = null }) {
  const meta = strategyMeta ?? result?.strategyMeta ?? null;
  const inserted = db.prepare(`
    INSERT INTO backtest_runs (
      strategy, source, underlying, interval, book_depth, from_ts, to_ts, batch_size,
      params_json, ticks, batches, summary_json, result_json,
      strategy_id, strategy_version_id, strategy_snapshot_json, dataset_request_json,
      status, error, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.strategy,
    result.source,
    result.underlying,
    result.interval,
    result.bookDepth ?? null,
    result.from,
    result.to,
    request.batchSize,
    JSON.stringify(request.params ?? {}),
    result.ticks,
    result.batches,
    JSON.stringify(result.summary ?? {}),
    JSON.stringify(result),
    meta?.strategy_id ?? null,
    meta?.strategy_version_id ?? null,
    meta ? JSON.stringify(meta) : null,
    JSON.stringify(stripRequestForSnapshot(request)),
    status,
    error,
    durationMs,
  );
  const runId = inserted.lastInsertRowid;
  persistEventTraces(db, runId, result);
  return getBacktestRun(db, runId);
}

export function getBacktestRun(db, id) {
  const row = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
  return row ? toApiRun(row, true) : null;
}

export function listBacktestRuns(db, { limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
  return db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?').all(safeLimit).map((row) => toApiRun(row));
}

function toApiRun(row, includeResult = false) {
  const run = {
    id: Number(row.id),
    strategy: row.strategy,
    source: row.source,
    underlying: row.underlying,
    interval: row.interval,
    bookDepth: row.book_depth,
    from: row.from_ts,
    to: row.to_ts,
    batchSize: row.batch_size,
    params: JSON.parse(row.params_json),
    ticks: row.ticks,
    batches: row.batches,
    summary: JSON.parse(row.summary_json),
    created_at: row.created_at,
    strategy_id: row.strategy_id != null ? Number(row.strategy_id) : null,
    strategy_version_id: row.strategy_version_id != null ? Number(row.strategy_version_id) : null,
    strategy_snapshot: row.strategy_snapshot_json ? JSON.parse(row.strategy_snapshot_json) : null,
    status: row.status ?? 'completed',
    error: row.error ?? null,
    duration_ms: row.duration_ms ?? null,
  };
  if (includeResult) run.result = JSON.parse(row.result_json);
  return run;
}

function stripRequestForSnapshot(request) {
  const { glsAst, strategyMeta, ...rest } = request;
  return rest;
}
