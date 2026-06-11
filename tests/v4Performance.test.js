import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { analyzeStrategyParallelism } from '../src/backtestStudio/gls/compiler.js';
import { createGlsBacktestRunner } from '../src/backtestStudio/gls/runtime.js';
import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { createColumnSetBuilder, columnSetToShared, wrapSharedColumnSet } from '../src/backtest/columnStore.js';
import { runParallelEventSlices } from '../src/backtest/eventPool.js';
import { runBacktestSweep } from '../src/backtest/sweep.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeBacktestTicksParquet } from '../src/sync/duckdbParquet.js';

const SIMPLE = `
strategy "Parallel Safe" {
  param minDistanceAbs = 10
  param maxAsk = 0.6
  param budget = 10

  onEventStart(event) { state.entered = false }

  onTick(tick, event) {
    let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let ask = book.ask(side, tick)
    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      enter(side, { price: ask, budget: params.budget, reason: "entry" })
      state.entered = true
    }
  }

  onEventEnd(event) { closeOpenPosition({ reason: "event_end" }) }
}
`;

test('analyzeStrategyParallelism flags runState usage', () => {
  const edge = parse(getEdgeSniperV2GlsSource());
  assert.equal(analyzeStrategyParallelism(edge).parallelSafe, false);

  const simple = parse(SIMPLE);
  assert.equal(analyzeStrategyParallelism(simple).parallelSafe, true);
});

test('fast-run matches full summary on simple strategy', () => {
  const ast = parse(SIMPLE);
  const columnSet = buildMultiEventColumnSet();

  const run = (fastRun) => {
    const runner = createGlsBacktestRunner(ast, {}, { executionMode: 'compiled-soa', bookDepth: 25, fastRun });
    runner.bindColumnSet(columnSet);
    for (const ev of columnSet.events) {
      runner.beginEvent(ev);
      for (let i = ev.startRow; i < ev.endRow; i += 1) runner.processIndex(i);
      runner.endEvent(ev);
    }
    return runner.finish();
  };

  const full = run(false);
  const fast = run(true);
  assert.equal(fast.summary.totalPnl, full.summary.totalPnl);
  assert.equal(fast.summary.totalEvents, full.summary.totalEvents);
  assert.equal(fast.summary.totalEntries, full.summary.totalEntries);
  assert.equal(fast.events.length, full.events.length);
});

test('fast-run keeps order data for polymarket fees', () => {
  const ast = parse(SIMPLE);
  const columnSet = buildMultiEventColumnSet();
  const runner = createGlsBacktestRunner(ast, {}, { executionMode: 'compiled-soa', bookDepth: 25, fastRun: true });
  runner.bindColumnSet(columnSet);
  for (const ev of columnSet.events) {
    runner.beginEvent(ev);
    for (let i = ev.startRow; i < ev.endRow; i += 1) runner.processIndex(i);
    runner.endEvent(ev);
  }
  const result = runner.finish();
  const traded = result.events.filter((event) => event.reason !== 'no_entry');
  assert.ok(traded.length > 0);
  for (const event of traded) {
    assert.ok(Array.isArray(event.orders) && event.orders.length > 0, 'fast-run must persist entry orders for fees');
    assert.ok(event.cost > 0 || event.quantity > 0);
  }
  applyPolymarketFeesToBacktestResult(result);
  assert.ok((result.summary.feesPaid ?? 0) > 0 || (result.summary.fees?.totalFee ?? 0) > 0);
  assert.ok((result.summary.volume ?? 0) > 0);
});

test('parallel event slices match sequential compiled-soa', async () => {
  const ast = parse(SIMPLE);
  const columnSet = buildMultiEventColumnSet();

  const sequential = () => {
    const runner = createGlsBacktestRunner(ast, {}, { executionMode: 'compiled-soa', bookDepth: 25 });
    runner.bindColumnSet(columnSet);
    for (const ev of columnSet.events) {
      runner.beginEvent(ev);
      for (let i = ev.startRow; i < ev.endRow; i += 1) runner.processIndex(i);
      runner.endEvent(ev);
    }
    return runner.finish();
  };

  const slices = await runParallelEventSlices({
    ast,
    params: {},
    columnSet,
    workerCount: 2,
    bookDepth: 25,
  });
  assert.ok(slices?.length >= 2);

  const parallelRunner = createGlsBacktestRunner(ast, {}, { executionMode: 'compiled-soa', bookDepth: 25 });
  parallelRunner.importParallelSlices(slices);
  const parallel = parallelRunner.finish();

  const seq = sequential();
  assert.equal(parallel.summary.totalPnl, seq.summary.totalPnl);
  assert.equal(parallel.summary.totalEvents, seq.summary.totalEvents);
  assert.equal(parallel.events.length, seq.events.length);
});

test('compiled-soa processIndex skips ticks after early event finalize', () => {
  const ast = parse(`
strategy "Early Close" {
  onEventStart(event) { state.done = false }

  onTick(tick, event) {
    if (!state.done) {
      enter("UP", { price: 0.55, budget: 10, reason: "entry" })
      closeOpenPosition({ reason: "immediate" })
      state.done = true
    }
  }

  onEventEnd(event) {}
}
`);
  const columnSet = buildMultiEventColumnSet();
  const runner = createGlsBacktestRunner(ast, {}, { executionMode: 'compiled-soa', bookDepth: 25, fastRun: true });
  runner.bindColumnSet(columnSet);
  for (const ev of columnSet.events) {
    runner.beginEvent(ev);
    for (let i = ev.startRow; i < ev.endRow; i += 1) runner.processIndex(i);
    runner.endEvent(ev);
  }
  const result = runner.finish();
  assert.equal(result.summary.totalEvents, columnSet.events.length);
});

test('sweep reuses column set and returns per-variant summaries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-sweep-'));
  process.env.BACKTEST_ENGINE = 'soa';
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const parquetPath = path.join(dir, 'lake', 'backtest_ticks', 'part-test.parquet');
      await writeBacktestTicksParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'backtest_ticks.parquet'),
        finalPath: parquetPath,
        bookDepth: 2,
        rows: Array.from({ length: 8 }, (_, index) => ({
          marketId: 'market-1',
          underlying: 'BTC',
          interval: '5m',
          conditionId: 'condition-1',
          eventStart: '2026-05-31T00:00:00.000Z',
          eventEnd: '2026-05-31T00:05:00.000Z',
          ts: `2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`,
          underlyingPrice: 73400 + index * 10,
          priceToBeat: 73000,
          upPrice: 0.55,
          downPrice: 0.45,
          upBestBid: 0.53,
          upBestAsk: 0.55,
          downBestBid: 0.45,
          downBestAsk: 0.47,
          coverage: 1,
          degraded: false,
          bookDepth: 2,
          upAskLevels: [{ px: 0.55, sz: 10 }, { px: 0.56, sz: 10 }],
          upBidLevels: [{ px: 0.53, sz: 10 }, { px: 0.52, sz: 10 }],
          downAskLevels: [{ px: 0.47, sz: 10 }, { px: 0.48, sz: 10 }],
          downBidLevels: [{ px: 0.45, sz: 10 }, { px: 0.44, sz: 10 }],
        })),
      });
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        dt: '2026-05-31',
        activePath: toPortablePath(parquetPath),
        rows: 8,
        status: 'valid',
      });

      const ast = parse(SIMPLE);
      const baseRequest = {
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T00:00:08.000Z',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        glsAst: ast,
        strategyLabel: 'Parallel Safe',
        params: {},
      };

      const sweep = await runBacktestSweep(db, baseRequest, [
        { id: 'loose', params: { minDistanceAbs: 0, maxAsk: 0.99 } },
        { id: 'tight', params: { minDistanceAbs: 500, maxAsk: 0.99 } },
        { id: 'mid', params: { minDistanceAbs: 10, maxAsk: 0.99 } },
      ]);

      assert.equal(sweep.variantCount, 3);
      assert.equal(sweep.ticks, 8);
      assert.ok(sweep.timings.duckdbReadMs >= 0);
      assert.ok(sweep.timings.avgVariantMs > 0);
      const loose = sweep.variants.find((v) => v.id === 'loose');
      const tight = sweep.variants.find((v) => v.id === 'tight');
      assert.ok(loose.summary.totalEntries >= tight.summary.totalEntries);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('columnSetToShared roundtrip preserves column values', () => {
  const columnSet = buildMultiEventColumnSet();
  const shared = columnSetToShared(columnSet);
  const wrapped = wrapSharedColumnSet(shared);
  assert.equal(wrapped.length, columnSet.length);
  assert.equal(wrapped.columns.get('underlying_price')[0], columnSet.columns.get('underlying_price')[0]);
  assert.ok(shared.columns.get('underlying_price').buffer instanceof SharedArrayBuffer);
});

function buildMultiEventColumnSet() {
  const builder = createColumnSetBuilder({ initialCapacity: 16 });
  builder.registerColumn('condition_id', 'code');
  builder.registerColumn('_ts_ms', 'ms');
  builder.registerColumn('_event_start_ms', 'ms');
  builder.registerColumn('_event_end_ms', 'ms');
  builder.registerColumn('underlying_price', 'numeric');
  builder.registerColumn('price_to_beat', 'numeric');
  builder.registerColumn('up_price', 'numeric');
  builder.registerColumn('down_price', 'numeric');
  builder.registerColumn('up_best_ask', 'numeric');
  builder.registerColumn('up_best_bid', 'numeric');
  builder.registerColumn('down_best_ask', 'numeric');
  builder.registerColumn('down_best_bid', 'numeric');

  const events = [
    { id: 'c1', start: Date.parse('2026-05-31T00:00:00.000Z'), end: Date.parse('2026-05-31T00:05:00.000Z'), prices: [73450, 73520] },
    { id: 'c2', start: Date.parse('2026-05-31T00:05:00.000Z'), end: Date.parse('2026-05-31T00:10:00.000Z'), prices: [73480, 73490] },
  ];

  for (const event of events) {
    for (const [offset, underlying] of event.prices.entries()) {
      builder.ensureCapacity(1);
      const i = builder.length;
      builder.codes.get('condition_id')[i] = builder.internCode('condition_id', event.id);
      builder.columns.get('_ts_ms')[i] = event.start + offset * 1000;
      builder.columns.get('_event_start_ms')[i] = event.start;
      builder.columns.get('_event_end_ms')[i] = event.end;
      builder.columns.get('underlying_price')[i] = underlying;
      builder.columns.get('price_to_beat')[i] = 73000;
      builder.columns.get('up_price')[i] = 0.55;
      builder.columns.get('down_price')[i] = 0.45;
      builder.columns.get('up_best_ask')[i] = 0.55;
      builder.columns.get('up_best_bid')[i] = 0.53;
      builder.columns.get('down_best_ask')[i] = 0.47;
      builder.columns.get('down_best_bid')[i] = 0.45;
      builder.length += 1;
    }
  }

  return builder.finalize();
}
