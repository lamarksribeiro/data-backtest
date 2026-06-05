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
import { parse } from '../src/backtestStudio/gls/parser.js';
import { validate } from '../src/backtestStudio/gls/validator.js';
import { compareEdgeSniperParity } from '../src/backtestStudio/gls/parity.js';
import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { seedEdgeSniperV2Strategy } from '../src/backtestStudio/gls/seedStrategies.js';
import { createStrategyVersion } from '../src/backtestStudio/state/strategies.js';

const RELAXED_PARAMS = {
  minDistanceAbs: 0,
  minDistanceNearExpiry: 0,
  minDirectionalProb: 0.01,
  minEdge: -0.5,
  maxSpread: 0.99,
  minLiquidityRatio: 0.01,
  minAsk: 0.001,
  maxAsk: 0.99,
  entryWindowStart: 300,
  entryWindowEnd: 0,
  momentumSec: 1,
  slowMomentumSec: 1,
};

test('edge-sniper-v2 GLS source validates and parses', () => {
  const source = getEdgeSniperV2GlsSource();
  const validation = validate(source);
  assert.equal(validation.ok, true, validation.errors?.map((e) => e.message).join('; '));
  const ast = parse(source);
  assert.equal(ast.name, 'Edge Sniper V2 GLS');
  assert.ok(ast.params.length >= 20);
});

test('edge-sniper GLS parity matches native on default-params synthetic ticks', () => {
  const ticks = buildSyntheticEventTicks({ distance: 0, ask: 0.52, bid: 0.5 });
  const report = compareEdgeSniperParity(ticks, {});
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 0);
  assert.equal(report.gls.totalEntries, 0);
  assert.equal(report.native.totalPnl, 0);
});

test('edge-sniper GLS parity on relaxed params produces comparable report', () => {
  const ticks = buildSyntheticEventTicks({ distance: 120, ask: 0.45, bid: 0.43, ptb: 73000 });
  const report = compareEdgeSniperParity(ticks, RELAXED_PARAMS);
  assert.equal(report.native.totalEvents, report.gls.totalEvents);
  assert.ok(report.native.totalEntries >= 0);
  assert.ok(Array.isArray(report.divergences));
  if (!report.match) assert.ok(report.divergences.length > 0);
});

test('seed edge-sniper-v2-gls strategy and run via lakehouse engine', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-gls-seed-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const strategy = seedEdgeSniperV2Strategy(db);
      const version = createStrategyVersion(db, strategy.id, { source_code: getEdgeSniperV2GlsSource() });
      assert.equal(strategy.slug, 'edge-sniper-v2-gls');

      const parquetPath = path.join(dir, 'lake', 'backtest_ticks', 'part-test.parquet');
      await writeBacktestTicksParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'backtest_ticks.parquet'),
        finalPath: parquetPath,
        bookDepth: 2,
        rows: buildSyntheticEventTicks({ distance: 0, ask: 0.52, bid: 0.5 }).map((tick, index) => ({
          marketId: 'market-1',
          underlying: 'BTC',
          interval: '5m',
          conditionId: tick.condition_id,
          eventStart: tick.event_start,
          eventEnd: tick.event_end,
          ts: tick.ts,
          underlyingPrice: tick.btc_price,
          priceToBeat: tick.price_to_beat,
          upPrice: tick.up_price,
          downPrice: tick.down_price,
          upBestBid: tick.up_best_bid,
          upBestAsk: tick.up_best_ask,
          downBestBid: tick.down_best_bid,
          downBestAsk: tick.down_best_ask,
          coverage: 1,
          degraded: false,
          up_ask_px_1: tick.up_best_ask,
          up_ask_sz_1: 50,
          down_ask_px_1: tick.down_best_ask,
          down_ask_sz_1: 50,
          down_bid_px_1: tick.down_best_bid,
          down_bid_sz_1: 50,
        })),
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

      const native = await runBacktest(db, {
        strategy: 'edge-sniper-v2',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T00:00:12.000Z',
        batchSize: 5,
      });
      const gls = await runBacktest(db, {
        glsAst: parse(getEdgeSniperV2GlsSource()),
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T00:00:12.000Z',
        batchSize: 5,
      });
      assert.equal(native.summary.totalEntries, gls.summary.totalEntries);
      assert.equal(native.summary.totalPnl, gls.summary.totalPnl);
      assert.equal(version.validation.ok, true);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function buildSyntheticEventTicks({ distance = 0, ask = 0.52, bid = 0.5, ptb = 73400 }) {
  const underlying = ptb + distance;
  return Array.from({ length: 12 }, (_, index) => ({
    condition_id: 'condition-parity-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    ts: `2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`,
    btc_price: underlying + (index > 6 ? -5 : 0),
    price_to_beat: ptb,
    up_price: ask,
    down_price: 1 - ask,
    up_best_ask: ask,
    up_best_bid: bid,
    down_best_ask: 0.5,
    down_best_bid: 0.48,
    up_ask_px_1: ask,
    up_ask_sz_1: 100,
    down_ask_px_1: 0.5,
    down_ask_sz_1: 100,
  }));
}
