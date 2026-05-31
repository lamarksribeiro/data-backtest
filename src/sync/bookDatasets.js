import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildFinalParquetPath, buildTempParquetPath, toPortablePath } from '../lake/paths.js';
import { upsertManifestPartition } from '../state/manifest.js';
import { countTicksByEvent, getPartitionEvents, getTicksWithBooksForEvents, listSealedScalarPartitions } from '../source/postgres.js';
import { flattenBookTick } from './bookFlatten.js';
import { writeBacktestTicksParquet, writeBooksParquet } from './duckdbParquet.js';
import { createBacktestTicksRowsChecksum, createBooksRowsChecksum, createRunId, createSourceFingerprint } from './fingerprint.js';

export async function listBookPartitions(pool, opts) {
  return listSealedScalarPartitions(pool, opts);
}

export async function exportBooksPartition({ config, db, pool, partition, dryRun = false, rebuild = false, allowNeedsReview = false }) {
  return exportBookDatasetPartition({
    dataset: 'books',
    config,
    db,
    pool,
    partition,
    dryRun,
    rebuild,
    allowNeedsReview,
    transformRows: (rows) => rows,
    checksumRows: (rows) => createBooksRowsChecksum(rows),
    writeParquet: ({ rows, tempPath, finalPath }) => writeBooksParquet({ rows, tempPath, finalPath }),
  });
}

export async function exportBacktestTicksPartition({
  config,
  db,
  pool,
  partition,
  dryRun = false,
  rebuild = false,
  allowNeedsReview = false,
  bookDepth = config.backtestBookDepth,
}) {
  return exportBookDatasetPartition({
    dataset: 'backtest_ticks',
    config,
    db,
    pool,
    partition: { ...partition, bookDepth },
    dryRun,
    rebuild,
    allowNeedsReview,
    transformRows: (rows) => rows.map((row) => flattenBookTick(row, bookDepth)),
    checksumRows: (rows) => createBacktestTicksRowsChecksum(rows, bookDepth),
    writeParquet: ({ rows, tempPath, finalPath }) => writeBacktestTicksParquet({ rows, tempPath, finalPath, bookDepth }),
  });
}

function getManifestStatus(db, dataset, partition) {
  const existing = db.prepare(`
    SELECT status, active_path, source_fingerprint FROM lake_manifest
    WHERE dataset = ? AND COALESCE(market_id, '') = COALESCE(?, '')
      AND underlying = ? AND interval = ? AND COALESCE(resolution, '') = ''
      AND COALESCE(book_depth, -1) = COALESCE(?, -1) AND dt = ?
  `).get(dataset, partition.marketId, partition.underlying, partition.interval, partition.bookDepth ?? null, partition.dt);
  return existing || { status: 'missing', active_path: null, source_fingerprint: null };
}

function shouldProcess(db, dataset, partition, opts = {}) {
  if (opts.rebuild) return { process: true, reason: 'rebuild_requested' };
  const existing = getManifestStatus(db, dataset, partition);
  if (existing.status === 'valid') return { process: false, reason: 'already_valid', existing };
  if (existing.status === 'needs_review' && !opts.allowNeedsReview) {
    return { process: false, reason: 'needs_review_requires_manual_rebuild', existing };
  }
  return { process: true, reason: existing.status, existing };
}

async function exportBookDatasetPartition({
  dataset,
  config,
  db,
  pool,
  partition,
  dryRun,
  rebuild,
  allowNeedsReview,
  transformRows,
  checksumRows,
  writeParquet,
}) {
  const decision = shouldProcess(db, dataset, partition, { rebuild, allowNeedsReview });
  if (!decision.process) {
    return {
      skipped: true,
      reason: decision.reason,
      partition,
      activePath: decision.existing?.active_path ?? null,
      status: decision.existing?.status ?? 'missing',
    };
  }

  const events = await getPartitionEvents(pool, partition);
  const conditionIds = events.map((event) => event.conditionId);
  const counts = await countTicksByEvent(pool, partition, conditionIds);
  const eventsWithCounts = events.map((event) => {
    const actual = counts.get(event.conditionId) || { count: 0, minTs: null, maxTs: null };
    return { ...event, actualCount: actual.count, minTs: actual.minTs, maxTs: actual.maxTs };
  });

  const actualRows = eventsWithCounts.reduce((sum, event) => sum + event.actualCount, 0);
  const expectedRows = eventsWithCounts.reduce((sum, event) => sum + event.ticksRecorded, 0);
  const diverged = actualRows !== expectedRows;
  const status = diverged ? 'needs_review' : 'valid';

  if (dryRun) {
    return { dryRun: true, partition, rows: actualRows, expectedRows, eventsCount: events.length, status };
  }

  const runId = createRunId(dataset.replace('_', '-'));
  const manifestPartition = {
    dataset,
    marketId: partition.marketId,
    underlying: partition.underlying,
    interval: partition.interval,
    bookDepth: partition.bookDepth ?? null,
    dt: partition.dt,
  };
  const tempPath = buildTempParquetPath(config.lakeRoot, dataset, runId);
  const finalPath = buildFinalParquetPath(config.lakeRoot, manifestPartition, runId);

  const rawRows = await getTicksWithBooksForEvents(pool, partition, conditionIds);
  const rows = transformRows(rawRows);
  const valueChecksum = checksumRows(rows);
  const sourceFingerprint = createSourceFingerprint({
    dataset,
    ...partition,
    rows: actualRows,
    valueChecksum,
    events: eventsWithCounts,
  });

  upsertManifestPartition(db, {
    ...manifestPartition,
    runId,
    rows: actualRows,
    eventsCount: events.length,
    sourceTickCount: actualRows,
    sourceConditionCount: conditionIds.length,
    sourceQualityRecordedAtMax: partition.sourceQualityRecordedAtMax,
    sourceFingerprint,
    status: 'writing',
  });

  try {
    await writeParquet({ rows, tempPath, finalPath });
    const minTs = eventsWithCounts.map((event) => event.minTs).filter(Boolean).sort()[0] ?? null;
    const maxTs = eventsWithCounts.map((event) => event.maxTs).filter(Boolean).sort().at(-1) ?? null;

    upsertManifestPartition(db, {
      ...manifestPartition,
      activePath: toPortablePath(finalPath),
      runId,
      rows: actualRows,
      eventsCount: events.length,
      minTs,
      maxTs,
      coverageMin: partition.coverageMin,
      hasDegraded: partition.hasDegraded,
      sourceTickCount: actualRows,
      sourceConditionCount: conditionIds.length,
      sourceQualityRecordedAtMax: partition.sourceQualityRecordedAtMax,
      sourceFingerprint,
      status,
      error: diverged ? `actual tick count ${actualRows} differs from event_quality ${expectedRows}` : null,
    });

    await rm(path.dirname(tempPath), { recursive: true, force: true });

    return {
      partition,
      activePath: toPortablePath(finalPath),
      rows: actualRows,
      expectedRows,
      eventsCount: events.length,
      status,
      sourceFingerprint,
    };
  } catch (err) {
    await mkdir(path.dirname(tempPath), { recursive: true });
    upsertManifestPartition(db, {
      ...manifestPartition,
      runId,
      rows: actualRows,
      eventsCount: events.length,
      sourceTickCount: actualRows,
      sourceConditionCount: conditionIds.length,
      sourceQualityRecordedAtMax: partition.sourceQualityRecordedAtMax,
      sourceFingerprint,
      status: 'invalid',
      error: err.message,
    });
    throw err;
  }
}
