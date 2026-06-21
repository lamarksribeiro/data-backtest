import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { createColumnSetBuilder, createTickCursorView } from '../src/backtest/columnStore.js';
import { runBacktest } from '../src/backtest/engine.js';
import { toLegacyBacktestTick } from '../src/legacy/polymarketTestAdapter.js';
import { legacyTickFromCursor } from '../src/backtestStudio/strategyLibrary/tickBridge.js';
import {
  createLegacyTickFacade,
  createLegacyTickFacadeBinding,
} from '../src/backtestStudio/strategyLibrary/legacyTickFacade.js';
import { createLibraryRunnerAdapter } from '../src/backtestStudio/strategyLibrary/runnerAdapter.js';
import { patchRunnerSourceForSoaRuntime } from '../src/backtestStudio/strategyLibrary/runtime/runnerPreamble.js';
import { createSampleRing } from '../src/backtestStudio/strategyLibrary/runtime/sampleRing.js';
import { loadStrategyLibraryRunner, clearStrategyLibraryRunnerCache } from '../src/backtestStudio/strategyLibrary/loadRunner.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { extractDefaultParamsFromSchema } from '../src/backtestStudio/state/strategyPresets.js';
import { seedPortedStrategies } from '../scripts/seed-ported-strategies.js';
import { loadConfig } from '../src/config.js';

function legacyTicksFixture() {
  const base = {
    event_start: '2026-06-01T12:00:00.000Z',
    event_end: '2026-06-01T12:05:00.000Z',
    condition_id: 'cond-soa-parity',
    underlying_price: 105000,
    price_to_beat: 104900,
    up_price: 0.55,
    down_price: 0.45,
    up_best_ask: 0.56,
    up_best_bid: 0.54,
    down_best_ask: 0.46,
    down_best_bid: 0.44,
    up_ask_px_1: 0.56,
    up_ask_sz_1: 20,
    down_ask_px_1: 0.46,
    down_ask_sz_1: 18,
  };
  return Array.from({ length: 24 }, (_, index) => toLegacyBacktestTick({
    ...base,
    ts: `2026-06-01T12:00:${String(10 + index).padStart(2, '0')}.000Z`,
    underlying_price: base.underlying_price + index * 3,
    up_ask_px_1: 0.56 + index * 0.001,
  }, { index, bookDepth: 25, bookFormat: 'parsed' }));
}

function columnSetFromLegacyTicks(ticks) {
  const builder = createColumnSetBuilder({ initialCapacity: Math.max(ticks.length, 32) });
  const scalarColumns = [
    ['condition_id', 'code'],
    ['_ts_ms', 'ms'],
    ['_event_start_ms', 'ms'],
    ['_event_end_ms', 'ms'],
    ['underlying_price', 'numeric'],
    ['price_to_beat', 'numeric'],
    ['up_price', 'numeric'],
    ['down_price', 'numeric'],
    ['up_best_ask', 'numeric'],
    ['up_best_bid', 'numeric'],
    ['down_best_ask', 'numeric'],
    ['down_best_bid', 'numeric'],
  ];
  for (const [name, kind] of scalarColumns) builder.registerColumn(name, kind);
  for (let level = 1; level <= 25; level += 1) {
    for (const prefix of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
      builder.registerColumn(`${prefix}_px_${level}`, 'numeric');
      builder.registerColumn(`${prefix}_sz_${level}`, 'numeric');
    }
  }

  const appendFromTick = (tick, rowIndex) => {
    builder.ensureCapacity(1);
    const i = builder.length;
    const tsMs = Date.parse(tick.ts);
    const startMs = Date.parse(tick.event_start);
    const endMs = Date.parse(tick.event_end);
    builder.codes.get('condition_id')[i] = builder.internCode('condition_id', tick.condition_id);
    builder.columns.get('_ts_ms')[i] = tsMs;
    builder.columns.get('_event_start_ms')[i] = startMs;
    builder.columns.get('_event_end_ms')[i] = endMs;
    builder.columns.get('underlying_price')[i] = tick.btc_price;
    builder.columns.get('price_to_beat')[i] = tick.price_to_beat;
    builder.columns.get('up_price')[i] = tick.up_price;
    builder.columns.get('down_price')[i] = tick.down_price;
    builder.columns.get('up_best_ask')[i] = tick.up_best_ask;
    builder.columns.get('up_best_bid')[i] = tick.up_best_bid;
    builder.columns.get('down_best_ask')[i] = tick.down_best_ask;
    builder.columns.get('down_best_bid')[i] = tick.down_best_bid;
    const bookSides = [
      ['up_ask', tick.up_book_asks],
      ['up_bid', tick.up_book_bids],
      ['down_ask', tick.down_book_asks],
      ['down_bid', tick.down_book_bids],
    ];
    for (const [prefix, levels] of bookSides) {
      if (!Array.isArray(levels)) continue;
      for (let level = 0; level < levels.length && level < 25; level += 1) {
        builder.columns.get(`${prefix}_px_${level + 1}`)[i] = levels[level].price;
        builder.columns.get(`${prefix}_sz_${level + 1}`)[i] = levels[level].size;
      }
    }
    builder.length += 1;
    rowIndex;
  };

  for (const tick of ticks) appendFromTick(tick);
  return builder.finalize();
}

test('legacy tick facade matches materialized legacy tick fields', () => {
  const ticks = legacyTicksFixture();
  const columnSet = columnSetFromLegacyTicks(ticks);
  const binding = createLegacyTickFacadeBinding(columnSet, 25);

  for (let row = 0; row < ticks.length; row += 1) {
    const facade = binding.atRow(row);
    const expected = ticks[row];

    assert.equal(facade.ts, expected.ts);
    assert.equal(facade.btc_price, expected.btc_price);
    assert.equal(facade.price_to_beat, expected.price_to_beat);
    assert.equal(facade.up_best_ask, expected.up_best_ask);
    assert.equal(facade.up_book_asks.length, expected.up_book_asks.length);
    assert.equal(facade.up_book_asks[0].price, expected.up_book_asks[0].price);
    assert.equal(facade._tsMs, Date.parse(expected.ts));
  }
});

test('sample ring supports filter shift and indexed access', () => {
  const ring = createSampleRing(8);
  ring.push({ timeMs: 1, btc: 1 });
  ring.push({ timeMs: 2, btc: 2 });
  ring.push({ timeMs: 3, btc: 3 });
  assert.equal(ring.length, 3);
  assert.equal(ring[2].btc, 3);
  assert.equal(ring.filter((item) => item.btc >= 2).length, 2);
  ring.pruneOlderThan(1);
  assert.equal(ring.length, 2);
  assert.equal(ring[0].btc, 2);
  assert.equal(ring[1].btc, 3);
  assert.deepEqual(ring.slice(0).map((item) => item.btc), [2, 3]);
});

test('patchRunnerSourceForSoaRuntime injects time helpers without sample ring', () => {
  const source = `function addSample(state, tick) {
  const timeMs = new Date(tick.ts).getTime();
  const tickTime = new Date(tick.ts);
  return { timeMs, tickTime };
}`;
  const patched = patchRunnerSourceForSoaRuntime(source);
  assert.match(patched, /__runnerTickTimeMs/);
  assert.match(patched, /__runnerDateFromTick/);
  assert.doesNotMatch(patched, /__runnerCreateSampleStore/);
  assert.doesNotMatch(patched, /pruneOlderThan/);
  assert.match(patched, /__runnerTickTimeMs\(tick\)/);
  assert.match(patched, /__runnerDateFromTick\(tick\)/);
});

test('impulse runner parity: facade SoA path matches materialized ticks', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);
  clearStrategyLibraryRunnerCache();

  const ticks = legacyTicksFixture();
  const columnSet = columnSetFromLegacyTicks(ticks);

  const materializedRunner = loadStrategyLibraryRunner(db, 'impulse-elasticity-runner', 1, {});
  for (const tick of ticks) materializedRunner.processTick(tick);
  const materializedResult = materializedRunner.finish();

  clearStrategyLibraryRunnerCache();
  const adapter = createLibraryRunnerAdapter(db, { slug: 'impulse-elasticity-runner', version: 1 }, {});
  adapter.bindColumnSet(columnSet);
  for (let row = 0; row < columnSet.length; row += 1) adapter.processIndex(row);
  const facadeResult = adapter.finish();

  assert.equal(
    facadeResult.summary.totalEntries,
    materializedResult.summary.totalEntries,
    'totalEntries mismatch',
  );
  assert.equal(
    facadeResult.summary.totalEvents,
    materializedResult.summary.totalEvents,
    'totalEvents mismatch',
  );
  closeStateDatabase(db);
});

test('library-runner-soa backtest meets level-2 performance target', async () => {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);
  clearStrategyLibraryRunnerCache();

  const row = db.prepare(`
    SELECT dt FROM lake_manifest
    WHERE dataset = 'backtest_ticks' AND underlying = 'BTC' AND interval = '5m'
      AND book_depth = 25 AND status IN ('valid', 'accepted')
    ORDER BY dt DESC LIMIT 1
  `).get();
  if (!row?.dt) {
    closeStateDatabase(db);
    return;
  }
  const next = new Date(`${row.dt}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const window = {
    from: `${row.dt}T00:00:00.000Z`,
    to: `${next.toISOString().slice(0, 10)}T00:00:00.000Z`,
  };

  const impulse = getStrategyBySlug(db, 'impulse-elasticity');
  const impulseVersion = db.prepare(`
    SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1
  `).get(impulse.id);
  const impulseRow = {
    ...impulseVersion,
    params_schema: JSON.parse(impulseVersion.params_schema_json || '{}'),
    validation: JSON.parse(impulseVersion.validation_json || '{}'),
    compiled: impulseVersion.compiled_json ? JSON.parse(impulseVersion.compiled_json) : null,
  };
  const impulseResolved = resolveVersionForBacktest(impulseRow, { bookDepth: 25, db });
  const t0 = performance.now();
  const impulseResult = await runBacktest(db, {
    ...window,
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    batchSize: 25000,
    fastRun: true,
    params: extractDefaultParamsFromSchema(impulseRow.params_schema || {}),
    db,
    glsAst: impulseResolved.glsAst,
    columnAnalysis: impulseResolved.columnAnalysis,
    runnerLibrary: impulseResolved.runnerLibrary,
  });
  const impulseWall = performance.now() - t0;
  assert.ok(impulseResult.ticks > 1000);
  assert.ok(impulseResult.timings.processMs < 5000,
    `impulse processMs ${impulseResult.timings.processMs} expected < 5000`);
  assert.ok(impulseWall < 7000, `impulse wall ${Math.round(impulseWall)}ms expected < 7000`);

  for (const slug of ['cofre-sete-v1', 'fusion-five-v1']) {
    const strategy = getStrategyBySlug(db, slug);
    const version = db.prepare(`
      SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1
    `).get(strategy.id);
    const versionRow = {
      ...version,
      params_schema: JSON.parse(version.params_schema_json || '{}'),
      validation: JSON.parse(version.validation_json || '{}'),
      compiled: version.compiled_json ? JSON.parse(version.compiled_json) : null,
    };
    const resolved = resolveVersionForBacktest(versionRow, { bookDepth: 25, db });
    const result = await runBacktest(db, {
      ...window,
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      batchSize: 25000,
      fastRun: true,
      params: extractDefaultParamsFromSchema(versionRow.params_schema || {}),
      db,
      glsAst: resolved.glsAst,
      columnAnalysis: resolved.columnAnalysis,
      runnerLibrary: resolved.runnerLibrary,
    });
    assert.ok(result.ticks > 1000, slug);
    assert.ok(Number.isFinite(result.timings.processMs), `${slug} processMs`);
  }

  closeStateDatabase(db);
});
