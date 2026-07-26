import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(
  __dirname,
  '../labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js',
);
const BOOTSTRAP_PATH = path.resolve(
  __dirname,
  '../data/strategy-libraries/pair-ladder-complete-set-runner.v1.json',
);

function loadPairLadder() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __pairLadderCompleteSetExports;`)();
}

const pair = loadPairLadder();

function makeTick({
  offsetMs = 0,
  upAsk = 0.51,
  downAsk = 0.49,
  upBid = upAsk - 0.01,
  downBid = downAsk - 0.01,
  btcPrice = 101,
  conditionId = 'cond-pair-ladder',
  eventStart = '2026-07-20T12:00:00.000Z',
  eventEnd = '2026-07-20T12:05:00.000Z',
} = {}) {
  const ts = new Date(Date.parse(eventStart) + offsetMs).toISOString();
  return {
    ts,
    event_start: eventStart,
    event_end: eventEnd,
    condition_id: conditionId,
    btc_price: btcPrice,
    price_to_beat: 100,
    coverage: 1,
    degraded: false,
    up_best_ask: upAsk,
    up_best_bid: upBid,
    down_best_ask: downAsk,
    down_best_bid: downBid,
    up_book_asks: [{ price: upAsk, size: 500 }],
    up_book_bids: [{ price: upBid, size: 500 }],
    down_book_asks: [{ price: downAsk, size: 500 }],
    down_book_bids: [{ price: downBid, size: 500 }],
  };
}

test('bootstrap empacotado corresponde exatamente ao runner auditado', () => {
  const bootstrap = JSON.parse(fs.readFileSync(BOOTSTRAP_PATH, 'utf8'));
  const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.equal(bootstrap.source_code, runnerSource);
  assert.equal(bootstrap.slug, 'pair-ladder-complete-set-runner');
});

test('seed abre 50 + hedge 100 no oposto dentro da janela', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    openMaxAvgSum: 1.01,
    hedgeShares: 100,
    seedHedgeSameTick: true,
    maxFillsPerEvent: 10,
  });
  runner.processTick(makeTick({ offsetMs: 4000, upAsk: 0.51, downAsk: 0.49 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.9, downAsk: 0.1, btcPrice: 101 }));
  const result = runner.finish();
  assert.equal(result.summary.totalEntries, 1);
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event, 'expected entered event');
  assert.equal(event.upShares + event.downShares, 150);
  assert.ok(Array.isArray(event.orders) && event.orders.length >= 2);
  const qtys = event.orders.map((o) => o.shares).sort((a, b) => a - b);
  assert.deepEqual(qtys, [50, 100]);
});

test('seed assíncrono: abre um lado e hedgeia quando oposto fica barato', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    seedHedgeSameTick: false,
    openShares: 50,
    hedgeShares: 100,
    hedgeMaxAsk: 0.70,
    hedgePreferAsk: 0.50,
    hedgeTargetAvgSum: 0.99,
    minSecToHedge: 5,
    chaseMaxAsk: 0.40,
    maxFillsPerEvent: 10,
    lateStartSec: 250,
  });
  runner.processTick(makeTick({ offsetMs: 4000, upAsk: 0.51, downAsk: 0.51 }));
  // ainda cedo demais (< minSecToHedge) e ask não prefer
  runner.processTick(makeTick({ offsetMs: 6000, upAsk: 0.51, downAsk: 0.49 }));
  // depois do min wait + prefer/cheap
  runner.processTick(makeTick({ offsetMs: 30000, upAsk: 0.80, downAsk: 0.22 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.9, downAsk: 0.1, btcPrice: 101 }));
  const result = runner.finish();
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.upShares > 0 && event.downShares > 0, 'expected dual inventory after async hedge');
});

test('Etapa 9: chase_momo compra o lado cujo ask subiu (underweight)', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    seedHedgeSameTick: true,
    openShares: 50,
    hedgeShares: 50,
    clipShares: 50,
    legChoice: 'chase_momo',
    momoLookbackSec: 15,
    momoMinRise: 0.02,
    momoMinAsk: 0.20,
    momoMaxAsk: 0.70,
    forbidOverweight: true,
    maxResidualShares: 100,
    maxFillsPerEvent: 12,
    lateStartSec: 250,
    rebalanceMaxAsk: 0.55,
    chaseMaxAsk: 0.15,
    stopAvgSum: 0.99,
    stopMinBalance: 0.5,
    softLockAllowBuild: true,
    softLockAllowVacuum: false,
  });
  // seed dual flat @ ~0.50/0.49
  runner.processTick(makeTick({ offsetMs: 2000, upAsk: 0.50, downAsk: 0.49 }));
  // build ask history: Up flat, Down rising
  runner.processTick(makeTick({ offsetMs: 5000, upAsk: 0.50, downAsk: 0.50 }));
  runner.processTick(makeTick({ offsetMs: 10000, upAsk: 0.49, downAsk: 0.52 }));
  runner.processTick(makeTick({ offsetMs: 15000, upAsk: 0.48, downAsk: 0.54 }));
  runner.processTick(makeTick({ offsetMs: 20000, upAsk: 0.47, downAsk: 0.56 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.2, downAsk: 0.8, btcPrice: 99 }));
  const event = runner.finish().events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  const momo = (event.fills || []).filter((f) => f.source === 'momo');
  assert.ok(momo.length >= 1, `expected momo fills, sources=${(event.fills || []).map((f) => f.source).join(',')}`);
  assert.ok(momo.every((f) => f.side === 'DOWN'), 'momo should chase rising Down ask');
});

test('Etapa 8: rebalance/build não completa hedge antes do dual', () => {
  const baseParams = {
    spreadCents: 0,
    slippageCents: 0,
    seedHedgeSameTick: false,
    openShares: 50,
    hedgeShares: 100,
    clipShares: 100,
    hedgePreferAsk: 0.50,
    hedgeTargetAvgSum: 0.99,
    minSecToHedge: 20,
    chaseMaxAsk: 0.20,
    rebalanceMaxAsk: 0.90,
    rebalanceCushionAsk: 0.90,
    pairSnapMax: 0.50,
    maxFillsPerEvent: 16,
    lateStartSec: 250,
  };

  // Early settle: still one-sided — rebalance must not have filled the hedge
  const earlyRunner = pair.createBacktestRunner(baseParams);
  earlyRunner.processTick(makeTick({ offsetMs: 2000, upAsk: 0.51, downAsk: 0.49 }));
  earlyRunner.processTick(makeTick({ offsetMs: 3000, upAsk: 0.51, downAsk: 0.49 }));
  earlyRunner.processTick(makeTick({ offsetMs: 5000, upAsk: 0.50, downAsk: 0.49 }));
  earlyRunner.processTick(makeTick({ offsetMs: 10000, upAsk: 0.50, downAsk: 0.49 }));
  earlyRunner.processTick(makeTick({
    offsetMs: 12000,
    upAsk: 0.50,
    downAsk: 0.49,
    eventEnd: '2026-07-20T12:00:15.000Z',
  }));
  const earlyEv = earlyRunner.finish().events.find((e) => e.reason !== 'no_entry');
  assert.ok(earlyEv);
  assert.ok(
    earlyEv.upShares === 0 || earlyEv.downShares === 0,
    `expected single-sided before minSecToHedge, got up=${earlyEv.upShares} down=${earlyEv.downShares}`,
  );
  assert.ok(
    !(earlyEv.fills || []).some((f) => f.source === 'rebalance'),
    'rebalance must not fire pre-dual',
  );

  // Full path: after wait, seed_hedge completes dual
  const runner = pair.createBacktestRunner(baseParams);
  runner.processTick(makeTick({ offsetMs: 2000, upAsk: 0.51, downAsk: 0.49 }));
  runner.processTick(makeTick({ offsetMs: 10000, upAsk: 0.50, downAsk: 0.49 }));
  runner.processTick(makeTick({ offsetMs: 25000, upAsk: 0.48, downAsk: 0.50 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.9, downAsk: 0.1, btcPrice: 101 }));
  const event = runner.finish().events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.upShares > 0 && event.downShares > 0, 'expected dual after minSecToHedge');
  const sources = (event.fills || []).map((f) => f.source);
  assert.ok(sources.includes('seed'), `expected seed, got ${sources.join(',')}`);
  assert.ok(sources.includes('seed_hedge'), `expected seed_hedge, got ${sources.join(',')}`);
});

test('softLockAllowVacuum ainda vacuum após lock', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    seedHedgeSameTick: false,
    openShares: 50,
    hedgeShares: 100,
    openMaxAsk: 0.55,
    hedgePreferAsk: 0.50,
    minSecToHedge: 5,
    stopAvgSum: 0.96,
    stopMinBalance: 0.4,
    softLockAllowVacuum: true,
    softLockAllowBuild: false,
    lateStartSec: 180,
    lateMaxAsk: 0.15,
    maxFillsPerEvent: 10,
    forbidOverweight: true,
    maxResidualShares: 100,
  });
  runner.processTick(makeTick({ offsetMs: 4000, upAsk: 0.50, downAsk: 0.52 }));
  runner.processTick(makeTick({ offsetMs: 20000, upAsk: 0.55, downAsk: 0.45 }));
  // late: vacuum underweight UP barato
  runner.processTick(makeTick({ offsetMs: 200000, upAsk: 0.05, downAsk: 0.90 }));
  runner.processTick(makeTick({ offsetMs: 210000, upAsk: 0.04, downAsk: 0.92 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.01, downAsk: 0.99, btcPrice: 101 }));
  const result = runner.finish();
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.vacuumFills >= 1, `expected vacuum fills, got ${event.vacuumFills}, up=${event.upShares} down=${event.downShares} locked=${event.locked}`);
});

test('softLockAllowBuild continua chase under após lock', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    seedHedgeSameTick: true,
    openShares: 50,
    hedgeShares: 50,
    clipShares: 50,
    openMaxAsk: 0.55,
    stopAvgSum: 0.99,
    stopMinBalance: 0.5,
    softLockAllowVacuum: false,
    softLockAllowBuild: true,
    lateStartSec: 250,
    forbidOverweight: true,
    maxResidualShares: 100,
    rebalanceMaxAsk: 0.70,
    chaseMaxAsk: 0.40,
    buildOnlyImprove: false,
    maxFillsPerEvent: 12,
  });
  // seed dual @ ~0.95 avgSum → lock
  runner.processTick(makeTick({ offsetMs: 5000, upAsk: 0.48, downAsk: 0.47 }));
  runner.processTick(makeTick({ offsetMs: 60000, upAsk: 0.55, downAsk: 0.35 }));
  runner.processTick(makeTick({ offsetMs: 90000, upAsk: 0.60, downAsk: 0.30 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.01, downAsk: 0.99, btcPrice: 101 }));
  const result = runner.finish();
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.locked, 'expected lock after cheap dual');
  assert.ok(
    event.fillCount >= 3,
    `expected chase fills after lock, got fills=${event.fillCount} build=${event.buildFills} up=${event.upShares} down=${event.downShares}`,
  );
});

test('gate blockAvgSum impede fill que piora inventário acima do teto', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    openMaxAvgSum: 1.01,
    seedHedgeSameTick: true,
    hedgeShares: 100,
    blockAvgSum: 1.02,
    buildMaxAvgSum: 1.0,
    buildOnlyImprove: true,
    rebalanceMaxAsk: 0.55,
    chaseMaxAsk: 0.10,
    stopAvgSum: 0.90,
    stopMinBalance: 0.99,
    lateStartSec: 250,
    maxFillsPerEvent: 20,
  });
  runner.processTick(makeTick({ offsetMs: 3000, upAsk: 0.50, downAsk: 0.50 }));
  for (let i = 0; i < 5; i += 1) {
    runner.processTick(makeTick({
      offsetMs: 60000 + i * 1000,
      upAsk: 0.70,
      downAsk: 0.70,
    }));
  }
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.9, downAsk: 0.1 }));
  const result = runner.finish();
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.fillCount <= 4, `expected few fills, got ${event.fillCount}`);
  assert.ok(event.blockedByGate >= 1);
});

test('path Doggy: rebalance caro + chase barato puxa avgSum', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    openMaxAvgSum: 1.05,
    seedHedgeSameTick: true,
    hedgeShares: 100,
    clipShares: 100,
    blockAvgSum: 1.15,
    buildMaxAvgSum: 1.15,
    buildOnlyImprove: false,
    rebalanceMaxAsk: 0.90,
    rebalanceCushionAsk: 0.90,
    stopAvgSum: 0.98,
    refuseAvgSum: 1.05,
    chaseMaxAsk: 0.40,
    lateStartSec: 250,
    maxEventNotional: 600,
    maxSharesPerSide: 500,
    maxFillsPerEvent: 16,
  });
  runner.processTick(makeTick({ offsetMs: 4000, upAsk: 0.49, downAsk: 0.52 }));
  runner.processTick(makeTick({ offsetMs: 30000, upAsk: 0.25, downAsk: 0.81 }));
  runner.processTick(makeTick({ offsetMs: 60000, upAsk: 0.22, downAsk: 0.85 }));
  runner.processTick(makeTick({ offsetMs: 90000, upAsk: 0.20, downAsk: 0.86 }));
  runner.processTick(makeTick({ offsetMs: 120000, upAsk: 0.28, downAsk: 0.55 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.95, downAsk: 0.05, btcPrice: 99 }));
  const result = runner.finish();
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.fillCount >= 4, `expected multi-fill ladder, got ${event.fillCount}`);
  assert.ok(event.avgSum != null && event.avgSum < 1.05, `avgSum too high: ${event.avgSum}`);
  assert.ok(event.upShares > 0 && event.downShares > 0);
});

test('late vacuum equaliza residual barato e pode travar avgSum', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    openShares: 50,
    hedgeShares: 100,
    seedHedgeSameTick: true,
    clipShares: 100,
    openMaxAvgSum: 1.01,
    stopAvgSum: 0.98,
    stopMinBalance: 0.95,
    blockAvgSum: 1.10,
    buildMaxAvgSum: 1.10,
    refuseAvgSum: 1.05,
    rebalanceMaxAsk: 0.55,
    chaseMaxAsk: 0.10,
    lateStartSec: 180,
    lateMaxAsk: 0.12,
    lateUltraAsk: 0.05,
    lateClipShares: 50,
    maxFillsPerEvent: 20,
  });
  runner.processTick(makeTick({ offsetMs: 4000, upAsk: 0.52, downAsk: 0.48 }));
  runner.processTick(makeTick({ offsetMs: 200000, upAsk: 0.95, downAsk: 0.04 }));
  runner.processTick(makeTick({ offsetMs: 210000, upAsk: 0.96, downAsk: 0.03 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.99, downAsk: 0.01, btcPrice: 99 }));
  const result = runner.finish();
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.vacuumFills >= 1, 'expected vacuum fills');
  assert.ok(event.avgSum != null && event.avgSum < 1.05);
});

test('fillMode mid resolve entre bid e ask', () => {
  const tick = makeTick({ upAsk: 0.52, downAsk: 0.48, upBid: 0.50, downBid: 0.46 });
  const midUp = pair.resolveFillPrice(tick, 'UP', { fillMode: 'mid', slippageCents: 0, spreadCents: 0 });
  const midDown = pair.resolveFillPrice(tick, 'DOWN', { fillMode: 'mid', slippageCents: 0, spreadCents: 0 });
  assert.equal(midUp, 0.51);
  assert.equal(midDown, 0.47);
  const makerUp = pair.resolveFillPrice(tick, 'UP', { fillMode: 'optimistic_maker', slippageCents: 0 });
  assert.equal(makerUp, 0.50);
});

test('scaleOnlyTowardLock bloqueia chase que explode residual', () => {
  const stats = { avgSum: 0.97, balance: 0.9, residual: 10 };
  const bad = { avgSum: 0.95, balance: 0.5, residual: 200 };
  const good = { avgSum: 0.94, balance: 0.96, residual: 5 };
  const cheapChaseWithinCap = { avgSum: 0.94, balance: 0.5, residual: 40 };
  assert.equal(pair.improvesTowardLock(stats, bad, {
    scaleOnlyTowardLock: true,
    stopAvgSum: 0.95,
    stopMinBalance: 0.95,
    maxResidualShares: 50,
    refuseAvgSum: 1.0,
  }), false);
  assert.equal(pair.improvesTowardLock(stats, good, {
    scaleOnlyTowardLock: true,
    stopAvgSum: 0.95,
    stopMinBalance: 0.95,
    maxResidualShares: 50,
    refuseAvgSum: 1.0,
  }), true);
  // Doggy: 1º chase após seed flat pode piorar bal se avgSum melhora e residual cabe no cap
  assert.equal(pair.improvesTowardLock(stats, cheapChaseWithinCap, {
    scaleOnlyTowardLock: true,
    stopAvgSum: 0.95,
    stopMinBalance: 0.95,
    maxResidualShares: 50,
    refuseAvgSum: 1.0,
  }), true);
});

test('fees pós-processamento debitam fills taker', () => {
  const runner = pair.createBacktestRunner({
    spreadCents: 0,
    slippageCents: 0,
    openMaxAvgSum: 1.01,
    applyPolymarketFees: true,
  });
  runner.processTick(makeTick({ offsetMs: 4000, upAsk: 0.50, downAsk: 0.50 }));
  runner.processTick(makeTick({ offsetMs: 300000, upAsk: 0.9, downAsk: 0.1, btcPrice: 101 }));
  const result = runner.finish();
  const before = result.summary.totalPnl;
  applyPolymarketFeesToBacktestResult(result, { category: 'crypto' });
  if (result.summary.totalEntries > 0) {
    assert.ok(result.summary.totalPnl <= before + 1e-9);
  }
});

test('path oscilante com snap/build gera inventário dual', () => {
  const ticks = [];
  const start = '2026-07-20T15:00:00.000Z';
  const end = '2026-07-20T15:05:00.000Z';
  const path = [
    [4000, 0.49, 0.49],
    [30000, 0.55, 0.45],
    [60000, 0.44, 0.56],
    [90000, 0.58, 0.42],
    [120000, 0.40, 0.60],
    [200000, 0.92, 0.06],
    [240000, 0.95, 0.04],
    [300000, 0.99, 0.01],
  ];
  for (const [offsetMs, upAsk, downAsk] of path) {
    ticks.push(makeTick({
      offsetMs,
      upAsk,
      downAsk,
      eventStart: start,
      eventEnd: end,
      btcPrice: offsetMs >= 300000 ? 99 : 101,
    }));
  }
  const result = pair.runPairLadderCompleteSetBacktest({
    spreadCents: 0,
    slippageCents: 0,
    openMaxAvgSum: 1.01,
    maxFillsPerEvent: 30,
  }, ticks);
  assert.equal(result.summary.totalEntries, 1);
  const event = result.events[0];
  assert.ok(event.upShares > 0 && event.downShares > 0);
  assert.equal(event.positionType, 'BOTH');
});
