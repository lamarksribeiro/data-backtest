import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateFee,
  makerFillObservation,
  simulatePassivePair,
} from '../scripts/lab-paired-liquidity-reconstitution.js';

const BASE = {
  id: 'base',
  makerFeeRate: 0,
  takerFeeRate: 0.07,
  takerRebateRate: 0,
  slippageTicks: 1,
  depthHaircut: 0.5,
  queueHaircut: 0.35,
  latencyMs: 750,
  legLatencyMs: 500,
  exitLatencyMs: 750,
  touchThroughTicks: 1,
  confirmMs: 1000,
};

const VARIANT = {
  id: 'maker-pair-test',
  family: 'paired-maker-reconstitution',
  frequency: 'test',
  targetTau: 180,
  maxBidSum: 0.99,
  maxCombinedSpread: 0.06,
  minTopDepth: 5,
  minPrice: 0.1,
  maxPrice: 0.9,
  ttlSec: 10,
};

test('official crypto fee curve is symmetric and rounded to five decimals', () => {
  assert.equal(calculateFee(100, 0.3, 0.07), 1.47);
  assert.equal(calculateFee(100, 0.7, 0.07), 1.47);
  assert.equal(calculateFee(100, 0.5, 0.07), 1.75);
});

test('maker fill requires configured trade-through instead of a mere touch', () => {
  const common = {
    askSize: 100,
    quote: 0.49,
    touchThroughTicks: 1,
    queueHaircut: 0.35,
    requestedQty: 5,
  };
  assert.equal(makerFillObservation({ ...common, ask: 0.49 }), 0);
  assert.equal(makerFillObservation({ ...common, ask: 0.48 }), 5);
});

test('paired passive fills lock the same net result for UP and DOWN settlement', () => {
  const ticks = [
    tick('2026-05-05T00:02:00.000Z', 0.51, 0.49, 0.51, 0.49),
    tick('2026-05-05T00:02:01.000Z', 0.48, 0.47, 0.48, 0.47),
    tick('2026-05-05T00:02:02.000Z', 0.48, 0.47, 0.48, 0.47),
  ];
  const result = simulatePassivePair(ticks, VARIANT, BASE, { qty: 5, riskCapUsd: 5 });
  assert.equal(result.entered, true);
  assert.equal(result.matchedShares, 5);
  assert.ok(Math.abs(result.resultIfUp - 0.1) < 1e-9);
  assert.ok(Math.abs(result.resultIfDown - 0.1) < 1e-9);
  assert.equal(result.worstCase, result.bestCase);
});

test('one-sided maker fill is unwound and never reported as a locked pair', () => {
  const ticks = [
    tick('2026-05-05T00:02:00.000Z', 0.51, 0.49, 0.51, 0.49),
    tick('2026-05-05T00:02:01.000Z', 0.48, 0.48, 0.52, 0.49),
    tick('2026-05-05T00:02:02.000Z', 0.48, 0.48, 0.52, 0.49),
    tick('2026-05-05T00:02:11.000Z', 0.50, 0.48, 0.52, 0.49),
    tick('2026-05-05T00:02:12.000Z', 0.50, 0.48, 0.52, 0.49),
  ];
  const result = simulatePassivePair(ticks, VARIANT, BASE, { qty: 5, riskCapUsd: 5 });
  assert.equal(result.entered, true);
  assert.equal(result.matchedShares, 0);
  assert.equal(result.locked, false);
  assert.equal(result.orderMisses, 1);
  assert.ok(result.pnlNet < 0);
  assert.ok(Math.abs(result.resultIfUp - result.resultIfDown) < 1e-9);
});

function tick(ts, upAsk, upBid, downAsk, downBid) {
  const eventStart = '2026-05-05T00:00:00.000Z';
  return {
    id: Date.parse(ts),
    condition_id: 'event-test',
    event_start: eventStart,
    event_end: '2026-05-05T00:05:00.000Z',
    ts,
    btc_price: 100,
    price_to_beat: 99,
    up_best_ask: upAsk,
    up_best_bid: upBid,
    down_best_ask: downAsk,
    down_best_bid: downBid,
    up_book_asks: [{ price: upAsk, size: 100 }],
    up_book_bids: [{ price: upBid, size: 100 }],
    down_book_asks: [{ price: downAsk, size: 100 }],
    down_book_bids: [{ price: downBid, size: 100 }],
  };
}
