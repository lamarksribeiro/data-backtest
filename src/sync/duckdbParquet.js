import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const SCALARS_TABLE_SQL = `
CREATE TABLE scalars (
  market_id VARCHAR,
  underlying VARCHAR,
  interval VARCHAR,
  condition_id VARCHAR,
  event_start VARCHAR,
  event_end VARCHAR,
  ts VARCHAR,
  underlying_price DOUBLE,
  price_to_beat DOUBLE,
  up_price DOUBLE,
  down_price DOUBLE,
  up_best_bid DOUBLE,
  up_best_ask DOUBLE,
  down_best_bid DOUBLE,
  down_best_ask DOUBLE,
  coverage DOUBLE,
  degraded BOOLEAN
)
`;

export async function writeScalarsParquet({ rows, tempPath, finalPath }) {
  await mkdir(path.dirname(tempPath), { recursive: true });
  await mkdir(path.dirname(finalPath), { recursive: true });
  await rm(tempPath, { force: true });

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(SCALARS_TABLE_SQL);
    const appender = await connection.createAppender('scalars');
    try {
      for (const row of rows) appendScalarRow(appender, row);
      appender.flushSync();
    } finally {
      appender.closeSync();
    }

    await connection.run(`COPY scalars TO ${quotedString(tempPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  await rm(finalPath, { force: true });
  await rename(tempPath, finalPath);
}

export async function writeBooksParquet({ rows, tempPath, finalPath }) {
  await writeWithDuckDb({
    rows,
    tempPath,
    finalPath,
    tableName: 'books',
    createTableSql: `
      CREATE TABLE books (
        market_id VARCHAR,
        underlying VARCHAR,
        interval VARCHAR,
        condition_id VARCHAR,
        event_start VARCHAR,
        event_end VARCHAR,
        ts VARCHAR,
        up_book_asks VARCHAR,
        up_book_bids VARCHAR,
        down_book_asks VARCHAR,
        down_book_bids VARCHAR
      )
    `,
    appendRow: appendBookRow,
  });
}

export async function writeBacktestTicksParquet({ rows, tempPath, finalPath, bookDepth }) {
  await writeWithDuckDb({
    rows,
    tempPath,
    finalPath,
    tableName: 'backtest_ticks',
    createTableSql: buildBacktestTicksTableSql(bookDepth),
    appendRow: (appender, row) => appendBacktestTickRow(appender, row, bookDepth),
  });
}

async function writeWithDuckDb({ rows, tempPath, finalPath, tableName, createTableSql, appendRow }) {
  await mkdir(path.dirname(tempPath), { recursive: true });
  await mkdir(path.dirname(finalPath), { recursive: true });
  await rm(tempPath, { force: true });

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(createTableSql);
    const appender = await connection.createAppender(tableName);
    try {
      for (const row of rows) appendRow(appender, row);
      appender.flushSync();
    } finally {
      appender.closeSync();
    }

    await connection.run(`COPY ${tableName} TO ${quotedString(tempPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  await rm(finalPath, { force: true });
  await rename(tempPath, finalPath);
}

function appendNullableDouble(appender, value) {
  if (value == null) appender.appendNull();
  else appender.appendDouble(value);
}

function appendScalarRow(appender, row) {
  appender.appendVarchar(row.marketId);
  appender.appendVarchar(row.underlying);
  appender.appendVarchar(row.interval);
  appender.appendVarchar(row.conditionId);
  appender.appendVarchar(row.eventStart);
  appender.appendVarchar(row.eventEnd);
  appender.appendVarchar(row.ts);
  appendNullableDouble(appender, row.underlyingPrice);
  appendNullableDouble(appender, row.priceToBeat);
  appendNullableDouble(appender, row.upPrice);
  appendNullableDouble(appender, row.downPrice);
  appendNullableDouble(appender, row.upBestBid);
  appendNullableDouble(appender, row.upBestAsk);
  appendNullableDouble(appender, row.downBestBid);
  appendNullableDouble(appender, row.downBestAsk);
  appendNullableDouble(appender, row.coverage);
  appender.appendBoolean(row.degraded);
  appender.endRow();
}

function appendBookRow(appender, row) {
  appender.appendVarchar(row.marketId);
  appender.appendVarchar(row.underlying);
  appender.appendVarchar(row.interval);
  appender.appendVarchar(row.conditionId);
  appender.appendVarchar(row.eventStart);
  appender.appendVarchar(row.eventEnd);
  appender.appendVarchar(row.ts);
  appender.appendVarchar(row.upBookAsks ?? '[]');
  appender.appendVarchar(row.upBookBids ?? '[]');
  appender.appendVarchar(row.downBookAsks ?? '[]');
  appender.appendVarchar(row.downBookBids ?? '[]');
  appender.endRow();
}

function buildBacktestTicksTableSql(bookDepth) {
  const bookColumns = [];
  for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
    for (let i = 1; i <= bookDepth; i += 1) {
      bookColumns.push(`${side}_px_${i} DOUBLE`);
      bookColumns.push(`${side}_sz_${i} DOUBLE`);
    }
  }

  return `
    CREATE TABLE backtest_ticks (
      market_id VARCHAR,
      underlying VARCHAR,
      interval VARCHAR,
      condition_id VARCHAR,
      event_start VARCHAR,
      event_end VARCHAR,
      ts VARCHAR,
      underlying_price DOUBLE,
      price_to_beat DOUBLE,
      up_price DOUBLE,
      down_price DOUBLE,
      up_best_bid DOUBLE,
      up_best_ask DOUBLE,
      down_best_bid DOUBLE,
      down_best_ask DOUBLE,
      coverage DOUBLE,
      degraded BOOLEAN,
      book_depth INTEGER,
      ${bookColumns.join(',\n      ')}
    )
  `;
}

function appendBacktestTickRow(appender, row, bookDepth) {
  appendScalarColumns(appender, row);
  appender.appendInteger(bookDepth);
  for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
    for (let i = 1; i <= bookDepth; i += 1) {
      appendNullableDouble(appender, row[`${side}_px_${i}`]);
      appendNullableDouble(appender, row[`${side}_sz_${i}`]);
    }
  }
  appender.endRow();
}

function appendScalarColumns(appender, row) {
  appender.appendVarchar(row.marketId);
  appender.appendVarchar(row.underlying);
  appender.appendVarchar(row.interval);
  appender.appendVarchar(row.conditionId);
  appender.appendVarchar(row.eventStart);
  appender.appendVarchar(row.eventEnd);
  appender.appendVarchar(row.ts);
  appendNullableDouble(appender, row.underlyingPrice);
  appendNullableDouble(appender, row.priceToBeat);
  appendNullableDouble(appender, row.upPrice);
  appendNullableDouble(appender, row.downPrice);
  appendNullableDouble(appender, row.upBestBid);
  appendNullableDouble(appender, row.upBestAsk);
  appendNullableDouble(appender, row.downBestBid);
  appendNullableDouble(appender, row.downBestAsk);
  appendNullableDouble(appender, row.coverage);
  appender.appendBoolean(row.degraded);
}
