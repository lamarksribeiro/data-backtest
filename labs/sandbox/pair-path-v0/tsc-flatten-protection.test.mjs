import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyProtection,
  chooseConservativeAction,
  estimateAction,
  settlePath,
  takerFee,
  walkAsk,
  walkBid,
} from './tsc-flatten-protection.mjs';

function book({ bid, ask, bidSize = 10, askSize = 10 }) {
  return {
    bestBid: bid,
    bestAsk: ask,
    bids: [{ px: bid, size: bidSize }],
    asks: [{ px: ask, size: askSize }],
  };
}

function tick({
  upBid,
  upAsk,
  downBid,
  downAsk,
  zUp = 2,
  zDown = -2,
  upBidSize = 10,
  upAskSize = 10,
  downBidSize = 10,
  downAskSize = 10,
}) {
  return {
    upAsk,
    downAsk,
    zUp,
    zDown,
    books: {
      UP: book({
        bid: upBid,
        ask: upAsk,
        bidSize: upBidSize,
        askSize: upAskSize,
      }),
      DOWN: book({
        bid: downBid,
        ask: downAsk,
        bidSize: downBidSize,
        askSize: downAskSize,
      }),
    },
  };
}

function entry(ticks, index = 0) {
  return {
    status: 'fill',
    side: 'UP',
    executionIndex: index,
    fill: walkAsk(ticks[index].books.UP.asks, 5, 0.81),
  };
}

function protection(overrides = {}) {
  return {
    actionMode: 'hybrid',
    trigger: { id: 'always', kind: 'always', mtmCeilingPerShare: null },
    actionFloorPerShare: -0.2,
    latencyTicks: 1,
    slipCents: 1,
    maxAttempts: 2,
    ...overrides,
  };
}

test('FAK ask and bid walks retain partial depth', () => {
  const ask = walkAsk(
    [
      { px: 0.8, size: 2 },
      { px: 0.81, size: 1 },
      { px: 0.83, size: 10 },
    ],
    5,
    0.81,
  );
  const bid = walkBid(
    [
      { px: 0.79, size: 2 },
      { px: 0.78, size: 1 },
      { px: 0.76, size: 10 },
    ],
    5,
    0.78,
  );
  assert.equal(ask.filledQty, 3);
  assert.equal(ask.full, false);
  assert.equal(bid.filledQty, 3);
  assert.equal(bid.full, false);
  assert.ok(Math.abs(bid.vwap - (0.79 * 2 + 0.78) / 3) < 1e-12);
});

test('hybrid chooses the larger conservative worst-case floor', () => {
  const ticks = [
    tick({ upBid: 0.79, upAsk: 0.8, downBid: 0.19, downAsk: 0.2 }),
  ];
  const loaded = entry(ticks);
  const pairPreferred = tick({
    upBid: 0.72,
    upAsk: 0.74,
    downBid: 0.22,
    downAsk: 0.24,
  });
  const flattenPreferred = tick({
    upBid: 0.78,
    upAsk: 0.8,
    downBid: 0.29,
    downAsk: 0.3,
  });
  assert.equal(
    chooseConservativeAction(pairPreferred, loaded, protection()).action,
    'pair',
  );
  assert.equal(
    chooseConservativeAction(flattenPreferred, loaded, protection()).action,
    'flatten',
  );
});

test('protection signal and execution are both later snapshots', () => {
  const ticks = [
    tick({ upBid: 0.79, upAsk: 0.8, downBid: 0.19, downAsk: 0.2 }),
    tick({ upBid: 0.78, upAsk: 0.79, downBid: 0.2, downAsk: 0.21 }),
    tick({ upBid: 0.77, upAsk: 0.78, downBid: 0.21, downAsk: 0.22 }),
  ];
  const result = applyProtection(
    ticks,
    entry(ticks),
    protection({ actionMode: 'flatten' }),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.signalIndex, 1);
  assert.equal(result.executionIndex, 2);
  assert.equal(result.action, 'flatten');
  assert.equal(result.fill.filledQty, 5);
});

test('zero-fill FAK can re-signal, while partial FAK is retained', () => {
  const ticks = [
    tick({ upBid: 0.79, upAsk: 0.8, downBid: 0.19, downAsk: 0.2 }),
    tick({ upBid: 0.78, upAsk: 0.79, downBid: 0.2, downAsk: 0.21 }),
    tick({
      upBid: 0.7,
      upAsk: 0.72,
      downBid: 0.28,
      downAsk: 0.3,
      upBidSize: 0,
    }),
    tick({ upBid: 0.76, upAsk: 0.77, downBid: 0.22, downAsk: 0.23 }),
    tick({
      upBid: 0.75,
      upAsk: 0.76,
      downBid: 0.23,
      downAsk: 0.24,
      upBidSize: 3,
    }),
  ];
  const result = applyProtection(
    ticks,
    entry(ticks),
    protection({ actionMode: 'flatten' }),
  );
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].reason, 'fak_no_fill');
  assert.equal(result.reason, 'partial_fill');
  assert.equal(result.fill.filledQty, 3);
});

test('full flatten produces outcome-independent realized PnL', () => {
  const ticks = [
    tick({ upBid: 0.79, upAsk: 0.8, downBid: 0.19, downAsk: 0.2 }),
  ];
  const loaded = entry(ticks);
  const flattenFill = walkBid(ticks[0].books.UP.bids, 5, 0.78);
  const flattened = {
    attempted: true,
    action: 'flatten',
    fill: flattenFill,
  };
  const up = settlePath(loaded, flattened, 'UP');
  const down = settlePath(loaded, flattened, 'DOWN');
  assert.equal(up.pnl, down.pnl);
  assert.equal(up.residualQty, 0);
  assert.equal(up.worstCasePnl, up.pnl);
  const expected =
    5 * 0.79 -
    takerFee(0.79, 5) -
    5 * 0.8 -
    takerFee(0.8, 5);
  assert.ok(Math.abs(up.pnl - expected) < 1e-12);
});

test('partial flatten retains directional residual and exact worst-case', () => {
  const ticks = [
    tick({ upBid: 0.79, upAsk: 0.8, downBid: 0.19, downAsk: 0.2 }),
  ];
  const loaded = entry(ticks);
  const partial = walkBid([{ px: 0.79, size: 3 }], 5, 0.78);
  const settlement = settlePath(
    loaded,
    { attempted: true, action: 'flatten', fill: partial },
    'UP',
  );
  assert.equal(settlement.residualQty, 2);
  assert.equal(settlement.flattenedQty, 3);
  assert.ok(settlement.worstCasePnl < 0);
});

test('signal-side full-depth requirement rejects knowingly partial protection', () => {
  const ticks = [
    tick({ upBid: 0.79, upAsk: 0.8, downBid: 0.19, downAsk: 0.2 }),
  ];
  const loaded = entry(ticks);
  const signal = tick({
    upBid: 0.78,
    upAsk: 0.79,
    downBid: 0.2,
    downAsk: 0.21,
    upBidSize: 3,
    downAskSize: 3,
  });
  assert.equal(estimateAction(signal, loaded, 'flatten').admissible, false);
  assert.equal(estimateAction(signal, loaded, 'pair').admissible, false);
  assert.equal(chooseConservativeAction(signal, loaded, protection()), null);
});
