import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildFinalParquetPath, buildTempParquetPath, toPortablePath } from '../lake/paths.js';
import { cleanupPartitionParquetFiles } from '../lake/cleanup.js';
import { upsertManifestPartition } from '../state/manifest.js';
import { countTicksByEvent, getPartitionEvents, getTicksWithBooksForEvents, listSealedScalarPartitions } from '../source/postgres.js';
import { writeBacktestTicksParquetFromBookRows, writeBooksParquet } from './duckdbParquet.js';
import { createBooksRowsChecksum, createRunId, createSourceFingerprint } from './fingerprint.js';
import { publishPartitionArchiveStatus } from '../source/archiveApi.js';
import { listExcludedConditionIdsForDay } from '../state/eventExclusions.js';
import { applyTickNormalization } from './applyNormalization.js';
import { classifyExportQuality } from './qualityPolicy.js';
import { buildPartitionQualityDetails } from './qualityDetails.js';

export async function listBookPartitions(pool, opts) {
  return listSealedScalarPartitions(pool, opts);
}

export async function exportBooksPartition({ config, db, pool, partition, dryRun = false, rebuild = false, allowNeedsReview = false, onProgress }) {
  return exportBookDatasetPartition({
    dataset: 'books',
    config,
    db,
    pool,
    partition,
    dryRun,
    rebuild,
    allowNeedsReview,
    onProgress,
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
  onProgress,
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
    onProgress,
    transformRows: null,
    checksumRows: null,
    writeParquet: ({ rows, tempPath, finalPath }) => writeBacktestTicksParquetFromBookRows({ rows, tempPath, finalPath, bookDepth }),
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
  if (existing.status === 'accepted') return { process: false, reason: 'already_accepted', existing };
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
  onProgress,
}) {
  const report = (phase, extra = {}) => {
    onProgress?.({ current: { dt: partition.dt, phase, ...extra } });
  };

  const decision = shouldProcess(db, dataset, partition, { rebuild, allowNeedsReview });
  if (!decision.process) {
    report('skipped');
    return {
      skipped: true,
      reason: decision.reason,
      partition,
      activePath: decision.existing?.active_path ?? null,
      status: decision.existing?.status ?? 'missing',
    };
  }

  report('listing_events');
  const events = await getPartitionEvents(pool, partition);
  const conditionIds = events.map((event) => event.conditionId);
  const expectedRows = events.reduce((sum, event) => sum + event.ticksRecorded, 0);

  if (dryRun) {
    report('done', { rows: expectedRows });
    return {
      dryRun: true,
      partition,
      rows: expectedRows,
      expectedRows,
      eventsCount: events.length,
      status: 'valid',
      estimateSource: 'event_quality',
    };
  }

  report('counting_ticks');
  const counts = await countTicksByEvent(pool, partition, conditionIds);
  const eventsWithCounts = events.map((event) => {
    const actual = counts.get(event.conditionId) || { count: 0, minTs: null, maxTs: null };
    return { ...event, actualCount: actual.count, minTs: actual.minTs, maxTs: actual.maxTs };
  });

  const sourceRows = eventsWithCounts.reduce((sum, event) => sum + event.actualCount, 0);

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

  report('fetching_rows');
  const rawRows = await getTicksWithBooksForEvents(pool, partition, conditionIds);
  const manualExcludedConditionIds = listExcludedConditionIdsForDay(db, {
    dt: partition.dt,
    underlying: partition.underlying,
    interval: partition.interval,
    marketId: partition.marketId,
  });
  const normalized = applyTickNormalization(rawRows, config, {
    manualExcludedConditionIds,
    partitionEvents: eventsWithCounts,
  });
  const rows = transformRows ? transformRows(normalized.ticks) : normalized.ticks;
  const normalization = normalized.normalization;
  const actualRows = rows.length;
  const quality = classifyExportQuality({
    actualRows,
    expectedRows,
    acceptMismatchRatio: config.syncAcceptCountMismatchRatio,
    normalization,
    maxDayOmitRatio: config.syncNormalizeDayOmitRatio,
  });
  const qualityDetails = buildPartitionQualityDetails({
    partition,
    events: eventsWithCounts,
    actualRows,
    expectedRows,
    quality,
    normalization,
  });
  let valueChecksum = checksumRows ? checksumRows(rows) : null;
  const countOnlyFingerprint = createSourceFingerprint({
    dataset,
    ...partition,
    rows: sourceRows,
    events: eventsWithCounts,
  });
  let sourceFingerprint = valueChecksum
    ? createSourceFingerprint({
      dataset,
      ...partition,
      rows: actualRows,
      valueChecksum,
      events: eventsWithCounts,
    })
    : countOnlyFingerprint;

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
    report('writing_parquet', { rows: actualRows });
    const writeResult = await writeParquet({ rows, tempPath, finalPath });
    if (!valueChecksum && writeResult?.valueChecksum) {
      valueChecksum = writeResult.valueChecksum;
      sourceFingerprint = createSourceFingerprint({
        dataset,
        ...partition,
        rows: actualRows,
        valueChecksum,
        events: eventsWithCounts,
      });
    }
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
      qualityDetails,
      sourceTickCount: actualRows,
      sourceConditionCount: conditionIds.length,
      sourceQualityRecordedAtMax: partition.sourceQualityRecordedAtMax,
      sourceFingerprint,
      status: quality.status,
      error: quality.error,
    });

    await rm(path.dirname(tempPath), { recursive: true, force: true });
    await cleanupPartitionParquetFiles({ db, lakeRoot: config.lakeRoot, partition: manifestPartition });

    const exportResult = {
      partition,
      activePath: toPortablePath(finalPath),
      rows: actualRows,
      expectedRows,
      eventsCount: events.length,
      status: quality.status,
      sourceFingerprint,
    };
    report('done', { rows: actualRows, path: exportResult.activePath });
    if (dataset === 'backtest_ticks') {
      exportResult.archivePublish = await publishPartitionArchiveStatus({
        config,
        partition,
        events,
        exportResult,
      });
    }
    return exportResult;
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
