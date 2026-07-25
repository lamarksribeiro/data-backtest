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

test('hashUnitInterval é determinístico e em [0,1)', () => {
  const a = escada.hashUnitInterval('seed-a');
  const b = escada.hashUnitInterval('seed-a');
  const c = escada.hashUnitInterval('seed-b');
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1);
  assert.notEqual(a, c);
});

test('shouldMakerFillByProb: p=1 sempre; p=0 nunca', () => {
  assert.equal(escada.shouldMakerFillByProb(1, 'x'), true);
  assert.equal(escada.shouldMakerFillByProb(0, 'x'), false);
});

test('makerFillProb 0 no touch: zero fills maker no hedge', () => {
  const tick = {
    ts: '2026-06-01T12:02:00.000Z',
    event_start: '2026-06-01T12:00:00.000Z',
    condition_id: 'cond-fillrate-0',
    price_to_beat: 100000,
    btc_price: 100100,
    up_best_ask: 0.55,
    up_best_bid: 0.54,
    down_best_ask: 0.45,
    down_best_bid: 0.44,
    up_price: 0.55,
    down_price: 0.45,
    up_book_asks: JSON.stringify([{ price: 0.55, size: 500 }]),
    down_book_asks: JSON.stringify([{ price: 0.45, size: 500 }]),
  };
  const result = escada.runEscadaDuplaBacktest(
    {
      executionMode: 'touch_maker',
      throughFillOnTrigger: true,
      makerFillProb: 0,
      makerMissPolicy: 'skip',
      takerPriceMode: 'formula',
      ladderProfile: 'ascent_hedge',
      rearmMode: 'off',
      rearmOnMakerCancel: true,
      maxSubLevels: 1,
      maxDescLevels: 1,
      equalizeEnabled: false,
      sideMultiplier: 1,
      spreadCents: 1,
      slippageCents: 0,
      minSecondsLeftToStart: 45,
      maxSecondsLeftToStart: 240,
      maxEventNotional: 200,
    },
    [tick],
  );
  const ev = result.events[0];
  assert.ok(ev.fills.some((f) => f.side === 'UP' && f.liquidity === 'taker'));
  assert.equal(ev.fills.filter((f) => f.side === 'DOWN').length, 0);
  assert.ok((ev.makerMisses || 0) >= 1);
});
