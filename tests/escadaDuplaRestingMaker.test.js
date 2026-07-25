import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/escada-dupla-runner.js');
const PRESET_PATH = path.resolve(
  __dirname,
  '../labs/strategies/carry/escada-dupla-v1/presets/btc-resting-honest.json',
);

function loadEscada() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __escadaExports;`)();
}

const escada = loadEscada();

function baseTick(overrides = {}) {
  const eventStart = overrides.event_start || '2026-06-01T12:00:00.000Z';
  const upAsk = overrides.up_best_ask ?? 0.55;
  const downAsk = overrides.down_best_ask ?? Math.max(0.01, 1 - upAsk);
  return {
    ts: overrides.ts || '2026-06-01T12:02:00.000Z',
    event_start: eventStart,
    condition_id: overrides.condition_id || 'cond-escada-resting',
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

const RESTING_PARAMS = {
  sideMultiplier: 1,
  ladderProfile: 'ascent_hedge',
  rearmMode: 'off',
  liquidityMode: 'auto',
  executionMode: 'resting_maker',
  spreadCents: 1,
  slippageCents: 0,
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

test('preset btc-resting-honest usa resting_maker com microestrutura do champion', () => {
  const preset = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
  assert.equal(preset.studioVersion, 4);
  assert.equal(preset.params.executionMode, 'resting_maker');
  assert.equal(preset.params.spreadCents, 1);
  assert.equal(preset.params.slippageCents, 0);
  assert.equal(preset.params.applyPolymarketFees, true);
  assert.equal(preset.params.ladderProfile, 'ascent_hedge');
  assert.equal(escada.mergeEscadaParams(preset.params).executionMode, 'resting_maker');
});

test('shouldFillRestingBuy exige atravessar limit - epsilon', () => {
  assert.equal(escada.shouldFillRestingBuy(0.45, 0.44, 0.44, 0.01), false);
  assert.equal(escada.shouldFillRestingBuy(0.45, 0.43, 0.44, 0.01), true);
  assert.equal(escada.shouldFillRestingBuy(null, 0.43, 0.44, 0.01), false);
});

test('resting_maker: oposto não preenche no tick de disparo (só resting place)', () => {
  // tau=180s → dentro da janela [45, 240]
  const tick = baseTick({
    ts: '2026-06-01T12:02:00.000Z',
    up_best_ask: 0.55,
    up_best_bid: 0.54,
    down_best_ask: 0.45,
    down_best_bid: 0.44,
  });

  const result = escada.runEscadaDuplaBacktest(RESTING_PARAMS, [tick]);
  const ev = result.events[0];
  assert.ok(ev);
  assert.equal(ev.leaderSide, 'UP');
  assert.ok(ev.restingPlaced >= 1, 'deveria colocar resting no lado oposto');
  assert.equal(ev.restingFilled || 0, 0);
  assert.ok(ev.fills.every((f) => f.side === 'UP' && f.liquidity === 'taker'));
  assert.equal(ev.fills.filter((f) => f.side === 'DOWN').length, 0);
  const logs = result.log.map((l) => l.msg).join('\n');
  assert.match(logs, /RESTING PLACE/);
});

test('resting_maker: fill do oposto só após ask atravessar o limit', () => {
  const ticks = [
    baseTick({
      ts: '2026-06-01T12:02:00.000Z',
      up_best_ask: 0.55,
      up_best_bid: 0.54,
      down_best_ask: 0.45,
      down_best_bid: 0.44,
    }),
    // ainda sem cross (ask > bid - epsilon no resting price 0.44)
    baseTick({
      ts: '2026-06-01T12:02:02.000Z',
      up_best_ask: 0.56,
      up_best_bid: 0.55,
      down_best_ask: 0.44,
      down_best_bid: 0.43,
    }),
    // cross: prevAsk 0.44, currAsk 0.43 <= 0.44 - 0.01
    baseTick({
      ts: '2026-06-01T12:02:04.000Z',
      up_best_ask: 0.57,
      up_best_bid: 0.56,
      down_best_ask: 0.43,
      down_best_bid: 0.42,
    }),
    // fecha o evento no settlement
    baseTick({
      ts: '2026-06-01T12:04:50.000Z',
      up_best_ask: 0.60,
      up_best_bid: 0.59,
      down_best_ask: 0.40,
      down_best_bid: 0.39,
      btc_price: 100200,
    }),
  ];

  const result = escada.runEscadaDuplaBacktest(RESTING_PARAMS, ticks);
  const ev = result.events.find((e) => e.reason !== 'no_entry') || result.events[0];
  assert.ok(ev);
  assert.ok(ev.restingFilled >= 1, `esperava fill resting, got ${ev.restingFilled}`);
  const downMaker = ev.fills.filter((f) => f.side === 'DOWN' && f.liquidity === 'maker');
  assert.ok(downMaker.length >= 1);
  assert.ok(ev.fills.some((f) => f.side === 'UP' && f.liquidity === 'taker'));
});

test('optimistic_maker preenche mais shares no oposto que resting no mesmo path', () => {
  const ticks = [
    baseTick({
      ts: '2026-06-01T12:02:00.000Z',
      up_best_ask: 0.55,
      up_best_bid: 0.54,
      down_best_ask: 0.45,
      down_best_bid: 0.44,
    }),
    baseTick({
      ts: '2026-06-01T12:02:05.000Z',
      up_best_ask: 0.56,
      up_best_bid: 0.55,
      down_best_ask: 0.44,
      down_best_bid: 0.43,
    }),
    baseTick({
      ts: '2026-06-01T12:04:50.000Z',
      up_best_ask: 0.60,
      up_best_bid: 0.59,
      down_best_ask: 0.40,
      down_best_bid: 0.39,
      btc_price: 100200,
    }),
  ];

  const optimistic = escada.runEscadaDuplaBacktest(
    { ...RESTING_PARAMS, executionMode: 'optimistic_maker' },
    ticks,
  );
  const resting = escada.runEscadaDuplaBacktest(RESTING_PARAMS, ticks);

  const optEv = optimistic.events.find((e) => e.fills?.length) || optimistic.events[0];
  const restEv = resting.events.find((e) => e.fills?.length) || resting.events[0];

  const optDown = optEv.fills.filter((f) => f.side === 'DOWN').reduce((s, f) => s + f.qty, 0);
  const restDown = restEv.fills.filter((f) => f.side === 'DOWN').reduce((s, f) => s + f.qty, 0);

  assert.ok(optDown > restDown, `optimistic DOWN=${optDown} deveria > resting DOWN=${restDown}`);
  assert.ok((restEv.restingPlaced || 0) >= 1);
});
