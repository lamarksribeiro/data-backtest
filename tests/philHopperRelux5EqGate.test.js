import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../labs/legacy/strategy-runners/portable/phil-hopper-relux5-runner.js');

function loadRelux5() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __philHopperRelux5Exports;`)();
}

const rx = loadRelux5();

test('eqExigeLucro default on', () => {
  const p = rx.mergeRelux5Params({});
  assert.equal(p.eqExigeLucro, true);
  assert.equal(p.eqLucroMinUsd, 0);
});

test('eqWouldBeProfitable: par barato equaliza com lucro', () => {
  const p = rx.mergeRelux5Params({ eqExigeLucro: true, applyPolymarketFees: true });
  const shares = { UP: 100, DOWN: 50 };
  const cost = { UP: 55, DOWN: 20 }; // invested 75, dif 50
  const dif = 50;
  const ok = rx.eqWouldBeProfitable(shares, cost, dif, 0.05, p, 'taker');
  assert.equal(ok, true);
  const { net } = rx.eqProjectedNet(shares, cost, dif, 0.05, p, 'taker');
  assert.ok(net > 0);
});

test('eqWouldBeProfitable: par caro bloqueia equalize', () => {
  const p = rx.mergeRelux5Params({ eqExigeLucro: true, applyPolymarketFees: true });
  const shares = { UP: 500, DOWN: 480 };
  const cost = { UP: 400, DOWN: 300 }; // pair ~145c
  const dif = 20;
  const ok = rx.eqWouldBeProfitable(shares, cost, dif, 0.05, p, 'taker');
  assert.equal(ok, false);
});

test('eqWouldBeProfitable: eqExigeLucro off sempre permite', () => {
  const p = rx.mergeRelux5Params({ eqExigeLucro: false });
  const shares = { UP: 500, DOWN: 480 };
  const cost = { UP: 400, DOWN: 300 };
  assert.equal(rx.eqWouldBeProfitable(shares, cost, 20, 0.05, p, 'taker'), true);
});

test('shouldFreezeEscadaForEq quando ask 5c mas par caro', () => {
  const p = rx.mergeRelux5Params({ eqExigeLucro: true, applyPolymarketFees: true, eqPreco: 0.05 });
  const shares = { UP: 500, DOWN: 480 };
  const cost = { UP: 400, DOWN: 300 };
  const asks = { UP: 0.95, DOWN: 0.05 };
  assert.equal(rx.shouldFreezeEscadaForEq(shares, cost, asks, p), true);
});

test('shouldFreezeEscadaForEq false quando ask acima de eqPreco', () => {
  const p = rx.mergeRelux5Params({ eqExigeLucro: true });
  const shares = { UP: 100, DOWN: 50 };
  const cost = { UP: 55, DOWN: 20 };
  const asks = { UP: 0.70, DOWN: 0.30 };
  assert.equal(rx.shouldFreezeEscadaForEq(shares, cost, asks, p), false);
});

test('simulateRelux5Path: não equaliza par caro mesmo com ask 5c', () => {
  // Path que choppa e acumula caro; winner irrelevante para equalized flag
  const sim = rx.simulateRelux5Path(
    {
      eqExigeLucro: true,
      applyPolymarketFees: false,
      equalizar: true,
      eqPreco: 0.05,
      maxViradasAtivo: false,
      travaAtiva: false,
      descModo: 'comprar',
      executionMode: 'optimistic',
      geracaoAtiva: false,
      multCalcAtivo: false,
      pausaLiderAtiva: false,
      tetoInvestAtivo: false,
      sizeScale: 1,
    },
  // UP sobe forte, DOWN cai a 5c no fim — mas com muito UP acumulado
    [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 5],
    'UP',
    { honest: false },
  );
  // Se equalizou com par caro, equalized seria true com pnlGross negativo em matched scenario
  // Com gate, não deve equalizar
  if (sim.equalized) {
    const inv = sim.inv;
    const matched = Math.min(sim.shares.UP, sim.shares.DOWN);
    assert.ok(matched - inv >= 0, 'equalized só com locked >= 0');
  }
});

test('maxViradas default = 4 (corta cauda)', () => {
  const p = rx.mergeRelux5Params({});
  assert.equal(p.maxViradas, 4);
  assert.equal(p.maxViradasAtivo, true);
});

test('shouldFillRestingBuy: ask já abaixo do limite preenche', () => {
  assert.equal(rx.shouldFillRestingBuy(0.30, 0.30, 0.36, 0.01), true);
  assert.equal(rx.shouldFillRestingBuy(0.50, 0.35, 0.36, 0.01), true);
  assert.equal(rx.shouldFillRestingBuy(0.50, 0.50, 0.36, 0.01), false);
});

test('simulateRelux5Path: DESC compra lado barato após SUB', () => {
  // UP sobe a 55 (SUB), depois cai: DOWN sobe relativamente; path em cents UP
  // 50→55→40: em 40c UP, DOWN=60; DESC UP @36 dispara quando UP<=36
  const sim = rx.simulateRelux5Path(
    {
      equalizar: false,
      travaAtiva: false,
      geracaoAtiva: false,
      multCalcAtivo: false,
      pausaLiderAtiva: false,
      tetoInvestAtivo: false,
      maxViradasAtivo: false,
      descModo: 'comprar',
      executionMode: 'optimistic',
    },
    [50, 55, 36, 28],
    'UP',
    { honest: true },
  );
  const descFills = sim.fills.filter((f) => String(f.tipo).includes('DESC'));
  assert.ok(descFills.length > 0, `esperava DESC fills, got ${JSON.stringify(sim.fills)}`);
});
