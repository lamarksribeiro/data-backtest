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
 * Sessão de ticks do backtest com leitura única Parquet → memória.
 * Evita o overhead de múltiplas consultas com LIMIT/OFFSET e fecha a conexão do DuckDB imediatamente.
 */
export async function openBacktestTickSession(db, request) {
  const availability = requireDatasetAvailability(db, {
    ...request,
    dataset: 'backtest_ticks',
  });
  const bookDepth = request.bookDepth ?? 25;
  const jsonSafe = request.jsonSafe !== false;
  const selectCols = backtestTickSelectColumns(bookDepth);
  const sourceSql = buildTicksSql(availability, {
    ...request,
    dataset: 'backtest_ticks',
  }, { select: selectCols, order: true });

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  let rows = [];
  try {
    await connection.run('SET threads TO 4');
    const result = await connection.runAndReadAll(sourceSql);
    const rawRows = result.getRowObjectsJS();
    rows = jsonSafe ? rawRows.map(jsonSafeRow) : rawRows.map(enrichRawRow);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  return {
    bookDepth,
    async readBatch(offset, limit) {
      const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 1, 1), MAX_BACKTEST_ROWS);
      const safeOffset = Math.max(Number.parseInt(String(offset), 10) || 0, 0);
      return rows.slice(safeOffset, safeOffset + safeLimit);
    },
    close() {
      rows = []; // Libera memória
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

function buildTicksSql(availability, request, { select = '*', order = true } = {}) {
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
  const orderClause = order ? `ORDER BY CAST(${tsColumn} AS TIMESTAMP) ASC, condition_id ASC` : '';
  return `
    SELECT ${select}
    FROM read_parquet(${parquetList(availability.files)})
    WHERE CAST(${tsColumn} AS TIMESTAMP) >= CAST(${quotedString(new Date(request.from).toISOString())} AS TIMESTAMP)
      AND CAST(${tsColumn} AS TIMESTAMP) < CAST(${quotedString(new Date(request.to).toISOString())} AS TIMESTAMP)
      ${conditionClause}
      ${qualityClause}
    ${orderClause}
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
  const safe = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      const ms = value.getTime();
      safe[key] = value.toISOString();
      if (key === 'ts') safe._tsMs = ms;
      else if (key === 'event_start') safe._eventStartMs = ms;
      else if (key === 'event_end') safe._eventEndMs = ms;
    } else if (typeof value === 'bigint') {
      safe[key] = Number(value);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function enrichRawRow(row) {
  if (row.ts instanceof Date) row._tsMs = row.ts.getTime();
  else if (typeof row.ts === 'string') row._tsMs = new Date(row.ts).getTime();

  if (row.event_start instanceof Date) row._eventStartMs = row.event_start.getTime();
  else if (typeof row.event_start === 'string') row._eventStartMs = new Date(row.event_start).getTime();

  if (row.event_end instanceof Date) row._eventEndMs = row.event_end.getTime();
  else if (typeof row.event_end === 'string') row._eventEndMs = new Date(row.event_end).getTime();

  return row;
}
