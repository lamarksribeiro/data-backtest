import test from 'node:test';
import assert from 'node:assert/strict';
import { runHyperionMakerScalper } from '../src/strategies/hyperionScalperMaker.js';

test('runHyperionMakerScalper executes partial maker limit exits with zero exit fee', () => {
  const event = {
    start: 1000,
    end: 301000,
    priceToBeat: 70000,
  };

  const ticks = [
    // Tick 0: Normal
    { ts: 10000, underlyingPrice: 70000, up_best_ask: 0.45, up_best_bid: 0.44 },
    // Tick 5: Impulse spike of +$30 USD on spot -> Taker Entry at Ask 0.46
    { ts: 15000, underlyingPrice: 70030, up_best_ask: 0.46, up_best_bid: 0.45 },
    // Tick 8: Book reprices Ask to 0.55 (+9¢ move) -> Triggers Level 1 Limit Target (+8¢ Maker Exit 50%)
    { ts: 18000, underlyingPrice: 70035, up_best_ask: 0.55, up_best_bid: 0.54 },
    // Tick 12: Book reprices Ask to 0.61 (+15¢ move) -> Triggers Level 2 Limit Target (+14¢ Maker Exit 50%)
    { ts: 22000, underlyingPrice: 70040, up_best_ask: 0.61, up_best_bid: 0.60 },
  ];

  const result = runHyperionMakerScalper(event, ticks, { minSpikeAbs: 20 });

  assert.ok(result);
  assert.equal(result.tradesCount, 1);
  assert.equal(result.traces.length, 3); // 1 Entry + 1 Partial Exit + 1 Final Exit
  assert.equal(result.traces[0].type, 'ENTRY');
  assert.equal(result.traces[1].type, 'PARTIAL_MAKER_EXIT');
  assert.equal(result.traces[1].fee, 0); // ZERO Maker Fee on Exit
  assert.equal(result.traces[2].type, 'MAKER_EXIT_FINAL');
  assert.equal(result.traces[2].fee, 0); // ZERO Maker Fee on Exit
  assert.ok(result.totalPnl > 0);
});
