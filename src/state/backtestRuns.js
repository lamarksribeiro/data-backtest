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
  return getBacktestRun(db, runId, { includeResult: true, includeEquity: false });
}

export function getBacktestRun(db, id, { includeResult = false, includeEquity = true } = {}) {
  const row = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
  return row ? toApiRun(row, { includeResult, includeEquity }) : null;
}

export function listBacktestRuns(db, { limit = 20, strategy_id: strategyId, strategy_version_id: strategyVersionId, status, underlying, interval, pnl } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
  const filters = [];
  const params = [];

  addNumberFilter(filters, params, 'strategy_id', strategyId);
  addNumberFilter(filters, params, 'strategy_version_id', strategyVersionId);
  addTextFilter(filters, params, 'status', status);
  addTextFilter(filters, params, 'underlying', underlying);
  addTextFilter(filters, params, 'interval', interval);
  if (pnl === 'positive') filters.push("CAST(json_extract(summary_json, '$.totalPnl') AS REAL) > 0");
  if (pnl === 'negative') filters.push("CAST(json_extract(summary_json, '$.totalPnl') AS REAL) < 0");
  if (pnl === 'zero') filters.push("COALESCE(CAST(json_extract(summary_json, '$.totalPnl') AS REAL), 0) = 0");

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM backtest_runs ${where} ORDER BY id DESC LIMIT ?`).all(...params, safeLimit).map((row) => toApiRun(row));
}

function addNumberFilter(filters, params, column, value) {
  if (value == null || value === '' || value === 'all') return;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return;
  filters.push(`${column} = ?`);
  params.push(parsed);
}

function addTextFilter(filters, params, column, value) {
  if (value == null || value === '' || value === 'all') return;
  filters.push(`${column} = ?`);
  params.push(String(value));
}

function toApiRun(row, { includeResult = false, includeEquity = false } = {}) {
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
  if (includeResult) {
    run.result = JSON.parse(row.result_json);
  } else if (includeEquity && row.result_json) {
    const parsed = JSON.parse(row.result_json);
    run.equity = Array.isArray(parsed.equity) ? parsed.equity : [];
  }
  return run;
}

function stripRequestForSnapshot(request) {
  const { glsAst, strategyMeta, ...rest } = request;
  return rest;
}
