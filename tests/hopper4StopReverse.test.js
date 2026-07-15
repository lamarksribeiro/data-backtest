import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/hopper-4-runner.js');

function loadHopper4() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __hopper4Exports;`)();
}

const hopper = loadHopper4();

function baseTick(overrides = {}) {
  const eventStart = overrides.event_start || '2026-06-01T12:00:00.000Z';
  return {
    ts: overrides.ts || '2026-06-01T12:01:00.000Z',
    event_start: eventStart,
    condition_id: overrides.condition_id || 'cond-hopper4-test',
    price_to_beat: 100000,
    btc_price: overrides.btc_price ?? 100050,
    up_best_ask: overrides.up_best_ask ?? 0.60,
    up_best_bid: overrides.up_best_bid ?? 0.58,
    down_best_ask: overrides.down_best_ask ?? 0.42,
    down_best_bid: overrides.down_best_bid ?? 0.40,
    up_price: overrides.up_price ?? 0.59,
    down_price: overrides.down_price ?? 0.41,
    up_book_asks: overrides.up_book_asks ?? JSON.stringify([{ price: 0.60, size: 500 }]),
    up_book_bids: overrides.up_book_bids ?? JSON.stringify([{ price: 0.58, size: 500 }]),
    down_book_asks: overrides.down_book_asks ?? JSON.stringify([{ price: 0.42, size: 500 }]),
    down_book_bids: overrides.down_book_bids ?? JSON.stringify([{ price: 0.40, size: 500 }]),
    ...overrides,
  };
}

const baseParams = {
  walletSize: 100,
  pctWallet: 0.06,
  triggerCents: 60,
  distMinPtb: 0,
  distFinalPtb: 0,
  minTimeForNewCycleSec: 35,
  cooldownBuySec: 0,
  cooldownFlipSec: 0,
  maxViradas: 5,
  multVirada: [2, 4, 8, 20, 32],
  fokEnabled: true,
  fokPriceCap: 0.75,
  fokAteVirada: 1,
};

test('mergeHopper4Params defaults match Hopper4 live', () => {
  const p = hopper.mergeHopper4Params({});
  assert.equal(p.triggerCents, 60);
  assert.equal(p.distMinPtb, 5);
  assert.equal(p.maxViradas, 5);
  assert.deepEqual(p.multVirada, [2, 4, 8, 20, 32]);
  assert.equal(p.fokEnabled, true);
  assert.equal(p.fokPriceCap, 0.75);
});

test('entrada INICIO no lado caro >= trigger', () => {
  const result = hopper.runHopper4Backtest(baseParams, [
    baseTick({
      ts: '2026-06-01T12:01:00.000Z',
      btc_price: 100050,
      up_best_ask: 0.62,
      up_best_bid: 0.60,
      down_best_ask: 0.40,
      down_best_bid: 0.38,
      up_book_asks: JSON.stringify([{ price: 0.62, size: 500 }]),
      up_book_bids: JSON.stringify([{ price: 0.60, size: 500 }]),
    }),
    baseTick({
      ts: '2026-06-01T12:04:50.000Z',
      btc_price: 100080,
      up_best_ask: 0.90,
      down_best_ask: 0.12,
    }),
  ]);

  assert.equal(result.summary.totalEntries, 1);
  const ev = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(ev);
  assert.equal(ev.fills.length >= 1, true);
  assert.equal(ev.fills[0].type, 'INICIO');
  assert.equal(ev.fills[0].side, 'UP');
  assert.match(result.log.map((l) => l.msg).join('\n'), /COMPRA Hopper 4.*INICIO/);
});

test('virada vende tudo e compra o oposto com mult', () => {
  const ticks = [
    // Entrada UP @ 62c
    baseTick({
      ts: '2026-06-01T12:01:00.000Z',
      btc_price: 100050,
      up_best_ask: 0.62,
      up_best_bid: 0.60,
      down_best_ask: 0.40,
      down_best_bid: 0.38,
      up_book_asks: JSON.stringify([{ price: 0.62, size: 500 }]),
      up_book_bids: JSON.stringify([{ price: 0.60, size: 500 }]),
      down_book_asks: JSON.stringify([{ price: 0.40, size: 500 }]),
      down_book_bids: JSON.stringify([{ price: 0.38, size: 500 }]),
    }),
    // Virada: DOWN >= 60c, BTC favorece DOWN
    baseTick({
      ts: '2026-06-01T12:01:30.000Z',
      btc_price: 99950,
      up_best_ask: 0.38,
      up_best_bid: 0.36,
      down_best_ask: 0.62,
      down_best_bid: 0.60,
      up_book_asks: JSON.stringify([{ price: 0.38, size: 500 }]),
      up_book_bids: JSON.stringify([{ price: 0.36, size: 500 }]),
      down_book_asks: JSON.stringify([{ price: 0.62, size: 500 }]),
      down_book_bids: JSON.stringify([{ price: 0.60, size: 500 }]),
    }),
    // Settlement DOWN wins
    baseTick({
      ts: '2026-06-01T12:04:50.000Z',
      btc_price: 99900,
      up_best_ask: 0.10,
      down_best_ask: 0.92,
    }),
  ];

  const result = hopper.runHopper4Backtest(baseParams, ticks);
  const ev = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(ev);
  assert.equal(ev.nViradas, 1);
  assert.equal(ev.exits.length >= 1, true);
  assert.equal(ev.exits[0].type, 'VIRA-VENDE');
  assert.equal(ev.exits[0].side, 'UP');
  const compraVirada = ev.fills.find((f) => String(f.type).includes('VIRA'));
  assert.ok(compraVirada);
  assert.equal(compraVirada.side, 'DOWN');
  // mult 2x da entrada
  const shEntrada = ev.fills.find((f) => f.type === 'INICIO').qty;
  assert.equal(compraVirada.qty, Math.round(shEntrada * 2));
});

test('FOK cancela virada sem zerar posição', () => {
  const ticks = [
    baseTick({
      ts: '2026-06-01T12:01:00.000Z',
      btc_price: 100050,
      up_best_ask: 0.62,
      up_best_bid: 0.60,
      down_best_ask: 0.40,
      down_best_bid: 0.38,
      up_book_asks: JSON.stringify([{ price: 0.62, size: 500 }]),
      up_book_bids: JSON.stringify([{ price: 0.60, size: 500 }]),
      down_book_asks: JSON.stringify([{ price: 0.40, size: 500 }]),
      down_book_bids: JSON.stringify([{ price: 0.38, size: 500 }]),
    }),
    // Virada tentada mas book DOWN com preço médio alto (acima de 75c)
    baseTick({
      ts: '2026-06-01T12:01:30.000Z',
      btc_price: 99950,
      up_best_ask: 0.20,
      up_best_bid: 0.18,
      down_best_ask: 0.80,
      down_best_bid: 0.78,
      up_book_asks: JSON.stringify([{ price: 0.20, size: 500 }]),
      up_book_bids: JSON.stringify([{ price: 0.18, size: 500 }]),
      down_book_asks: JSON.stringify([
        { price: 0.80, size: 5 },
        { price: 0.90, size: 500 },
      ]),
      down_book_bids: JSON.stringify([{ price: 0.78, size: 500 }]),
    }),
    baseTick({
      ts: '2026-06-01T12:04:50.000Z',
      btc_price: 100080,
      up_best_ask: 0.90,
      down_best_ask: 0.12,
    }),
  ];

  const result = hopper.runHopper4Backtest({
    ...baseParams,
    fokEnabled: true,
    fokPriceCap: 0.75,
    fokAteVirada: 1,
  }, ticks);

  const logs = result.log.map((l) => l.msg).join('\n');
  assert.match(logs, /FOK CANCELOU VIRADA/);
  const ev = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(ev);
  assert.equal(ev.nViradas, 0);
  assert.equal(ev.exits.length, 0);
  // Ainda tem posição UP (settlement)
  assert.equal(ev.fills.filter((f) => f.side === 'UP').length >= 1, true);
  assert.equal(ev.fills.filter((f) => f.side === 'DOWN').length, 0);
});

test('analisarLiquidezFok rejeita media acima do teto', () => {
  const an = hopper.analisarLiquidezFok(
    JSON.stringify([{ price: 0.80, size: 100 }]),
    50,
    0.80,
    0.75,
  );
  assert.equal(an.executavel, false);
});
