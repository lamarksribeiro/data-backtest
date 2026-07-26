import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(
  __dirname,
  '../labs/legacy/strategy-runners/portable/paridade-invariante-runner.js',
);
const BOOTSTRAP_PATH = path.resolve(
  __dirname,
  '../data/strategy-libraries/paridade-invariante-runner.v1.json',
);

function loadParidadeInvariante() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __paridadeInvarianteExports;`)();
}

const paridade = loadParidadeInvariante();

test('bootstrap empacotado corresponde exatamente ao runner auditado', () => {
  const bootstrap = JSON.parse(fs.readFileSync(BOOTSTRAP_PATH, 'utf8'));
  const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.equal(bootstrap.source_code, runnerSource);
});

function makeTick({
  offsetMs = 0,
  upAsk = 0.15,
  downAsk = 0.81,
  upBid = upAsk - 0.01,
  downBid = downAsk - 0.01,
  upSize = 100,
  downSize = 100,
  btcPrice = 101,
  conditionId = 'cond-paridade',
} = {}) {
  const eventStart = '2026-07-02T10:15:00.000Z';
  const ts = new Date(Date.parse(eventStart) + 120000 + offsetMs).toISOString();
  return {
    ts,
    event_start: eventStart,
    event_end: '2026-07-02T10:20:00.000Z',
    condition_id: conditionId,
    btc_price: btcPrice,
    price_to_beat: 100,
    coverage: 1,
    degraded: false,
    up_best_ask: upAsk,
    up_best_bid: upBid,
    down_best_ask: downAsk,
    down_best_bid: downBid,
    up_book_asks: [{ price: upAsk, size: upSize }],
    up_book_bids: [{ price: upBid, size: upSize }],
    down_book_asks: [{ price: downAsk, size: downSize }],
    down_book_bids: [{ price: downBid, size: downSize }],
  };
}

test('taxa e edge do par completo usam as duas pernas', () => {
  assert.equal(paridade.calculateFillFee(20, 0.15, 0.07), 0.1785);
  assert.equal(paridade.calculateFillFee(20, 0.81, 0.07), 0.21546);

  const opportunity = paridade.evaluatePairOpportunity(makeTick(), {
    sizingMode: 'fixed',
    targetPairShares: 20,
    minPairShares: 5,
    maxPairShares: 80,
    maxEventNotional: 80,
    minNetEdgePerShare: 0.005,
    minNetProfitUsd: 0.10,
    operationalBufferPerShare: 0.002,
  });
  assert.equal(opportunity.ok, true);
  assert.equal(opportunity.qty, 20);
  assert.ok(Math.abs(opportunity.totalCost - 19.2) < 1e-9);
  assert.ok(Math.abs(opportunity.estimatedFees - 0.39396) < 1e-9);
  assert.ok(Math.abs(opportunity.netLockedPnl - 0.40604) < 1e-9);
  assert.ok(Math.abs(opportunity.guardedNetPnl - 0.36604) < 1e-9);
});

test('profundidade insuficiente em uma perna cancela o par inteiro', () => {
  const opportunity = paridade.evaluatePairOpportunity(makeTick({ downSize: 4 }), {
    sizingMode: 'fixed',
    targetPairShares: 20,
    minPairShares: 5,
    maxPairShares: 80,
    maxEventNotional: 80,
  });
  assert.equal(opportunity.ok, false);
  assert.equal(opportunity.reason, 'depth_or_profit');
});

test('qualidade obrigatória rejeita tick sem cobertura explícita', () => {
  const tick = makeTick();
  delete tick.coverage;
  const opportunity = paridade.evaluatePairOpportunity(tick, {
    requireQuality: true,
    minCoverage: 0.99,
  });
  assert.equal(opportunity.ok, false);
  assert.equal(opportunity.reason, 'coverage_missing');
});

test('um milagre de um tick é rejeitado por confirmação temporal', () => {
  const result = paridade.runParidadeInvarianteBacktest(
    {
      sizingMode: 'fixed',
      targetPairShares: 20,
      confirmationTicks: 2,
      executionLatencyTicks: 1,
      maxSignalGapMs: 750,
    },
    [
      makeTick({ offsetMs: 0 }),
      makeTick({ offsetMs: 500, upAsk: 0.16, downAsk: 0.85 }),
      makeTick({ offsetMs: 1000, upAsk: 0.16, downAsk: 0.85 }),
    ],
  );
  assert.equal(result.summary.totalEntries, 0);
  assert.equal(result.summary.confirmedSignals, 0);
});

test('confirmação mais latência exige três snapshots ainda lucrativos', () => {
  const result = paridade.runParidadeInvarianteBacktest(
    {
      sizingMode: 'fixed',
      targetPairShares: 20,
      confirmationTicks: 2,
      executionLatencyTicks: 1,
      maxSignalGapMs: 750,
    },
    [
      makeTick({ offsetMs: 0 }),
      makeTick({ offsetMs: 500 }),
      makeTick({ offsetMs: 1000 }),
    ],
  );
  assert.equal(result.summary.totalEntries, 1);
  assert.equal(result.summary.confirmedSignals, 1);
  assert.equal(result.summary.latencyMisses, 0);
  assert.equal(result.events[0].pairInvariant, true);
  assert.equal(result.events[0].orders.length, 2);
});

test('PnL líquido é idêntico com vitória de UP ou DOWN', () => {
  function run(btcPrice, conditionId) {
    const result = paridade.runParidadeInvarianteBacktest(
      {
        sizingMode: 'fixed',
        targetPairShares: 20,
        confirmationTicks: 2,
        executionLatencyTicks: 1,
        maxSignalGapMs: 750,
      },
      [
        makeTick({ offsetMs: 0, btcPrice, conditionId }),
        makeTick({ offsetMs: 500, btcPrice, conditionId }),
        makeTick({ offsetMs: 1000, btcPrice, conditionId }),
      ],
    );
    applyPolymarketFeesToBacktestResult(result, { category: 'crypto' });
    return result;
  }

  const upWins = run(101, 'cond-up-wins');
  const downWins = run(99, 'cond-down-wins');
  assert.equal(upWins.events[0].winnerSide, 'UP');
  assert.equal(downWins.events[0].winnerSide, 'DOWN');
  assert.ok(Math.abs(upWins.events[0].finalPnl - 0.40604) < 1e-9);
  assert.ok(Math.abs(downWins.events[0].finalPnl - 0.40604) < 1e-9);
  assert.equal(upWins.events[0].finalPnl, downWins.events[0].finalPnl);
  assert.equal(upWins.events[0].fees.entryTradesCharged, 2);
  assert.equal(downWins.events[0].fees.entryTradesCharged, 2);
});

test('latência cancela a entrada se o edge desaparece no tick de execução', () => {
  const result = paridade.runParidadeInvarianteBacktest(
    {
      sizingMode: 'fixed',
      targetPairShares: 20,
      confirmationTicks: 2,
      executionLatencyTicks: 1,
      maxSignalGapMs: 750,
    },
    [
      makeTick({ offsetMs: 0 }),
      makeTick({ offsetMs: 500 }),
      makeTick({ offsetMs: 1000, upAsk: 0.20, downAsk: 0.81 }),
    ],
  );
  assert.equal(result.summary.totalEntries, 0);
  assert.equal(result.summary.confirmedSignals, 1);
  assert.equal(result.summary.latencyMisses, 1);
});
