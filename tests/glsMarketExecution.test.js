import test from 'node:test';
import assert from 'node:assert/strict';

import { createGlsRunnerFromSource } from '../src/backtestStudio/gls/runtime.js';
import { createOrderSimulator } from '../src/backtestStudio/gls/orderSimulator.js';

test('GLS order simulator sells only available bid-book liquidity', () => {
  const simulator = createOrderSimulator();
  const entry = simulator.enter('UP', {
    ts: '2026-05-31T00:00:01.000Z',
    price: 0.4,
    maxPrice: 0.4,
    budget: 4,
    minShares: 1,
    tick: {
      up_book_asks: JSON.stringify([{ price: 0.4, size: 10 }]),
    },
  });
  assert.equal(entry.shares, 10);

  const exit = simulator.exit({
    ts: '2026-05-31T00:00:02.000Z',
    price: 0.79,
    tick: {
      up_book_bids: JSON.stringify([
        { price: 0.8, size: 3 },
        { price: 0.79, size: 4 },
        { price: 0.78, size: 100 },
      ]),
    },
  });

  assert.equal(exit.shares, 7);
  assert.equal(exit.closed, false);
  assert.equal(exit.remainingShares, 3);
  assert.equal(exit.notional, 5.5600000000000005);
  assert.equal(exit.avgPrice, 0.7942857142857144);
  assert.ok(Math.abs(exit.pnl - 2.76) < 0.0000001);
  assert.deepEqual(exit.fills, [
    { price: 0.8, qty: 3 },
    { price: 0.79, qty: 4 },
  ]);

  const snapshot = simulator.snapshot();
  assert.equal(snapshot.position.shares, 3);
  assert.ok(Math.abs(snapshot.position.openCost - 1.2) < 0.0000001);
});

test('GLS order simulator does not reverse unless old position is fully sold', () => {
  const simulator = createOrderSimulator();
  simulator.enter('UP', {
    ts: '2026-05-31T00:00:01.000Z',
    price: 0.4,
    maxPrice: 0.4,
    budget: 4,
    minShares: 1,
    tick: {
      up_book_asks: JSON.stringify([{ price: 0.4, size: 10 }]),
    },
  });

  const reversed = simulator.reverse('DOWN', {
    ts: '2026-05-31T00:00:02.000Z',
    exitPrice: 0.2,
    price: 0.45,
    maxPrice: 0.45,
    budget: 4,
    minShares: 1,
    tick: {
      up_book_bids: JSON.stringify([{ price: 0.2, size: 4 }]),
      down_book_asks: JSON.stringify([{ price: 0.45, size: 20 }]),
    },
  });

  assert.equal(reversed, false);
  const snapshot = simulator.snapshot();
  assert.equal(snapshot.position.side, 'UP');
  assert.equal(snapshot.position.shares, 6);
  assert.equal(snapshot.orders.length, 2);
  assert.equal(snapshot.orders[1].type, 'exit');
  assert.equal(snapshot.orders[1].closed, false);
});

test('GLS order simulator does not fabricate bid liquidity when no bid level crosses limit', () => {
  const simulator = createOrderSimulator();
  simulator.enter('DOWN', {
    ts: '2026-05-31T00:00:01.000Z',
    price: 0.5,
    maxPrice: 0.5,
    budget: 5,
    minShares: 1,
    tick: {
      down_book_asks: JSON.stringify([{ price: 0.5, size: 10 }]),
    },
  });

  const exit = simulator.exit({
    ts: '2026-05-31T00:00:02.000Z',
    price: 0.52,
    tick: {
      down_book_bids: JSON.stringify([{ price: 0.51, size: 10 }]),
    },
  });

  assert.equal(exit, false);
  const snapshot = simulator.snapshot();
  assert.equal(snapshot.position.shares, 10);
  assert.equal(snapshot.realizedPnl, 0);
});

test('GLS order simulator does not reuse cached book levels from mutable tick cursors', () => {
  const simulator = createOrderSimulator();
  let index = 0;
  const cursor = {
    setIndex(nextIndex) {
      index = nextIndex;
    },
    get book_depth() {
      return 1;
    },
    get up_ask_px_1() {
      return index === 0 ? 0.1 : 0.2;
    },
    get up_ask_sz_1() {
      return 10;
    },
  };

  const first = simulator.enter('UP', {
    ts: '2026-05-31T00:00:01.000Z',
    price: 0.1,
    maxPrice: 0.2,
    budget: 2,
    minShares: 1,
    tick: cursor,
  });
  assert.deepEqual(first.fills, [{ price: 0.1, qty: 10 }]);

  simulator.reset();
  cursor.setIndex(1);
  const second = simulator.enter('UP', {
    ts: '2026-05-31T00:00:02.000Z',
    price: 0.2,
    maxPrice: 0.2,
    budget: 2,
    minShares: 1,
    tick: cursor,
  });

  assert.deepEqual(second.fills, [{ price: 0.2, qty: 10 }]);
});

test('GLS runtime passes tick book depth into strategy exits', () => {
  const runner = createGlsRunnerFromSource(`
    strategy "Market Real Exit" {
      onTick(tick, event) {
        if (!position.open) {
          enter("UP", { price: 0.4, maxPrice: 0.4, budget: 4, minShares: 1, tick: tick, reason: "entry" })
        } else {
          let bid = book.bid("UP", tick)
          if (bid >= 0.79) {
            exit({ price: 0.79, reason: "take" })
          }
        }
      }

      onEventEnd(event) {
      }
    }
  `);

  runner.processTick({
    condition_id: 'runtime-market-exit-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    ts: '2026-05-31T00:00:01.000Z',
    btc_price: 72900,
    price_to_beat: 73000,
    up_best_ask: 0.4,
    up_best_bid: 0.39,
    down_best_ask: 0.6,
    down_best_bid: 0.59,
    up_book_asks: JSON.stringify([{ price: 0.4, size: 10 }]),
  });
  runner.processTick({
    condition_id: 'runtime-market-exit-1',
    event_start: '2026-05-31T00:00:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
    ts: '2026-05-31T00:00:02.000Z',
    btc_price: 72900,
    price_to_beat: 73000,
    up_best_ask: 0.82,
    up_best_bid: 0.8,
    down_best_ask: 0.2,
    down_best_bid: 0.18,
    up_book_bids: JSON.stringify([
      { price: 0.8, size: 3 },
      { price: 0.79, size: 4 },
      { price: 0.78, size: 100 },
    ]),
  });

  const result = runner.finish();
  const [event] = result.events;
  assert.equal(event.exits[0].shares, 7);
  assert.deepEqual(event.exits[0].fills, [
    { price: 0.8, qty: 3 },
    { price: 0.79, qty: 4 },
  ]);
  assert.equal(event.orders[0].shares, 10);
  assert.equal(event.positionType, 'UP');
  assert.equal(event.expirationResult, 'loss');
});
