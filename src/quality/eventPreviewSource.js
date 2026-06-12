import { buildLiveNormalizationIndex, buildNormalizationIndexFromReport } from './eventNormalizationIndex.js';
import { buildParquetEventPreview, buildSourceEventPreview } from './eventPreview.js';
import { findLakePartitionForPreview, loadParquetScalarTicksForEvent } from './parquetEventTicks.js';
import { getScalarTicksForEvents, resolveMarketId } from '../source/postgres.js';

async function resolveNormalizationIndex(db, pool, partition, marketId, dt, underlying, interval, config) {
  let normalizationIndex = buildNormalizationIndexFromReport(partition?.quality_details?.normalization);
  const manifestNorm = partition?.quality_details?.normalization;
  const indexLooksIncomplete = manifestNorm?.events_omitted > 0
    && [...normalizationIndex.values()].filter((row) => row.action === 'omit').length < manifestNorm.events_omitted;
  if (!manifestNorm?.events_index?.length || indexLooksIncomplete) {
    normalizationIndex = await buildLiveNormalizationIndex(
      pool,
      { marketId, dt, underlying, interval },
      config,
    );
  }
  return normalizationIndex;
}

export async function resolveDualEventPreview({
  db,
  pool,
  config,
  dt,
  underlying,
  interval,
  conditionId,
}) {
  const marketId = await resolveMarketId(pool, { underlying, interval });
  if (!marketId) {
    return { ok: false, status: 404, code: 'MARKET_NOT_FOUND', message: 'Market not found in source database' };
  }

  const sourceTicks = await getScalarTicksForEvents(
    pool,
    { marketId, dt, underlying, interval },
    [conditionId],
  );
  if (!sourceTicks.length) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'No ticks found for event' };
  }

  const original = buildSourceEventPreview(sourceTicks, config);
  const { partition, dataset: lakeDataset } = findLakePartitionForPreview(db, {
    dt,
    underlying,
    interval,
    bookDepth: config.backtestBookDepth,
  });
  const normalizationIndex = await resolveNormalizationIndex(
    db,
    pool,
    partition,
    marketId,
    dt,
    underlying,
    interval,
    config,
  );
  const normMeta = normalizationIndex.get(conditionId) || {};

  let parquet = null;
  let parquet_available = false;

  if (partition?.active_path) {
    parquet_available = true;
    const parquetTicks = await loadParquetScalarTicksForEvent(db, {
      dt,
      underlying,
      interval,
      conditionId,
      partition,
      dataset: lakeDataset ?? 'scalars',
      bookDepth: config.backtestBookDepth,
    });
    parquet = buildParquetEventPreview(parquetTicks, normMeta, config);
    parquet.partition_status = partition.status;
  }

  return {
    ok: true,
    status: 200,
    body: {
      dt,
      underlying,
      interval,
      condition_id: conditionId,
      event_start: sourceTicks[0]?.eventStart ?? null,
      event_end: sourceTicks[0]?.eventEnd ?? null,
      original,
      parquet,
      parquet_available,
      partition_status: partition?.status ?? 'missing',
    },
  };
}
