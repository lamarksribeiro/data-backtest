import { quotedString } from '@duckdb/node-api';

import { partitionDatesForRange } from '../query/availability.js';
import { getManifestPartition, upsertManifestPartition } from '../state/manifest.js';
import { buildFinalParquetPath, buildTempParquetPath, toPortablePath } from '../lake/paths.js';
import { writeParquetFromSelect } from './duckdbParquet.js';
import { BASE_SCALAR_COLUMNS } from '../query/duckdbQuery.js';

export function listValidBacktestTicksManifestPartitions(db, { from, to, underlying, interval, bookDepth }) {
  const dates = partitionDatesForRange(from, to);
  if (!dates.length) return [];
  const rows = db.prepare(`
    SELECT * FROM lake_manifest
    WHERE dataset = 'backtest_ticks'
      AND underlying = ?
      AND interval = ?
      AND book_depth = ?
      AND dt >= ?
      AND dt <= ?
      AND resolution IS NULL
      AND status IN ('valid', 'accepted')
      AND active_path IS NOT NULL
    ORDER BY dt ASC
  `).all(underlying, interval, bookDepth, dates[0], dates.at(-1));
  return rows;
}

/**
 * Deriva backtest_ticks_lite (sem book depth) a partir de backtest_ticks valido.
 */
export async function exportBacktestTicksLitePartition({
  config,
  db,
  partition,
  dryRun = false,
  rebuild = false,
}) {
  const existing = getManifestPartition(db, {
    dataset: 'backtest_ticks',
    underlying: partition.underlying,
    interval: partition.interval,
    bookDepth: partition.bookDepth,
    dt: partition.dt,
  });
  if (!existing?.active_path || !['valid', 'accepted'].includes(existing.status)) {
    return { skipped: true, reason: 'backtest_ticks_not_ready', dt: partition.dt };
  }

  const liteManifest = getManifestPartition(db, {
    dataset: 'backtest_ticks_lite',
    underlying: partition.underlying,
    interval: partition.interval,
    bookDepth: null,
    dt: partition.dt,
  });
  if (liteManifest?.status === 'valid' && !rebuild) {
    return { skipped: true, reason: 'already_valid', dt: partition.dt };
  }

  const select = BASE_SCALAR_COLUMNS.join(', ');
  const sourcePath = existing.active_path.replace(/\\/g, '/');
  const runId = `lite-${Date.now()}`;
  const litePartition = {
    dataset: 'backtest_ticks_lite',
    underlying: partition.underlying,
    interval: partition.interval,
    dt: partition.dt,
  };
  const finalPath = buildFinalParquetPath(config.lakeRoot, litePartition, runId);
  const tempPath = buildTempParquetPath(config.lakeRoot, 'backtest_ticks_lite', runId);

  if (dryRun) {
    return { dryRun: true, dt: partition.dt, wouldWrite: toPortablePath(finalPath) };
  }

  await writeParquetFromSelect({
    tempPath,
    finalPath,
    sql: `SELECT ${select} FROM read_parquet(${quotedString(sourcePath)})`,
  });

  upsertManifestPartition(db, {
    dataset: 'backtest_ticks_lite',
    underlying: partition.underlying,
    interval: partition.interval,
    bookDepth: null,
    dt: partition.dt,
    activePath: toPortablePath(finalPath),
    runId,
    rows: existing.rows,
    eventsCount: existing.events_count,
    status: 'valid',
  });

  return { ok: true, dt: partition.dt, path: toPortablePath(finalPath) };
}
