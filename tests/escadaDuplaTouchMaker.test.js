import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/escada-dupla-runner.js');

function loadEscada() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __escadaExports;`)();
}

const escada = loadEscada();

function baseTick(overrides = {}) {
  const upAsk = overrides.up_best_ask ?? 0.55;
  const downAsk = overrides.down_best_ask ?? Math.max(0.01, 1 - upAsk);
  return {
    ts: overrides.ts || '2026-06-01T12:02:00.000Z',
    event_start: overrides.event_start || '2026-06-01T12:00:00.000Z',
    condition_id: overrides.condition_id || 'cond-escada-touch',
    price_to_beat: 100000,
    btc_price: overrides.btc_price ?? 100100,
    up_best_ask: upAsk,
    up_best_bid: overrides.up_best_bid ?? Math.max(0.01, upAsk - 0.01),
    down_best_ask: downAsk,
    down_best_bid: overrides.down_best_bid ?? Math.max(0.01, downAsk - 0.01),
    up_price: upAsk,
    down_price: downAsk,
    up_book_asks: overrides.up_book_asks ?? JSON.stringify([{ price: upAsk, size: 500 }]),
    down_book_asks: overrides.down_book_asks ?? JSON.stringify([{ price: downAsk, size: 500 }]),
    ...overrides,
  };
}

const TOUCH_PARAMS = {
  sideMultiplier: 1,
  ladderProfile: 'ascent_hedge',
  rearmMode: 'off',
  liquidityMode: 'auto',
  executionMode: 'touch_maker',
  throughFillOnTrigger: true,
  makerPostMode: 'limit',
  rearmOnMakerCancel: true,
  spreadCents: 1,
  slippageCents: 1,
  makerFillEpsilon: 0.01,
  makerTimeoutSec: 30,
  maxSubLevels: 1,
  maxDescLevels: 1,
  equalizeEnabled: false,
  maxEventNotional: 200,
  maxSharesPerSide: 400,
  minSecondsLeftToStart: 45,
  maxSecondsLeftToStart: 240,
};

test('resolveExecutionMode reconhece touch_maker', () => {
  assert.equal(escada.resolveExecutionMode({ executionMode: 'touch_maker' }), 'touch_maker');
  assert.equal(escada.resolveMakerPostMode({ makerPostMode: 'auto' }, 'touch_maker'), 'limit');
  assert.equal(escada.resolveMakerPostMode({ makerPostMode: 'auto' }, 'resting_maker'), 'bid');
});

test('touch_maker: hedge DESC preenche maker no tick em que ask já <= limit', () => {
  const tick = baseTick({
    ts: '2026-06-01T12:02:00.000Z',
    up_best_ask: 0.55,
    up_best_bid: 0.54,
    down_best_ask: 0.45,
    down_best_bid: 0.44,
  });
  const result = escada.runEscadaDuplaBacktest(TOUCH_PARAMS, [tick]);
  const ev = result.events[0];
  assert.ok(ev);
  assert.equal(ev.leaderSide, 'UP');
  const downMaker = ev.fills.filter((f) => f.side === 'DOWN' && f.liquidity === 'maker');
  const upTaker = ev.fills.filter((f) => f.side === 'UP' && f.liquidity === 'taker');
  assert.ok(upTaker.length >= 1, 'líder deve ser taker');
  assert.ok(downMaker.length >= 1, 'oposto DESC deve through-fill maker');
  assert.equal(downMaker[0].price, 0.45);
});

test('touch_maker + taker formula paga halfSpread+slip sem walk profundo', () => {
  const tick = baseTick({
    ts: '2026-06-01T12:02:00.000Z',
    up_best_ask: 0.55,
    up_best_bid: 0.54,
    down_best_ask: 0.45,
    down_best_bid: 0.44,
    up_book_asks: JSON.stringify([
      { price: 0.55, size: 1 },
      { price: 0.90, size: 500 },
    ]),
  });
  const result = escada.runEscadaDuplaBacktest(
    { ...TOUCH_PARAMS, takerPriceMode: 'formula', slippageCents: 1, spreadCents: 1 },
    [tick],
  );
  const ev = result.events[0];
  const up = ev.fills.find((f) => f.side === 'UP' && f.liquidity === 'taker');
  assert.ok(up);
  // limit 55¢ + halfSpread 0.5 + slip 1 = 56.5¢
  assert.ok(Math.abs(up.price - 0.565) < 1e-6, `got ${up.price}`);
});

test('touch_maker + capped limita walk adverso', () => {
  const tick = baseTick({
    ts: '2026-06-01T12:02:00.000Z',
    up_best_ask: 0.55,
    down_best_ask: 0.45,
    up_book_asks: JSON.stringify([
      { price: 0.55, size: 1 },
      { price: 0.95, size: 500 },
    ]),
  });
  const result = escada.runEscadaDuplaBacktest(
    {
      ...TOUCH_PARAMS,
      takerPriceMode: 'capped',
      takerMaxExtraCents: 1,
      slippageCents: 0,
      spreadCents: 1,
    },
    [tick],
  );
  const up = result.events[0].fills.find((f) => f.side === 'UP');
  assert.ok(up);
  const formula = 0.55 + 0.005; // half spread
  const cap = formula + 0.01;
  assert.ok(up.price <= cap + 1e-9, `capped price ${up.price} > ${cap}`);
});

test('touch_maker preenche mais hedge que resting_maker no mesmo path curto', () => {
  const ticks = [
    baseTick({
      ts: '2026-06-01T12:02:00.000Z',
      up_best_ask: 0.55,
      down_best_ask: 0.45,
      down_best_bid: 0.44,
    }),
    baseTick({
      ts: '2026-06-01T12:04:50.000Z',
      up_best_ask: 0.60,
      down_best_ask: 0.40,
      btc_price: 100200,
    }),
  ];
  const touch = escada.runEscadaDuplaBacktest(TOUCH_PARAMS, ticks);
  const resting = escada.runEscadaDuplaBacktest(
    { ...TOUCH_PARAMS, executionMode: 'resting_maker', makerPostMode: 'bid', throughFillOnTrigger: false },
    ticks,
  );
  const tEv = touch.events.find((e) => e.fills?.length) || touch.events[0];
  const rEv = resting.events.find((e) => e.fills?.length) || resting.events[0];
  const tDown = tEv.fills.filter((f) => f.side === 'DOWN').reduce((s, f) => s + f.qty, 0);
  const rDown = rEv.fills.filter((f) => f.side === 'DOWN').reduce((s, f) => s + f.qty, 0);
  assert.ok(tDown > rDown, `touch DOWN=${tDown} deveria > resting DOWN=${rDown}`);
});
