import { checkDatasetAvailability } from '../query/availability.js';
import { queryTicksFromPartitionPath } from '../query/duckdbQuery.js';

function numberOrNull(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

export function parquetRowToScalarTick(row) {
  return {
    conditionId: row.condition_id ?? null,
    eventStart: isoTs(row.event_start),
    eventEnd: isoTs(row.event_end),
    ts: isoTs(row.ts),
    underlyingPrice: numberOrNull(row.underlying_price),
    priceToBeat: numberOrNull(row.price_to_beat),
    upPrice: numberOrNull(row.up_price),
    downPrice: numberOrNull(row.down_price),
  };
}

function nextDayIso(dt) {
  const date = new Date(`${dt}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

/** @deprecated use findLakePartitionForPreview */
export function findScalarsPartition(db, { dt, underlying, interval, bookDepth = null }) {
  const availability = checkDatasetAvailability(db, {
    dataset: 'scalars',
    from: `${dt}T00:00:00.000Z`,
    to: nextDayIso(dt),
    underlying,
    interval,
  });
  return availability.partitions.find((row) => row.dt === dt) ?? null;
}

export function findLakePartitionForPreview(db, { dt, underlying, interval, bookDepth = null }) {
  const range = {
    from: `${dt}T00:00:00.000Z`,
    to: nextDayIso(dt),
    underlying,
    interval,
  };

  const candidates = [
    { dataset: 'scalars' },
    { dataset: 'backtest_ticks', bookDepth },
  ];

  let fallback = null;
  for (const candidate of candidates) {
    const availability = checkDatasetAvailability(db, { ...range, ...candidate });
    const partition = availability.partitions.find((row) => row.dt === dt) ?? null;
    if (!partition) continue;
    if (!fallback) fallback = { partition, dataset: candidate.dataset };
    if (partition.active_path) {
      return { partition, dataset: candidate.dataset };
    }
  }

  return fallback ?? { partition: null, dataset: null };
}

export async function loadParquetScalarTicksForEvent(db, {
  dt,
  underlying,
  interval,
  conditionId,
  partition = null,
  dataset = null,
  bookDepth = null,
}) {
  let lakeDataset = dataset;
  let resolvedPartition = partition;
  if (!resolvedPartition?.active_path) {
    const found = findLakePartitionForPreview(db, { dt, underlying, interval, bookDepth });
    resolvedPartition = found.partition;
    lakeDataset = lakeDataset ?? found.dataset ?? 'scalars';
  }
  const activePath = resolvedPartition?.active_path ?? null;
  if (!activePath) return [];

  const rows = await queryTicksFromPartitionPath({
    activePath,
    from: `${dt}T00:00:00.000Z`,
    to: nextDayIso(dt),
    conditionId,
    dataset: lakeDataset ?? 'scalars',
    bookDepth,
  });
  return rows.map(parquetRowToScalarTick);
}
