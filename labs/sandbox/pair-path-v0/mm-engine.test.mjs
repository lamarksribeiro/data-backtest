import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPolicy, runEvent } from './mm-engine.mjs';

function ticks() {
  return [
    {
      tsMs: 100_500,
      tau: 100,
      upBid: 0.95,
      upAsk: 0.96,
      downBid: 0.04,
      downAsk: 0.05,
    },
    {
      tsMs: 101_500,
      tau: 99,
      upBid: 0.95,
      upAsk: 0.96,
      downBid: 0.04,
      downAsk: 0.05,
    },
    {
      tsMs: 102_500,
      tau: 98,
      upBid: 0.95,
      upAsk: 0.96,
      downBid: 0.039,
      downAsk: 0.05,
    },
  ];
}

function policy(tradeTape) {
  return defaultPolicy({
    entryTau: 120,
    stopQuoteTau: 1,
    zoneLo: 0.88,
    zoneHi: 0.995,
    maxNakedPx: 0.05,
    makerFillModel: 'trade_through',
    tradeTape,
  });
}

test('default maker order respects the observed five-share minimum', () => {
  assert.equal(defaultPolicy().size, 5);
});

test('strict later trade-through proves a resting maker buy fill', () => {
  const result = runEvent(
    ticks(),
    policy([
      {
        timestamp: 101,
        side: 'SELL',
        outcome: 'DOWN',
        price: 0.04,
        size: 100,
        transactionHash: 'same-price-does-not-prove-queue',
      },
      {
        timestamp: 102,
        side: 'SELL',
        outcome: 'DOWN',
        price: 0.039,
        size: 1,
        transactionHash: 'strict-trade-through',
      },
    ]),
    'DOWN',
  );
  assert.equal(result.makerFills, 1);
  assert.equal(result.invDOWN, 5);
});

test('trade in the posting second cannot prove a later hypothetical fill', () => {
  const result = runEvent(
    ticks(),
    policy([
      {
        timestamp: 100,
        side: 'SELL',
        outcome: 'DOWN',
        price: 0.01,
        size: 100,
        transactionHash: 'ambiguous-same-second',
      },
    ]),
    'DOWN',
  );
  assert.equal(result.makerFills, 0);
});
