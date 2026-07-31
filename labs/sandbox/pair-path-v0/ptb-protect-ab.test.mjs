import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBaseParams, runEvent } from './ptb-protect-ab.mjs';

function tick({
  tsMs,
  tau,
  upAsk,
  downAsk,
  distance = 30,
}) {
  return {
    tsMs,
    tau,
    upAsk,
    downAsk,
    underlyingPrice: 100_000 + distance,
    priceToBeat: 100_000,
    upAskPrices: [upAsk],
    upAskSizes: [100],
    downAskPrices: [downAsk],
    downAskSizes: [100],
  };
}

function params(overrides = {}) {
  return {
    ...buildBaseParams(0),
    id: 'test',
    hedgeId: 'hedge-asap',
    hedgeMode: 'asap',
    openShares: 10,
    openConfirmationTicks: 1,
    latencyTicks: 1,
    openLeaveUsd: 0,
    minimumOrderShares: 5,
    ...overrides,
  };
}

test('tight2 size 10 submits two valid five-share clips', () => {
  const result = runEvent(
    [
      tick({ tsMs: 0, tau: 200, upAsk: 0.55, downAsk: 0.46 }),
      tick({ tsMs: 500, tau: 199.5, upAsk: 0.55, downAsk: 0.4 }),
      tick({ tsMs: 1_000, tau: 199, upAsk: 0.64, downAsk: 0.36 }),
      tick({ tsMs: 1_500, tau: 198.5, upAsk: 0.65, downAsk: 0.36 }),
    ],
    params({
      hedgeAskMax: 0.4,
      avgSumMax: 0.95,
      hedgeLevels: [
        { askMax: 0.4, frac: 0.5 },
        { askMax: 0.36, frac: 0.5 },
      ],
    }),
    'tight2',
  );
  assert.equal(result.equalized, true);
  assert.deepEqual(
    result.fillDetails.map((fill) => fill.shares),
    [10, 5, 5],
  );
});

test('deep3 size 10 rejects the impossible four-share first clip', () => {
  const result = runEvent(
    [
      tick({ tsMs: 0, tau: 200, upAsk: 0.55, downAsk: 0.46 }),
      tick({ tsMs: 500, tau: 199.5, upAsk: 0.55, downAsk: 0.4 }),
      tick({ tsMs: 1_000, tau: 199, upAsk: 0.65, downAsk: 0.32 }),
      tick({ tsMs: 1_500, tau: 198.5, upAsk: 0.67, downAsk: 0.3 }),
    ],
    params({
      hedgeAskMax: 0.4,
      avgSumMax: 0.96,
      hedgeLevels: [
        { askMax: 0.4, frac: 0.4 },
        { askMax: 0.36, frac: 0.3 },
        { askMax: 0.32, frac: 0.3 },
      ],
    }),
    'deep3',
  );
  assert.equal(result.equalized, false);
  assert.equal(result.hedgeFills, 0);
  assert.equal(result.residual, 10);
});

test('shot-protect can submit a full emergency hedge after PTB return', () => {
  const result = runEvent(
    [
      tick({ tsMs: 0, tau: 200, upAsk: 0.55, downAsk: 0.46, distance: 30 }),
      tick({ tsMs: 500, tau: 199.5, upAsk: 0.55, downAsk: 0.43, distance: 28 }),
      tick({ tsMs: 1_000, tau: 199, upAsk: 0.54, downAsk: 0.47, distance: 15 }),
      tick({ tsMs: 1_500, tau: 198.5, upAsk: 0.53, downAsk: 0.47, distance: 10 }),
    ],
    params({
      hedgeMode: 'never',
      hedgeAskMax: 0,
      avgSumMax: 0,
      emergencyHedge: {
        triggerDistMaxUsd: 20,
        askMax: 0.55,
        avgSumMax: 1.1,
      },
    }),
    'shot-protect',
  );
  assert.equal(result.equalized, true);
  assert.equal(result.fillDetails.at(-1).kind, 'emergency_hedge');
  assert.equal(result.fillDetails.at(-1).shares, 10);
});

test('canonical winner overrides an agreeing but wrong terminal proxy', () => {
  const result = runEvent(
    [
      tick({ tsMs: 0, tau: 200, upAsk: 0.55, downAsk: 0.46 }),
      tick({ tsMs: 500, tau: 199.5, upAsk: 0.55, downAsk: 0.46 }),
      tick({ tsMs: 1_000, tau: 0.5, upAsk: 0.99, downAsk: 0.01 }),
    ],
    params({
      hedgeMode: 'never',
      canonicalWinners: { canonical_test: 'DOWN' },
    }),
    'canonical_test',
  );
  assert.equal(result.proxyWinner, 'UP');
  assert.equal(result.winner, 'DOWN');
  assert.equal(result.winnerSource, 'canonical_override');
  assert.ok(result.guardedRealizedPnl < 0);
});
