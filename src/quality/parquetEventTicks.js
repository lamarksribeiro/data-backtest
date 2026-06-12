import { checkDatasetAvailability } from '../query/availability.js';
import { queryTicks } from '../query/duckdbQuery.js';

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

export function findScalarsPartition(db, { dt, underlying, interval }) {
  const availability = checkDatasetAvailability(db, {
    dataset: 'scalars',
    from: `${dt}T00:00:00.000Z`,
    to: nextDayIso(dt),
    underlying,
    interval,
  });
  return availability.partitions.find((row) => row.dt === dt) ?? null;
}

export async function loadParquetScalarTicksForEvent(db, { dt, underlying, interval, conditionId }) {
  const rows = await queryTicks(db, {
    dataset: 'scalars',
    underlying,
    interval,
    from: `${dt}T00:00:00.000Z`,
    to: nextDayIso(dt),
    conditionId,
    limit: 10_000,
  });
  return rows.map(parquetRowToScalarTick);
}
