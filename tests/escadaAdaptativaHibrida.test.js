import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(
  __dirname,
  '../labs/legacy/strategy-runners/portable/escada-adaptativa-hibrida-runner.js',
);
const BOOTSTRAP_PATH = path.resolve(
  __dirname,
  '../data/strategy-libraries/escada-adaptativa-hibrida-runner.v1.json',
);

function loadRunnerExports() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __escadaAdaptativaExports;`)();
}

const eah = loadRunnerExports();

const BASE_PARAMS = {
  walletSize: 1000,
  riskPerEventPct: 0.0025,
  minShares: 5,
  maxCycles: 1,
  modelWeight: 0,
  minDirectionalProbability: 0.57,
  minEdge: 0.06,
  minTicksBeforeEntry: 8,
  maxSpread: 0.05,
  makerFillMode: 'strict_cross',
  cancelLatencyTicks: 1,
  takerLatencyTicks: 1,
  shockSigma: 10,
  requireQuality: true,
};

function makeTick({
  offsetSec = 60,
  upBid = 0.45,
  upAsk = 0.47,
  downBid = 0.18,
  downAsk = 0.20,
  upSize = 100,
  downSize = 100,
  btcPrice = 100100,
  conditionId = 'cond-eah',
} = {}) {
  const eventStart = '2026-07-02T10:15:00.000Z';
  const ts = new Date(Date.parse(eventStart) + (offsetSec * 1000)).toISOString();
  return {
    ts,
    event_start: eventStart,
    event_end: '2026-07-02T10:20:00.000Z',
    condition_id: conditionId,
    btc_price: btcPrice,
    underlying_price: btcPrice,
    price_to_beat: 100000,
    coverage: 1,
    degraded: false,
    up_price: (upBid + upAsk) / 2,
    down_price: (downBid + downAsk) / 2,
    up_best_bid: upBid,
    up_best_ask: upAsk,
    down_best_bid: downBid,
    down_best_ask: downAsk,
    up_book_bids: [{ price: upBid, size: upSize }],
    up_book_asks: [{ price: upAsk, size: upSize }],
    down_book_bids: [{ price: downBid, size: downSize }],
    down_book_asks: [{ price: downAsk, size: downSize }],
  };
}

function warmupTicks() {
  return Array.from({ length: 8 }, (_, index) => makeTick({ offsetSec: 60 + index }));
}

function protectedPath({ downSize = 100 } = {}) {
  return [
    ...warmupTicks(),
    makeTick({ offsetSec: 68, upAsk: 0.44, upBid: 0.43 }),
    makeTick({
      offsetSec: 69,
      upAsk: 0.44,
      upBid: 0.43,
      downAsk: 0.50,
      downBid: 0.49,
      downSize,
    }),
    makeTick({
      offsetSec: 70,
      upAsk: 0.44,
      upBid: 0.43,
      downAsk: 0.50,
      downBid: 0.49,
      downSize,
    }),
    makeTick({
      offsetSec: 299,
      upAsk: 0.99,
      upBid: 0.98,
      downAsk: 0.02,
      downBid: 0.01,
      btcPrice: 100200,
    }),
  ];
}

test('bootstrap empacotado corresponde exatamente ao runner auditado', () => {
  const bootstrap = JSON.parse(fs.readFileSync(BOOTSTRAP_PATH, 'utf8'));
  assert.equal(bootstrap.source_code, fs.readFileSync(RUNNER_PATH, 'utf8'));
});

test('limite de risco deriva 0,25% da banca de US$ 1.000', () => {
  const params = eah.mergeEscadaAdaptativaParams(BASE_PARAMS);
  assert.equal(params.maxRiskUsd, 2.5);
  assert.equal(params.maxGrossExposureUsd, 25);

  const state = { shares: { UP: 0, DOWN: 0 }, cost: 0, estimatedFees: 0 };
  const allowed = eah.simulateBuy(state, 'UP', [{ qty: 5, price: 0.5 }], 'maker', params);
  const rejected = eah.simulateBuy(state, 'UP', [{ qty: 5, price: 0.51 }], 'maker', params);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.risk.worstPnl, -2.5);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.risk.worstPnl, -2.55);
});

test('fill maker estrito exige atravessamento; estresse preenche no toque', () => {
  const order = { purpose: 'directional', price: 0.45 };
  const strict = eah.mergeEscadaAdaptativaParams({ makerFillMode: 'strict_cross', tickSize: 0.01 });
  const adverse = eah.mergeEscadaAdaptativaParams({ makerFillMode: 'adverse_entry_touch', tickSize: 0.01 });

  assert.equal(eah.shouldFillMaker(order, 0.47, 0.45, strict), false);
  assert.equal(eah.shouldFillMaker(order, 0.47, 0.44, strict), true);
  assert.equal(eah.shouldFillMaker(order, 0.47, 0.45, adverse), true);

  const hedge = { purpose: 'hedge', price: 0.45 };
  assert.equal(eah.shouldFillMaker(hedge, 0.47, 0.45, adverse), false);
});

test('escada abre residual, protege a perna oposta e respeita US$ 2,50', () => {
  const result = eah.runEscadaAdaptativaHibridaBacktest(BASE_PARAMS, protectedPath());
  const event = result.events.find((item) => item.reason !== 'no_entry');
  assert.ok(event);
  assert.equal(event.fills[0].purpose, 'directional');
  assert.equal(event.fills[0].side, 'UP');
  assert.equal(event.fills[0].liquidity, 'maker');
  assert.equal(event.fills[1].purpose, 'hedge');
  assert.equal(event.fills[1].side, 'DOWN');
  assert.equal(event.fills[1].liquidity, 'taker');
  assert.deepEqual(event.shares, { UP: 5, DOWN: 5 });
  assert.ok(event.risk.worstPnl >= 0.02);
  assert.ok(event.maxObservedWorstLoss <= 2.5);
  assert.equal(event.diagnostics.cycles, 1);
  assert.equal(event.diagnostics.protectedCycles, 1);
  assert.equal(result.summary.takerFilled, 1);
});

test('taxa taker estimada pelo risco coincide com a camada oficial de fees', () => {
  const result = eah.runEscadaAdaptativaHibridaBacktest(BASE_PARAMS, protectedPath());
  const before = result.events.find((item) => item.reason !== 'no_entry');
  const estimated = before.estimatedTakerFees;
  applyPolymarketFeesToBacktestResult(result, { category: 'crypto' });
  const event = result.events.find((item) => item.reason !== 'no_entry');
  assert.equal(event.fees.makerTradesFree, 1);
  assert.equal(event.fees.entryTradesCharged, 1);
  assert.equal(event.fees.totalFee, estimated);
  assert.equal(event.finalPnl, event.finalPnlBeforeFees - estimated);
});

test('taker FOK não inventa liquidez quando a proteção não tem 5 shares', () => {
  const result = eah.runEscadaAdaptativaHibridaBacktest(
    { ...BASE_PARAMS, makerTimeoutSec: 5 },
    protectedPath({ downSize: 4 }),
  );
  const event = result.events.find((item) => item.reason !== 'no_entry');
  assert.ok(event);
  assert.equal(event.fills.filter((fill) => fill.liquidity === 'taker').length, 0);
  assert.equal(event.shares.UP, 5);
  assert.ok([0, 5].includes(event.shares.DOWN));
  if (event.shares.DOWN === 5) {
    assert.equal(
      event.fills.find((fill) => fill.side === 'DOWN')?.liquidity,
      'maker',
      'proteção posterior só pode vir do resting maker',
    );
  }
  assert.ok(event.diagnostics.makerPlaced >= 2, 'deveria tentar hedge maker após rejeitar FOK');
  assert.ok(event.maxObservedWorstLoss <= 2.5);
});

test('banca de US$ 100 com risco de 0,25% rejeita a ordem mínima de 5 shares', () => {
  const result = eah.runEscadaAdaptativaHibridaBacktest(
    { ...BASE_PARAMS, walletSize: 100 },
    protectedPath(),
  );
  assert.equal(result.summary.totalEntries, 0);
  assert.ok(result.summary.riskRejected > 0);
  assert.equal(result.summary.riskLimitUsd, 0.25);
});

test('qualidade ausente bloqueia novas cotações', () => {
  const ticks = warmupTicks().map((tick) => {
    const copy = { ...tick };
    delete copy.coverage;
    return copy;
  });
  const result = eah.runEscadaAdaptativaHibridaBacktest(BASE_PARAMS, ticks);
  assert.equal(result.summary.totalEntries, 0);
  assert.equal(result.summary.makerPlaced, 0);
  assert.ok(result.summary.qualityRejected > 0);
});
