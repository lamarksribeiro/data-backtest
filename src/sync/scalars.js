import { rm } from 'node:fs/promises';
import path from 'node:path';

import { buildFinalParquetPath, buildTempParquetPath, toPortablePath } from '../lake/paths.js';
import { cleanupPartitionParquetFiles } from '../lake/cleanup.js';
import { markDerivedStaleForScalars, markManifestPartitionStale, upsertManifestPartition } from '../state/manifest.js';
import { countTicksByEvent, getPartitionEvents, getScalarTicksForEvent, getScalarTicksForEvents, listSealedScalarPartitions } from '../source/postgres.js';
import { markPartitionArchiveStatusStale } from '../source/archiveApi.js';
import { createRunId, createScalarRowsChecksum, createSourceFingerprint } from './fingerprint.js';
import { writeScalarsParquet } from './duckdbParquet.js';
import { listExcludedConditionIdsForDay } from '../state/eventExclusions.js';
import { applyTickNormalization, mergeNormalizationReports } from './applyNormalization.js';
import { classifyExportQuality } from './qualityPolicy.js';
import { buildPartitionQualityDetails } from './qualityDetails.js';
import { PrepareJobCancelledError } from '../prepare/errors.js';

export async function listScalarPartitions(pool, opts) {
  return listSealedScalarPartitions(pool, opts);
}

export function incrementalRange({ now = new Date(), lookbackDays = 2, marginMinutes = 2, from = null, to = null } = {}) {
  const cutoff = new Date(now.getTime() - marginMinutes * 60_000);
  const rangeTo = to ? new Date(to) : cutoff;
  const rangeFrom = from ? new Date(from) : new Date(rangeTo.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(rangeFrom.getTime())) throw new Error(`Invalid incremental from: ${from}`);
  if (Number.isNaN(rangeTo.getTime())) throw new Error(`Invalid incremental to: ${to}`);
  if (rangeTo <= rangeFrom) throw new Error('incremental range end must be after start');
  return {
    from: rangeFrom.toISOString(),
    to: rangeTo.toISOString(),
    maxEventEnd: cutoff.toISOString(),
  };
}

export function getScalarsManifestStatus(db, partition) {
  const existing = db.prepare(`
    SELECT status, active_path, source_fingerprint FROM lake_manifest
    WHERE dataset = 'scalars' AND COALESCE(market_id, '') = COALESCE(?, '')
      AND underlying = ? AND interval = ? AND COALESCE(resolution, '') = ''
      AND COALESCE(book_depth, -1) = -1 AND dt = ?
  `).get(partition.marketId, partition.underlying, partition.interval, partition.dt);
  return existing || { status: 'missing', active_path: null };
}

export async function buildScalarsSourceFingerprint(pool, partition) {
  const events = await getPartitionEvents(pool, partition);
  const conditionIds = events.map((event) => event.conditionId);
  const counts = await countTicksByEvent(pool, partition, conditionIds);
  const eventsWithCounts = events.map((event) => {
    const actual = counts.get(event.conditionId) || { count: 0, minTs: null, maxTs: null };
    return { ...event, actualCount: actual.count, minTs: actual.minTs, maxTs: actual.maxTs };
  });
  const rows = eventsWithCounts.reduce((sum, event) => sum + event.actualCount, 0);
  const ticks = await getScalarTicksForEvents(pool, partition, conditionIds);
  const valueChecksum = createScalarRowsChecksum(ticks);
  const sourceFingerprint = createSourceFingerprint({
    dataset: 'scalars',
    ...partition,
    rows,
    valueChecksum,
    events: eventsWithCounts,
  });

  return { rows, events, eventsWithCounts, valueChecksum, sourceFingerprint };
}

export async function reconcileScalarsPartition({ config, db, pool, partition, markStale = true }) {
  const existing = getScalarsManifestStatus(db, partition);
  if (!existing.status || existing.status === 'missing') {
    return { partition, status: 'missing', stale: false, reason: 'not_in_manifest' };
  }

  const source = await buildScalarsSourceFingerprint(pool, partition);
  const stale = existing.source_fingerprint !== source.sourceFingerprint;
  let archiveStale = null;
  if (stale && markStale) {
    markScalarsPartitionStale(db, partition, 'source fingerprint changed during reconcile');
    archiveStale = await markPartitionArchiveStatusStale({
      config,
      partition,
      events: source.events,
      reason: 'source fingerprint changed during reconcile',
    });
  }

  return {
    partition,
    previousStatus: existing.status,
    previousFingerprint: existing.source_fingerprint,
    currentFingerprint: source.sourceFingerprint,
    rows: source.rows,
    stale,
    archiveStale,
  };
}

export function markScalarsPartitionStale(db, partition, reason) {
  const manifestPartition = { dataset: 'scalars', ...partition };
  const changed = markManifestPartitionStale(db, manifestPartition, reason);
  const derivedChanged = markDerivedStaleForScalars(db, partition, `parent scalars stale: ${reason || 'source changed'}`);
  return { changed, derivedChanged };
}

export function shouldProcessScalarsPartition(db, partition, opts = {}) {
  if (opts.rebuild) return { process: true, reason: 'rebuild_requested' };
  const existing = getScalarsManifestStatus(db, partition);
  if (existing.status === 'valid') return { process: false, reason: 'already_valid', existing };
  if (existing.status === 'accepted') return { process: false, reason: 'already_accepted', existing };
  if (existing.status === 'needs_review' && !opts.allowNeedsReview) {
    return { process: false, reason: 'needs_review_requires_manual_rebuild', existing };
  }
  return { process: true, reason: existing.status, existing };
}

export async function exportScalarsPartition({
  config,
  db,
  pool,
  partition,
  dryRun = false,
  rebuild = false,
  allowNeedsReview = false,
  onProgress,
  shouldCancel,
}) {
  const report = (phase, extra = {}) => {
    onProgress?.({ current: { dt: partition.dt, phase, ...extra } });
  };

  const dataset = 'scalars';
  const manifestPartition = {
    dataset,
    marketId: partition.marketId,
    underlying: partition.underlying,
    interval: partition.interval,
    dt: partition.dt,
  };

  assertNotCancelled(shouldCancel);
  const decision = shouldProcessScalarsPartition(db, partition, { rebuild, allowNeedsReview });
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
  assertNotCancelled(shouldCancel);
  const events = await getPartitionEvents(pool, partition);
  const conditionIds = events.map((event) => event.conditionId);
  report('counting_ticks');
  assertNotCancelled(shouldCancel);
  const counts = await countTicksByEvent(pool, partition, conditionIds);
  const eventsWithCounts = events.map((event) => {
    const actual = counts.get(event.conditionId) || { count: 0, minTs: null, maxTs: null };
    return { ...event, actualCount: actual.count, minTs: actual.minTs, maxTs: actual.maxTs };
  });

  const sourceRows = eventsWithCounts.reduce((sum, event) => sum + event.actualCount, 0);
  const expectedRows = eventsWithCounts.reduce((sum, event) => sum + event.ticksRecorded, 0);
  const countOnlyFingerprint = createSourceFingerprint({
    dataset,
    ...partition,
    rows: sourceRows,
    events: eventsWithCounts,
  });

  if (dryRun) {
    report('done', { rows: sourceRows });
    return {
      dryRun: true,
      partition,
      rows: sourceRows,
      expectedRows,
      eventsCount: events.length,
      status: 'valid',
      sourceFingerprint: countOnlyFingerprint,
    };
  }

  const runId = createRunId('scalars');
  const tempPath = buildTempParquetPath(config.lakeRoot, dataset, runId);
  const finalPath = buildFinalParquetPath(config.lakeRoot, manifestPartition, runId);
  report('fetching_rows');
  assertNotCancelled(shouldCancel);
  const manualExcludedConditionIds = listExcludedConditionIdsForDay(db, {
    dt: partition.dt,
    underlying: partition.underlying,
    interval: partition.interval,
    marketId: partition.marketId,
  });
  const normalized = await fetchAndNormalizeScalarTicksByEvent({
    pool,
    eventsWithCounts,
    config,
    partition,
    manualExcludedConditionIds,
    shouldCancel,
  });
  const ticks = normalized.ticks;
  const normalization = normalized.normalization;
  const actualRows = ticks.length;
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
  const valueChecksum = createScalarRowsChecksum(ticks);
  const sourceFingerprint = createSourceFingerprint({
    dataset,
    ...partition,
    rows: actualRows,
    valueChecksum,
    events: eventsWithCounts,
  });

  try {
    report('writing_parquet', { rows: actualRows });
    assertNotCancelled(shouldCancel);
    await writeScalarsParquet({ rows: ticks, tempPath, finalPath, shouldCancel });

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
    report('done', { rows: actualRows });

    return {
      partition,
      activePath: toPortablePath(finalPath),
      rows: actualRows,
      expectedRows,
      eventsCount: events.length,
      status: quality.status,
      sourceFingerprint,
      normalization,
      qualityClassifyMs: normalized.qualityClassifyMs,
    };
  } catch (err) {
    await rm(path.dirname(tempPath), { recursive: true, force: true });
    throw err;
  }
}

function assertNotCancelled(shouldCancel) {
  if (typeof shouldCancel === 'function' && shouldCancel()) {
    throw new PrepareJobCancelledError();
  }
}

async function fetchAndNormalizeScalarTicksByEvent({
  pool,
  partition,
  eventsWithCounts,
  config,
  manualExcludedConditionIds,
  shouldCancel,
}) {
  const exportTicks = [];
  const reports = [];
  let qualityClassifyMs = 0;

  for (const event of eventsWithCounts) {
    assertNotCancelled(shouldCancel);
    const rawTicks = await getScalarTicksForEvent(pool, partition, event.conditionId);
    const normalized = applyTickNormalization(rawTicks, config, {
      manualExcludedConditionIds,
      partitionEvents: [event],
    });
    exportTicks.push(...normalized.ticks);
    reports.push(normalized.normalization);
    qualityClassifyMs += normalized.qualityClassifyMs || 0;
  }

  exportTicks.sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  return {
    ticks: exportTicks,
    normalization: mergeNormalizationReports(reports),
    qualityClassifyMs,
  };
}
