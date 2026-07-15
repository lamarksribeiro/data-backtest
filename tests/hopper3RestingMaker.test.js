import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/hopper-3-runner.js');

function loadHopper() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __hopperExports;`)();
}

const hopper = loadHopper();

function baseTick(overrides = {}) {
  const eventStart = overrides.event_start || '2026-06-01T12:00:00.000Z';
  return {
    ts: overrides.ts || '2026-06-01T12:01:00.000Z',
    event_start: eventStart,
    condition_id: overrides.condition_id || 'cond-hopper-test',
    price_to_beat: 100000,
    btc_price: overrides.btc_price ?? 100050,
    up_best_ask: overrides.up_best_ask ?? 0.70,
    up_best_bid: overrides.up_best_bid ?? 0.68,
    down_best_ask: overrides.down_best_ask ?? 0.32,
    down_best_bid: overrides.down_best_bid ?? 0.30,
    up_price: overrides.up_price ?? 0.69,
    down_price: overrides.down_price ?? 0.31,
    up_book_asks: overrides.up_book_asks ?? JSON.stringify([{ price: 0.70, size: 500 }]),
    up_book_bids: overrides.up_book_bids ?? JSON.stringify([{ price: 0.68, size: 500 }]),
    down_book_asks: overrides.down_book_asks ?? JSON.stringify([{ price: 0.32, size: 500 }]),
    down_book_bids: overrides.down_book_bids ?? JSON.stringify([{ price: 0.30, size: 500 }]),
    ...overrides,
  };
}

test('resolveExecutionMode maps simulateMaker and explicit modes', () => {
  assert.equal(hopper.resolveExecutionMode({}, true), 'optimistic_maker');
  assert.equal(hopper.resolveExecutionMode({}, false), 'taker');
  assert.equal(hopper.resolveExecutionMode({ executionMode: 'resting_maker' }, true), 'resting_maker');
  assert.equal(hopper.resolveExecutionMode({ executionMode: 'taker' }, true), 'taker');
  assert.equal(hopper.mergeHopperParams({ simulateMaker: true }).executionMode, 'optimistic_maker');
  assert.equal(hopper.mergeHopperParams({ executionMode: 'resting_maker' }).executionMode, 'resting_maker');
});

test('shouldFillRestingBuy requires ask to cross below limit minus epsilon', () => {
  assert.equal(hopper.shouldFillRestingBuy(0.70, 0.69, 0.68, 0.01), false);
  assert.equal(hopper.shouldFillRestingBuy(0.70, 0.68, 0.68, 0.01), false);
  assert.equal(hopper.shouldFillRestingBuy(0.70, 0.67, 0.68, 0.01), true);
  assert.equal(hopper.shouldFillRestingBuy(null, 0.67, 0.68, 0.01), false);
});

test('resting_maker does not fill on the placement tick', () => {
  const result = hopper.runHopper3Backtest(
    {
      executionMode: 'resting_maker',
      makerTimeoutSec: 60,
      makerFillEpsilon: 0.01,
      triggerExpensiveCents: 70,
      minEntryAskCents: 55,
      maxEntryAskCents: 85,
      maxSpreadCents: 10,
      distMinPtb: 0,
      minTimeForNewCycleSec: 35,
      maxFlipsAllowed: 0,
      dynamicSizingEnabled: false,
      walletSize: 100,
      pctWallet: 0.06,
    },
    [
      baseTick({
        ts: '2026-06-01T12:01:00.000Z',
        up_best_ask: 0.70,
        up_best_bid: 0.68,
      }),
    ],
  );

  assert.equal(result.summary.restingPlaced >= 1, true);
  assert.equal(result.summary.restingFilled, 0);
  assert.equal(result.summary.totalEntries, 0);
  const logs = result.log.map((l) => l.msg).join('\n');
  assert.match(logs, /RESTING PLACE/);
  assert.doesNotMatch(logs, /RESTING FILL/);
});

test('resting_maker fills only after ask crosses limit', () => {
  const params = {
    executionMode: 'resting_maker',
    makerTimeoutSec: 60,
    makerFillEpsilon: 0.01,
    triggerExpensiveCents: 70,
    minEntryAskCents: 55,
    maxEntryAskCents: 85,
    maxSpreadCents: 10,
    distMinPtb: 0,
    minTimeForNewCycleSec: 35,
    maxFlipsAllowed: 0,
    dynamicSizingEnabled: false,
    walletSize: 100,
  };

  const ticks = [
    baseTick({
      ts: '2026-06-01T12:01:00.000Z',
      up_best_ask: 0.70,
      up_best_bid: 0.68,
    }),
    // still above limit-epsilon
    baseTick({
      ts: '2026-06-01T12:01:02.000Z',
      up_best_ask: 0.69,
      up_best_bid: 0.68,
    }),
    // cross: ask 0.67 <= 0.68 - 0.01
    baseTick({
      ts: '2026-06-01T12:01:04.000Z',
      up_best_ask: 0.67,
      up_best_bid: 0.66,
    }),
  ];

  const result = hopper.runHopper3Backtest(params, ticks);
  assert.equal(result.summary.restingFilled, 1);
  assert.equal(result.summary.totalEntries, 1);

  const entered = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(entered);
  assert.equal(entered.fills[0].liquidity, 'maker');
  assert.equal(entered.fills[0].price, 0.68);
});

test('resting_maker rejects marketable bid >= ask', () => {
  const result = hopper.runHopper3Backtest(
    {
      executionMode: 'resting_maker',
      triggerExpensiveCents: 70,
      minEntryAskCents: 55,
      maxEntryAskCents: 85,
      maxSpreadCents: 10,
      distMinPtb: 0,
      minTimeForNewCycleSec: 35,
      maxFlipsAllowed: 0,
    },
    [
      baseTick({
        ts: '2026-06-01T12:01:00.000Z',
        up_best_ask: 0.70,
        up_best_bid: 0.70, // marketable
      }),
    ],
  );
  assert.equal(result.summary.restingPlaced, 0);
  assert.match(result.log.map((l) => l.msg).join('\n'), /RESTING REJECT/);
});

test('resting_maker cancels on timeout', () => {
  const result = hopper.runHopper3Backtest(
    {
      executionMode: 'resting_maker',
      makerTimeoutSec: 3,
      makerFillEpsilon: 0.01,
      triggerExpensiveCents: 70,
      minEntryAskCents: 55,
      maxEntryAskCents: 85,
      maxSpreadCents: 10,
      distMinPtb: 0,
      minTimeForNewCycleSec: 35,
      maxFlipsAllowed: 0,
    },
    [
      baseTick({
        ts: '2026-06-01T12:01:00.000Z',
        up_best_ask: 0.70,
        up_best_bid: 0.68,
      }),
      baseTick({
        ts: '2026-06-01T12:01:04.000Z',
        up_best_ask: 0.70,
        up_best_bid: 0.68,
      }),
    ],
  );
  assert.equal(result.summary.restingPlaced >= 1, true);
  assert.equal(result.summary.restingFilled, 0);
  assert.equal(result.summary.restingCancelled >= 1, true);
  assert.match(result.log.map((l) => l.msg).join('\n'), /RESTING CANCEL.*timeout/);
});

test('optimistic_maker still fills immediately at bid', () => {
  const result = hopper.runHopper3Backtest(
    {
      executionMode: 'optimistic_maker',
      triggerExpensiveCents: 70,
      minEntryAskCents: 55,
      maxEntryAskCents: 85,
      maxSpreadCents: 10,
      distMinPtb: 0,
      minTimeForNewCycleSec: 35,
      maxFlipsAllowed: 0,
    },
    [
      baseTick({
        ts: '2026-06-01T12:01:00.000Z',
        up_best_ask: 0.70,
        up_best_bid: 0.68,
      }),
    ],
  );
  assert.equal(result.summary.totalEntries, 1);
  assert.equal(result.events[0].fills[0].liquidity, 'maker');
  assert.equal(result.events[0].fills[0].price, 0.68);
  assert.equal(result.summary.restingPlaced, 0);
});

test('fee engine does not charge resting maker fills', () => {
  const result = hopper.runHopper3Backtest(
    {
      executionMode: 'resting_maker',
      makerTimeoutSec: 60,
      makerFillEpsilon: 0.01,
      triggerExpensiveCents: 70,
      minEntryAskCents: 55,
      maxEntryAskCents: 85,
      maxSpreadCents: 10,
      distMinPtb: 0,
      minTimeForNewCycleSec: 35,
      maxFlipsAllowed: 0,
    },
    [
      baseTick({ ts: '2026-06-01T12:01:00.000Z', up_best_ask: 0.70, up_best_bid: 0.68 }),
      baseTick({ ts: '2026-06-01T12:01:04.000Z', up_best_ask: 0.67, up_best_bid: 0.66 }),
    ],
  );

  applyPolymarketFeesToBacktestResult(result, { category: 'crypto' });
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event?.fees);
  assert.equal(event.fees.entryFee, 0);
  assert.equal(event.fees.makerTradesFree >= 1, true);
});
