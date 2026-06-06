import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeBacktestTicksParquet } from '../src/sync/duckdbParquet.js';
import { runBacktest } from '../src/backtest/engine.js';

test('native edge-sniper-v2 backtest runs from manifest backtest_ticks parquet', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-native-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const parquetPath = path.join(dir, 'lake', 'backtest_ticks', 'part-test.parquet');
      await writeBacktestTicksParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'backtest_ticks.parquet'),
        finalPath: parquetPath,
        bookDepth: 2,
        rows: Array.from({ length: 12 }, (_, index) => makeBacktestTickRow(`2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`, 73400 + index)),
      });
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        dt: '2026-05-31',
        activePath: toPortablePath(parquetPath),
        rows: 12,
        status: 'valid',
      });

      const result = await runBacktest(db, {
        strategy: 'edge-sniper-v2',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T00:00:12.000Z',
        batchSize: 5,
      });

      assert.equal(result.strategy, 'EDGE_SNIPER_V2');
      assert.equal(result.source, 'lakehouse');
      assert.equal(result.ticks, 12);
      assert.equal(result.batches, 3); // fatiamento em memória após leitura única
      assert.equal(result.summary.totalEvents, 1);
      assert.equal(result.summary.totalEntries, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].reason, 'no_entry');
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
    priceToBeat: underlyingPrice,
    upPrice: 0.51,
    downPrice: 0.49,
    upBestBid: 0.5,
    upBestAsk: 0.52,
    downBestBid: 0.48,
    downBestAsk: 0.5,
    coverage: 1,
    degraded: false,
    up_ask_px_1: 0.52,
    up_ask_sz_1: 50,
    up_ask_px_2: 0.53,
    up_ask_sz_2: 50,
    up_bid_px_1: 0.5,
    up_bid_sz_1: 50,
    up_bid_px_2: 0.49,
    up_bid_sz_2: 50,
    down_ask_px_1: 0.51,
    down_ask_sz_1: 50,
    down_ask_px_2: 0.52,
    down_ask_sz_2: 50,
    down_bid_px_1: 0.48,
    down_bid_sz_1: 50,
    down_bid_px_2: 0.47,
    down_bid_sz_2: 50,
  };
}
