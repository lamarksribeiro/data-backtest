import { markManifestPartitionStale } from './manifest.js';

export function addEventExclusion(db, {
  marketId,
  conditionId,
  eventStart,
  dt,
  underlying,
  interval,
  reason = 'manual',
  notes = null,
  excludedBy = null,
}) {
  db.prepare(`
    INSERT INTO event_exclusions (
      market_id, condition_id, event_start, dt, underlying, interval,
      reason, notes, excluded_by, excluded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(market_id, condition_id) DO UPDATE SET
      event_start = excluded.event_start,
      dt = excluded.dt,
      underlying = excluded.underlying,
      interval = excluded.interval,
      reason = excluded.reason,
      notes = excluded.notes,
      excluded_by = excluded.excluded_by,
      excluded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    marketId,
    conditionId,
    eventStart,
    dt,
    underlying,
    interval,
    reason,
    notes,
    excludedBy,
  );
}

export function removeEventExclusion(db, { marketId, conditionId }) {
  const result = db.prepare(`
    DELETE FROM event_exclusions
    WHERE market_id = ? AND condition_id = ?
  `).run(marketId, conditionId);
  return result.changes > 0;
}

export function listEventExclusionsForDay(db, { dt, underlying, interval, marketId = null }) {
  if (marketId) {
    return db.prepare(`
      SELECT * FROM event_exclusions
      WHERE dt = ? AND underlying = ? AND interval = ? AND market_id = ?
      ORDER BY event_start ASC
    `).all(dt, underlying, interval, marketId).map(mapExclusionRow);
  }
  return db.prepare(`
    SELECT * FROM event_exclusions
    WHERE dt = ? AND underlying = ? AND interval = ?
    ORDER BY event_start ASC
  `).all(dt, underlying, interval).map(mapExclusionRow);
}

export function listExcludedConditionIdsForDay(db, { dt, underlying, interval, marketId = null }) {
  return new Set(listEventExclusionsForDay(db, { dt, underlying, interval, marketId })
    .map((row) => row.conditionId));
}

export function markDayManifestStale(db, { underlying, interval, dt, marketId = null }, reason) {
  const rows = db.prepare(`
    SELECT dataset, market_id, underlying, interval, resolution, book_depth, dt
    FROM lake_manifest
    WHERE underlying = ? AND interval = ? AND dt = ?
      AND (? IS NULL OR market_id = ? OR market_id IS NULL)
      AND status NOT IN ('stale', 'writing')
  `).all(underlying, interval, dt, marketId, marketId);

  let changed = 0;
  for (const row of rows) {
    changed += markManifestPartitionStale(db, {
      dataset: row.dataset,
      marketId: row.market_id,
      underlying: row.underlying,
      interval: row.interval,
      resolution: row.resolution,
      bookDepth: row.book_depth,
      dt: row.dt,
    }, reason);
  }
  return changed;
}

function mapExclusionRow(row) {
  return {
    marketId: row.market_id,
    conditionId: row.condition_id,
    eventStart: row.event_start,
    dt: row.dt,
    underlying: row.underlying,
    interval: row.interval,
    reason: row.reason,
    notes: row.notes,
    excludedBy: row.excluded_by,
    excludedAt: row.excluded_at,
  };
}
