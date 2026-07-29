import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(
  __dirname,
  '../labs/legacy/strategy-runners/portable/pair-path-runner.js',
);
const BOOTSTRAP_PATH = path.resolve(
  __dirname,
  '../data/strategy-libraries/pair-path-runner.v1.json',
);

function loadPairPath() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __pairPathExports;`)();
}

const pair = loadPairPath();

function makeTick({
  offsetMs = 0,
  upAsk = 0.55,
  downAsk = 0.46,
  upBid = upAsk - 0.01,
  downBid = downAsk - 0.01,
  btcPrice = 101,
  conditionId = 'cond-pair-path',
  eventStart = '2026-07-20T12:00:00.000Z',
  eventEnd = '2026-07-20T12:05:00.000Z',
  coverage = 1,
} = {}) {
  const ts = new Date(Date.parse(eventStart) + offsetMs).toISOString();
  return {
    ts,
    event_start: eventStart,
    event_end: eventEnd,
    condition_id: conditionId,
    btc_price: btcPrice,
    price_to_beat: 100,
    coverage,
    degraded: false,
    up_best_ask: upAsk,
    up_best_bid: upBid,
    down_best_ask: downAsk,
    down_best_bid: downBid,
  };
}

test('createBacktestRunner e exports existem', () => {
  assert.equal(typeof pair.createBacktestRunner, 'function');
  assert.equal(typeof pair.createEventEngine, 'function');
  assert.equal(pair.DEFAULT_PARAMS.restingFillModel, 'none');
  assert.equal(pair.DEFAULT_PARAMS.maxClipsPerTick, 1);
  assert.equal(pair.DEFAULT_PARAMS.confirmationTicks, 2);
});

test('bootstrap empacotado corresponde ao runner (se existir)', () => {
  if (!fs.existsSync(BOOTSTRAP_PATH)) return;
  const bootstrap = JSON.parse(fs.readFileSync(BOOTSTRAP_PATH, 'utf8'));
  const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.equal(bootstrap.source_code, runnerSource);
  assert.equal(bootstrap.slug, 'pair-path-runner');
});

test('Pair-Path V0: open + hedge equaliza inventário UP+DOWN', () => {
  const runner = pair.createBacktestRunner({
    openShares: 10,
    openCapCents: 2,
    openTriggerCents: 55,
    openAskLo: 0.52,
    openAskHi: 0.62,
    hedgeAskMax: 0.42,
    avgSumMax: 0.98,
    confirmationTicks: 1,
    restingFillModel: 'none',
    maxEventNotional: 50,
    tauOpenMin: 40,
    tauOpenMax: 240,
    tauHedgeMin: 15,
  });

  // tau = 120s remaining → offset 180s into 300s event
  runner.processTick(makeTick({ offsetMs: 180000, upAsk: 0.56, downAsk: 0.45 }));
  // hedge at ask 0.40 (≤ 0.42), proj avgSum = 0.56+0.40 = 0.96
  runner.processTick(makeTick({ offsetMs: 200000, upAsk: 0.60, downAsk: 0.40 }));
  runner.processTick(makeTick({
    offsetMs: 300000,
    upAsk: 0.95,
    downAsk: 0.05,
    upBid: 0.94,
    downBid: 0.01,
    btcPrice: 101,
  }));

  const result = runner.finish();
  assert.equal(result.summary.totalEntries, 1);
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event, 'expected entered event');
  assert.equal(event.positionType, 'BOTH');
  assert.ok(event.upShares > 0 && event.downShares > 0);
  assert.ok(Math.abs(event.upShares - event.downShares) < 1e-6, 'expected equalized');
  assert.ok(event.orders.length >= 2);
  assert.ok(event.avgSum != null && event.avgSum < 1);
});

test('Clip-Path: hedgeLevels preenche em clips', () => {
  const runner = pair.createBacktestRunner({
    openShares: 10,
    openCapCents: 2,
    confirmationTicks: 1,
    restingFillModel: 'none',
    maxClipsPerTick: 1,
    maxHedgeAttempts: 8,
    maxEventNotional: 50,
    avgSumMax: 0.96,
    hedgeAskMax: 0.42,
    hedgeLevels: [
      { askMax: 0.42, frac: 0.5 },
      { askMax: 0.38, frac: 0.5 },
    ],
  });

  runner.processTick(makeTick({ offsetMs: 180000, upAsk: 0.56, downAsk: 0.45 }));
  // first clip @ 0.41
  runner.processTick(makeTick({ offsetMs: 190000, upAsk: 0.60, downAsk: 0.41 }));
  // second clip @ 0.37
  runner.processTick(makeTick({ offsetMs: 200000, upAsk: 0.62, downAsk: 0.37 }));
  runner.processTick(makeTick({
    offsetMs: 300000,
    upAsk: 0.95,
    downAsk: 0.05,
    btcPrice: 101,
  }));

  const result = runner.finish();
  const event = result.events.find((e) => e.reason !== 'no_entry');
  assert.ok(event);
  assert.ok(event.nHedgeClips >= 1);
  assert.ok(event.upShares > 0 && event.downShares > 0);
  assert.equal(event.positionType, 'BOTH');
});
