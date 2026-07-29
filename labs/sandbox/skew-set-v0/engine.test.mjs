import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventEngine } from './engine.mjs';

const BASE = {
  openShares: 10,
  openPairSumMax: 1.0,
  openCapCents: 2,
  maxOpenAttempts: 3,
  tauOpenMin: 40,
  tauOpenMax: 240,
  spotBufferUsd: 15,
  oddsMinGap: 0.04,
  maxSkew: 0.3,
  skewDeadband: 0.05,
  rebalanceClipShares: 2,
  maxRebalancesPerEvent: 10,
  minSellEdge: 0.02,
  avgSumMax: 0.98,
  eqAskMax: 0.08,
  eqAvgSumMax: 0.99,
  eqMinShares: 0.5,
  tauEqMin: 12,
  tauDone: 3,
  maxEventNotional: 40,
  feeRate: 0.07,
  confirmationTicks: 1,
};

function tick(engine, opts) {
  return engine.onTick(opts);
}

test('1 — open recusado se soma > openPairSumMax', () => {
  const engine = createEventEngine({ ...BASE });
  tick(engine, { tau: 100, askUp: 0.55, askDown: 0.48 }); // sum 1.03
  assert.equal(engine.state.mode, 'idle');
  assert.equal(engine.state.fills.length, 0);
  assert.ok((engine.finish().blockCounts.OPEN_PAIR_SUM || 0) >= 1);
});

test('2 — open flat → shares iguais', () => {
  const engine = createEventEngine({ ...BASE });
  tick(engine, { tau: 100, askUp: 0.5, askDown: 0.5 });
  assert.equal(engine.state.mode, 'flat');
  assert.equal(engine.state.inv.UP.shares, 10);
  assert.equal(engine.state.inv.DOWN.shares, 10);
  assert.equal(engine.state.fills.filter((f) => f.kind === 'open').length, 2);
});

test('3 — sem concordância → zero rebalance buys', () => {
  const engine = createEventEngine({ ...BASE });
  // open at 0.50/0.50
  tick(engine, { tau: 100, askUp: 0.5, askDown: 0.5, btc: 100000, ptb: 100000 });
  // odds lean UP but spot flat (inside buffer) → no fav
  tick(engine, {
    tau: 90,
    askUp: 0.58,
    askDown: 0.42,
    bidUp: 0.57,
    bidDown: 0.41,
    btc: 100005,
    ptb: 100000,
  });
  const skewBuys = engine.state.fills.filter((f) => f.kind === 'skew_buy');
  assert.equal(skewBuys.length, 0);
  assert.equal(engine.state.inv.UP.shares, 10);
  assert.equal(engine.state.inv.DOWN.shares, 10);
});

test('4 — concordância UP → compra UP até maxSkew', () => {
  const engine = createEventEngine({
    ...BASE,
    avgSumMax: 1.05, // allow skew buys on this path
    maxRebalancesPerEvent: 20,
  });
  tick(engine, { tau: 120, askUp: 0.5, askDown: 0.5 });
  // Strong UP: spot + odds
  for (let tau = 110; tau >= 50; tau -= 1) {
    tick(engine, {
      tau,
      askUp: 0.6,
      askDown: 0.4,
      bidUp: 0.59,
      bidDown: 0.39,
      btc: 100050,
      ptb: 100000,
    });
  }
  const skewBuys = engine.state.fills.filter((f) => f.kind === 'skew_buy');
  assert.ok(skewBuys.length >= 1);
  assert.ok(skewBuys.every((f) => f.side === 'UP'));
  // targetFav = base*(1+0.3); base grows as we buy — aim at least first clip done
  assert.ok(engine.state.inv.UP.shares >= 12);
  assert.ok(engine.state.mode === 'skewing' || engine.state.inv.UP.shares > engine.state.inv.DOWN.shares);
});

test('5 — venda underdog bloqueada se bid sem edge', () => {
  const engine = createEventEngine({
    ...BASE,
    avgSumMax: 1.05,
    minSellEdge: 0.05,
    maxSkew: 0.4,
  });
  tick(engine, { tau: 120, askUp: 0.5, askDown: 0.5 });
  // Skew buy UP a few times so dog is above targetDog = base*(1-0.4)
  for (let i = 0; i < 5; i++) {
    tick(engine, {
      tau: 100 - i,
      askUp: 0.55,
      askDown: 0.45,
      bidUp: 0.54,
      bidDown: 0.44, // bid near/above avgCost of DOWN (0.50) → no edge after fee
      btc: 100040,
      ptb: 100000,
    });
  }
  const sells = engine.state.fills.filter((f) => f.kind === 'skew_sell');
  assert.equal(sells.length, 0);
  const result = engine.finish();
  assert.ok((result.blockCounts.SELL_NO_EDGE || 0) >= 1);
});

test('6 — EQ late no menor lado ≤ eqAskMax', () => {
  const engine = createEventEngine({
    ...BASE,
    avgSumMax: 1.05,
    eqAskMax: 0.08,
    tauEqMin: 12,
  });
  tick(engine, { tau: 120, askUp: 0.5, askDown: 0.5 });
  // Create residual: buy UP skew so DOWN is short relative? Actually residual
  // is the side with fewer shares. After skew UP, DOWN is smaller → EQ buys DOWN.
  tick(engine, {
    tau: 80,
    askUp: 0.6,
    askDown: 0.4,
    bidUp: 0.59,
    bidDown: 0.39,
    btc: 100050,
    ptb: 100000,
  });
  assert.ok(engine.state.inv.UP.shares > engine.state.inv.DOWN.shares);

  tick(engine, {
    tau: 10,
    askUp: 0.92,
    askDown: 0.06,
    bidUp: 0.91,
    bidDown: 0.05,
    btc: 100050,
    ptb: 100000,
  });
  const eqs = engine.state.fills.filter((f) => f.kind === 'eq');
  assert.equal(eqs.length, 1);
  assert.equal(eqs[0].side, 'DOWN');
  assert.ok(eqs[0].px <= 0.08);
  const res = residualOf(engine);
  assert.ok(res.shares < 0.5);
});

test('7 — avgSumMax bloqueia compra de skew', () => {
  const engine = createEventEngine({
    ...BASE,
    openPairSumMax: 1.0,
    avgSumMax: 0.96, // open already at 1.00 avgSum → any skew buy projects worse
  });
  tick(engine, { tau: 120, askUp: 0.5, askDown: 0.5 });
  assert.equal(engine.state.mode, 'flat');
  // avgSum after open = 1.00; buying more UP at 0.60 projects avgSum > 0.96
  tick(engine, {
    tau: 90,
    askUp: 0.6,
    askDown: 0.4,
    bidUp: 0.59,
    bidDown: 0.39,
    btc: 100050,
    ptb: 100000,
  });
  const skewBuys = engine.state.fills.filter((f) => f.kind === 'skew_buy');
  assert.equal(skewBuys.length, 0);
  assert.ok((engine.finish().blockCounts.SKEW_REFUSE_AVGSUM || 0) >= 1);
});

function residualOf(engine) {
  const d = engine.state.inv.UP.shares - engine.state.inv.DOWN.shares;
  if (Math.abs(d) < 1e-9) return { side: null, shares: 0 };
  return d > 0 ? { side: 'DOWN', shares: d } : { side: 'UP', shares: -d };
}
