import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeBacktestTicksParquet } from '../src/sync/duckdbParquet.js';
import { createPolymarketTestAdapter, getTicksForBacktestBatches } from '../src/legacy/polymarketTestAdapter.js';

test('polymarket-test adapter returns legacy tick shape from backtest_ticks parquet', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-legacy-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const parquetPath = path.join(dir, 'lake', 'backtest_ticks', 'part-test.parquet');
      await writeBacktestTicksParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'backtest_ticks.parquet'),
        finalPath: parquetPath,
        bookDepth: 2,
        rows: [
          { ...makeBacktestTickRow('2026-05-31T00:00:00.500Z', 73400), priceToBeat: null },
          makeBacktestTickRow('2026-05-31T00:00:01.000Z', 73400),
          makeBacktestTickRow('2026-05-31T00:00:02.000Z', 73401),
          makeBacktestTickRow('2026-05-31T00:00:03.000Z', 73402),
        ],
      });
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        dt: '2026-05-31',
        activePath: toPortablePath(parquetPath),
        rows: 4,
        status: 'valid',
      });

      const adapter = createPolymarketTestAdapter(db, { underlying: 'BTC', interval: '5m', bookDepth: 2 });
      const rows = await adapter.getTicksForBacktest('2026-05-31T00:00:00.000Z', '2026-05-31T00:00:02.000Z', { limit: 10 });

      assert.equal(rows.length, 2);
      assert.equal(rows[0].btc_price, 73400);
      assert.equal(rows[0].price_to_beat, 73300);
      assert.equal(rows[0].up_best_ask, 0.52);
      assert.equal(rows[0].up_best_bid, 0.5);
      assert.deepEqual(JSON.parse(rows[0].up_book_asks), [
        { price: 0.52, size: 10 },
        { price: 0.53, size: 11 },
      ]);
      assert.equal(rows[1].ts, '2026-05-31T00:00:02.000Z');
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('polymarket-test adapter yields legacy batches with stable synthetic ids', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-legacy-batches-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const parquetPath = path.join(dir, 'lake', 'backtest_ticks', 'part-test.parquet');
      await writeBacktestTicksParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'backtest_ticks.parquet'),
        finalPath: parquetPath,
        bookDepth: 1,
        rows: [
          makeBacktestTickRow('2026-05-31T00:00:01.000Z', 73400),
          makeBacktestTickRow('2026-05-31T00:00:02.000Z', 73401),
          makeBacktestTickRow('2026-05-31T00:00:03.000Z', 73402),
        ],
      });
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 1,
        dt: '2026-05-31',
        activePath: toPortablePath(parquetPath),
        rows: 3,
        status: 'valid',
      });

      const batches = [];
      for await (const batch of getTicksForBacktestBatches(db, {
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T00:00:03.000Z',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 1,
        batchSize: 2,
      })) {
        batches.push(batch);
      }

      assert.deepEqual(batches.map((batch) => batch.length), [2, 1]);
      assert.deepEqual(batches.flat().map((row) => row.id), [1, 2, 3]);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function makeBacktestTickRow(ts, underlyingPrice) {
  return {
    marketId: 'market-1',
    underlying: 'BTC',
    interval: '5m',
    conditionId: 'condition-1',
    eventStart: '2026-05-31T00:00:00.000Z',
    eventEnd: '2026-05-31T00:05:00.000Z',
    ts,
    underlyingPrice,
    priceToBeat: 73300,
    upPrice: 0.51,
    downPrice: 0.49,
    upBestBid: 0.1,
    upBestAsk: 0.9,
    downBestBid: 0.2,
    downBestAsk: 0.8,
    coverage: 1,
    degraded: false,
    up_ask_px_1: 0.52,
    up_ask_sz_1: 10,
    up_ask_px_2: 0.53,
    up_ask_sz_2: 11,
    up_bid_px_1: 0.5,
    up_bid_sz_1: 9,
    up_bid_px_2: 0.49,
    up_bid_sz_2: 8,
    down_ask_px_1: 0.51,
    down_ask_sz_1: 7,
    down_ask_px_2: 0.52,
    down_ask_sz_2: 6,
    down_bid_px_1: 0.48,
    down_bid_sz_1: 5,
    down_bid_px_2: 0.47,
    down_bid_sz_2: 4,
  };
}
