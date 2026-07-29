import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventEngine } from './engine.mjs';

const BASE = {
  openShares: 10,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTriggerCents: 55,
  openCapCents: 2,
  tauOpenMin: 40,
  tauOpenMax: 240,
  tauHedgeMin: 15,
  maxHedgeAttempts: 8,
  maxEventNotional: 25,
  eqAskMax: 0,
  restingFillModel: 'none',
};

function tick(engine, tau, upAsk, downAsk, ts = tau) {
  engine.onTick({ tau, upAsk, downAsk, ts });
}

test('second escape remains available below tauHedgeMin', () => {
  const engine = createEventEngine({
    ...BASE,
    hedgeLevels: [{ askMax: 0.4, frac: 1 }],
    avgSumMax: 0.94,
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1,
  });

  tick(engine, 100, 0.56, 0.45);
  tick(engine, 10, 0.56, 0.44);

  const result = engine.finish();
  assert.equal(result.residual.shares, 0);
  assert.equal(result.fills.at(-1).kind, 'hedge_escape2');
});

test('escape refuses a pair whose fee-adjusted locked PnL breaches the floor', () => {
  const engine = createEventEngine({
    ...BASE,
    hedgeLevels: [{ askMax: 0.4, frac: 1 }],
    avgSumMax: 0.94,
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    escapeMinLockedPnlPerShare: 0,
  });

  tick(engine, 100, 0.56, 0.45);
  tick(engine, 20, 0.56, 0.42);

  const result = engine.finish();
  assert.equal(result.residual.shares, 10);
  assert.equal(result.blockCounts.HEDGE_REFUSE_LOCKED_PNL, 1);
  assert.equal(result.fills.length, 1);
});

test('restingFillModel=none never manufactures a maker fill from a crossing', () => {
  const engine = createEventEngine({
    ...BASE,
    hedgeLevels: [{ askMax: 0.4, frac: 1 }],
    avgSumMax: 0.96,
  });

  tick(engine, 100, 0.56, 0.45);
  tick(engine, 90, 0.56, 0.43);
  tick(engine, 80, 0.56, 0.39);

  const result = engine.finish();
  assert.equal(result.residual.shares, 0);
  assert.equal(result.fills.at(-1).liquidity, 'taker');
  assert.equal(result.fills.some((fill) => fill.liquidity === 'maker'), false);
});

test('maxClipsPerTick=1 models sequential clip submission', () => {
  const engine = createEventEngine({
    ...BASE,
    hedgeLevels: [
      { askMax: 0.4, frac: 0.5 },
      { askMax: 0.38, frac: 0.5 },
    ],
    avgSumMax: 0.96,
    maxClipsPerTick: 1,
  });

  tick(engine, 100, 0.56, 0.45);
  tick(engine, 90, 0.56, 0.35);
  assert.equal(engine.state.inv.DOWN.shares, 5);

  tick(engine, 89, 0.56, 0.35);
  const result = engine.finish();
  assert.equal(result.inv.DOWN.shares, 10);
  assert.equal(result.fills.filter((fill) => fill.kind === 'hedge_clip').length, 2);
});

test('confirmationTicks requires consecutive qualifying observations', () => {
  const engine = createEventEngine({
    ...BASE,
    confirmationTicks: 2,
    hedgeAskMax: 0.4,
    avgSumMax: 0.96,
  });

  tick(engine, 100, 0.56, 0.45);
  assert.equal(engine.state.mode, 'idle');
  tick(engine, 99, 0.56, 0.45);
  assert.equal(engine.state.mode, 'opened');

  tick(engine, 90, 0.56, 0.39);
  assert.equal(engine.state.inv.DOWN.shares, 0);
  tick(engine, 89, 0.56, 0.39);
  assert.equal(engine.state.inv.DOWN.shares, 10);
});
