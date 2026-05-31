import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeOhlcParquetFromScalars, writeScalarsParquet } from '../src/sync/duckdbParquet.js';
import { checkDatasetAvailability, partitionDatesForRange } from '../src/query/availability.js';
import { queryCandles, queryTicks } from '../src/query/duckdbQuery.js';

test('availability resolves valid active_path and reports missing partitions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-query-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      upsertManifestPartition(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        dt: '2026-05-31',
        activePath: '/lake/scalars/part.parquet',
        status: 'valid',
      });

      assert.deepEqual(partitionDatesForRange('2026-05-31T12:00:00.000Z', '2026-06-02T00:00:00.000Z'), [
        '2026-05-31',
        '2026-06-01',
      ]);

      const availability = checkDatasetAvailability(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
      });

      assert.equal(availability.ok, false);
      assert.deepEqual(availability.files, ['/lake/scalars/part.parquet']);
      assert.deepEqual(availability.missing, ['2026-06-01']);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('queryTicks reads only manifest active_path parquet files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-query-ticks-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const scalarsPath = path.join(dir, 'lake', 'scalars', 'part-test.parquet');
      await writeScalarsParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'scalars.parquet'),
        finalPath: scalarsPath,
        rows: [
          makeScalarRow('2026-05-31T00:00:01.000Z', 100),
          makeScalarRow('2026-05-31T00:00:02.000Z', 101),
        ],
      });
      upsertManifestPartition(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        dt: '2026-05-31',
        activePath: toPortablePath(scalarsPath),
        rows: 2,
        status: 'valid',
      });

      const rows = await queryTicks(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
        limit: 10,
      });

      assert.equal(rows.length, 2);
      assert.equal(rows[0].underlying_price, 100);
      assert.equal(rows[1].underlying_price, 101);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('queryCandles reads OHLC partitions resolved by resolution', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-query-candles-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const scalarsPath = path.join(dir, 'lake', 'scalars', 'part-test.parquet');
      await writeScalarsParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'scalars.parquet'),
        finalPath: scalarsPath,
        rows: [makeScalarRow('2026-05-31T00:00:01.000Z', 100), makeScalarRow('2026-05-31T00:00:02.000Z', 101)],
      });
      const ohlcPath = path.join(dir, 'lake', 'ohlc', 'part-test.parquet');
      await writeOhlcParquetFromScalars({
        scalarPath: scalarsPath,
        tempPath: path.join(dir, 'lake', '.tmp', 'ohlc.parquet'),
        finalPath: ohlcPath,
        resolution: '1s',
      });
      upsertManifestPartition(db, {
        dataset: 'ohlc',
        underlying: 'BTC',
        interval: '5m',
        resolution: '1s',
        dt: '2026-05-31',
        activePath: toPortablePath(ohlcPath),
        rows: 2,
        status: 'valid',
      });

      const rows = await queryCandles(db, {
        underlying: 'BTC',
        interval: '5m',
        resolution: '1s',
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
        limit: 10,
      });

      assert.equal(rows.length, 2);
      assert.equal(rows[0].open_underlying, 100);
      assert.equal(rows[1].close_underlying, 101);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function makeScalarRow(ts, underlyingPrice) {
  return {
    marketId: 'market-1',
    underlying: 'BTC',
    interval: '5m',
    conditionId: 'condition-1',
    eventStart: '2026-05-31T00:00:00.000Z',
    eventEnd: '2026-05-31T00:05:00.000Z',
    ts,
    underlyingPrice,
    priceToBeat: 99,
    upPrice: 0.51,
    downPrice: 0.49,
    upBestBid: 0.50,
    upBestAsk: 0.52,
    downBestBid: 0.48,
    downBestAsk: 0.50,
    coverage: 1,
    degraded: false,
  };
}
