import { classifyTickCountQuality } from '../sync/qualityPolicy.js';

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

  const byStatusMap = Object.fromEntries(byStatus.map((row) => [row.status, Number(row.count || 0)]));
  const usable = (byStatusMap.valid || 0) + (byStatusMap.accepted || 0);
  const blocked = (byStatusMap.needs_review || 0) + (byStatusMap.invalid || 0) + (byStatusMap.stale || 0) + (byStatusMap.missing || 0);

  return {
    partitions: Number(totals.partitions || 0),
    rows: Number(totals.rows || 0),
    usable,
    warnings: byStatusMap.accepted || 0,
    blocked,
    by_status: byStatusMap,
  };
}

export function listBacktestContextOptions(db) {
  const rows = db.prepare(`
    SELECT underlying, interval, book_depth, MIN(dt) AS from_dt, MAX(dt) AS to_dt, COUNT(*) AS partitions
    FROM lake_manifest
    WHERE dataset = 'backtest_ticks'
      AND status IN ('valid', 'accepted')
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

export function acceptManifestPartition(db, partition, reason = '') {
  const existing = getManifestPartition(db, partition);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!existing.active_path) return { ok: false, reason: 'missing_active_path' };
  if (!['needs_review', 'stale', 'invalid'].includes(existing.status)) {
    return { ok: false, reason: 'unsupported_status', status: existing.status };
  }

  const note = reason?.trim() || 'accepted manually despite quality warning';
  const previous = existing.error ? `Original: ${existing.error}` : 'Original: no error recorded';
  db.prepare(`
    UPDATE lake_manifest
    SET status = 'accepted', verified_at = ?, error = ?
    WHERE id = ?
  `).run(new Date().toISOString(), `Accepted: ${note}. ${previous}`, existing.id);
  return { ok: true, partition: getManifestPartition(db, partition) };
}

export function revokeAcceptedManifestPartition(db, partition, reason = '') {
  const existing = getManifestPartition(db, partition);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'accepted') return { ok: false, reason: 'unsupported_status', status: existing.status };

  const note = reason?.trim() || 'manual acceptance revoked';
  db.prepare(`
    UPDATE lake_manifest
    SET status = 'needs_review', verified_at = NULL, error = ?
    WHERE id = ?
  `).run(`Acceptance revoked: ${note}. ${existing.error || ''}`.trim(), existing.id);
  return { ok: true, partition: getManifestPartition(db, partition) };
}

export function acceptEligibleReviewPartitions(db, opts, acceptMismatchRatio) {
  const params = [opts.dataset, opts.underlying, opts.interval, opts.fromDt, opts.toDt];
  let sql = `
    SELECT * FROM lake_manifest
    WHERE dataset = ?
      AND underlying = ?
      AND interval = ?
      AND dt >= ?
      AND dt <= ?
      AND status = 'needs_review'
      AND active_path IS NOT NULL
      AND error LIKE '%differs from event_quality%'`;

  if (opts.resolution) {
    params.push(opts.resolution);
    sql += ` AND resolution = ?`;
  } else {
    sql += ` AND resolution IS NULL`;
  }

  if (opts.bookDepth != null) {
    params.push(opts.bookDepth);
    sql += ` AND book_depth = ?`;
  } else {
    sql += ` AND book_depth IS NULL`;
  }

  const rows = db.prepare(sql).all(...params);
  const accepted = [];
  const skipped = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const expectedRows = expectedRowsFromError(row.error);
    const actualRows = Number(row.rows ?? row.source_tick_count ?? 0);
    if (expectedRows == null) {
      skipped.push({ id: row.id, dt: row.dt, reason: 'expected_rows_not_found' });
      continue;
    }

    const quality = classifyTickCountQuality({ actualRows, expectedRows, acceptMismatchRatio });
    if (quality.status !== 'accepted') {
      skipped.push({ id: row.id, dt: row.dt, reason: quality.status, error: quality.error });
      continue;
    }

    db.prepare(`
      UPDATE lake_manifest
      SET status = 'accepted', verified_at = ?, error = ?
      WHERE id = ?
    `).run(now, `Accepted automatically during manifest recheck: ${quality.error}. Original: ${row.error}`, row.id);
    accepted.push({ id: row.id, dt: row.dt, rows: actualRows, expectedRows });
  }

  return { ok: true, accepted, skipped };
}

export function getManifestPartition(db, partition) {
  return db.prepare(`
    SELECT * FROM lake_manifest
    WHERE dataset = ? AND COALESCE(market_id, '') = COALESCE(?, '')
      AND underlying = ? AND interval = ?
      AND COALESCE(resolution, '') = COALESCE(?, '')
      AND COALESCE(book_depth, -1) = COALESCE(?, -1)
      AND dt = ?
  `).get(
    partition.dataset,
    partition.marketId ?? null,
    partition.underlying,
    partition.interval,
    partition.resolution ?? null,
    partition.bookDepth ?? null,
    partition.dt,
  );
}

function expectedRowsFromError(error) {
  const match = String(error || '').match(/event_quality\s+(\d+)/);
  return match ? Number(match[1]) : null;
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
    ['valid', 'accepted'].includes(entry.status) ? (entry.verifiedAt ?? now) : (entry.verifiedAt ?? null),
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
