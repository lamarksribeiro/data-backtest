import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { validate } from '../src/backtestStudio/gls/validator.js';
import { compareGammaLadderParity } from '../src/backtestStudio/gls/gammaLadder/parity.js';
import { toLegacyBacktestTick } from '../src/legacy/polymarketTestAdapter.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';

const GLS_SOURCE = readFileSync(
  path.resolve('src/backtestStudio/gls/strategies/gammaLadderV1.gls'),
  'utf8',
);

test('gamma ladder GLS validates and parses', () => {
  const validation = validate(GLS_SOURCE);
  assert.equal(validation.ok, true, validation.errors?.map((e) => e.message).join('; '));
  const ast = parse(GLS_SOURCE);
  assert.equal(ast.name, 'Gamma Ladder V1');
  assert.ok(ast.params.length >= 30);
});

test('strategyLoader routes gamma ladder GLS to gamma-ladder runner', async () => {
  const loaded = await loadStrategy({
    glsAst: parse(GLS_SOURCE),
    bookDepth: 25,
  });
  assert.equal(loaded.kind, 'gamma-ladder');
  const runner = loaded.createRunner({});
  assert.equal(runner.executionMode, 'gamma-ladder');
  assert.equal(typeof runner.processIndex, 'function');
});

test('gamma ladder native vs gls adapter parity on synthetic box ticks', () => {
  const ticks = buildGammaLadderSyntheticTicks();
  const report = compareGammaLadderParity(ticks, {
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
  assert.equal(report.match, true, JSON.stringify(report.divergences));
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
