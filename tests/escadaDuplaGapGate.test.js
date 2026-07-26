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

const EVENT_START = '2026-06-01T12:00:00.000Z';

function makeTick(secondsIntoEvent, upAskCents, { bookSize = 500 } = {}) {
  const upAsk = upAskCents / 100;
  const downAsk = Math.max(0.01, 1 - upAsk);
  return {
    ts: new Date(Date.parse(EVENT_START) + secondsIntoEvent * 1000).toISOString(),
    event_start: EVENT_START,
    condition_id: 'cond-gap-gate',
    price_to_beat: 100000,
    btc_price: 100100,
    up_best_ask: upAsk,
    up_best_bid: Math.max(0.01, upAsk - 0.01),
    down_best_ask: downAsk,
    down_best_bid: Math.max(0.01, downAsk - 0.01),
    up_price: upAsk,
    down_price: downAsk,
    up_book_asks: JSON.stringify([{ price: upAsk, size: bookSize }]),
    down_book_asks: JSON.stringify([{ price: downAsk, size: bookSize }]),
  };
}

const BASE_PARAMS = {
  executionMode: 'resting_maker',
  makerPostMode: 'bid',
  throughFillOnTrigger: false,
  rearmOnMakerCancel: true,
  takerPriceMode: 'walk',
  ladderProfile: 'ascent_hedge',
  rearmMode: 'off',
  maxSubLevels: 1,
  maxDescLevels: 1,
  equalizeEnabled: false,
  sideMultiplier: 1,
  spreadCents: 1,
  slippageCents: 0,
  minSecondsLeftToStart: 45,
  maxSecondsLeftToStart: 240,
  maxEventNotional: 200,
};

test('maxCrossGapCents: salto de book além do gate não executa o gatilho e mantém o nível armado', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, maxCrossGapCents: 2 },
    [makeTick(60, 70), makeTick(61, 56)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP');
  // tick 1: gap 15¢ > 2¢ → skip; tick 2: gap 1¢ ≤ 2¢ → executa a 56¢
  assert.ok((ev.gateGapSkips || 0) >= 1);
  assert.equal(upFills.length, 1);
  assert.ok(Math.abs(upFills[0].price - 0.56) < 1e-9);
});

test('maxCrossGapCents: gap nunca fecha → zero fills no lado líder', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, maxCrossGapCents: 1 },
    [makeTick(60, 70), makeTick(61, 72), makeTick(62, 75)],
  );
  const ev = result.events[0];
  assert.equal(ev.fills.filter((f) => f.side === 'UP').length, 0);
  // 3 skips SUB (UP) + 3 skips DESC (DOWN, gap 15-20¢ também acima do gate)
  assert.equal(ev.gateGapSkips, 6);
});

test('gapShareScaleCents: shares encolhem proporcionalmente ao gap do cruzamento', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, gapShareScaleCents: 5 },
    [makeTick(60, 57)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP');
  // SUB-1 = 55¢, 30 shares; gap 2¢ com escala 5¢ → 30 × (1 − 2/5) = 18
  assert.equal(upFills.length, 1);
  assert.ok(Math.abs(upFills[0].qty - 18) < 1e-9);
  assert.ok((ev.gateScaledDown || 0) >= 1);
});

test('gapShareScaleCents: gap >= escala zera a compra e o nível segue armado para gap menor', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, gapShareScaleCents: 5 },
    [makeTick(60, 62), makeTick(61, 56)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP');
  // tick 1: gap 7¢ ≥ 5¢ → 0 shares; tick 2: gap 1¢ → 30 × 0,8 = 24
  assert.equal(upFills.length, 1);
  assert.ok(Math.abs(upFills[0].qty - 24) < 1e-9);
});

test('gates desligados (default 0) preservam o comportamento antigo', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS },
    [makeTick(60, 70)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP');
  assert.equal(upFills.length, 1);
  assert.ok(Math.abs(upFills[0].qty - 30) < 1e-9);
  assert.equal(ev.gateGapSkips || 0, 0);
});
