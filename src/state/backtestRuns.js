export function createBacktestRun(db, { request, result }) {
  const inserted = db.prepare(`
    INSERT INTO backtest_runs (
      strategy, source, underlying, interval, book_depth, from_ts, to_ts, batch_size,
      params_json, ticks, batches, summary_json, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
  return getBacktestRun(db, inserted.lastInsertRowid);
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
  };
  if (includeResult) run.result = JSON.parse(row.result_json);
  return run;
}
