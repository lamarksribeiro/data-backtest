import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPolymarketFeesToBacktestResult, calculatePolymarketTakerFee } from '../src/backtest/fees.js';

test('polymarket taker fee uses shares * rate * price * (1 - price)', () => {
  assert.equal(calculatePolymarketTakerFee({ shares: 10, price: 0.5, feeRate: 0.07 }), 0.175);
  assert.equal(calculatePolymarketTakerFee({ shares: 12, price: 0.25, feeRate: 0.07 }), 0.1575);
  assert.equal(calculatePolymarketTakerFee({ shares: 10, price: 1, feeRate: 0.07 }), 0);
});

test('applyPolymarketFeesToBacktestResult adjusts pnl and summary metrics', () => {
  const result = {
    params: { walletSize: 100 },
    events: [
      {
        eventId: 'a',
        eventStart: '2026-06-01T00:00:00.000Z',
        eventEnd: '2026-06-01T00:05:00.000Z',
        closedAt: '2026-06-01T00:04:00.000Z',
        positionType: 'UP',
        quantity: 10,
        cost: 3,
        finalPnl: 4,
        orders: [{ type: 'entry', side: 'UP', ts: '2026-06-01T00:01:00.000Z', shares: 10, avgPrice: 0.3, notional: 3 }],
        exits: [{ side: 'UP', ts: '2026-06-01T00:04:00.000Z', shares: 10, avgPrice: 0.7, notional: 7 }],
      },
      {
        eventId: 'b',
        eventStart: '2026-06-01T00:05:00.000Z',
        eventEnd: '2026-06-01T00:10:00.000Z',
        closedAt: '2026-06-01T00:09:00.000Z',
        positionType: 'DOWN',
        quantity: 10,
        cost: 4,
        finalPnl: -2,
        orders: [{ type: 'entry', side: 'DOWN', ts: '2026-06-01T00:06:00.000Z', shares: 10, avgPrice: 0.4, notional: 4 }],
        exits: [{ side: 'DOWN', ts: '2026-06-01T00:09:00.000Z', shares: 10, avgPrice: 0.2, notional: 2 }],
      },
      { eventId: 'c', eventStart: '2026-06-01T00:10:00.000Z', eventEnd: '2026-06-01T00:15:00.000Z', finalPnl: 0, reason: 'no_entry' },
    ],
    equity: [],
    summary: { totalEvents: 3, totalEntries: 2 },
    log: [],
  };

  applyPolymarketFeesToBacktestResult(result);

  assert.equal(result.events[0].finalPnlBeforeFees, 4);
  assert.equal(result.events[0].fees.totalFee, 0.294);
  assert.equal(result.events[0].finalPnl, 3.706);
  assert.equal(result.events[1].fees.totalFee, 0.28);
  assert.equal(result.summary.fees.totalFee, 0.574);
  assert.equal(result.summary.feesPaid, 0.574);
  assert.equal(result.summary.volume, 16);
  assert.equal(result.summary.totalWins, 1);
  assert.equal(result.summary.totalLosses, 1);
  assert.equal(round(result.summary.totalPnl), 1.426);
  assert.equal(result.summary.sharpeRatio, result.summary.sharpe);
  assert.equal(result.summary.sortinoRatio, result.summary.sortino);
  assert.ok(result.equity.length);
});

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
