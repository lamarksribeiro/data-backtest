import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { buildFinalParquetPath, buildTempParquetPath, toPortablePath } from '../lake/paths.js';
import { upsertManifestPartition } from '../state/manifest.js';
import { writeOhlcParquetFromScalars } from './duckdbParquet.js';
import { createRunId } from './fingerprint.js';

export const OHLC_RESOLUTIONS = ['1s', '5s', '1m', '5m'];

export function normalizeOhlcResolutions(value) {
  if (!value || value === true || value === 'all') return OHLC_RESOLUTIONS;
  const values = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  for (const resolution of values) {
    if (!OHLC_RESOLUTIONS.includes(resolution)) throw new Error(`Unsupported OHLC resolution: ${resolution}`);
  }
  return values;
}

export function listValidScalarManifestPartitions(db, opts = {}) {
  const params = [];
  let sql = `
    SELECT * FROM lake_manifest
    WHERE dataset = 'scalars'
      AND status IN ('valid', 'accepted')
      AND active_path IS NOT NULL`;

  if (opts.from) {
    params.push(opts.from.slice(0, 10));
    sql += ` AND dt >= $dt_from`;
  }
  if (opts.to) {
    params.push(opts.to.slice(0, 10));
    sql += ` AND dt < $dt_to`;
  }
  if (opts.underlying) {
    params.push(String(opts.underlying).toUpperCase());
    sql += ` AND underlying = $underlying`;
  }
  if (opts.interval) {
    params.push(String(opts.interval));
    sql += ` AND interval = $interval`;
  }

  sql = sql
    .replace('$dt_from', `?`)
    .replace('$dt_to', `?`)
    .replace('$underlying', `?`)
    .replace('$interval', `?`);

  sql += ` ORDER BY dt ASC, underlying ASC, interval ASC`;
  if (opts.limit) {
    params.push(opts.limit);
    sql += ` LIMIT ?`;
  }

  return db.prepare(sql).all(...params);
}

export async function exportOhlcFromScalarsPartition({ config, db, scalarPartition, resolution, dryRun = false, rebuild = false }) {
  const manifestPartition = {
    dataset: 'ohlc',
    marketId: scalarPartition.market_id,
    underlying: scalarPartition.underlying,
    interval: scalarPartition.interval,
    resolution,
    dt: scalarPartition.dt,
  };

  if (!rebuild) {
    const existing = getOhlcManifestStatus(db, manifestPartition);
    if (existing?.status === 'valid' || existing?.status === 'accepted') {
      return { skipped: true, reason: 'already_valid', partition: manifestPartition, activePath: existing.active_path };
    }
  }

  const sourceFingerprint = createOhlcSourceFingerprint(scalarPartition, resolution);

  if (dryRun) {
    return {
      dryRun: true,
      partition: manifestPartition,
      sourceScalarPath: scalarPartition.active_path,
      sourceFingerprint,
    };
  }

  const runId = createRunId(`ohlc-${resolution}`);
  const tempPath = buildTempParquetPath(config.lakeRoot, 'ohlc', runId);
  const finalPath = buildFinalParquetPath(config.lakeRoot, manifestPartition, runId);

  upsertManifestPartition(db, {
    ...manifestPartition,
    runId,
    sourceTickCount: Number(scalarPartition.rows || 0),
    sourceConditionCount: scalarPartition.source_condition_count,
    sourceQualityRecordedAtMax: scalarPartition.source_quality_recorded_at_max,
    sourceFingerprint,
    status: 'writing',
  });

  try {
    const stats = await writeOhlcParquetFromScalars({
      scalarPath: scalarPartition.active_path,
      tempPath,
      finalPath,
      resolution,
    });

    upsertManifestPartition(db, {
      ...manifestPartition,
      activePath: toPortablePath(finalPath),
      runId,
      rows: stats.rows,
      eventsCount: Number(scalarPartition.events_count || 0),
      minTs: stats.minTs,
      maxTs: stats.maxTs,
      coverageMin: scalarPartition.coverage_min,
      hasDegraded: Boolean(scalarPartition.has_degraded),
      sourceTickCount: Number(scalarPartition.rows || 0),
      sourceConditionCount: scalarPartition.source_condition_count,
      sourceQualityRecordedAtMax: scalarPartition.source_quality_recorded_at_max,
      sourceFingerprint,
      status: 'valid',
    });

    await rm(path.dirname(tempPath), { recursive: true, force: true });

    return {
      partition: manifestPartition,
      activePath: toPortablePath(finalPath),
      rows: stats.rows,
      status: 'valid',
      sourceFingerprint,
    };
  } catch (err) {
    await mkdir(path.dirname(tempPath), { recursive: true });
    upsertManifestPartition(db, {
      ...manifestPartition,
      runId,
      sourceTickCount: Number(scalarPartition.rows || 0),
      sourceConditionCount: scalarPartition.source_condition_count,
      sourceQualityRecordedAtMax: scalarPartition.source_quality_recorded_at_max,
      sourceFingerprint,
      status: 'invalid',
      error: err.message,
    });
    throw err;
  }
}

function getOhlcManifestStatus(db, partition) {
  return db.prepare(`
    SELECT status, active_path FROM lake_manifest
    WHERE dataset = 'ohlc' AND COALESCE(market_id, '') = COALESCE(?, '')
      AND underlying = ? AND interval = ? AND resolution = ?
      AND COALESCE(book_depth, -1) = -1 AND dt = ?
  `).get(partition.marketId, partition.underlying, partition.interval, partition.resolution, partition.dt);
}

function createOhlcSourceFingerprint(scalarPartition, resolution) {
  return crypto.createHash('sha256').update(JSON.stringify({
    dataset: 'ohlc',
    resolution,
    sourceDataset: 'scalars',
    sourcePath: scalarPartition.active_path,
    sourceFingerprint: scalarPartition.source_fingerprint,
    rows: Number(scalarPartition.rows || 0),
  })).digest('hex');
}
