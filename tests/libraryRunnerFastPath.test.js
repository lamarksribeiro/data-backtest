import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { createTickCursorView } from '../src/backtest/columnStore.js';
import { runBacktest } from '../src/backtest/engine.js';
import { toLegacyBacktestTick } from '../src/legacy/polymarketTestAdapter.js';
import { createLegacyTickBuilder, legacyTickFromCursor } from '../src/backtestStudio/strategyLibrary/tickBridge.js';
import { parseBookLevels, buildSortedBookLevels } from '../src/backtestStudio/strategyLibrary/runtime/bookLevels.js';
import { patchRunnerSourceForSoaRuntime } from '../src/backtestStudio/strategyLibrary/runtime/runnerPreamble.js';
import { loadStrategyLibraryRunner, clearStrategyLibraryRunnerCache } from '../src/backtestStudio/strategyLibrary/loadRunner.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { extractDefaultParamsFromSchema } from '../src/backtestStudio/state/strategyPresets.js';
import { seedPortedStrategies } from '../scripts/seed-ported-strategies.js';

test('parseBookLevels returns pre-parsed book arrays without re-parsing', () => {
  const parsed = buildSortedBookLevels([{ price: 0.55, size: 10 }], 'ask');
  const spy = parseBookLevels(parsed, 'ask');
  assert.equal(spy, parsed);
  assert.equal(spy._isParsed, true);
});

test('toLegacyBacktestTick parsed format exposes parsed arrays on book fields', () => {
  const tick = toLegacyBacktestTick({
    event_start: '2026-06-01T12:00:00.000Z',
    event_end: '2026-06-01T12:05:00.000Z',
    condition_id: 'c1',
    ts: '2026-06-01T12:00:01.000Z',
    underlying_price: 100000,
    price_to_beat: 99900,
    up_price: 0.55,
    down_price: 0.45,
    up_ask_px_1: 0.56,
    up_ask_sz_1: 12,
  }, { bookDepth: 25, bookFormat: 'parsed' });

  assert.ok(Array.isArray(tick.up_book_asks));
  assert.equal(tick.up_book_asks._isParsed, true);
  assert.equal(tick.up_book_asks, tick._parsed_up_book_asks);
  assert.equal(typeof tick.up_book_asks, 'object');
});

test('legacy tick builder reuses tick object and reads subset of columns', () => {
  const columnSet = {
    length: 2,
    columns: new Map([
      ['ts', ['2026-06-01T12:00:01.000Z', '2026-06-01T12:00:02.000Z']],
      ['event_start', ['2026-06-01T12:00:00.000Z', '2026-06-01T12:00:00.000Z']],
      ['event_end', ['2026-06-01T12:05:00.000Z', '2026-06-01T12:05:00.000Z']],
      ['condition_id', ['c1', 'c1']],
      ['underlying_price', [100000, 100001]],
      ['price_to_beat', [99900, 99900]],
      ['up_price', [0.55, 0.56]],
      ['down_price', [0.45, 0.44]],
      ['up_best_ask', [0.56, 0.57]],
      ['up_best_bid', [0.54, 0.55]],
      ['down_best_ask', [0.46, 0.45]],
      ['down_best_bid', [0.44, 0.43]],
      ['up_ask_px_1', [0.56, 0.57]],
      ['up_ask_sz_1', [12, 11]],
      ['noise_column', [1, 2]],
    ]),
  };
  const cursor = createTickCursorView(columnSet);
  const builder = createLegacyTickBuilder(25);

  cursor.setIndex(0);
  const tick0 = legacyTickFromCursor(cursor, columnSet, 25, builder);
  cursor.setIndex(1);
  const tick1 = legacyTickFromCursor(cursor, columnSet, 25, builder);

  assert.equal(tick0, tick1);
  assert.equal(tick1.btc_price, 100001);
  assert.equal(tick1.up_book_asks._isParsed, true);
  assert.equal('noise_column' in tick1, false);
});

test('patchRunnerSourceForSoaRuntime injects parsed-book fast path', () => {
  const source = `function parseBookLevels(rawLevels) {
  let levels = rawLevels;
  return levels;
}`;
  const patched = patchRunnerSourceForSoaRuntime(source);
  assert.match(patched, /rawLevels\._isParsed/);
  assert.match(patched, /__runnerTickTimeMs/);
});

test('impulse library-runner backtest is faster with fast tick bridge', async () => {
  const config = await import('../src/config.js').then((m) => m.loadConfig());
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

  const strategy = getStrategyBySlug(db, 'impulse-elasticity');
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
  const params = extractDefaultParamsFromSchema(versionRow.params_schema || {});

  const base = {
    ...window,
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    batchSize: 25000,
    fastRun: true,
    params,
    db,
    glsAst: resolved.glsAst,
    columnAnalysis: resolved.columnAnalysis,
    runnerLibrary: resolved.runnerLibrary,
  };

  const t0 = performance.now();
  const result = await runBacktest(db, base);
  const ms = performance.now() - t0;
  closeStateDatabase(db);

  assert.ok(result.ticks > 1000);
  assert.ok(result.timings.processMs < 5000,
    `expected processMs < 5s with SoA facade, got ${result.timings.processMs}`);
  assert.ok(ms < 7000, `expected wall < 7s, got ${Math.round(ms)}`);
});

test('loadStrategyLibraryRunner patched source preserves behavior on synthetic tick', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);
  clearStrategyLibraryRunnerCache();

  const runner = loadStrategyLibraryRunner(db, 'impulse-elasticity-runner', 1, {});
  const tick = toLegacyBacktestTick({
    event_start: '2026-06-01T12:00:00.000Z',
    event_end: '2026-06-01T12:05:00.000Z',
    condition_id: 'c-fast',
    ts: '2026-06-01T12:00:10.000Z',
    underlying_price: 105000,
    price_to_beat: 104900,
    up_price: 0.55,
    down_price: 0.45,
    up_ask_px_1: 0.56,
    up_ask_sz_1: 20,
    down_ask_px_1: 0.46,
    down_ask_sz_1: 18,
  }, { bookDepth: 25, bookFormat: 'parsed' });

  for (let i = 0; i < 12; i += 1) {
    runner.processTick({ ...tick, ts: `2026-06-01T12:00:${String(10 + i).padStart(2, '0')}.000Z`, id: i + 1 });
  }
  const finished = runner.finish();
  assert.ok(finished.summary);
  assert.ok(Array.isArray(finished.events));
  closeStateDatabase(db);
});
