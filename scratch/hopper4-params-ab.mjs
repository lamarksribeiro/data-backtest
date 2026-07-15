/**
 * A/B: same ticks, two param sets — PnL must differ if engine applies params.
 * Uses portable runner directly (no lake needed for synthetic; for lake use lab).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/hopper-4-runner.js');
const code = fs.readFileSync(RUNNER, 'utf8');
const hopper = new Function(`"use strict";\n${code}\nreturn __hopper4Exports;`)();

function tick(overrides = {}) {
  return {
    ts: '2026-06-01T12:01:00.000Z',
    event_start: '2026-06-01T12:00:00.000Z',
    condition_id: 'ab-test',
    price_to_beat: 100000,
    btc_price: 100050,
    up_best_ask: 0.62,
    up_best_bid: 0.60,
    down_best_ask: 0.40,
    down_best_bid: 0.38,
    up_price: 0.61,
    down_price: 0.39,
    up_book_asks: JSON.stringify([{ price: 0.62, size: 500 }]),
    up_book_bids: JSON.stringify([{ price: 0.60, size: 500 }]),
    down_book_asks: JSON.stringify([{ price: 0.40, size: 500 }]),
    down_book_bids: JSON.stringify([{ price: 0.38, size: 500 }]),
    ...overrides,
  };
}

const ticks = [
  tick({ ts: '2026-06-01T12:01:00.000Z', btc_price: 100050 }),
  tick({
    ts: '2026-06-01T12:01:40.000Z',
    btc_price: 99950,
    up_best_ask: 0.38, up_best_bid: 0.36,
    down_best_ask: 0.62, down_best_bid: 0.60,
    up_book_asks: JSON.stringify([{ price: 0.38, size: 500 }]),
    up_book_bids: JSON.stringify([{ price: 0.36, size: 500 }]),
    down_book_asks: JSON.stringify([{ price: 0.62, size: 500 }]),
    down_book_bids: JSON.stringify([{ price: 0.60, size: 500 }]),
  }),
  tick({ ts: '2026-06-01T12:04:50.000Z', btc_price: 99900, up_best_ask: 0.1, down_best_ask: 0.9 }),
];

const base = {
  walletSize: 100, pctWallet: 0.06, triggerCents: 60, distMinPtb: 0, distFinalPtb: 0,
  cooldownBuySec: 0, cooldownFlipSec: 0, fokEnabled: false, minTimeForNewCycleSec: 35,
};

const a = hopper.runHopper4Backtest({ ...base, maxViradas: 0 }, ticks);
const b = hopper.runHopper4Backtest({ ...base, maxViradas: 3 }, ticks);

console.log('maxViradas=0', {
  strategy: a.strategy,
  pnl: a.summary.totalPnl,
  fills: a.events[0]?.fills?.length,
  exits: a.events[0]?.exits?.length,
  nViradas: a.events[0]?.nViradas,
});
console.log('maxViradas=3', {
  strategy: b.strategy,
  pnl: b.summary.totalPnl,
  fills: b.events[0]?.fills?.length,
  exits: b.events[0]?.exits?.length,
  nViradas: b.events[0]?.nViradas,
});
console.log('params affect result?', a.summary.totalPnl !== b.summary.totalPnl);
