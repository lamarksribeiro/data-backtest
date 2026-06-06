import { DuckDBInstance, quotedString } from '@duckdb/node-api';

import { requireDatasetAvailability } from './availability.js';

const MAX_BACKTEST_ROWS = 5_000_000;

export function backtestTickSelectColumns(bookDepth = 25) {
  const cols = [
    'market_id', 'underlying', 'interval', 'condition_id', 'event_start', 'event_end', 'ts',
    'underlying_price', 'price_to_beat', 'up_price', 'down_price',
    'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
    'coverage', 'degraded', 'book_depth',
  ];
  const depth = Math.max(1, Number.parseInt(String(bookDepth), 10) || 25);
  for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
    for (let i = 1; i <= depth; i += 1) {
      cols.push(`${side}_px_${i}`, `${side}_sz_${i}`);
    }
  }
  return cols.join(', ');
}

export async function queryTicks(db, request) {
  const dataset = request.dataset || 'backtest_ticks';
  if (!['scalars', 'backtest_ticks'].includes(dataset)) {
    throw new Error(`Unsupported tick dataset: ${dataset}`);
  }
  const availability = requireDatasetAvailability(db, { ...request, dataset });
  const sql = buildTicksSql(availability, request, {
    select: dataset === 'backtest_ticks'
      ? backtestTickSelectColumns(request.bookDepth ?? 25)
      : '*',
  });
  return runDuckQuery(sql);
}

/**
 * Sessão DuckDB com uma varredura Parquet → tabela temporária em memória.
 * Batches subsequentes usam OFFSET na tabela (rápido) sem reabrir DuckDB nem reescanear Parquet.
 */
export async function openBacktestTickSession(db, request) {
  const availability = requireDatasetAvailability(db, {
    ...request,
    dataset: 'backtest_ticks',
  });
  const bookDepth = request.bookDepth ?? 25;
  const selectCols = backtestTickSelectColumns(bookDepth);
  const sourceSql = buildTicksSql(availability, {
    ...request,
    dataset: 'backtest_ticks',
  }, { select: selectCols });

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run('SET threads TO 4');
    await connection.run(`CREATE TEMP TABLE _bt_ticks AS ${sourceSql.trim()}`);
  } catch (err) {
    connection.closeSync();
    instance.closeSync();
    throw err;
  }

  return {
    bookDepth,
    async readBatch(offset, limit) {
      const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 1, 1), MAX_BACKTEST_ROWS);
      const safeOffset = Math.max(Number.parseInt(String(offset), 10) || 0, 0);
      const sql = `
        SELECT * FROM _bt_ticks
        ORDER BY CAST(ts AS TIMESTAMP) ASC, condition_id ASC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `;
      const result = await connection.runAndReadAll(sql);
      return result.getRowObjectsJS().map(jsonSafeRow);
    },
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

export async function queryCandles(db, request) {
  const availability = requireDatasetAvailability(db, { ...request, dataset: 'ohlc' });
  const sql = `
    SELECT *
    FROM read_parquet(${parquetList(availability.files)})
    WHERE CAST(bucket_ts AS TIMESTAMP) >= CAST(${quotedString(new Date(request.from).toISOString())} AS TIMESTAMP)
      AND CAST(bucket_ts AS TIMESTAMP) < CAST(${quotedString(new Date(request.to).toISOString())} AS TIMESTAMP)
    ORDER BY CAST(bucket_ts AS TIMESTAMP) ASC, condition_id ASC
    LIMIT ${safeLimit(request.limit)}
    OFFSET ${safeOffset(request.offset)}
  `;

  return runDuckQuery(sql);
}

function buildTicksSql(availability, request, { select = '*' } = {}) {
  const tsColumn = 'ts';
  const qualityClause = request.validBacktestRows ? `
      AND underlying_price IS NOT NULL
      AND price_to_beat IS NOT NULL
      AND price_to_beat > 1000` : '';
  const conditionClause = request.conditionId
    ? ` AND condition_id = ${quotedString(String(request.conditionId))}`
    : '';
  const limitClause = request.limit != null
    ? `LIMIT ${safeLimit(request.limit)} OFFSET ${safeOffset(request.offset)}`
    : '';
  return `
    SELECT ${select}
    FROM read_parquet(${parquetList(availability.files)})
    WHERE CAST(${tsColumn} AS TIMESTAMP) >= CAST(${quotedString(new Date(request.from).toISOString())} AS TIMESTAMP)
      AND CAST(${tsColumn} AS TIMESTAMP) < CAST(${quotedString(new Date(request.to).toISOString())} AS TIMESTAMP)
      ${conditionClause}
      ${qualityClause}
    ORDER BY CAST(${tsColumn} AS TIMESTAMP) ASC, condition_id ASC
    ${limitClause}
  `;
}

async function runDuckQuery(sql) {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run('SET threads TO 4');
    const result = await connection.runAndReadAll(sql);
    return result.getRowObjectsJS().map(jsonSafeRow);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function parquetList(files) {
  if (!files.length) throw new Error('No parquet files resolved from manifest');
  return `[${files.map((file) => quotedString(file)).join(', ')}]`;
}

function safeLimit(value) {
  const parsed = Number.parseInt(String(value ?? 1000), 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 1000, 1), MAX_BACKTEST_ROWS);
}

function safeOffset(value) {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Math.max(Number.isFinite(parsed) ? parsed : 0, 0);
}

function jsonSafeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonSafeValue(value)]));
}

function jsonSafeValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}
