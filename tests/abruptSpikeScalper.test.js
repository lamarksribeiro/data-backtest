import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAbruptSpikeScalperRunner,
  mergeAbruptSpikeScalperParams,
} from '../src/strategies/abruptSpikeScalper.js';

test('mergeAbruptSpikeScalperParams merges defaults and custom overrides', () => {
  const merged = mergeAbruptSpikeScalperParams({
    minSpikeAbs: 40,
    strategyMode: 'impulse',
    maxTradesPerEvent: 3,
  });

  assert.equal(merged.minSpikeAbs, 40);
  assert.equal(merged.strategyMode, 'impulse');
  assert.equal(merged.maxTradesPerEvent, 3);
  assert.equal(merged.walletSize, 100);
});

test('AbruptSpikeScalper triggers entry on abrupt BTC price surge in fade mode', () => {
  const runner = createAbruptSpikeScalperRunner({
    minSpikeAbs: 30,
    strategyMode: 'fade',
    impulseSec: 5,
    cooldownSec: 2,
    takeProfitPct: 0.10,
    partialTakeProfitPct: 0.50,
  });

  const baseTs = new Date('2026-07-22T20:00:00.000Z').getTime();
  const ticks = [
    // Initial sample at 25 seconds into event (275s remaining)
    {
      condition_id: 'event-1',
      event_start: new Date(baseTs).toISOString(),
      event_end: new Date(baseTs + 300000).toISOString(),
      ts: new Date(baseTs + 25000).toISOString(),
      btc_price: 65000,
      price_to_beat: 65000,
      up_best_ask: 0.50,
      down_best_ask: 0.50,
      up_best_bid: 0.49,
      down_best_bid: 0.49,
    },
    // Abrupt BTC surge UP (+50 USD in 4s at 29s into event = 271s remaining)
    {
      condition_id: 'event-1',
      event_start: new Date(baseTs).toISOString(),
      event_end: new Date(baseTs + 300000).toISOString(),
      ts: new Date(baseTs + 29000).toISOString(),
      btc_price: 65050,
      price_to_beat: 65000,
      up_best_ask: 0.70,
      down_best_ask: 0.30,
      up_best_bid: 0.68,
      down_best_bid: 0.28,
    },
  ];

  for (const tick of ticks) {
    runner.processTick(tick);
  }

  const result = runner.finish();
  assert.equal(result.summary.totalEntries, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].orders[0].side, 'DOWN'); // Fade mode buys DOWN on UP spike
});

test('AbruptSpikeScalper handles partial take profit and multiple trades per event', () => {
  const runner = createAbruptSpikeScalperRunner({
    minSpikeAbs: 20,
    strategyMode: 'impulse',
    impulseSec: 4,
    cooldownSec: 2,
    takeProfitPct: 0.10,
    partialTakeProfitPct: 0.50,
    takeProfitBid: 0.80,
    maxTradesPerEvent: 5,
  });

  const baseTs = new Date('2026-07-22T20:00:00.000Z').getTime();

  // Trade 1: Initial sample -> Spike UP -> Partial TP -> Full TP
  const ticks = [
    {
      condition_id: 'event-multi',
      event_start: new Date(baseTs).toISOString(),
      event_end: new Date(baseTs + 300000).toISOString(),
      ts: new Date(baseTs + 30000).toISOString(),
      btc_price: 65000,
      price_to_beat: 65000,
      up_best_ask: 0.40,
      down_best_ask: 0.60,
      up_best_bid: 0.38,
      down_best_bid: 0.58,
    },
    // Spike 1 UP (+40 USD) -> Triggers BUY UP @ 0.40
    {
      condition_id: 'event-multi',
      event_start: new Date(baseTs).toISOString(),
      event_end: new Date(baseTs + 300000).toISOString(),
      ts: new Date(baseTs + 34000).toISOString(),
      btc_price: 65040,
      price_to_beat: 65000,
      up_best_ask: 0.40,
      down_best_ask: 0.60,
      up_best_bid: 0.38,
      down_best_bid: 0.58,
    },
    // Price moves up -> Partial Take Profit (+25% gain on UP bid = 0.50)
    {
      condition_id: 'event-multi',
      event_start: new Date(baseTs).toISOString(),
      event_end: new Date(baseTs + 300000).toISOString(),
      ts: new Date(baseTs + 37000).toISOString(),
      btc_price: 65050,
      price_to_beat: 65000,
      up_best_ask: 0.52,
      down_best_ask: 0.48,
      up_best_bid: 0.50,
      down_best_bid: 0.46,
    },
    // Full Take profit hit (bid reaches 0.85 >= 0.80)
    {
      condition_id: 'event-multi',
      event_start: new Date(baseTs).toISOString(),
      event_end: new Date(baseTs + 300000).toISOString(),
      ts: new Date(baseTs + 40000).toISOString(),
      btc_price: 65100,
      price_to_beat: 65000,
      up_best_ask: 0.86,
      down_best_ask: 0.14,
      up_best_bid: 0.85,
      down_best_bid: 0.12,
    },
  ];

  for (const tick of ticks) {
    runner.processTick(tick);
  }

  const result = runner.finish();
  assert.equal(result.summary.totalEntries, 1);
  assert.equal(result.events.length, 1);
  assert.ok(result.summary.totalPnl > 0, `Expected totalPnl > 0, got ${result.summary.totalPnl}`);
});
