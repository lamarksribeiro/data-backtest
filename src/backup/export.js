import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import { listBacktestContextOptions } from '../state/manifest.js';
import { resolveLakeActivePath } from '../lake/paths.js';
import { sha256File } from './chunker.js';

export function listBackupPartitionGroups(db) {
  const { combinations } = listBacktestContextOptions(db);
  return combinations.map((combo) => ({
    underlying: combo.underlying,
    interval: combo.interval,
    bookDepth: combo.book_depth != null ? Number(combo.book_depth) : null,
    from: combo.from,
    to: combo.to,
    partitions: combo.partitions,
  }));
}

export function listBackupPartitions(db, {
  underlying = null,
  interval = null,
  bookDepth = null,
  fromDt = null,
  toDt = null,
} = {}) {
  const params = ['backtest_ticks'];
  let sql = `
    SELECT * FROM lake_manifest
    WHERE dataset = ?
      AND status IN ('valid', 'accepted')
      AND active_path IS NOT NULL
  `;
  if (underlying) {
    sql += ' AND underlying = ?';
    params.push(String(underlying).toUpperCase());
  }
  if (interval) {
    sql += ' AND interval = ?';
    params.push(interval);
  }
  if (bookDepth != null) {
    sql += ' AND book_depth = ?';
    params.push(bookDepth);
  }
  if (fromDt) {
    sql += ' AND dt >= ?';
    params.push(fromDt);
  }
  if (toDt) {
    sql += ' AND dt <= ?';
    params.push(toDt);
  }
  sql += ' ORDER BY underlying ASC, interval ASC, book_depth ASC, dt ASC';
  return db.prepare(sql).all(...params);
}

export async function loadPartitionFileInfo(config, manifestRow) {
  const resolved = resolveLakeActivePath(config.lakeRoot, manifestRow.active_path);
  if (!resolved) throw new Error(`Missing active_path for ${manifestRow.dt}`);
  await access(resolved, constants.R_OK);
  const sha256 = await sha256File(resolved);
  const { size } = await import('node:fs/promises').then((m) => m.stat(resolved));
  return {
    manifestRow,
    resolvedPath: resolved,
    sha256,
    bytes: size,
  };
}

export function listEventExclusionsForAsset(db, { underlying, interval }) {
  return db.prepare(`
    SELECT * FROM event_exclusions
    WHERE underlying = ? AND interval = ?
    ORDER BY dt ASC, event_start ASC
  `).all(underlying, interval).map((row) => ({
    market_id: row.market_id,
    condition_id: row.condition_id,
    event_start: row.event_start,
    dt: row.dt,
    underlying: row.underlying,
    interval: row.interval,
    reason: row.reason,
    notes: row.notes,
    excluded_by: row.excluded_by,
    excluded_at: row.excluded_at,
  }));
}
