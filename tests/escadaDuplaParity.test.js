import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/escada-dupla-runner.js');

function loadEscada() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __escadaExports;`)();
}

const escada = loadEscada();

test('resolveLiquidity: auto — líder taker, oposto maker', () => {
  assert.equal(escada.resolveLiquidityForSide('UP', 'UP', 'auto'), 'taker');
  assert.equal(escada.resolveLiquidityForSide('DOWN', 'UP', 'auto'), 'maker');
  assert.equal(escada.resolveLiquidityForSide('DOWN', 'DOWN', 'auto'), 'taker');
  assert.equal(escada.resolveLiquidityForSide('UP', null, 'auto'), 'taker');
});

test('buyFillPrice: maker = limit; taker = limit + halfSpread + slip', () => {
  const params = { spreadCents: 1, slippageCents: 1 };
  assert.equal(escada.buyFillPriceCents(55, 'maker', params), 55);
  assert.equal(escada.buyFillPriceCents(55, 'taker', params), 56.5);
});

test('path 50→55: UP líder, compra SUB-1 UP como taker', () => {
  const path = escada.expandPathTargets([55]);
  const sim = escada.simulateEscadaPath(
    {
      sideMultiplier: 1,
      spreadCents: 0,
      slippageCents: 0,
      liquidityMode: 'auto',
      equalizeEnabled: false,
      ladderProfile: 'oscillate',
      rearmMode: 'full',
      maxSubLevels: 0,
      maxDescLevels: 0,
    },
    path,
    'UP',
  );
  assert.equal(sim.leaderSide, 'UP');
  const upFills = sim.fills.filter((f) => f.lado === 'UP');
  assert.ok(upFills.length >= 1);
  assert.equal(upFills[0].liquidity, 'taker');
  assert.equal(upFills[0].preco, 55);
  assert.equal(sim.shares.UP, 30);
});

test('path sobe e reverte: DOWN fills são maker (oposto)', () => {
  const path = escada.expandPathTargets([55, 45]);
  const sim = escada.simulateEscadaPath(
    {
      sideMultiplier: 1,
      spreadCents: 0,
      slippageCents: 0,
      liquidityMode: 'auto',
      equalizeEnabled: false,
      ladderProfile: 'oscillate',
      rearmMode: 'full',
      maxSubLevels: 0,
      maxDescLevels: 0,
    },
    path,
    'DOWN',
  );
  assert.equal(sim.leaderSide, 'UP');
  const downFills = sim.fills.filter((f) => f.lado === 'DOWN');
  assert.ok(downFills.length >= 1, 'deveria comprar DOWN na descida');
  assert.ok(downFills.every((f) => f.liquidity === 'maker'));
});

test('multiplicador escala 2ª entrada SUB do mesmo idx (conta os dois lados)', () => {
  // ↑55 UP SUB-1 (30, n=0) → ↓45 DOWN SUB-1 (n=1) + UP DESC rearma SUB
  // → ↑55 UP SUB-1 de novo com n=2 → 30 * 2^2 = 120 (paridade HTML)
  const path = escada.expandPathTargets([55, 45, 55]);
  const sim = escada.simulateEscadaPath(
    {
      sideMultiplier: 2,
      spreadCents: 0,
      slippageCents: 0,
      liquidityMode: 'auto',
      equalizeEnabled: false,
      maxEventNotional: 500,
      maxSharesPerSide: 2000,
      ladderProfile: 'oscillate',
      rearmMode: 'full',
      maxSubLevels: 0,
      maxDescLevels: 0,
      maxPairAvgSumCents: 200,
    },
    path,
    'UP',
  );
  const sub1Up = sim.fills.filter((f) => f.lado === 'UP' && f.tipoBase === 'SUB' && f.idx === 1);
  assert.ok(sub1Up.length >= 2);
  assert.equal(sub1Up[0].shares, 30);
  assert.equal(sub1Up[1].shares, 120);
});

test('ascent_hedge: líder só SUB, oposto só DESC, sem re-arme', () => {
  const path = escada.expandPathTargets([55, 70, 40]);
  const sim = escada.simulateEscadaPath(
    {
      ladderProfile: 'ascent_hedge',
      rearmMode: 'off',
      sideMultiplier: 1,
      spreadCents: 0,
      equalizeEnabled: false,
      maxSubLevels: 4,
      maxDescLevels: 4,
      maxEventNotional: 500,
    },
    path,
    'UP',
  );
  assert.equal(sim.leaderSide, 'UP');
  // UP não deve ter DESC
  assert.equal(sim.fills.filter((f) => f.lado === 'UP' && f.tipoBase === 'DESC').length, 0);
  // DOWN não deve ter SUB
  assert.equal(sim.fills.filter((f) => f.lado === 'DOWN' && f.tipoBase === 'SUB').length, 0);
  assert.ok(sim.fills.some((f) => f.lado === 'UP' && f.tipoBase === 'SUB'));
  assert.ok(sim.fills.some((f) => f.lado === 'DOWN' && f.tipoBase === 'DESC'));
});

test('fees: maker 0, taker > 0', () => {
  const path = escada.expandPathTargets([55, 45]);
  const sim = escada.simulateEscadaPath(
    {
      sideMultiplier: 1,
      spreadCents: 0,
      slippageCents: 0,
      liquidityMode: 'auto',
      equalizeEnabled: false,
      ladderProfile: 'oscillate',
      rearmMode: 'full',
      maxSubLevels: 0,
      maxDescLevels: 0,
    },
    path,
    'DOWN',
  );
  const result = {
    params: { applyPolymarketFees: true },
    events: [{
      reason: 'expired',
      cost: sim.inv,
      quantity: sim.shares.UP + sim.shares.DOWN,
      finalPnl: sim.pnlGross,
      orders: sim.fills.map((f) => ({
        type: 'entry',
        shares: f.shares,
        price: f.preco / 100,
        liquidity: f.liquidity,
      })),
    }],
    summary: {},
  };
  applyPolymarketFeesToBacktestResult(result, { category: 'crypto' });
  const fees = result.events[0].fees;
  assert.ok(fees.entryFee > 0);
  assert.ok(fees.makerTradesFree >= 1);
  assert.ok(result.events[0].finalPnl < sim.pnlGross);
});

test('createBacktestRunner processa ticks sintéticos sem crash', () => {
  const eventStart = '2026-06-01T12:00:00.000Z';
  const ticks = [];
  for (let i = 0; i <= 60; i++) {
    const upAsk = 0.5 + i * 0.01;
    const ts = new Date(Date.parse(eventStart) + i * 1000).toISOString();
    ticks.push({
      ts,
      event_start: eventStart,
      condition_id: 'cond-escada-test',
      price_to_beat: 100000,
      btc_price: 100100,
      up_best_ask: Math.min(0.95, upAsk),
      up_best_bid: Math.min(0.94, upAsk - 0.01),
      down_best_ask: Math.max(0.05, 1 - upAsk),
      down_best_bid: Math.max(0.04, 1 - upAsk - 0.01),
      up_price: upAsk,
      down_price: 1 - upAsk,
      up_book_asks: JSON.stringify([{ price: Math.min(0.95, upAsk), size: 500 }]),
      down_book_asks: JSON.stringify([{ price: Math.max(0.05, 1 - upAsk), size: 500 }]),
    });
  }
  const result = escada.runEscadaDuplaBacktest(
    {
      sideMultiplier: 2,
      spreadCents: 1,
      slippageCents: 0,
      executionMode: 'optimistic_maker',
      liquidityMode: 'auto',
      maxEventNotional: 200,
    },
    ticks,
  );
  assert.ok(result.summary.totalEvents >= 1);
  assert.ok(result.summary.totalEntries >= 1);
  const ev = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(ev);
  assert.equal(ev.leaderSide, 'UP');
  assert.ok(ev.fills.some((f) => f.liquidity === 'taker'));
});
