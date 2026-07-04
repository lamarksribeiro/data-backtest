import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { createOrderSimulator, settleEventPnl } from '../src/backtestStudio/gls/orderSimulator.js';

function tickWithAsks(side, asks, book = 'ask') {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const key = book === 'bid' ? `${prefix}_book_bids` : `${prefix}_book_asks`;
  return { [key]: JSON.stringify(asks) };
}

// Tick com ask acima do limite → a LIMIT repousa (não é marketable)
const restingTickDown = tickWithAsks('DOWN', [{ price: 0.55, size: 100 }]);

test('placeLimitBuy validates args and respects maxRestingOrders', () => {
  const simulator = createOrderSimulator({ limits: { maxRestingOrders: 2 } });
  assert.equal(simulator.placeLimitBuy('INVALID', { price: 0.4, budget: 10, tick: restingTickDown }), false);
  assert.equal(simulator.placeLimitBuy('UP', { price: 1.0, budget: 10, tick: restingTickDown }), false);
  assert.equal(simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: restingTickDown }).id, 'lim-1');
  assert.equal(simulator.placeLimitBuy('DOWN', { price: 0.35, budget: 10, tick: restingTickDown }).id, 'lim-2');
  assert.equal(simulator.placeLimitBuy('DOWN', { price: 0.3, budget: 10, tick: restingTickDown }), false);
  assert.equal(simulator.restingView.length, 2);
});

test('placeLimitBuy rejects marketable orders (price >= best ask)', () => {
  const simulator = createOrderSimulator();
  // Ask a 0.35 e limite a 0.40 → marketable, não repousa
  const marketableTick = tickWithAsks('DOWN', [{ price: 0.35, size: 100 }]);
  assert.equal(simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: marketableTick }), false);
  // Sem tick/book → sem referência de preço, rejeita
  assert.equal(simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10 }), false);
  // Ask a 0.55 e limite a 0.40 → repousa
  assert.ok(simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: restingTickDown }));
});

test('maker fill does not trigger when ask was already below limit at placement', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  // Simula ask já abaixo do limite — placeLimitBuy rejeita (marketable)
  const belowLimit = tickWithAsks('DOWN', [{ price: 0.35, size: 100 }]);
  assert.equal(simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: belowLimit }), false);
});

test('maker fill triggers only when best ask crosses below limit minus epsilon', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, ts: '2026-06-01T00:00:01.000Z', tick: restingTickDown });

  assert.equal(simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.41, size: 100 }])), 0);
  assert.equal(simulator.restingView[0].status, 'open');

  // Encostar no limite não dispara (0.40 > 0.40 - 0.01 = 0.39)
  assert.equal(simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.40, size: 100 }])), 0);
  assert.equal(simulator.restingView[0].status, 'open');

  assert.equal(simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.39, size: 100 }])), 1);
  assert.equal(simulator.restingView[0].status, 'filled');
  assert.equal(simulator.positionView.hedge, null);
});

test('maker fill credits hedge lot while primary position stays intact', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.enter('UP', {
    ts: '2026-06-01T00:00:01.000Z',
    price: 0.6,
    maxPrice: 0.6,
    budget: 6,
    minShares: 1,
    tick: tickWithAsks('UP', [{ price: 0.6, size: 20 }]),
  });
  simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, ts: '2026-06-01T00:00:01.500Z', tick: restingTickDown });

  simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.38, size: 200 }]));

  assert.equal(simulator.positionView.open, true);
  assert.equal(simulator.positionView.side, 'UP');
  assert.equal(simulator.positionView.shares, 10);
  assert.deepEqual(simulator.positionView.hedge, { side: 'DOWN', shares: 25, cost: 10 });
});

test('settleEventPnl sums hedged lots on flip loss and whipsaw win', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.enter('UP', {
    ts: '2026-06-01T00:00:01.000Z',
    price: 0.6,
    maxPrice: 0.6,
    budget: 6,
    minShares: 1,
    tick: tickWithAsks('UP', [{ price: 0.6, size: 20 }]),
  });
  simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: restingTickDown });
  simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.38, size: 200 }]));

  const flipLoss = settleEventPnl(simulator, { underlyingPrice: 99000, price_to_beat: 100000 }, { priceToBeat: 100000 });
  assert.equal(flipLoss.winnerSide, 'DOWN');
  assert.equal(flipLoss.primaryLotPnl, -6);
  assert.equal(flipLoss.hedgePnl, 15);
  assert.equal(flipLoss.finalPnl, 9);

  const simulator2 = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator2.enter('UP', {
    ts: '2026-06-01T00:00:01.000Z',
    price: 0.6,
    maxPrice: 0.6,
    budget: 6,
    minShares: 1,
    tick: tickWithAsks('UP', [{ price: 0.6, size: 20 }]),
  });
  simulator2.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: restingTickDown });
  simulator2.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.38, size: 200 }]));

  const whipsaw = settleEventPnl(simulator2, { underlyingPrice: 101000, price_to_beat: 100000 }, { priceToBeat: 100000 });
  assert.equal(whipsaw.winnerSide, 'UP');
  assert.equal(whipsaw.primaryLotPnl, 4);
  assert.equal(whipsaw.hedgePnl, -10);
  assert.equal(whipsaw.finalPnl, -6);
});

test('cancelLimit and expireRestingOrders leave zero hedge cost', () => {
  const simulator = createOrderSimulator();
  simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: restingTickDown });
  assert.equal(simulator.cancelLimit(null), 1);
  assert.equal(simulator.restingView[0].status, 'cancelled');

  const simulator2 = createOrderSimulator();
  simulator2.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: restingTickDown });
  simulator2.expireRestingOrders();
  assert.equal(simulator2.restingView[0].status, 'expired');
  const settlement = settleEventPnl(simulator2, { underlyingPrice: 100000, price_to_beat: 100000 }, { priceToBeat: 100000 });
  assert.equal(settlement.reason, 'no_entry');
});

test('hasOpenRestingOrders blocks early finalize semantics', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.enter('UP', {
    ts: '2026-06-01T00:00:01.000Z',
    price: 0.6,
    maxPrice: 0.6,
    budget: 6,
    minShares: 1,
    tick: tickWithAsks('UP', [{ price: 0.6, size: 20 }]),
  });
  simulator.exit({
    ts: '2026-06-01T00:00:02.000Z',
    price: 0.7,
    tick: tickWithAsks('UP', [{ price: 0.7, size: 100 }], 'bid'),
  });
  simulator.placeLimitBuy('DOWN', { price: 0.4, budget: 10, tick: restingTickDown });

  assert.equal(simulator.positionView.open, false);
  assert.equal(simulator.hasOpenRestingOrders(), true);
});

test('placeBuyStop validates args and rejects stop at or below market', () => {
  const simulator = createOrderSimulator();
  const lowAsk = tickWithAsks('DOWN', [{ price: 0.35, size: 100 }]);
  assert.equal(simulator.placeBuyStop('INVALID', { stopPrice: 0.55, budget: 10, tick: lowAsk }), false);
  assert.equal(simulator.placeBuyStop('DOWN', { stopPrice: 0.30, budget: 10, tick: lowAsk }), false);
  assert.equal(simulator.placeBuyStop('DOWN', { stopPrice: 0.35, budget: 10, tick: lowAsk }), false);
  assert.ok(simulator.placeBuyStop('DOWN', { stopPrice: 0.55, budget: 10, tick: lowAsk }));
});

test('stop buy fill triggers when ask rises through trigger minus epsilon', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  const armTick = tickWithAsks('DOWN', [{ price: 0.38, size: 100 }]);
  simulator.placeBuyStop('DOWN', { stopPrice: 0.55, budget: 10, ts: '2026-06-01T00:00:10.000Z', tick: armTick });

  assert.equal(simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.40, size: 100 }])), 0);
  assert.equal(simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.52, size: 100 }])), 0);
  assert.equal(simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.55, size: 100 }])), 1);
  assert.equal(simulator.restingView[0].status, 'filled');
  const stopFill = simulator.snapshot().orders.find((o) => o.restingOrderId?.startsWith('stp-'));
  assert.equal(stopFill.liquidity, 'taker');
});

test('stop buy fill credits hedge lot on flip repricing', () => {
  const simulator = createOrderSimulator({ limits: { makerFillEpsilon: 0.01 } });
  simulator.enter('UP', {
    ts: '2026-06-01T00:00:01.000Z',
    price: 0.6,
    maxPrice: 0.6,
    budget: 6,
    minShares: 1,
    tick: tickWithAsks('UP', [{ price: 0.6, size: 20 }]),
  });
  simulator.placeBuyStop('DOWN', { stopPrice: 0.55, budget: 10, tick: tickWithAsks('DOWN', [{ price: 0.38, size: 100 }]) });
  simulator.checkRestingOrders(tickWithAsks('DOWN', [{ price: 0.56, size: 200 }]));

  assert.equal(simulator.positionView.open, true);
  assert.equal(simulator.positionView.side, 'UP');
  assert.deepEqual(simulator.positionView.hedge, { side: 'DOWN', shares: 18, cost: 9.9 });

  const flipLoss = settleEventPnl(simulator, { underlyingPrice: 99000, price_to_beat: 100000 }, { priceToBeat: 100000 });
  assert.equal(flipLoss.winnerSide, 'DOWN');
  assert.equal(flipLoss.primaryLotPnl, -6);
  assert.ok(flipLoss.hedgePnl > 0);
  assert.ok(flipLoss.finalPnl > flipLoss.primaryLotPnl);
});

test('applyPolymarketFeesToBacktestResult exempts maker fills and reports makerNotional', () => {
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
        cost: 6,
        finalPnl: 5,
        orders: [
          { type: 'entry', side: 'UP', ts: '2026-06-01T00:01:00.000Z', shares: 10, avgPrice: 0.6, notional: 6, liquidity: 'taker' },
          { type: 'entry', side: 'DOWN', ts: '2026-06-01T00:02:00.000Z', shares: 25, avgPrice: 0.4, notional: 10, liquidity: 'maker', reason: 'hedge_limit' },
        ],
        exits: [],
      },
    ],
    summary: { totalEntries: 1, totalPnl: 5 },
  };

  const adjusted = applyPolymarketFeesToBacktestResult(result);
  const takerFee = adjusted.events[0].fees.entryFee;
  assert.ok(takerFee > 0);
  assert.equal(adjusted.events[0].fees.makerTradesFree, 1);
  assert.equal(adjusted.events[0].fees.makerNotional, 10);
  assert.equal(adjusted.summary.fees.makerNotional, 10);
  assert.equal(adjusted.summary.fees.makerTradesFree, 1);
});
