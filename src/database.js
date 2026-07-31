import 'dotenv/config';

import pg from 'pg';

const { Pool } = pg;

const DEFAULT_BATCH_SIZE = 50_000;
const DEFAULT_FROM = '2026-05-04T15:00:00.000Z';

/**
 * Compatibility surface for research scripts ported from polymarket-test.
 *
 * The main data-backtest application reads Parquet through DuckDB. This module
 * intentionally targets the legacy local `goldenlens.ticks` source requested by
 * standalone quantitative labs. Every batch iterator uses a READ ONLY
 * transaction and keyset pagination; it never writes to the source database.
 */
export const pool = new Pool({
  connectionString: resolveDatabaseUrl(),
  max: 2,
  statement_timeout: 120_000,
  application_name: 'data-backtest-research',
});

export async function closeDatabasePool() {
  await pool.end();
}

export async function getBacktestRange(from = DEFAULT_FROM) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`
      SELECT
        COUNT(*)::bigint AS ticks,
        COUNT(DISTINCT condition_id)::bigint AS events,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts,
        MIN(event_start) AS first_event_start,
        MAX(event_start) AS last_event_start
      FROM ticks
      WHERE ts >= $1::timestamptz
    `, [normalizeIso(from, 'from')]);
    await client.query('COMMIT');
    return mapRangeRow(rows[0]);
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Legacy-compatible signature:
 *   getTicksForBacktestBatches(from, to, batchSize)
 *   getTicksForBacktestBatches(from, to, { batchSize, bookMode })
 *
 * `bookMode=top` returns the executable first JSONB level for each of the four
 * books. It is deliberately not the scalar best_* metadata, which can be stale.
 * `bookMode=full` returns every recorded level.
 */
export async function* getTicksForBacktestBatches(
  from = DEFAULT_FROM,
  to = new Date().toISOString(),
  batchSizeOrOptions = DEFAULT_BATCH_SIZE,
) {
  const options = typeof batchSizeOrOptions === 'object' && batchSizeOrOptions != null
    ? batchSizeOrOptions
    : { batchSize: batchSizeOrOptions };
  const batchSize = normalizeBatchSize(options.batchSize);
  const bookMode = options.bookMode === 'full' ? 'full' : 'top';
  const effectiveTo = to || '2099-12-31T23:59:59.999Z';
  const normalizedFrom = normalizeIso(from, 'from');
  const normalizedTo = normalizeIso(effectiveTo, 'to');
  const client = await pool.connect();

  let cursorTs = normalizedFrom;
  let cursorId = 0;
  try {
    await client.query('BEGIN READ ONLY');
    while (true) {
      const { rows } = await client.query(
        bookMode === 'full' ? FULL_BOOK_QUERY : TOP_BOOK_QUERY,
        [normalizedFrom, normalizedTo, cursorTs, cursorId, batchSize],
      );
      if (!rows.length) break;

      const batch = rows.map((row) => mapTickRow(row, bookMode));
      yield batch;

      const last = rows.at(-1);
      cursorTs = toIso(last.ts);
      cursorId = Number(last.id);
      if (rows.length < batchSize) break;
    }
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

const BASE_COLUMNS = `
  id,
  event_start,
  condition_id,
  ts,
  btc_price,
  btc_binance,
  price_to_beat,
  up_price,
  down_price,
  up_best_bid AS scalar_up_best_bid,
  up_best_ask AS scalar_up_best_ask,
  down_best_bid AS scalar_down_best_bid,
  down_best_ask AS scalar_down_best_ask`;

const RANGE_WHERE = `
  ts >= $1::timestamptz
  AND ts <= $2::timestamptz
  AND (ts, id) > ($3::timestamptz, $4::bigint)
  ORDER BY ts ASC, id ASC
  LIMIT $5`;

const TOP_BOOK_QUERY = `
  SELECT
    ${BASE_COLUMNS},
    (up_book_asks->0->>'price')::float8 AS book_up_best_ask,
    (up_book_asks->0->>'size')::float8 AS book_up_best_ask_size,
    (up_book_bids->0->>'price')::float8 AS book_up_best_bid,
    (up_book_bids->0->>'size')::float8 AS book_up_best_bid_size,
    (down_book_asks->0->>'price')::float8 AS book_down_best_ask,
    (down_book_asks->0->>'size')::float8 AS book_down_best_ask_size,
    (down_book_bids->0->>'price')::float8 AS book_down_best_bid,
    (down_book_bids->0->>'size')::float8 AS book_down_best_bid_size
  FROM ticks
  WHERE ${RANGE_WHERE}`;

const FULL_BOOK_QUERY = `
  SELECT
    ${BASE_COLUMNS},
    up_book_asks,
    up_book_bids,
    down_book_asks,
    down_book_bids
  FROM ticks
  WHERE ${RANGE_WHERE}`;

function mapTickRow(row, bookMode) {
  const upAsks = bookMode === 'full'
    ? normalizeLevels(row.up_book_asks, 'ask')
    : topLevel(row.book_up_best_ask, row.book_up_best_ask_size);
  const upBids = bookMode === 'full'
    ? normalizeLevels(row.up_book_bids, 'bid')
    : topLevel(row.book_up_best_bid, row.book_up_best_bid_size);
  const downAsks = bookMode === 'full'
    ? normalizeLevels(row.down_book_asks, 'ask')
    : topLevel(row.book_down_best_ask, row.book_down_best_ask_size);
  const downBids = bookMode === 'full'
    ? normalizeLevels(row.down_book_bids, 'bid')
    : topLevel(row.book_down_best_bid, row.book_down_best_bid_size);
  const eventStart = toIso(row.event_start);
  const eventEnd = new Date(Date.parse(eventStart) + 300_000).toISOString();

  return {
    id: Number(row.id),
    event_start: eventStart,
    event_end: eventEnd,
    condition_id: row.condition_id,
    ts: toIso(row.ts),
    btc_price: finiteOrNull(row.btc_price),
    btc_binance: finiteOrNull(row.btc_binance),
    price_to_beat: finiteOrNull(row.price_to_beat),
    up_price: finiteOrNull(row.up_price),
    down_price: finiteOrNull(row.down_price),
    up_best_bid: bestLevelPrice(upBids),
    up_best_ask: bestLevelPrice(upAsks),
    down_best_bid: bestLevelPrice(downBids),
    down_best_ask: bestLevelPrice(downAsks),
    scalar_up_best_bid: finiteOrNull(row.scalar_up_best_bid),
    scalar_up_best_ask: finiteOrNull(row.scalar_up_best_ask),
    scalar_down_best_bid: finiteOrNull(row.scalar_down_best_bid),
    scalar_down_best_ask: finiteOrNull(row.scalar_down_best_ask),
    up_book_asks: upAsks,
    up_book_bids: upBids,
    down_book_asks: downAsks,
    down_book_bids: downBids,
  };
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const source = process.env.DATA_COLLECTOR_DATABASE_URL || process.env.SOURCE_DATABASE_URL;
  if (!source) {
    throw new Error('DATABASE_URL is required for legacy PostgreSQL research labs');
  }
  const url = new URL(source);
  url.pathname = '/goldenlens';
  return url.toString();
}

function normalizeLevels(raw, side) {
  const levels = Array.isArray(raw) ? raw : [];
  return levels
    .map((level) => ({
      price: finiteOrNull(level?.price),
      size: finiteOrNull(level?.size),
    }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort(side === 'bid'
      ? (left, right) => right.price - left.price
      : (left, right) => left.price - right.price);
}

function topLevel(price, size) {
  const normalizedPrice = finiteOrNull(price);
  const normalizedSize = finiteOrNull(size);
  if (!(normalizedPrice > 0 && normalizedPrice < 1 && normalizedSize > 0)) return [];
  return [{ price: normalizedPrice, size: normalizedSize }];
}

function bestLevelPrice(levels) {
  return levels.length ? levels[0].price : null;
}

function mapRangeRow(row) {
  return {
    ticks: Number(row?.ticks || 0),
    events: Number(row?.events || 0),
    firstTs: row?.first_ts ? toIso(row.first_ts) : null,
    lastTs: row?.last_ts ? toIso(row.last_ts) : null,
    firstEventStart: row?.first_event_start ? toIso(row.first_event_start) : null,
    lastEventStart: row?.last_event_start ? toIso(row.last_event_start) : null,
  };
}

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_BATCH_SIZE), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH_SIZE;
  return Math.min(100_000, Math.max(1, parsed));
}

function normalizeIso(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${label}: ${value}`);
  return date.toISOString();
}

function toIso(value) {
  return new Date(value).toISOString();
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function safeRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original error.
  }
}
