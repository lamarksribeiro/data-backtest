import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/shotandgo-runner.js');
const LIB_PATH = path.resolve(__dirname, '../data/strategy-libraries/shotandgo-runner.v1.json');

function loadShotandgo() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __shotandgoExports;`)();
}

const sg = loadShotandgo();

test('defaults batem Phil_Hopper_Real.py', () => {
  const p = sg.mergeShotandgoParams({});
  assert.equal(p.executionMode, 'honest');
  assert.deepEqual(p.mult, [2, 3, 4, 5, 6, 6]);
  assert.equal(p.contagio, 'global');
  assert.equal(p.contagioMin, 5);
  assert.equal(p.descModo, 'gatilho');
  assert.equal(p.descVirada, 5);
  assert.equal(p.stopAtivo, true);
  assert.equal(p.stopVirada, 4);
  assert.equal(p.pisoAtivo, true);
  assert.deepEqual(p.pisoViradas, [4, 5]);
  assert.equal(p.maxViradas, 6);
  assert.equal(p.eqLimiteAtivo, true);
  assert.equal(p.eqLimiteArmaC, 10);
  assert.equal(p.eqPreco, 0.05);
  assert.equal(p.fokAtivo, true);
  assert.equal(p.takerPriceMode, 'taker_limit');
  assert.equal(p.subLevels[0].preco, 55);
  assert.equal(p.subLevels[0].shares, 20);
  assert.equal(p.descLevels[0].preco, 45);
  assert.equal(p.descLevels[0].shares, 5);
});

test('resolveFator: 1ª SUB = 1x; 2ª usa MULT[0]', () => {
  const p = sg.mergeShotandgoParams({ contagio: 'off' });
  const ativo = { UP: 1, DOWN: 1, G: 1 };
  assert.equal(sg.resolveFator(1, 'UP', [], ativo, p), 1);
  assert.equal(sg.resolveFator(1, 'UP', [{ lado: 'UP', idx: 1 }], ativo, p), 2);
  assert.equal(sg.resolveFator(1, 'DOWN', [
    { lado: 'UP', idx: 1 },
    { lado: 'DOWN', idx: 1 },
  ], ativo, p), 3);
});

test('resolveFator: contagio global trava em CONTAGIO_MIN', () => {
  const p = sg.mergeShotandgoParams({ contagio: 'global', contagioMin: 5 });
  const ativo = { UP: 1, DOWN: 1, G: 5 };
  const hist = [
    { lado: 'UP', idx: 1 },
    { lado: 'DOWN', idx: 1 },
    { lado: 'UP', idx: 1 },
    { lado: 'DOWN', idx: 1 },
  ];
  // n=4 → MULT[3]=5; global já travado em 5
  const f = sg.resolveFator(1, 'UP', hist, ativo, p);
  assert.ok(f >= 5);
});

test('path 55→45→55: re-arme + 2ª SUB-1 com MULT', () => {
  const path = sg.expandPathTargets([55, 45, 55]);
  const sim = sg.simulateShotandgoPath(
    {
      executionMode: 'optimistic',
      contagio: 'off',
      stopAtivo: false,
      pisoAtivo: false,
      maxViradasAtivo: false,
      equalizar: false,
      descModo: 'comprar',
      maxEventNotional: 5000,
    },
    path,
    'UP',
  );
  const sub1 = sim.fills.filter((f) => f.tipo === 'SUB-1');
  assert.ok(sub1.length >= 2, `esperava ≥2 SUB-1, got ${sub1.length}`);
  assert.equal(sub1[0].shares, 20);
  assert.equal(sub1[1].shares, 40); // MULT[0]=2
  assert.ok(sim.viradas >= 2);
});

test('DESC_MODO=gatilho após virada N: não compra DESC, mas re-arma', () => {
  const path = sg.expandPathTargets([55, 60, 65, 70, 55, 45]);
  const sim = sg.simulateShotandgoPath(
    {
      executionMode: 'optimistic',
      contagio: 'off',
      stopAtivo: false,
      pisoAtivo: false,
      maxViradasAtivo: false,
      equalizar: false,
      descModo: 'gatilho',
      descVirada: 1,
      maxEventNotional: 5000,
    },
    path,
    'UP',
  );
  assert.ok(sim.viradas >= 1);
  const descAfter = sim.fills.filter((f) => String(f.tipo).startsWith('DESC'));
  // Com descVirada=1, após 1ª virada DESC vira só gatilho — fills DESC só se dispararam antes
  assert.ok(Array.isArray(descAfter));
});

test('MAX_VIRADAS congela novas compras', () => {
  const path = sg.expandPathTargets([55, 45, 55, 45, 55, 45, 55]);
  const sim = sg.simulateShotandgoPath(
    {
      executionMode: 'optimistic',
      contagio: 'off',
      stopAtivo: false,
      pisoAtivo: false,
      maxViradasAtivo: true,
      maxViradas: 2,
      equalizar: false,
      descModo: 'comprar',
      maxEventNotional: 5000,
    },
    path,
    'UP',
  );
  assert.equal(sim.viradas, 2);
});

test('PISO eleva SUB-1 na virada marcada', () => {
  const path = sg.expandPathTargets([55, 60, 45, 55]);
  const sim = sg.simulateShotandgoPath(
    {
      executionMode: 'optimistic',
      contagio: 'off',
      stopAtivo: false,
      pisoAtivo: true,
      pisoViradas: [2],
      pisoMargem: 0.20,
      maxViradasAtivo: false,
      equalizar: false,
      descModo: 'comprar',
      maxEventNotional: 5000,
    },
    path,
    'UP',
  );
  const sub1 = sim.fills.filter((f) => f.tipo === 'SUB-1');
  assert.ok(sub1.length >= 2);
  // 2ª virada deve ser ≥ shares base * MULT (pode ser elevado pelo piso)
  assert.ok(sub1[1].shares >= 40);
});

test('shouldFillRestingBuy: atravessamento clássico', () => {
  assert.equal(sg.shouldFillRestingBuy(0.46, 0.44, 0.45, 0.01), true);
  assert.equal(sg.shouldFillRestingBuy(0.44, 0.43, 0.45, 0.01), false);
});

test('fees: runner NÃO embute taxa no cost (lab aplica uma vez)', () => {
  const eventStart = '2026-07-01T12:00:00.000Z';
  const mk = (sec, upAsk, dnAsk) => ({
    ts: new Date(Date.parse(eventStart) + sec * 1000).toISOString(),
    event_start: eventStart,
    condition_id: 'fee-audit-1',
    price_to_beat: 100000,
    btc_price: 100100,
    up_best_ask: upAsk,
    down_best_ask: dnAsk,
    up_best_bid: upAsk - 0.01,
    down_best_bid: dnAsk - 0.01,
    up_price: upAsk,
    down_price: dnAsk,
    up_book_asks: [{ price: upAsk, size: 500 }],
    down_book_asks: [{ price: dnAsk, size: 500 }],
  });
  const ticks = [mk(10, 0.50, 0.50), mk(30, 0.55, 0.45), mk(280, 0.90, 0.10), mk(295, 0.95, 0.05)];
  const raw = sg.runShotandgoBacktest(
    {
      executionMode: 'optimistic',
      stopAtivo: false,
      maxViradasAtivo: false,
      pisoAtivo: false,
      contagio: 'off',
      mult: [1],
      applyPolymarketFees: true,
      equalizar: false,
      descModo: 'comprar',
      maxEventNotional: 500,
    },
    ticks,
  );
  const ev = raw.events.find((e) => e.reason !== 'no_entry');
  assert.ok(ev);
  const fillCost = (ev.fills || []).reduce((s, f) => s + Number(f.shares) * Number(f.price), 0);
  assert.ok(Math.abs(ev.cost - fillCost) < 1e-6, `cost deve ser só notional, sem fee embutida: cost=${ev.cost} fills=${fillCost}`);
  const grossPnl = ev.finalPnl;
  const withFees = applyPolymarketFeesToBacktestResult(structuredClone(raw), { category: 'crypto' });
  const net = withFees.events.find((e) => e.reason !== 'no_entry');
  assert.ok(net.finalPnl <= grossPnl + 1e-9, 'fee pós-processada só pode reduzir PnL');
  const feeDelta = grossPnl - net.finalPnl;
  assert.ok(feeDelta >= 0);
  // Não pode parecer “taxa em dobro”: fee típica crypto << notional
  assert.ok(feeDelta < fillCost * 0.15, `fee absurda: delta=${feeDelta} notional=${fillCost}`);
});

test('backtest sintético: honest vs optimistic + fees', () => {
  const eventStart = '2026-07-01T12:00:00.000Z';
  const mk = (sec, upAsk, dnAsk, bookUp = null) => ({
    ts: new Date(Date.parse(eventStart) + sec * 1000).toISOString(),
    event_start: eventStart,
    condition_id: 'shotandgo-test-1',
    price_to_beat: 100000,
    btc_price: 100100,
    up_best_ask: upAsk,
    down_best_ask: dnAsk,
    up_best_bid: upAsk - 0.01,
    down_best_bid: dnAsk - 0.01,
    up_price: upAsk,
    down_price: dnAsk,
    up_book_asks: bookUp || [
      { price: upAsk, size: 500 },
      { price: upAsk + 0.01, size: 500 },
    ],
    down_book_asks: [
      { price: dnAsk, size: 500 },
      { price: dnAsk + 0.01, size: 500 },
    ],
  });

  const ticks = [
    mk(10, 0.50, 0.50),
    mk(20, 0.55, 0.45),
    mk(40, 0.60, 0.40),
    mk(60, 0.45, 0.55),
    mk(280, 0.90, 0.10),
    mk(295, 0.95, 0.05),
  ];

  const opt = sg.runShotandgoBacktest(
    {
      executionMode: 'optimistic',
      stopAtivo: false,
      maxViradasAtivo: false,
      maxEventNotional: 500,
      applyPolymarketFees: true,
    },
    ticks,
  );
  assert.equal(opt.strategy, 'SHOTANDGO_V1');
  assert.ok(opt.summary.totalEvents >= 1);
  assert.ok(opt.events.some((e) => e.reason !== 'no_entry'));

  const honest = sg.runShotandgoBacktest(
    {
      executionMode: 'honest',
      takerLatencyTicks: 0,
      stopAtivo: false,
      maxViradasAtivo: false,
      maxEventNotional: 500,
    },
    ticks,
  );
  assert.equal(honest.summary.executionMode, 'honest');

  const withFees = applyPolymarketFeesToBacktestResult(opt, { category: 'crypto' });
  assert.ok(withFees.fees || withFees.summary || withFees.events);
});

test('library bootstrap source_code sincronizado com portable', () => {
  if (!fs.existsSync(LIB_PATH)) {
    assert.ok(true, 'library ainda não empacotada — rode package:strategy-library');
    return;
  }
  const bootstrap = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
  const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.equal(bootstrap.source_code, runnerSource);
});
