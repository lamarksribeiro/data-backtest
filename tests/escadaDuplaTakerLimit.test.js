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

function makeTick(secondsIntoEvent, upAskCents, { upBookCents = upAskCents, bookSize = 500 } = {}) {
  const upAsk = upAskCents / 100;
  const downAsk = Math.max(0.01, 1 - upAsk);
  return {
    ts: new Date(Date.parse(EVENT_START) + secondsIntoEvent * 1000).toISOString(),
    event_start: EVENT_START,
    condition_id: 'cond-taker-limit',
    price_to_beat: 100000,
    btc_price: 100100,
    up_best_ask: upAsk,
    up_best_bid: Math.max(0.01, upAsk - 0.01),
    down_best_ask: downAsk,
    down_best_bid: Math.max(0.01, downAsk - 0.01),
    up_price: upAsk,
    down_price: downAsk,
    up_book_asks: JSON.stringify([{ price: upBookCents / 100, size: bookSize }]),
    down_book_asks: JSON.stringify([{ price: downAsk, size: bookSize }]),
  };
}

const BASE_PARAMS = {
  executionMode: 'resting_maker',
  makerPostMode: 'bid',
  throughFillOnTrigger: false,
  rearmOnMakerCancel: true,
  takerPriceMode: 'taker_limit',
  takerMaxExtraCents: 1,
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

// SUB-1 = 55¢ → fórmula 55,5¢ (+half spread) → cap 56,5¢ com takerMaxExtraCents=1

test('resolveTakerPriceMode aceita taker_limit; resolveTakerMissPolicy default rearm', () => {
  assert.equal(escada.resolveTakerPriceMode({ takerPriceMode: 'taker_limit' }), 'taker_limit');
  assert.equal(escada.resolveTakerMissPolicy({}), 'rearm');
  assert.equal(escada.resolveTakerMissPolicy({ takerMissPolicy: 'skip' }), 'skip');
});

test('taker_limit: gap grande (ask 70 no cruzamento do 55) vira MISS, sem inventário', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, takerMissPolicy: 'skip' },
    [makeTick(60, 70), makeTick(61, 70)],
  );
  const ev = result.events[0];
  assert.equal(ev.fills.filter((f) => f.side === 'UP').length, 0);
  assert.ok((ev.takerMisses || 0) >= 1);
  // skip: nível não reaponta — uma única tentativa
  assert.equal(ev.takerAttempts, 1);
});

test('taker_limit + rearm: miss reaponta e preenche quando o walk volta para <= cap', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, takerMissPolicy: 'rearm' },
    [makeTick(60, 70), makeTick(61, 55.5)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP' && f.liquidity === 'taker');
  assert.equal(ev.takerMisses, 1);
  assert.equal(upFills.length, 1);
  assert.ok(Math.abs(upFills[0].price - 0.555) < 1e-9);
});

test('taker_limit: walk dentro do cap preenche ao preço real do book', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS },
    [makeTick(60, 56)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP' && f.liquidity === 'taker');
  assert.equal(upFills.length, 1);
  // paga o walk real (56¢), não o preço fantasma do nível (55,5¢)
  assert.ok(Math.abs(upFills[0].price - 0.56) < 1e-9);
  assert.equal(ev.takerMisses || 0, 0);
});

test('takerLatencyTicks=1: decide no tick t, executa contra o book de t+1 (fuga do preço vira miss)', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, takerMissPolicy: 'skip', takerLatencyTicks: 1 },
    [makeTick(60, 56), makeTick(61, 70)],
  );
  const ev = result.events[0];
  assert.equal(ev.fills.filter((f) => f.side === 'UP').length, 0);
  assert.equal(ev.takerMisses, 1);
});

test('takerLatencyTicks=1: preço estável preenche no tick seguinte', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, takerLatencyTicks: 1 },
    [makeTick(60, 56), makeTick(61, 56)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP' && f.liquidity === 'taker');
  assert.equal(upFills.length, 1);
  assert.ok(Math.abs(upFills[0].price - 0.56) < 1e-9);
  assert.equal(upFills[0].time, makeTick(61, 56).ts);
});

test('modos existentes preservados: capped ainda preenche com cap no gap', () => {
  const result = escada.runEscadaDuplaBacktest(
    { ...BASE_PARAMS, takerPriceMode: 'capped', takerMaxExtraCents: 1 },
    [makeTick(60, 70)],
  );
  const ev = result.events[0];
  const upFills = ev.fills.filter((f) => f.side === 'UP' && f.liquidity === 'taker');
  assert.equal(upFills.length, 1);
  assert.ok(Math.abs(upFills[0].price - 0.565) < 1e-9);
});
