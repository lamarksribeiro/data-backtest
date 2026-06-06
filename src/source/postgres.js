import pg from 'pg';
import { sourceBookDepthOptions } from '../state/contextOptions.js';

const { Pool } = pg;

export function createSourcePool(config) {
  if (!config.dataCollectorDatabaseUrl) {
    throw new Error('DATA_COLLECTOR_DATABASE_URL is required for sync commands');
  }

  const pool = new Pool({
    connectionString: config.dataCollectorDatabaseUrl,
    max: config.syncMaxPool ?? 2,
    statement_timeout: config.syncStatementTimeoutMs,
    application_name: 'data-backtest-sync',
  });

  pool.on('connect', (client) => {
    client.query('SET default_transaction_read_only = on').catch(() => {});
  });

  return pool;
}

export async function closeSourcePool(pool) {
  await pool.end();
}

export async function listSealedScalarPartitions(pool, opts) {
  const params = [opts.from, opts.to];
  let sql = `
    SELECT
      m.id AS market_id,
      m.underlying,
      m.type AS interval,
      (eq.event_start AT TIME ZONE 'UTC')::date::text AS dt,
      COUNT(*)::int AS events_count,
      COALESCE(SUM(eq.ticks_recorded), 0)::bigint AS expected_ticks,
      MIN(eq.coverage)::float8 AS coverage_min,
      BOOL_OR(eq.degraded)::boolean AS has_degraded,
      MAX(eq.recorded_at) AS source_quality_recorded_at_max
    FROM event_quality eq
    JOIN markets m ON m.id = eq.market_id
    WHERE eq.event_start >= $1::timestamptz
      AND eq.event_start < $2::timestamptz`;

  if (opts.maxEventEnd) {
    params.push(opts.maxEventEnd);
    sql += ` AND eq.event_end < $${params.length}::timestamptz`;
  }

  if (opts.underlying) {
    params.push(String(opts.underlying).toUpperCase());
    sql += ` AND m.underlying = $${params.length}`;
  }

  if (opts.interval) {
    params.push(marketTypeFromInterval(opts.interval));
    sql += ` AND m.type = $${params.length}`;
  }

  sql += `
    GROUP BY m.id, m.underlying, m.type, dt
    ORDER BY dt ASC, m.underlying ASC, m.type ASC`;

  if (opts.limit) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const { rows } = await pool.query(sql, params);
  return rows.map((row) => ({
    marketId: row.market_id,
    underlying: row.underlying,
    interval: intervalFromMarketType(row.interval),
    marketType: row.interval,
    dt: row.dt,
    eventsCount: Number(row.events_count || 0),
    expectedTicks: Number(row.expected_ticks || 0),
    coverageMin: row.coverage_min == null ? null : Number(row.coverage_min),
    hasDegraded: Boolean(row.has_degraded),
    sourceQualityRecordedAtMax: row.source_quality_recorded_at_max ? new Date(row.source_quality_recorded_at_max).toISOString() : null,
  }));
}

export async function getPartitionEvents(pool, partition) {
  const { rows } = await pool.query(`
    SELECT
      eq.condition_id,
      eq.market_id,
      eq.event_start,
      eq.event_end,
      eq.ticks_recorded,
      eq.coverage,
      eq.degraded,
      eq.recorded_at
    FROM event_quality eq
    WHERE eq.market_id = $1
      AND (eq.event_start AT TIME ZONE 'UTC')::date = $2::date
    ORDER BY eq.event_start ASC, eq.condition_id ASC
  `, [partition.marketId, partition.dt]);

  return rows.map((row) => ({
    conditionId: row.condition_id,
    marketId: row.market_id,
    eventStart: new Date(row.event_start).toISOString(),
    eventEnd: new Date(row.event_end).toISOString(),
    ticksRecorded: Number(row.ticks_recorded || 0),
    coverage: row.coverage == null ? null : Number(row.coverage),
    degraded: Boolean(row.degraded),
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
  }));
}

export async function getScalarTicksForEvents(pool, partition, conditionIds) {
  if (!conditionIds.length) return [];
  const { rows } = await pool.query(`
    SELECT
      t.market_id,
      $2::text AS underlying,
      $3::text AS interval,
      t.condition_id,
      t.event_start,
      e.event_end,
      t.ts,
      t.underlying_price,
      t.price_to_beat,
      t.up_price,
      t.down_price,
      t.up_best_bid,
      t.up_best_ask,
      t.down_best_bid,
      t.down_best_ask,
      eq.coverage,
      eq.degraded
    FROM ticks t
    JOIN events e ON e.market_id = t.market_id AND e.condition_id = t.condition_id
    JOIN event_quality eq ON eq.market_id = t.market_id AND eq.condition_id = t.condition_id
    WHERE t.market_id = $1
      AND t.condition_id = ANY($4::text[])
    ORDER BY t.ts ASC, t.id ASC
  `, [partition.marketId, partition.underlying, partition.interval, conditionIds]);

  return rows.map(rowToScalarTick);
}

export async function getTicksWithBooksForEvents(pool, partition, conditionIds) {
  if (!conditionIds.length) return [];
  const { rows } = await pool.query(`
    SELECT
      t.market_id,
      $2::text AS underlying,
      $3::text AS interval,
      t.condition_id,
      t.event_start,
      e.event_end,
      t.ts,
      t.underlying_price,
      t.price_to_beat,
      t.up_price,
      t.down_price,
      t.up_best_bid,
      t.up_best_ask,
      t.down_best_bid,
      t.down_best_ask,
      t.up_book_asks,
      t.up_book_bids,
      t.down_book_asks,
      t.down_book_bids,
      eq.coverage,
      eq.degraded
    FROM ticks t
    JOIN events e ON e.market_id = t.market_id AND e.condition_id = t.condition_id
    JOIN event_quality eq ON eq.market_id = t.market_id AND eq.condition_id = t.condition_id
    WHERE t.market_id = $1
      AND t.condition_id = ANY($4::text[])
    ORDER BY t.ts ASC, t.id ASC
  `, [partition.marketId, partition.underlying, partition.interval, conditionIds]);

  return rows.map(rowToBookTick);
}

export async function countTicksByEvent(pool, partition, conditionIds) {
  if (!conditionIds.length) return new Map();
  const { rows } = await pool.query(`
    SELECT condition_id, COUNT(*)::bigint AS count, MIN(ts) AS min_ts, MAX(ts) AS max_ts
    FROM ticks
    WHERE market_id = $1
      AND condition_id = ANY($2::text[])
    GROUP BY condition_id
  `, [partition.marketId, conditionIds]);

  return new Map(rows.map((row) => [row.condition_id, {
    count: Number(row.count || 0),
    minTs: row.min_ts ? new Date(row.min_ts).toISOString() : null,
    maxTs: row.max_ts ? new Date(row.max_ts).toISOString() : null,
  }]));
}

export const SUPPORTED_INTERVALS = ['5m', '15m', '1h', '4h'];

const INTERVAL_ALIASES = {
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  'crypto-updown-5m': '5m',
  'crypto-updown-15m': '15m',
  'crypto-updown-1h': '1h',
  'crypto-updown-4h': '4h',
};

const INTERVAL_TO_MARKET_TYPE = {
  '5m': 'crypto-updown-5m',
  '15m': 'crypto-updown-15m',
  '1h': 'crypto-updown-1h',
  '4h': 'crypto-updown-4h',
};

export function normalizeInterval(interval) {
  const normalized = INTERVAL_ALIASES[String(interval || '').trim().toLowerCase()];
  if (!normalized) {
    throw new Error(`Invalid interval: ${interval}. Supported: ${SUPPORTED_INTERVALS.join(', ')}`);
  }
  return normalized;
}

export function isSupportedInterval(interval) {
  try {
    normalizeInterval(interval);
    return true;
  } catch {
    return false;
  }
}

export function marketTypeFromInterval(interval) {
  return INTERVAL_TO_MARKET_TYPE[normalizeInterval(interval)];
}

export function intervalFromMarketType(type) {
  const normalized = INTERVAL_ALIASES[String(type || '').trim().toLowerCase()];
  if (!normalized) {
    throw new Error(`Invalid market type: ${type}`);
  }
  return normalized;
}

export async function listSourceBookDepths(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT m.book_depth
    FROM markets m
    ORDER BY m.book_depth ASC
  `);
  return rows.map((row) => String(row.book_depth));
}

export async function listSourceContextOptions(pool, config) {
  const [bookDepths, combinationsResult] = await Promise.all([
    listSourceBookDepths(pool),
    pool.query(`
      SELECT
        m.underlying,
        m.type AS market_type,
        m.book_depth,
        MIN((eq.event_start AT TIME ZONE 'UTC')::date)::text AS from_dt,
        MAX((eq.event_start AT TIME ZONE 'UTC')::date)::text AS to_dt,
        COUNT(DISTINCT (eq.event_start AT TIME ZONE 'UTC')::date)::int AS partitions
      FROM markets m
      JOIN event_quality eq ON eq.market_id = m.id
      GROUP BY m.underlying, m.type, m.book_depth
      ORDER BY m.underlying ASC, m.type ASC, m.book_depth ASC
    `),
  ]);

  const combinations = combinationsResult.rows.flatMap((row) => {
    if (!isSupportedInterval(row.market_type)) return [];
    return [{
      underlying: row.underlying,
      interval: intervalFromMarketType(row.market_type),
      book_depth: String(row.book_depth),
      from: row.from_dt,
      to: row.to_dt,
      partitions: Number(row.partitions || 0),
    }];
  });

  return {
    underlyings: uniqueValues(combinations.map((row) => row.underlying)),
    intervals: uniqueValues(combinations.map((row) => row.interval)).filter(isSupportedInterval),
    book_depths: sourceBookDepthOptions(config, bookDepths),
    combinations,
  };
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function numberOrNull(value) {
  if (value == null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function rowToScalarTick(row) {
  return {
    marketId: row.market_id,
    underlying: row.underlying,
    interval: row.interval,
    conditionId: row.condition_id,
    eventStart: new Date(row.event_start).toISOString(),
    eventEnd: new Date(row.event_end).toISOString(),
    ts: new Date(row.ts).toISOString(),
    underlyingPrice: numberOrNull(row.underlying_price),
    priceToBeat: numberOrNull(row.price_to_beat),
    upPrice: numberOrNull(row.up_price),
    downPrice: numberOrNull(row.down_price),
    upBestBid: numberOrNull(row.up_best_bid),
    upBestAsk: numberOrNull(row.up_best_ask),
    downBestBid: numberOrNull(row.down_best_bid),
    downBestAsk: numberOrNull(row.down_best_ask),
    coverage: numberOrNull(row.coverage),
    degraded: Boolean(row.degraded),
  };
}

function rowToBookTick(row) {
  return {
    ...rowToScalarTick(row),
    upBookAsks: normalizeJson(row.up_book_asks),
    upBookBids: normalizeJson(row.up_book_bids),
    downBookAsks: normalizeJson(row.down_book_asks),
    downBookBids: normalizeJson(row.down_book_bids),
  };
}

function normalizeJson(value) {
  if (value == null) return '[]';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
