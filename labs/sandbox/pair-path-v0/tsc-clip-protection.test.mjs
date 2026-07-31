import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProtection,
  settlePath,
  takerFee,
  walkAsk,
} from './tsc-clip-protection.mjs';

function tick({
  tau,
  upAsk,
  downAsk,
  zUp = 2,
  zDown = -2,
  upSize = 10,
  downSize = 10,
}) {
  return {
    tau,
    upAsk,
    downAsk,
    zUp,
    zDown,
    asks: {
      UP: [{ px: upAsk, size: upSize }],
      DOWN: [{ px: downAsk, size: downSize }],
    },
  };
}

test('FAK depth walk retains a real partial fill', () => {
  const result = walkAsk(
    [
      { px: 0.8, size: 2 },
      { px: 0.81, size: 1 },
      { px: 0.83, size: 10 },
    ],
    5,
    0.81,
  );
  assert.equal(result.filledQty, 3);
  assert.equal(result.full, false);
  assert.equal(result.vwap, (0.8 * 2 + 0.81) / 3);
});

test('opposite hedge is executed only on a later snapshot', () => {
  const ticks = [
    tick({ tau: 10, upAsk: 0.8, downAsk: 0.2 }),
    tick({ tau: 9.5, upAsk: 0.79, downAsk: 0.2, zUp: -0.5 }),
    tick({ tau: 9, upAsk: 0.78, downAsk: 0.21, zUp: -0.7 }),
  ];
  const entry = {
    status: 'fill',
    side: 'UP',
    executionIndex: 0,
    fill: walkAsk(ticks[0].asks.UP, 5, 0.81),
  };
  const result = applyProtection(ticks, entry, {
    trigger: 'spot_z_lt_0',
    lockFloorPerShare: -0.05,
    latencyTicks: 1,
    slipCents: 1,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.signalIndex, 1);
  assert.equal(result.executionIndex, 2);
  assert.equal(result.fill.filledQty, 5);
  assert.ok(Math.abs(result.fill.vwap - 0.21) < 1e-12);
});

test('partial entry below minimum cannot create an impossible hedge order', () => {
  const ticks = [tick({ tau: 10, upAsk: 0.8, downAsk: 0.2 })];
  const entry = {
    status: 'fill',
    side: 'UP',
    executionIndex: 0,
    fill: walkAsk([{ px: 0.8, size: 3 }], 5, 0.81),
  };
  const result = applyProtection(ticks, entry, {
    trigger: 'always',
    lockFloorPerShare: -0.1,
    latencyTicks: 1,
    slipCents: 1,
  });
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'residual_below_minimum');
});

test('balanced complete set has outcome-independent PnL and bounded worst case', () => {
  const ticks = [
    tick({ tau: 10, upAsk: 0.8, downAsk: 0.2 }),
    tick({ tau: 9.5, upAsk: 0.79, downAsk: 0.2 }),
    tick({ tau: 9, upAsk: 0.78, downAsk: 0.2 }),
  ];
  const entry = {
    status: 'fill',
    side: 'UP',
    executionIndex: 0,
    fill: walkAsk(ticks[0].asks.UP, 5, 0.81),
  };
  const protection = {
    attempted: true,
    fill: walkAsk(ticks[2].asks.DOWN, 5, 0.21),
  };
  const up = settlePath(entry, protection, 'UP');
  const down = settlePath(entry, protection, 'DOWN');
  assert.equal(up.pnl, down.pnl);
  assert.equal(up.residualQty, 0);
  assert.equal(up.worstCasePnl, up.pnl);
  assert.ok(
    Math.abs(up.pnl - (5 - 5 - takerFee(0.8, 5) - takerFee(0.2, 5))) <
      1e-12,
  );
});
