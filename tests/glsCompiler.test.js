import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { compileStrategy, analyzeStrategyColumns } from '../src/backtestStudio/gls/compiler.js';
import { createGlsBacktestRunner } from '../src/backtestStudio/gls/runtime.js';

const SIMPLE = `
strategy "Compiler Test" {
  param minDistanceAbs = 10
  param maxAsk = 0.6
  param stopBid = 0.2
  param budget = 10

  onEventStart(event) {
    state.entered = false
  }

  onTick(tick, event) {
    let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let ask = book.ask(side, tick)
    let bid = book.bid(side, tick)
    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      enter(side, { price: ask, budget: params.budget, reason: "entry" })
      state.entered = true
    }
    if (position.open && bid <= params.stopBid) {
      exit({ price: bid, reason: "stop" })
    }
  }

  onEventEnd(event) {
    closeOpenPosition({ reason: "event_end" })
  }
}
`;

function makeTick(ts, underlying, ask, bid) {
  return {
    ts,
    condition_id: 'cond-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    underlying_price: underlying,
    price_to_beat: 73000,
    up_best_ask: ask,
    up_best_bid: bid,
    down_best_ask: 1 - bid,
    down_best_bid: 1 - ask,
    up_price: ask,
    down_price: 1 - ask,
  };
}

test('compiler produces hook functions', () => {
  const ast = parse(SIMPLE);
  const compiled = compileStrategy(ast);
  assert.equal(typeof compiled.onTick, 'function');
  assert.equal(typeof compiled.onEventStart, 'function');
  assert.equal(typeof compiled.onEventEnd, 'function');
});

test('compiled and interpreter paths match on simple strategy', () => {
  const ast = parse(SIMPLE);
  const ticks = [
    makeTick('2026-05-31T00:00:00.000Z', 73450, 0.55, 0.53),
    makeTick('2026-05-31T00:00:01.000Z', 73520, 0.58, 0.56),
    makeTick('2026-05-31T00:00:02.000Z', 73520, 0.15, 0.12),
  ];

  const runWith = (mode) => {
    const runner = createGlsBacktestRunner(ast, {}, { executionMode: mode });
    for (const tick of ticks) runner.processTick(tick);
    return runner.finish();
  };

  const interpreted = runWith('interpreter');
  const compiled = runWith('compiled');
  assert.deepEqual(compiled.summary, interpreted.summary);
  assert.equal(compiled.events.length, interpreted.events.length);
  assert.equal(compiled.events[0]?.finalPnl, interpreted.events[0]?.finalPnl);
});

test('analyzeStrategyColumns detects book usage', () => {
  const ast = parse(SIMPLE);
  const analysis = analyzeStrategyColumns(ast, 10);
  assert.equal(analysis.needsBookLevels, true);
  assert.ok(analysis.scalarColumns.includes('underlying_price'));
});
