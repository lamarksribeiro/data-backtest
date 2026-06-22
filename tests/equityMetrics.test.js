import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEquityCurveFromEvents,
  computeMaxDrawdown,
  computeRecoveryFactor,
  finalizeEquityMetrics,
} from '../src/backtest/equityMetrics.js';

test('computeMaxDrawdown measures peak-to-trough drop, not single-trade loss', () => {
  const equity = [
    { ts: '2026-06-01T00:05:00.000Z', pnl: 10 },
    { ts: '2026-06-01T00:10:00.000Z', pnl: 5 },
    { ts: '2026-06-01T00:15:00.000Z', pnl: -3 },
  ];

  assert.equal(computeMaxDrawdown(equity), 13);
});

test('buildEquityCurveFromEvents sorts events before accumulating pnl', () => {
  const events = [
    {
      eventId: 'b',
      closedAt: '2026-06-01T00:10:00.000Z',
      finalPnl: -8,
      orders: [{ shares: 1 }],
    },
    {
      eventId: 'a',
      closedAt: '2026-06-01T00:05:00.000Z',
      finalPnl: 10,
      orders: [{ shares: 1 }],
    },
  ];

  const equity = buildEquityCurveFromEvents(events);
  assert.deepEqual(equity.map((point) => point.pnl), [10, 2]);
  assert.equal(computeMaxDrawdown(equity), 8);
});

test('finalizeEquityMetrics aligns summary drawdown with stored equity curve', () => {
  const result = {
    events: [],
    equity: [
      { ts: '2026-06-01T00:05:00.000Z', pnl: 20 },
      { ts: '2026-06-01T00:10:00.000Z', pnl: 8 },
      { ts: '2026-06-01T00:15:00.000Z', pnl: 15 },
    ],
    summary: {
      totalPnl: 15,
      maxLoss: -7,
      maxDrawdown: 7,
    },
  };

  finalizeEquityMetrics(result);

  assert.equal(result.summary.maxDrawdown, 12);
  assert.equal(result.summary.recoveryFactor, 1.25);
});

test('computeRecoveryFactor returns null when drawdown is zero', () => {
  assert.equal(computeRecoveryFactor(10, 0), null);
  assert.equal(computeRecoveryFactor(10, 5), 2);
});