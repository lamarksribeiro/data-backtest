import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { createColumnSetBuilder } from '../src/backtest/columnStore.js';
import { parse } from '../src/backtestStudio/gls/parser.js';
import { validateAst } from '../src/backtestStudio/gls/validator.js';
import { createGlsBacktestRunner } from '../src/backtestStudio/gls/runtime.js';
import { createOrderSimulator, settleEventPnl } from '../src/backtestStudio/gls/orderSimulator.js';

const TFC_GLS = fs.readFileSync(
  path.join('src', 'backtestStudio', 'gls', 'strategies', 'TerminalFavoriteCarry.gls'),
  'utf8',
);

function tickWithAsks(side, asks, book = 'ask') {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const key = book === 'bid' ? `${prefix}_book_bids` : `${prefix}_book_asks`;
  return { [key]: JSON.stringify(asks) };
}

function mergeTick(base, extra) {
  return { ...base, ...extra };
}

test('placeLimitBuy role entry validates and rejects when primary position exists', () => {
  const simulator = createOrderSimulator();
  const tick = tickWithAsks('UP', [{ price: 0.62, size: 100 }]);
  assert.ok(simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, tick, role: 'entry' }));
  simulator.enter('UP', {
    price: 0.6,
    maxPrice: 0.6,
    budget: 6,
    minShares: 1,
    tick: tickWithAsks('UP', [{ price: 0.6, size: 20 }]),
  });
  assert.equal(simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: tickWithAsks('DOWN', [{ price: 0.55, size: 100 }]), role: 'entry' }), false);
});

test('resting entry order fill creates primary position with maker fee semantics', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  const armTick = tickWithAsks('UP', [{ price: 0.62, size: 100 }]);
  simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, ts: '2026-06-01T00:00:01.000Z', tick: armTick, role: 'entry' });

  assert.equal(simulator.checkRestingOrders(tickWithAsks('UP', [{ price: 0.60, size: 100 }])), 1);
  assert.equal(simulator.positionView.open, true);
  assert.equal(simulator.positionView.side, 'UP');
  assert.equal(simulator.positionView.shares, 16);
  assert.equal(simulator.positionView.avgEntryPrice, 0.61);
  assert.equal(simulator.positionView.hedge, null);

  const entryOrder = simulator.snapshot().orders.find((o) => o.type === 'entry');
  assert.equal(entryOrder.liquidity, 'maker');
  assert.equal(entryOrder.orderRole, 'entry');

  const fees = applyPolymarketFeesToBacktestResult({
    params: {},
    events: [{
      eventId: 'a',
      orders: [entryOrder],
      exits: [],
      finalPnl: 0,
    }],
    summary: {},
  });
  assert.equal(fees.events[0].fees.entryFee, 0);
  assert.equal(fees.events[0].fees.makerTradesFree, 1);
});

test('entry maker fill does not trigger when ask only touches limit price', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, tick: tickWithAsks('UP', [{ price: 0.62, size: 100 }]), role: 'entry' });
  assert.equal(simulator.checkRestingOrders(tickWithAsks('UP', [{ price: 0.61, size: 100 }])), 0);
  assert.equal(simulator.positionView.open, false);
});

test('entry maker fill is rejected when primary position already open', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.enter('UP', {
    price: 0.6,
    maxPrice: 0.6,
    budget: 6,
    minShares: 1,
    tick: tickWithAsks('UP', [{ price: 0.6, size: 20 }]),
  });
  simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: tickWithAsks('DOWN', [{ price: 0.55, size: 100 }]), role: 'entry' });
  assert.equal(simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.38, size: 100 }])), 0);
  assert.equal(simulator.positionView.side, 'UP');
  assert.equal(simulator.positionView.shares, 10);
});

test('cancelLimit works for entry resting orders', () => {
  const simulator = createOrderSimulator();
  const posted = simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, tick: tickWithAsks('UP', [{ price: 0.62, size: 100 }]), role: 'entry' });
  assert.equal(simulator.cancelLimit(posted.id), 1);
  assert.equal(simulator.restingView[0].status, 'cancelled');
  const settlement = settleEventPnl(simulator, { underlyingPrice: 100000, price_to_beat: 100000 }, { priceToBeat: 100000 });
  assert.equal(settlement.reason, 'no_entry');
});

test('cancelled entry order without fill yields zero pnl event', () => {
  const simulator = createOrderSimulator();
  simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, tick: tickWithAsks('UP', [{ price: 0.62, size: 100 }]), role: 'entry' });
  simulator.cancelLimit(null);
  const settlement = settleEventPnl(simulator, { underlyingPrice: 101000, price_to_beat: 100000 }, { priceToBeat: 100000 });
  assert.equal(settlement.finalPnl, 0);
  assert.equal(settlement.reason, 'no_entry');
});

test('maker primary position supports late flip reverse', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, tick: tickWithAsks('UP', [{ price: 0.62, size: 100 }]), role: 'entry' });
  simulator.checkRestingOrders(tickWithAsks('UP', [{ price: 0.60, size: 100 }]));

  const reversed = simulator.reverse('DOWN', {
    price: 0.45,
    exitPrice: 0.58,
    budget: 10,
    tick: mergeTick(
      tickWithAsks('DOWN', [{ price: 0.45, size: 100 }]),
      tickWithAsks('UP', [{ price: 0.58, size: 100 }], 'bid'),
    ),
  });
  assert.ok(reversed);
  assert.equal(simulator.positionView.side, 'DOWN');
  assert.equal(simulator.positionView.open, true);
});

test('event with open entry resting order keeps processing ticks', () => {
  const simulator = createOrderSimulator();
  simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, tick: tickWithAsks('UP', [{ price: 0.62, size: 100 }]), role: 'entry' });
  assert.equal(simulator.positionView.open, false);
  assert.equal(simulator.hasOpenRestingOrders(), true);
});

test('maker fill works with mutable tick cursor (compiled-soa regression)', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  const cursor = {
    index: 0,
    setIndex(i) { this.index = i; },
    down_best_ask: 0.38,
  };
  Object.defineProperty(cursor, 'up_best_ask', {
    enumerable: true,
    get() { return this.index === 0 ? 0.62 : 0.60; },
  });
  Object.defineProperty(cursor, 'up_book_asks', {
    enumerable: true,
    get() {
      const price = this.index === 0 ? 0.62 : 0.60;
      return JSON.stringify([{ price, size: 100 }]);
    },
  });

  cursor.setIndex(0);
  simulator.placeLimitBuy('UP', { price: 0.61, budget: 10, tick: cursor, role: 'entry' });
  cursor.setIndex(1);
  assert.equal(simulator.checkRestingOrders(cursor), 1);
  assert.equal(simulator.positionView.open, true);
});

test('GLS maker integration fills when ask crosses limit on next tick', () => {
  const ast = parse(TFC_GLS);
  const params = {
    minAsk: 0.55, maxAsk: 0.82, minSecondsLeft: 5, maxSecondsLeft: 30, maxDistAbs: 20,
    entryMakerEnabled: true, entryMakerDelta: 0.01, entryMakerDeadlineSec: 10,
    entryMakerFallbackTaker: false, lateFlipExitEnabled: false,
    velocityLookbackSecs: 5, maxAdverseSpotChange: 8.0, minObi: -1.0,
  };
  const base = {
    condition_id: 'fill-int',
    event_start: '2026-06-25T00:00:00.000Z',
    event_end: '2026-06-25T00:05:00.000Z',
    underlying_price: 100010,
    price_to_beat: 100000,
  };
  const ticks = [];
  for (let sec = 20; sec <= 32; sec += 1) {
    const ask = sec === 32 ? 0.60 : 0.62;
    ticks.push({
      ...base,
      ts: `2026-06-25T00:04:${String(sec).padStart(2, '0')}.000Z`,
      up_best_ask: ask,
      up_best_bid: ask - 0.02,
      down_best_ask: 1 - ask + 0.02,
      down_best_bid: 1 - ask,
      up_price: ask,
      down_price: 1 - ask,
    });
  }
  const runner = createGlsBacktestRunner(ast, params, { executionMode: 'interpreter', fastRun: false });
  for (const tick of ticks) runner.processTick(tick);
  const result = runner.finish();
  assert.equal(result.summary.totalEntries, 1);
  assert.equal(result.events[0]?.orders?.[0]?.liquidity, 'maker');
});

test('TerminalFavoriteCarry.gls validates with V7 params', () => {
  const ast = parse(TFC_GLS);
  const validation = validateAst(ast);
  assert.equal(validation.ok, true, validation.errors?.join('\n'));
});

test('entryMakerEnabled interpreter and compiled-soa parity on synthetic ticks', () => {
  const ast = parse(TFC_GLS);
  const params = {
    minAsk: 0.55,
    maxAsk: 0.82,
    minSecondsLeft: 5,
    maxSecondsLeft: 30,
    entryMakerEnabled: true,
    entryMakerDelta: 0.01,
    entryMakerDeadlineSec: 10,
    entryMakerChase: 0.02,
    entryMakerFallbackTaker: false,
    lateFlipExitEnabled: false,
  };

  const ticks = [
    {
      ts: '2026-06-25T00:04:20.000Z',
      condition_id: 'cond-maker',
      event_start: '2026-06-25T00:00:00.000Z',
      event_end: '2026-06-25T00:05:00.000Z',
      underlying_price: 100010,
      price_to_beat: 100000,
      up_best_ask: 0.62,
      up_best_bid: 0.60,
      down_best_ask: 0.40,
      down_best_bid: 0.38,
      up_price: 0.62,
      down_price: 0.38,
    },
    {
      ts: '2026-06-25T00:04:35.000Z',
      condition_id: 'cond-maker',
      event_start: '2026-06-25T00:00:00.000Z',
      event_end: '2026-06-25T00:05:00.000Z',
      underlying_price: 100040,
      price_to_beat: 100000,
      up_best_ask: 0.60,
      up_best_bid: 0.58,
      down_best_ask: 0.42,
      down_best_bid: 0.40,
      up_price: 0.60,
      down_price: 0.40,
    },
    {
      ts: '2026-06-25T00:04:59.000Z',
      condition_id: 'cond-maker',
      event_start: '2026-06-25T00:00:00.000Z',
      event_end: '2026-06-25T00:05:00.000Z',
      underlying_price: 100080,
      price_to_beat: 100000,
      up_best_ask: 0.70,
      up_best_bid: 0.68,
      down_best_ask: 0.32,
      down_best_bid: 0.30,
      up_price: 0.70,
      down_price: 0.30,
    },
  ];

  const runInterpreted = () => {
    const runner = createGlsBacktestRunner(ast, params, { executionMode: 'interpreter' });
    for (const tick of ticks) runner.processTick(tick);
    return runner.finish();
  };

  const runCompiledSoa = () => {
    const columnSet = ticksToColumnSet(ticks);
    const runner = createGlsBacktestRunner(ast, params, { executionMode: 'compiled-soa', bookDepth: 25 });
    runner.bindColumnSet(columnSet);
    for (const ev of columnSet.events) {
      runner.beginEvent(ev);
      for (let i = ev.startRow; i < ev.endRow; i += 1) runner.processIndex(i);
      runner.endEvent(ev);
    }
    return runner.finish();
  };

  const interpreted = runInterpreted();
  const compiled = runCompiledSoa();
  assert.deepEqual(compiled.summary, interpreted.summary);
  assert.equal(compiled.events.length, interpreted.events.length);
  assert.equal(compiled.events[0]?.orders?.length, interpreted.events[0]?.orders?.length);
});

function ticksToColumnSet(ticks) {
  const builder = createColumnSetBuilder({ initialCapacity: ticks.length });
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

  for (const tick of ticks) {
    builder.ensureCapacity(1);
    const i = builder.length;
    builder.codes.get('condition_id')[i] = builder.internCode('condition_id', tick.condition_id);
    builder.columns.get('_ts_ms')[i] = Date.parse(tick.ts);
    builder.columns.get('_event_start_ms')[i] = Date.parse(tick.event_start);
    builder.columns.get('_event_end_ms')[i] = Date.parse(tick.event_end);
    builder.columns.get('underlying_price')[i] = tick.underlying_price;
    builder.columns.get('price_to_beat')[i] = tick.price_to_beat;
    builder.columns.get('up_price')[i] = tick.up_price;
    builder.columns.get('down_price')[i] = tick.down_price;
    builder.columns.get('up_best_ask')[i] = tick.up_best_ask;
    builder.columns.get('up_best_bid')[i] = tick.up_best_bid;
    builder.columns.get('down_best_ask')[i] = tick.down_best_ask;
    builder.columns.get('down_best_bid')[i] = tick.down_best_bid;
    builder.length += 1;
  }

  const columnSet = builder.finalize();
  columnSet.events = [{
    eventId: ticks[0].condition_id,
    eventStart: ticks[0].event_start,
    eventEnd: ticks[0].event_end,
    startRow: 0,
    endRow: ticks.length,
  }];
  return columnSet;
}
