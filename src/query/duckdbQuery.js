import { DuckDBInstance, quotedString } from '@duckdb/node-api';

import { requireDatasetAvailability } from './availability.js';

export async function queryTicks(db, request) {
  const dataset = request.dataset || 'backtest_ticks';
  if (!['scalars', 'backtest_ticks'].includes(dataset)) {
    throw new Error(`Unsupported tick dataset: ${dataset}`);
  }
  const availability = requireDatasetAvailability(db, { ...request, dataset });
  const tsColumn = 'ts';
  const qualityClause = request.validBacktestRows ? `
      AND underlying_price IS NOT NULL
      AND price_to_beat IS NOT NULL
      AND price_to_beat > 1000` : '';
  const sql = `
    SELECT *
    FROM read_parquet(${parquetList(availability.files)})
    WHERE CAST(${tsColumn} AS TIMESTAMP) >= CAST(${quotedString(new Date(request.from).toISOString())} AS TIMESTAMP)
      AND CAST(${tsColumn} AS TIMESTAMP) < CAST(${quotedString(new Date(request.to).toISOString())} AS TIMESTAMP)
      ${qualityClause}
    ORDER BY CAST(${tsColumn} AS TIMESTAMP) ASC, condition_id ASC
    LIMIT ${safeLimit(request.limit)}
    OFFSET ${safeOffset(request.offset)}
  `;

  return runDuckQuery(sql);
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

async function runDuckQuery(sql) {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
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
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 1000, 1), 100000);
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
