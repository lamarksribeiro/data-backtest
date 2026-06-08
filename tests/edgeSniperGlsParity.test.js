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
import { listStrategyVersions } from '../src/backtestStudio/state/strategies.js';

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
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalPnl, 17.05);
  assert.equal(report.gls.totalPnl, 17.05);
});

test('edge-sniper GLS parity matches native partial take-profit and expiry PnL', () => {
  const ticks = buildPartialTakeProfitTicks();
  const report = compareEdgeSniperParity(ticks, {
    ...RELAXED_PARAMS,
    stopBid: 0.01,
    takeProfitBid: 0.92,
    takeProfitPct: 0.35,
    trailAfterBid: 0.99,
    lateExitSec: 0,
    lateExitMinBid: 0.99,
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalWins, 1);
  assert.equal(report.gls.totalWins, 1);
  assert.equal(report.native.totalPnl, 16.25);
  assert.equal(report.gls.totalPnl, 16.25);
});

test('edge-sniper GLS parity matches native stop-reverse PnL', () => {
  const ticks = buildStopReverseTicks();
  const report = compareEdgeSniperParity(ticks, {
    ...RELAXED_PARAMS,
    stopBid: 0.18,
    takeProfitBid: 0.92,
    trailAfterBid: 0.99,
    lateExitSec: 16,
    lateExitMinBid: 0.99,
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalWins, 1);
  assert.equal(report.gls.totalWins, 1);
  assert.equal(report.native.totalPnl, 9.3);
  assert.equal(report.gls.totalPnl, 9.3);
});

test('edge-sniper GLS parity matches native stop-reverse open-cost budget after partial', () => {
  const ticks = buildStopReverseBudgetModeTicks();
  const report = compareEdgeSniperParity(ticks, {
    ...RELAXED_PARAMS,
    stopBid: 0.01,
    takeProfitBid: 0.92,
    takeProfitPct: 0.35,
    trailAfterBid: 0.99,
    lateExitSec: 16,
    lateExitMinBid: 0.99,
    stopReverseBudgetMode: 'open-cost',
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalWins, 1);
  assert.equal(report.gls.totalWins, 1);
  assert.equal(report.native.totalPnl, 13.2);
  assert.equal(report.gls.totalPnl, 13.2);
});

test('edge-sniper GLS parity matches native scheduled stop-reverse distance', () => {
  const ticks = buildStopReverseTicks('condition-reverse-schedule-1');
  const report = compareEdgeSniperParity(ticks, {
    ...RELAXED_PARAMS,
    stopBid: 0.18,
    takeProfitBid: 0.92,
    trailAfterBid: 0.99,
    lateExitSec: 16,
    lateExitMinBid: 0.99,
    stopReverseMinDistanceAbs: 200,
    stopReverseDistanceSchedule: [{ minSecondsRemaining: 0, minDistanceAbs: 10 }],
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalWins, 1);
  assert.equal(report.gls.totalWins, 1);
  assert.equal(report.native.totalPnl, 9.3);
  assert.equal(report.gls.totalPnl, 9.3);
});

test('edge-sniper GLS parity does not reverse on expiration tick', () => {
  const ticks = buildExpirationNoReverseTicks();
  const report = compareEdgeSniperParity(ticks, {
    ...RELAXED_PARAMS,
    stopBid: 0.18,
    takeProfitBid: 0.92,
    trailAfterBid: 0.99,
    lateExitSec: 16,
    lateExitMinBid: 0.99,
    stopReverseMaxSecondsRemaining: 300,
    stopReverseMinSecondsRemaining: 0,
    stopReverseMinDistanceAbs: 10,
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalLosses, 1);
  assert.equal(report.gls.totalLosses, 1);
  assert.equal(report.native.totalPnl, -13.95);
  assert.equal(report.gls.totalPnl, -13.95);
});

test('edge-sniper GLS parity matches native dynamic stop PnL', () => {
  const ticks = buildDynamicStopTicks();
  const report = compareEdgeSniperParity(ticks, {
    ...RELAXED_PARAMS,
    stopReverseEnabled: false,
    stopBid: 0.18,
    dynamicStopEnabled: true,
    dynamicStopFactor: 0.8,
    dynamicStopMinBid: 0.16,
    takeProfitBid: 0.92,
    trailAfterBid: 0.99,
    lateExitSec: 16,
    lateExitMinBid: 0.99,
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalLosses, 1);
  assert.equal(report.gls.totalLosses, 1);
  assert.equal(report.native.totalPnl, -3.1);
  assert.equal(report.gls.totalPnl, -3.1);
});

test('edge-sniper GLS parity matches native model scoring with book mids', () => {
  const ticks = buildModelSensitiveTicks();
  const report = compareEdgeSniperParity(ticks, {
    minDistanceAbs: 0,
    minDistanceNearExpiry: 0,
    minDirectionalProb: 0.55,
    minEdge: 0.02,
    maxSpread: 0.99,
    minLiquidityRatio: 0.01,
    minAsk: 0.001,
    maxAsk: 0.99,
    entryWindowStart: 300,
    entryWindowEnd: 0,
    momentumSec: 4,
    slowMomentumSec: 8,
    stopReverseEnabled: false,
    takeProfitBid: 0.99,
    trailAfterBid: 0.99,
    lateExitSec: 0,
    lateExitMinBid: 0.99,
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEntries, 1);
  assert.equal(report.gls.totalEntries, 1);
  assert.equal(report.native.totalPnl, 19.754);
  assert.equal(report.gls.totalPnl, 19.754);
});

test('edge-sniper GLS parity matches native multi-event expiry and equity cap', () => {
  const ticks = buildMultiEventEquityTicks();
  const report = compareEdgeSniperParity(ticks, {
    ...RELAXED_PARAMS,
    walletSize: 20,
    maxOrderValue: 15,
    stopReverseEnabled: false,
    stopBid: 0.01,
    takeProfitBid: 0.99,
    trailAfterBid: 0.99,
    lateExitSec: 0,
    lateExitMinBid: 0.99,
  });
  assert.equal(report.match, true, JSON.stringify(report.divergences));
  assert.equal(report.native.totalEvents, 2);
  assert.equal(report.gls.totalEvents, 2);
  assert.equal(report.native.totalEntries, 2);
  assert.equal(report.gls.totalEntries, 2);
  assert.equal(report.native.totalWins, 1);
  assert.equal(report.gls.totalWins, 1);
  assert.equal(report.native.totalLosses, 1);
  assert.equal(report.gls.totalLosses, 1);
  assert.equal(report.native.totalPnl, -7.35);
  assert.equal(report.gls.totalPnl, -7.35);
});

test('seed edge-sniper-v2-gls strategy and run via lakehouse engine', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-gls-seed-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const strategy = seedEdgeSniperV2Strategy(db);
      const [version] = listStrategyVersions(db, strategy.id);
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

function buildPartialTakeProfitTicks() {
  return Array.from({ length: 12 }, (_, index) => ({
    condition_id: 'condition-partial-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    ts: `2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`,
    btc_price: 73120,
    price_to_beat: 73000,
    up_price: 0.45,
    down_price: 0.55,
    up_best_ask: 0.45,
    up_best_bid: index >= 7 ? 0.93 : 0.43,
    down_best_ask: 0.55,
    down_best_bid: 0.53,
    up_ask_px_1: 0.45,
    up_ask_sz_1: 100,
    down_ask_px_1: 0.55,
    down_ask_sz_1: 100,
  }));
}

function buildStopReverseTicks(conditionId = 'condition-reverse-1') {
  const seconds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 241, 242, 299];
  return seconds.map((second) => {
    const afterReverseSignal = second >= 241;
    return {
      condition_id: conditionId,
      event_start: '2026-05-31T00:00:00.000Z',
      event_end: '2026-05-31T00:05:00.000Z',
      ts: `2026-05-31T00:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`,
      btc_price: afterReverseSignal ? 72900 : 73120,
      price_to_beat: 73000,
      up_price: 0.45,
      down_price: 0.55,
      up_best_ask: 0.45,
      up_best_bid: afterReverseSignal ? 0.2 : 0.43,
      down_best_ask: 0.45,
      down_best_bid: 0.43,
      up_ask_px_1: 0.45,
      up_ask_sz_1: 100,
      down_ask_px_1: 0.45,
      down_ask_sz_1: 100,
    };
  });
}

function buildStopReverseBudgetModeTicks() {
  const seconds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 241, 242, 299];
  return seconds.map((second) => {
    const afterReverseSignal = second >= 241;
    return {
      condition_id: 'condition-reverse-budget-1',
      event_start: '2026-05-31T00:00:00.000Z',
      event_end: '2026-05-31T00:05:00.000Z',
      ts: `2026-05-31T00:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`,
      btc_price: afterReverseSignal ? 72900 : 73120,
      price_to_beat: 73000,
      up_price: 0.45,
      down_price: 0.55,
      up_best_ask: 0.45,
      up_best_bid: afterReverseSignal ? 0.2 : (second >= 7 ? 0.93 : 0.43),
      down_best_ask: 0.45,
      down_best_bid: 0.43,
      up_ask_px_1: 0.45,
      up_ask_sz_1: 100,
      down_ask_px_1: 0.45,
      down_ask_sz_1: 100,
    };
  });
}

function buildExpirationNoReverseTicks() {
  const seconds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 300];
  return seconds.map((second) => {
    const expirationTick = second >= 300;
    const upAsk = 0.45;
    const downAsk = 0.45;
    return {
      condition_id: 'condition-expiry-no-reverse-1',
      event_start: '2026-05-31T00:00:00.000Z',
      event_end: '2026-05-31T00:05:00.000Z',
      ts: `2026-05-31T00:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`,
      btc_price: expirationTick ? 72900 : 73120,
      price_to_beat: 73000,
      up_price: 0.45,
      down_price: 0.55,
      up_best_ask: upAsk,
      up_best_bid: expirationTick ? 0.2 : 0.43,
      down_best_ask: downAsk,
      down_best_bid: 0.43,
      up_ask_px_1: upAsk,
      up_ask_sz_1: 100,
      down_ask_px_1: downAsk,
      down_ask_sz_1: 100,
      up_book_asks: JSON.stringify([{ price: upAsk, size: 100 }]),
      down_book_asks: JSON.stringify([{ price: downAsk, size: 100 }]),
    };
  });
}

function buildDynamicStopTicks() {
  return Array.from({ length: 12 }, (_, index) => ({
    condition_id: 'condition-dynamic-stop-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    ts: `2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`,
    btc_price: 73120,
    price_to_beat: 73000,
    up_price: 0.45,
    down_price: 0.55,
    up_best_ask: 0.45,
    up_best_bid: index >= 7 ? 0.35 : 0.43,
    down_best_ask: 0.55,
    down_best_bid: 0.53,
    up_ask_px_1: 0.45,
    up_ask_sz_1: 100,
    down_ask_px_1: 0.55,
    down_ask_sz_1: 100,
  }));
}

function buildModelSensitiveTicks() {
  const cfg = {
    ptb: 73000,
    startDist: 11.82,
    step: -3.48,
    lateStep: -1.28,
    upAsk: 0.459,
    upBid: 0.258,
    downAsk: 0.419,
    downBid: 0.392,
    upPrice: 0.646,
    downPrice: 0.916,
  };
  return Array.from({ length: 20 }, (_, index) => ({
    condition_id: 'condition-model-sensitive-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    ts: `2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`,
    btc_price: cfg.ptb + cfg.startDist + (index * cfg.step) + (index > 10 ? cfg.lateStep * (index - 10) : 0),
    price_to_beat: cfg.ptb,
    up_price: cfg.upPrice,
    down_price: cfg.downPrice,
    up_best_ask: cfg.upAsk,
    up_best_bid: cfg.upBid,
    down_best_ask: cfg.downAsk,
    down_best_bid: cfg.downBid,
    up_ask_px_1: cfg.upAsk,
    up_ask_sz_1: 100,
    down_ask_px_1: cfg.downAsk,
    down_ask_sz_1: 100,
  }));
}

function buildMultiEventEquityTicks() {
  return [
    ...buildEquityEventTicks('condition-equity-1', '2026-05-31T00:00:00.000Z', 72900),
    ...buildEquityEventTicks('condition-equity-2', '2026-05-31T00:05:00.000Z', 73120),
  ];
}

function buildEquityEventTicks(conditionId, eventStart, finalBtc) {
  const eventStartMs = new Date(eventStart).getTime();
  return Array.from({ length: 12 }, (_, index) => ({
    condition_id: conditionId,
    event_start: eventStart,
    event_end: new Date(eventStartMs + 300000).toISOString(),
    ts: new Date(eventStartMs + (index * 1000)).toISOString(),
    btc_price: index >= 10 ? finalBtc : 73120,
    price_to_beat: 73000,
    up_price: 0.45,
    down_price: 0.55,
    up_best_ask: 0.45,
    up_best_bid: 0.43,
    down_best_ask: 0.55,
    down_best_bid: 0.53,
    up_ask_px_1: 0.45,
    up_ask_sz_1: 100,
    down_ask_px_1: 0.55,
    down_ask_sz_1: 100,
  }));
}
