import test from 'node:test';
import assert from 'node:assert/strict';
import { runHyperionScalper } from '../src/strategies/hyperionScalper.js';

test('runHyperionScalper executes intra-event scalps with take-profit exit', () => {
  const event = {
    start: 1000,
    end: 301000,
    priceToBeat: 70000,
  };

  const ticks = [
    // Tick 0: Normal
    { ts: 10000, underlyingPrice: 70000, up_best_ask: 0.45, up_best_bid: 0.44 },
    // Tick 5: Impulse spike of +$30 USD on spot
    { ts: 15000, underlyingPrice: 70030, up_best_ask: 0.46, up_best_bid: 0.45 },
    // Tick 8: Book reprices UP bid to 0.58 (+12 cents gain)
    { ts: 18000, underlyingPrice: 70035, up_best_ask: 0.59, up_best_bid: 0.58 },
  ];

  const result = runHyperionScalper(event, ticks, { minSpikeAbs: 20, takeProfitCents: 0.10 });

  assert.ok(result);
  assert.equal(result.tradesCount, 1);
  assert.equal(result.traces.length, 2); // 1 Entry + 1 Exit
  assert.equal(result.traces[0].type, 'ENTRY');
  assert.equal(result.traces[1].type, 'EXIT');
  assert.equal(result.traces[1].reason, 'take_profit_scalp');
  assert.ok(result.totalPnl > 0);
});
