import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { composeGammaLadderStrategyJs } from '../src/backtestStudio/strategyJs/composeGammaLadder.js';
import { compileStrategyJs } from '../src/backtestStudio/strategyJs/compile.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { toLegacyBacktestTick } from '../src/legacy/polymarketTestAdapter.js';

const GLS_SOURCE = `strategy "Gamma Ladder V1" {
  param walletSize = 100
  param entryWindowStart = 105
  param entryWindowEnd = 4
  onEventStart(event) { state.ready = true }
  onTick(tick, event) {}
  onEventEnd(event) {}
}`;

test('gamma ladder Strategy JS validates with embedded runner factory', () => {
  const db = openStateDatabase(path.join(os.tmpdir(), `gamma-val-${Date.now()}.db`));
  try {
    const js = composeGammaLadderStrategyJs(GLS_SOURCE);
    const compiled = compileStrategyJs(js, { db });
    assert.equal(compiled.ok, true, compiled.errors?.map((e) => e.message).join('; '));
    assert.equal(compiled.execution_kind, 'embedded-runner');
    assert.equal(compiled.editable_logic, true);
    assert.ok(js.includes('function gammaLadderRunnerFactory'));
    assert.ok(!compiled.dependencies?.some((d) => d.slug === 'gamma-ladder-engine'));
  } finally {
    closeStateDatabase(db);
  }
});

test('strategyLoader routes gamma to embedded-runner from strategy source', async () => {
  const db = openStateDatabase(path.join(os.tmpdir(), `gamma-load-${Date.now()}.db`));
  try {
    const js = composeGammaLadderStrategyJs(GLS_SOURCE);
    const version = {
      language: 'strategy-js-v1',
      source_code: js,
      compiled_json: JSON.stringify(compileStrategyJs(js, { db }).compiled),
      checksum: compileStrategyJs(js, { db }).compiled.source_checksum,
    };
    const resolved = resolveVersionForBacktest(version, { bookDepth: 25, db });
    assert.equal(resolved.strategyMeta.execution_kind, 'embedded-runner');
    assert.equal(resolved.strategyMeta.editable_logic, true);
    assert.equal(resolved.embeddedRunner, true);
    const loaded = await loadStrategy({
      glsAst: resolved.glsAst,
      columnAnalysis: resolved.columnAnalysis,
      embeddedRunner: resolved.embeddedRunner,
      strategySourceCode: resolved.strategySourceCode,
      db,
      bookDepth: 25,
    });
    assert.equal(loaded.kind, 'embedded-runner');
    const runner = loaded.createRunner({});
    assert.equal(runner.executionMode, 'embedded-runner');
    assert.equal(typeof runner.processIndex, 'function');
  } finally {
    closeStateDatabase(db);
  }
});

test('gamma ladder embedded runner executes on synthetic box ticks', async () => {
  const db = openStateDatabase(path.join(os.tmpdir(), `gamma-run-${Date.now()}.db`));
  try {
    const js = composeGammaLadderStrategyJs(GLS_SOURCE);
    const compiled = compileStrategyJs(js, { db });
    const resolved = resolveVersionForBacktest({
      language: 'strategy-js-v1',
      source_code: js,
      compiled_json: JSON.stringify(compiled.compiled),
      checksum: compiled.compiled.source_checksum,
    }, { bookDepth: 25, db });

    const loaded = await loadStrategy({
      glsAst: resolved.glsAst,
      embeddedRunner: resolved.embeddedRunner,
      strategySourceCode: resolved.strategySourceCode,
      db,
      bookDepth: 25,
    });
    const runner = loaded.createRunner({
      boxEnabled: true,
      hedgeEnabled: false,
      minDistanceAbs: 0,
      minEdge: -0.5,
      minDirectionalProb: 0.01,
      maxSpread: 0.99,
      minLiquidityRatio: 0.01,
      entryWindowStart: 300,
      entryWindowEnd: 0,
      minTicksBeforeEntry: 2,
      maxOddsSum: 2,
      minOddsSum: 0.01,
    });
    for (const tick of buildGammaLadderSyntheticTicks()) {
      runner.processTick(tick);
    }
    const result = runner.finish();
    assert.ok(Number.isFinite(result.summary?.totalPnl));
  } finally {
    closeStateDatabase(db);
  }
});

function buildGammaLadderSyntheticTicks() {
  const eventStart = '2026-05-31T00:00:00.000Z';
  const eventEnd = '2026-05-31T00:05:00.000Z';
  const ticks = [];
  for (let i = 0; i < 20; i += 1) {
    const ts = new Date(Date.parse(eventStart) + i * 10_000).toISOString();
    ticks.push(toLegacyBacktestTick({
      event_start: eventStart,
      event_end: eventEnd,
      condition_id: 'condition-gamma-1',
      ts,
      underlying_price: 73500 + i,
      price_to_beat: 73450,
      up_price: 0.48,
      down_price: 0.49,
      up_best_ask: 0.47,
      up_best_bid: 0.45,
      down_best_ask: 0.48,
      down_best_bid: 0.46,
      up_ask_px_1: 0.47,
      up_ask_sz_1: 200,
      up_ask_px_2: 0.48,
      up_ask_sz_2: 200,
      up_bid_px_1: 0.45,
      up_bid_sz_1: 200,
      down_ask_px_1: 0.48,
      down_ask_sz_1: 200,
      down_ask_px_2: 0.49,
      down_ask_sz_2: 200,
      down_bid_px_1: 0.46,
      down_bid_sz_1: 200,
    }, { index: i, bookDepth: 2 }));
  }
  return ticks;
}