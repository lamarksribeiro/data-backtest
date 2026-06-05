const LIST_LIMIT = 100;

export function listManifest(db, opts = {}) {
  const limit = Math.min(Math.max(Number.parseInt(String(opts.limit ?? LIST_LIMIT), 10) || LIST_LIMIT, 1), 500);
  const status = opts.status ? String(opts.status) : null;

  if (status) {
    return db.prepare(`
      SELECT * FROM lake_manifest
      WHERE status = ?
      ORDER BY dt DESC, dataset ASC, underlying ASC, interval ASC, id DESC
      LIMIT ?
    `).all(status, limit);
  }

  return db.prepare(`
    SELECT * FROM lake_manifest
    ORDER BY dt DESC, dataset ASC, underlying ASC, interval ASC, id DESC
    LIMIT ?
  `).all(limit);
}

export function manifestStats(db) {
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM lake_manifest
    GROUP BY status
    ORDER BY status ASC
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(*) AS partitions, COALESCE(SUM(rows), 0) AS rows
    FROM lake_manifest
  `).get();

  return {
    partitions: Number(totals.partitions || 0),
    rows: Number(totals.rows || 0),
    by_status: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.count || 0)])),
  };
}

export function listBacktestContextOptions(db) {
  const rows = db.prepare(`
    SELECT underlying, interval, book_depth, MIN(dt) AS from_dt, MAX(dt) AS to_dt, COUNT(*) AS partitions
    FROM lake_manifest
    WHERE dataset = 'backtest_ticks'
      AND status = 'valid'
      AND active_path IS NOT NULL
    GROUP BY underlying, interval, book_depth
    ORDER BY underlying ASC, interval ASC, book_depth ASC
  `).all();

  return {
    underlyings: unique(rows.map((row) => row.underlying)),
    intervals: unique(rows.map((row) => row.interval)),
    book_depths: unique(rows.map((row) => row.book_depth).filter((value) => value != null).map(String)),
    combinations: rows.map((row) => ({
      underlying: row.underlying,
      interval: row.interval,
      book_depth: row.book_depth != null ? String(row.book_depth) : null,
      from: row.from_dt,
      to: row.to_dt,
      partitions: Number(row.partitions || 0),
    })),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

export function upsertManifestPartition(db, entry) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO lake_manifest (
      dataset, market_id, underlying, interval, resolution, book_depth, dt,
      active_path, run_id, rows, events_count, min_ts, max_ts, coverage_min,
      has_degraded, source_tick_count, source_condition_count,
      source_quality_recorded_at_max, source_fingerprint, status, verified_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dataset, COALESCE(market_id, ''), underlying, interval, COALESCE(resolution, ''), COALESCE(book_depth, -1), dt)
    DO UPDATE SET
      active_path = excluded.active_path,
      run_id = excluded.run_id,
      rows = excluded.rows,
      events_count = excluded.events_count,
      min_ts = excluded.min_ts,
      max_ts = excluded.max_ts,
      coverage_min = excluded.coverage_min,
      has_degraded = excluded.has_degraded,
      source_tick_count = excluded.source_tick_count,
      source_condition_count = excluded.source_condition_count,
      source_quality_recorded_at_max = excluded.source_quality_recorded_at_max,
      source_fingerprint = excluded.source_fingerprint,
      status = excluded.status,
      verified_at = excluded.verified_at,
      error = excluded.error
  `);

  stmt.run(
    entry.dataset,
    entry.marketId ?? null,
    entry.underlying,
    entry.interval,
    entry.resolution ?? null,
    entry.bookDepth ?? null,
    entry.dt,
    entry.activePath ?? null,
    entry.runId ?? null,
    entry.rows ?? 0,
    entry.eventsCount ?? 0,
    entry.minTs ?? null,
    entry.maxTs ?? null,
    entry.coverageMin ?? null,
    entry.hasDegraded ? 1 : 0,
    entry.sourceTickCount ?? null,
    entry.sourceConditionCount ?? null,
    entry.sourceQualityRecordedAtMax ?? null,
    entry.sourceFingerprint ?? null,
    entry.status ?? 'pending',
    entry.status === 'valid' ? (entry.verifiedAt ?? now) : (entry.verifiedAt ?? null),
    entry.error ?? null,
  );
}

export function markManifestPartitionStale(db, partition, reason) {
  const result = db.prepare(`
    UPDATE lake_manifest
    SET status = 'stale', error = ?, verified_at = NULL
    WHERE dataset = ?
      AND (? IS NULL OR market_id = ?)
      AND underlying = ?
      AND interval = ?
      AND COALESCE(resolution, '') = COALESCE(?, '')
      AND COALESCE(book_depth, -1) = COALESCE(?, -1)
      AND dt = ?
      AND status != 'stale'
  `).run(
    reason || 'source changed',
    partition.dataset,
    partition.marketId ?? null,
    partition.marketId ?? null,
    partition.underlying,
    partition.interval,
    partition.resolution ?? null,
    partition.bookDepth ?? null,
    partition.dt,
  );

  return result.changes || 0;
}

export function markDerivedStaleForScalars(db, partition, reason) {
  const result = db.prepare(`
    UPDATE lake_manifest
    SET status = 'stale', error = ?, verified_at = NULL
    WHERE dataset = 'ohlc'
      AND (? IS NULL OR market_id = ?)
      AND underlying = ?
      AND interval = ?
      AND dt = ?
      AND status != 'stale'
  `).run(
    reason || 'source scalars changed',
    partition.marketId ?? null,
    partition.marketId ?? null,
    partition.underlying,
    partition.interval,
    partition.dt,
  );
  return result.changes || 0;
}
