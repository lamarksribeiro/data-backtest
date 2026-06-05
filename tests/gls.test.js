import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { validate } from '../src/backtestStudio/gls/validator.js';
import { createGlsBacktestRunner } from '../src/backtestStudio/gls/runtime.js';

const SIMPLE_STRATEGY = `
strategy "Distance Entry" {
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
      mark("entry")
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

test('GLS parser parses strategy params and hooks', () => {
  const ast = parse(SIMPLE_STRATEGY);
  assert.equal(ast.type, 'Strategy');
  assert.equal(ast.name, 'Distance Entry');
  assert.equal(ast.params.length, 4);
  assert.ok(ast.hooks.onTick);
  assert.ok(ast.hooks.onEventStart);
  assert.ok(ast.hooks.onEventEnd);
});

test('GLS validator accepts valid strategy and rejects unknown functions', () => {
  const ok = validate(SIMPLE_STRATEGY);
  assert.equal(ok.ok, true);
  assert.equal(ok.params_schema.minDistanceAbs.default, 10);

  const bad = validate(`
    strategy "Bad" {
      onTick(tick, event) {
        book.bestAsk("UP", tick)
      }
    }
  `);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /does not exist/);
});

test('GLS validator rejects duplicate params and forbidden writes', () => {
  const dup = validate(`
    strategy "Dup" {
      param x = 1
      param x = 2
    }
  `);
  assert.equal(dup.ok, false);
  assert.equal(dup.errors[0].code, 'DUPLICATE_PARAM');

  const write = validate(`
    strategy "Write" {
      onTick(tick, event) {
        tick.foo = 1
      }
    }
  `);
  assert.equal(write.ok, false);
  assert.equal(write.errors[0].code, 'FORBIDDEN_WRITE');
});

test('GLS runtime executes hooks and simulates orders deterministically', () => {
  const ast = parse(SIMPLE_STRATEGY);
  const ticks = [
    makeTick('2026-05-31T00:00:00.000Z', 73450, 0.55, 0.53),
    makeTick('2026-05-31T00:00:01.000Z', 73520, 0.58, 0.56),
    makeTick('2026-05-31T00:00:02.000Z', 73520, 0.15, 0.12),
  ];

  const runOnce = () => {
    const runner = createGlsBacktestRunner(ast, {});
    for (const tick of ticks) runner.processTick(tick);
    return runner.finish();
  };

  const first = runOnce();
  const second = runOnce();
  assert.deepEqual(first.summary, second.summary);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].orders.length, 2);
  assert.equal(first.events[0].orders[0].type, 'entry');
  assert.equal(first.events[0].orders[1].type, 'exit');
  assert.ok(first.events[0].marks.some((mark) => mark.name === 'entry'));
});

function makeTick(ts, underlyingPrice, ask, bid) {
  return {
    condition_id: 'condition-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    ts,
    btc_price: underlyingPrice,
    price_to_beat: 73400,
    up_price: ask,
    down_price: 1 - ask,
    up_best_ask: ask,
    up_best_bid: bid,
    down_best_ask: 0.5,
    down_best_bid: 0.48,
  };
}
