#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeDatabasePool,
  getBacktestRange,
  getTicksForBacktestBatches,
} from '../src/database.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

const DEFAULT_FROM = '2026-05-04T15:00:00.000Z';
const OFFICIAL_FEE_SOURCE = 'https://docs.polymarket.com/trading/fees';
const EPS = 1e-9;
const CENT = 0.01;

const HYPOTHESES = Object.freeze([
  {
    id: 'net-complete-set',
    name: 'Net Complete-Set',
    latentVariable: 'crossed executable asks after both taker fees',
    formula: 'G = q * [1 - (aU + aD)] - feeU - feeD - slippage',
    directional: false,
  },
  {
    id: 'paired-expansion-lock',
    name: 'Paired Expansion Lock',
    latentVariable: 'future compression of the combined executable spread',
    formula: 'L_t = proceeds(bU_t, bD_t) - allInCost(aU_0, aD_0)',
    directional: false,
  },
  {
    id: 'paired-maker-reconstitution',
    name: 'Paired Maker Reconstitution',
    latentVariable: 'two-sided path visitation sufficient to fill both passive bids',
    formula: 'M = q * [1 - (lU + lD)] - orphanUnwind - fees',
    directional: false,
  },
  {
    id: 'split-sell-inversion',
    name: 'Split-and-Sell Inversion',
    latentVariable: 'crossed executable bids after mint cost and sell fees',
    formula: 'S = proceeds(bU, bD) - q - fees - slippage',
    directional: false,
  },
]);

const EXECUTION_SCENARIOS = Object.freeze({
  optimistic: {
    id: 'optimistic',
    makerFeeRate: 0,
    takerFeeRate: 0.07,
    takerRebateRate: 0.44,
    slippageTicks: 0,
    depthHaircut: 1,
    queueHaircut: 0.75,
    latencyMs: 500,
    legLatencyMs: 500,
    exitLatencyMs: 500,
    touchThroughTicks: 0,
    confirmMs: 500,
  },
  base: {
    id: 'base',
    makerFeeRate: 0,
    takerFeeRate: 0.07,
    takerRebateRate: 0,
    slippageTicks: 1,
    depthHaircut: 0.5,
    queueHaircut: 0.35,
    latencyMs: 750,
    legLatencyMs: 500,
    exitLatencyMs: 750,
    touchThroughTicks: 1,
    confirmMs: 1000,
  },
  pessimistic: {
    id: 'pessimistic',
    makerFeeRate: 0,
    takerFeeRate: 0.0875,
    takerRebateRate: 0,
    slippageTicks: 2,
    depthHaircut: 0.25,
    queueHaircut: 0.15,
    latencyMs: 1250,
    legLatencyMs: 750,
    exitLatencyMs: 1250,
    touchThroughTicks: 2,
    confirmMs: 1500,
  },
});

const TEMPORAL_VARIANTS = Object.freeze([
  {
    id: 'expansion-low',
    family: 'paired-expansion-lock',
    frequency: 'low',
    targetTau: 120,
    maxAskSum: 1.01,
    maxCombinedSpread: 0.02,
    minTopDepth: 50,
    minPrice: 0.20,
    maxPrice: 0.80,
    lockProfitPerPair: 0.004,
  },
  {
    id: 'expansion-medium',
    family: 'paired-expansion-lock',
    frequency: 'medium',
    targetTau: 180,
    maxAskSum: 1.02,
    maxCombinedSpread: 0.04,
    minTopDepth: 10,
    minPrice: 0.10,
    maxPrice: 0.90,
    lockProfitPerPair: 0.002,
  },
  {
    id: 'expansion-high',
    family: 'paired-expansion-lock',
    frequency: 'high',
    targetTau: 240,
    maxAskSum: 1.04,
    maxCombinedSpread: 0.08,
    minTopDepth: 5,
    minPrice: 0.05,
    maxPrice: 0.95,
    lockProfitPerPair: 0,
  },
]);

const PASSIVE_VARIANTS = Object.freeze([
  {
    id: 'maker-pair-low',
    family: 'paired-maker-reconstitution',
    frequency: 'low',
    targetTau: 180,
    maxBidSum: 0.98,
    maxCombinedSpread: 0.04,
    minTopDepth: 20,
    minPrice: 0.20,
    maxPrice: 0.80,
    ttlSec: 120,
  },
  {
    id: 'maker-pair-medium',
    family: 'paired-maker-reconstitution',
    frequency: 'medium',
    targetTau: 180,
    maxBidSum: 0.99,
    maxCombinedSpread: 0.06,
    minTopDepth: 10,
    minPrice: 0.10,
    maxPrice: 0.90,
    ttlSec: 90,
  },
  {
    id: 'maker-pair-high',
    family: 'paired-maker-reconstitution',
    frequency: 'high',
    targetTau: 240,
    maxBidSum: 1.00,
    maxCombinedSpread: 0.10,
    minTopDepth: 5,
    minPrice: 0.05,
    maxPrice: 0.95,
    ttlSec: 60,
  },
]);

const IMMEDIATE_VARIANTS = Object.freeze([
  {
    id: 'net-complete-set',
    family: 'net-complete-set',
    frequency: 'opportunity',
    minTau: 5,
    maxTau: 280,
    minSafetyPerPair: 0.002,
  },
  {
    id: 'split-sell-inversion',
    family: 'split-sell-inversion',
    frequency: 'opportunity',
    minTau: 5,
    maxTau: 280,
    minSafetyPerPair: 0.002,
  },
]);

const ALL_VARIANTS = Object.freeze([
  ...IMMEDIATE_VARIANTS,
  ...TEMPORAL_VARIANTS,
  ...PASSIVE_VARIANTS,
]);

const REFERENCE_RUNNERS = Object.freeze([
  ['edge-sniper-v2', 'labs/legacy/strategy-runners/portable/edge-sniper-runner.js'],
  ['terminal-convexity-v1', 'labs/legacy/strategy-runners/portable/terminal-convexity-runner.js'],
  ['gamma-ladder-v1', 'labs/legacy/strategy-runners/portable/gamma-ladder-runner.js'],
  ['impulse-elasticity-v1', 'labs/legacy/strategy-runners/portable/impulse-elasticity-runner.js'],
]);

export function calculateFee(shares, price, feeRate) {
  const qty = Math.max(0, finite(shares));
  const px = clamp(finite(price), 0, 1);
  const rate = Math.max(0, finite(feeRate));
  if (!(qty > 0 && px > 0 && px < 1 && rate > 0)) return 0;
  return round5(qty * rate * px * (1 - px));
}

export function makerFillObservation({
  ask,
  askSize,
  quote,
  touchThroughTicks,
  queueHaircut,
  requestedQty,
}) {
  const threshold = quote - touchThroughTicks * CENT;
  if (!(ask > 0 && ask <= threshold + EPS && askSize > 0)) return 0;
  return Math.min(requestedQty, askSize * queueHaircut);
}

export function simulatePassivePair(eventTicks, variant, scenario, options = {}) {
  const qty = options.qty ?? 5;
  const riskCapUsd = options.riskCapUsd ?? 5;
  const signalIndex = findTargetTauIndex(eventTicks, variant.targetTau);
  if (signalIndex < 0) return null;
  const signal = eventTicks[signalIndex];
  const up = sideBook(signal, 'UP');
  const down = sideBook(signal, 'DOWN');
  if (!validTwoSided(up) || !validTwoSided(down)) return null;
  const bidSum = up.bid + down.bid;
  const combinedSpread = up.ask - up.bid + down.ask - down.bid;
  const minDepth = Math.min(up.bidSize, down.bidSize);
  if (bidSum > variant.maxBidSum + EPS
    || combinedSpread > variant.maxCombinedSpread + EPS
    || minDepth < variant.minTopDepth
    || Math.min(up.bid, down.bid) < variant.minPrice
    || Math.max(up.bid, down.bid) > variant.maxPrice) {
    return null;
  }
  if (!(up.bid < up.ask - EPS && down.bid < down.ask - EPS)) return null;

  const preRisk = qty * Math.max(up.bid, down.bid)
    + calculateFee(qty, Math.max(up.bid, down.bid), scenario.makerFeeRate);
  if (preRisk > riskCapUsd + EPS) return null;

  const ledger = createLedger({
    eventTicks,
    variant,
    scenario,
    signal,
    signalIndex,
    qty,
    maxRiskPreEntry: preRisk,
    requiresPreSettlementExit: false,
  });
  ledger.quotes = { UP: up.bid, DOWN: down.bid };
  ledger.combinedCostQuoted = qty * bidSum;
  ledger.marginSafety = qty * (1 - bidSum)
    - calculateFee(qty, up.bid, scenario.makerFeeRate)
    - calculateFee(qty, down.bid, scenario.makerFeeRate);

  const activeMs = Date.parse(signal.ts) + scenario.latencyMs;
  const deadlineMs = Math.min(
    Date.parse(signal.event_end) - 1000,
    activeMs + variant.ttlSec * 1000,
  );
  const sides = ['UP', 'DOWN'];
  const streakStartedAt = { UP: null, DOWN: null };
  const attempted = { UP: false, DOWN: false };
  let lastIndex = signalIndex;

  for (let index = signalIndex + 1; index < eventTicks.length; index += 1) {
    const tick = eventTicks[index];
    const tickMs = Date.parse(tick.ts);
    if (tickMs < activeMs) continue;
    if (tickMs > deadlineMs) break;
    lastIndex = index;

    for (const side of sides) {
      if (attempted[side]) continue;
      const book = sideBook(tick, side);
      const observed = makerFillObservation({
        ask: book.ask,
        askSize: book.askSize,
        quote: ledger.quotes[side],
        touchThroughTicks: scenario.touchThroughTicks,
        queueHaircut: scenario.queueHaircut,
        requestedQty: qty,
      });
      if (observed <= EPS) {
        streakStartedAt[side] = null;
        continue;
      }
      if (streakStartedAt[side] == null) streakStartedAt[side] = tickMs;
      if (tickMs - streakStartedAt[side] < scenario.confirmMs) continue;

      attempted[side] = true;
      recordBuy(ledger, {
        side,
        qty: observed,
        rawPrice: ledger.quotes[side],
        execPrice: ledger.quotes[side],
        liquidity: 'maker',
        ts: tick.ts,
        reason: 'confirmed_trade_through',
      });
    }
    if (attempted.UP && attempted.DOWN) break;
  }

  ledger.orderAttempts = 2;
  ledger.orderMisses = Number(!attempted.UP) + Number(!attempted.DOWN);
  ledger.makerFilledSides = Number(ledger.bought.UP > EPS) + Number(ledger.bought.DOWN > EPS);
  const deadlineIndex = findIndexAtOrAfter(
    eventTicks,
    Math.max(deadlineMs, Date.parse(eventTicks[lastIndex]?.ts || signal.ts)),
  );
  unwindExcess(ledger, Math.max(signalIndex, deadlineIndex), 'maker_orphan_unwind');
  const idealLockedPnl = qty * (1 - bidSum)
    - calculateFee(qty, up.bid, scenario.makerFeeRate)
    - calculateFee(qty, down.bid, scenario.makerFeeRate);
  return finalizeLedger(ledger, {
    idealNetPnl: idealLockedPnl,
    entryType: 'simultaneous_resting_bids',
  });
}

function simulateNetCompleteSet(eventTicks, variant, scenario, options) {
  const qty = options.qty;
  for (let index = 0; index < eventTicks.length; index += 1) {
    const tick = eventTicks[index];
    const tau = secondsRemaining(tick);
    if (tau < variant.minTau || tau > variant.maxTau) continue;
    const up = sideBook(tick, 'UP');
    const down = sideBook(tick, 'DOWN');
    if (!validAsk(up) || !validAsk(down)) continue;
    const projected = projectedPairBuy(up, down, qty, scenario);
    if (projected.marginPerPair < variant.minSafetyPerPair
      || projected.fillableQty + EPS < qty) continue;
    const preRisk = Math.max(projected.maxOrphanRisk, Math.max(0, -projected.lockedPnl));
    if (preRisk > options.riskCapUsd + EPS) continue;

    const order = deterministicSideOrder(tick.condition_id);
    const firstIndex = findIndexAfter(eventTicks, index, scenario.latencyMs);
    if (firstIndex < 0) return null;
    const ledger = createLedger({
      eventTicks,
      variant,
      scenario,
      signal: tick,
      signalIndex: index,
      qty,
      maxRiskPreEntry: preRisk,
      requiresPreSettlementExit: false,
    });
    ledger.marginSafety = projected.lockedPnl;
    const first = executeBuy(ledger, eventTicks[firstIndex], order[0], qty, 'taker', 'pair_leg_1');
    const secondIndex = findIndexAfter(eventTicks, firstIndex, scenario.legLatencyMs);
    if (secondIndex >= 0) {
      executeBuy(ledger, eventTicks[secondIndex], order[1], qty, 'taker', 'pair_leg_2');
      unwindExcess(ledger, secondIndex, 'pair_orphan_unwind');
    } else if (first > EPS) {
      unwindExcess(ledger, firstIndex, 'pair_orphan_unwind');
    }
    ledger.orderAttempts = 2;
    ledger.orderMisses = Number(ledger.bought.UP + EPS < qty)
      + Number(ledger.bought.DOWN + EPS < qty);
    return finalizeLedger(ledger, {
      idealNetPnl: projected.lockedPnl,
      entryType: 'sequential_fak_complete_set',
    });
  }
  return null;
}

function simulateSplitSell(eventTicks, variant, scenario, options) {
  const qty = options.qty;
  for (let index = 0; index < eventTicks.length; index += 1) {
    const tick = eventTicks[index];
    const tau = secondsRemaining(tick);
    if (tau < variant.minTau || tau > variant.maxTau) continue;
    const up = sideBook(tick, 'UP');
    const down = sideBook(tick, 'DOWN');
    if (!validBid(up) || !validBid(down)) continue;
    const projected = projectedPairSell(up, down, qty, scenario);
    if (projected.marginPerPair < variant.minSafetyPerPair
      || projected.fillableQty + EPS < qty) continue;
    const preRisk = Math.max(projected.maxOrphanRisk, Math.max(0, -projected.lockedPnl));
    if (preRisk > options.riskCapUsd + EPS) continue;

    const order = deterministicSideOrder(tick.condition_id);
    const firstIndex = findIndexAfter(eventTicks, index, scenario.latencyMs);
    if (firstIndex < 0) return null;
    const ledger = createLedger({
      eventTicks,
      variant,
      scenario,
      signal: tick,
      signalIndex: index,
      qty,
      maxRiskPreEntry: preRisk,
      requiresPreSettlementExit: true,
    });
    ledger.mintCost = qty;
    ledger.bought.UP = qty;
    ledger.bought.DOWN = qty;
    ledger.remaining.UP = qty;
    ledger.remaining.DOWN = qty;
    ledger.marginSafety = projected.lockedPnl;
    executeSell(ledger, eventTicks[firstIndex], order[0], qty, 'taker', 'split_sell_leg_1');
    const secondIndex = findIndexAfter(eventTicks, firstIndex, scenario.legLatencyMs);
    if (secondIndex >= 0) {
      executeSell(ledger, eventTicks[secondIndex], order[1], qty, 'taker', 'split_sell_leg_2');
    }
    ledger.orderAttempts = 2;
    ledger.orderMisses = Number(ledger.sold.UP + EPS < qty)
      + Number(ledger.sold.DOWN + EPS < qty);
    return finalizeLedger(ledger, {
      idealNetPnl: projected.lockedPnl,
      entryType: 'mint_then_sequential_sell',
    });
  }
  return null;
}

function simulateExpansionLock(eventTicks, variant, scenario, options) {
  const qty = options.qty;
  const signalIndex = findTargetTauIndex(eventTicks, variant.targetTau);
  if (signalIndex < 0) return null;
  const signal = eventTicks[signalIndex];
  const up = sideBook(signal, 'UP');
  const down = sideBook(signal, 'DOWN');
  if (!validTwoSided(up) || !validTwoSided(down)) return null;
  const askSum = up.ask + down.ask;
  const combinedSpread = up.ask - up.bid + down.ask - down.bid;
  const minDepth = Math.min(up.askSize, down.askSize);
  if (askSum > variant.maxAskSum + EPS
    || combinedSpread > variant.maxCombinedSpread + EPS
    || minDepth < variant.minTopDepth
    || Math.min(up.ask, down.ask) < variant.minPrice
    || Math.max(up.ask, down.ask) > variant.maxPrice) {
    return null;
  }

  const projected = projectedPairBuy(up, down, qty, scenario);
  const preRisk = Math.max(projected.maxOrphanRisk, Math.max(0, -projected.lockedPnl));
  if (preRisk > options.riskCapUsd + EPS) return null;
  const order = deterministicSideOrder(signal.condition_id);
  const firstIndex = findIndexAfter(eventTicks, signalIndex, scenario.latencyMs);
  if (firstIndex < 0) return null;
  const ledger = createLedger({
    eventTicks,
    variant,
    scenario,
    signal,
    signalIndex,
    qty,
    maxRiskPreEntry: preRisk,
    requiresPreSettlementExit: true,
  });
  ledger.marginSafety = projected.lockedPnl;
  executeBuy(ledger, eventTicks[firstIndex], order[0], qty, 'taker', 'straddle_leg_1');
  const secondIndex = findIndexAfter(eventTicks, firstIndex, scenario.legLatencyMs);
  if (secondIndex >= 0) {
    executeBuy(ledger, eventTicks[secondIndex], order[1], qty, 'taker', 'straddle_leg_2');
    unwindExcess(ledger, secondIndex, 'straddle_orphan_unwind');
  } else {
    unwindExcess(ledger, firstIndex, 'straddle_orphan_unwind');
  }
  ledger.orderAttempts = 2;
  ledger.orderMisses = Number(ledger.bought.UP + EPS < qty)
    + Number(ledger.bought.DOWN + EPS < qty);

  const monitorStart = Math.max(firstIndex, secondIndex);
  const totalEntryOutlay = ledger.buyCost + ledger.fees - ledger.rebates;
  for (let index = monitorStart + 1; index < eventTicks.length; index += 1) {
    const tick = eventTicks[index];
    const upHeld = ledger.remaining.UP;
    const downHeld = ledger.remaining.DOWN;
    if (upHeld <= EPS && downHeld <= EPS) break;

    const freeRoll = projectFreeRoll(tick, ledger, scenario, totalEntryOutlay);
    if (freeRoll && freeRoll.proceeds + EPS >= totalEntryOutlay) {
      executeSell(ledger, tick, freeRoll.side, ledger.remaining[freeRoll.side], 'taker', 'free_roll');
      ledger.freeRoll = true;
      break;
    }

    const projectedExit = projectPairedExit(tick, ledger, scenario);
    const target = totalEntryOutlay + variant.lockProfitPerPair * Math.min(upHeld, downHeld);
    if (projectedExit.fillableQty > EPS && projectedExit.netProceeds + EPS >= target) {
      const exitOrder = deterministicSideOrder(`${tick.condition_id}:exit`);
      const firstExit = findIndexAfter(eventTicks, index, scenario.exitLatencyMs);
      if (firstExit < 0) break;
      executeSell(
        ledger,
        eventTicks[firstExit],
        exitOrder[0],
        ledger.remaining[exitOrder[0]],
        'taker',
        'paired_lock_leg_1',
      );
      const secondExit = findIndexAfter(eventTicks, firstExit, scenario.legLatencyMs);
      if (secondExit >= 0) {
        executeSell(
          ledger,
          eventTicks[secondExit],
          exitOrder[1],
          ledger.remaining[exitOrder[1]],
          'taker',
          'paired_lock_leg_2',
        );
      }
      ledger.locked = ledger.remaining.UP <= EPS && ledger.remaining.DOWN <= EPS;
      break;
    }
  }

  return finalizeLedger(ledger, {
    idealNetPnl: projected.lockedPnl,
    entryType: 'paired_taker_then_combined_exit',
  });
}

function simulateBaseline(eventTicks, id, scenario, options) {
  const qty = options.qty;
  const index = findTargetTauIndex(eventTicks, 120);
  if (index < 0) return null;
  const signal = eventTicks[index];
  const ledger = createLedger({
    eventTicks,
    variant: { id, family: 'baseline', frequency: 'same-signal' },
    scenario,
    signal,
    signalIndex: index,
    qty,
    maxRiskPreEntry: qty,
    requiresPreSettlementExit: false,
  });
  const executionIndex = findIndexAfter(eventTicks, index, scenario.latencyMs);
  if (executionIndex < 0) return null;
  if (id === 'baseline-random-dual') {
    const order = deterministicSideOrder(`${signal.condition_id}:baseline-dual`);
    executeBuy(ledger, eventTicks[executionIndex], order[0], qty, 'taker', 'baseline_leg_1');
    const second = findIndexAfter(eventTicks, executionIndex, scenario.legLatencyMs);
    if (second >= 0) executeBuy(ledger, eventTicks[second], order[1], qty, 'taker', 'baseline_leg_2');
    if (second >= 0) unwindExcess(ledger, second, 'baseline_orphan_unwind');
  } else {
    let side = 'UP';
    if (id === 'baseline-down-only') side = 'DOWN';
    if (id === 'baseline-random-side') {
      side = deterministicSideOrder(`${signal.condition_id}:baseline`)[0];
    }
    executeBuy(ledger, eventTicks[executionIndex], side, qty, 'taker', id);
  }
  return finalizeLedger(ledger, { idealNetPnl: null, entryType: 'same_time_same_book_baseline' });
}

function createLedger({
  eventTicks,
  variant,
  scenario,
  signal,
  signalIndex,
  qty,
  maxRiskPreEntry,
  requiresPreSettlementExit,
}) {
  return {
    eventTicks,
    variant,
    scenario,
    signal,
    signalIndex,
    qtyRequested: qty,
    maxRiskPreEntry,
    requiresPreSettlementExit,
    bought: { UP: 0, DOWN: 0 },
    sold: { UP: 0, DOWN: 0 },
    remaining: { UP: 0, DOWN: 0 },
    buyCost: 0,
    rawBuyCost: 0,
    sellProceeds: 0,
    rawSellProceeds: 0,
    mintCost: 0,
    fees: 0,
    takerFees: 0,
    makerFees: 0,
    rebates: 0,
    slippageLoss: 0,
    spreadLoss: 0,
    fills: [],
    exits: [],
    partialFill: false,
    locked: false,
    freeRoll: false,
    marginSafety: null,
    orderAttempts: 0,
    orderMisses: 0,
  };
}

function executeBuy(ledger, tick, side, requestedQty, liquidity, reason) {
  const book = sideBook(tick, side);
  if (!validAsk(book) || requestedQty <= EPS) return 0;
  const scenario = ledger.scenario;
  const available = book.askSize * scenario.depthHaircut;
  const filled = Math.min(requestedQty, available);
  if (filled <= EPS) return 0;
  const rawPrice = book.ask;
  const execPrice = clamp(rawPrice + scenario.slippageTicks * CENT, CENT, 0.99);
  recordBuy(ledger, { side, qty: filled, rawPrice, execPrice, liquidity, ts: tick.ts, reason });
  if (filled + EPS < requestedQty) ledger.partialFill = true;
  return filled;
}

function recordBuy(ledger, {
  side,
  qty,
  rawPrice,
  execPrice,
  liquidity,
  ts,
  reason,
}) {
  const feeRate = liquidity === 'maker'
    ? ledger.scenario.makerFeeRate
    : ledger.scenario.takerFeeRate;
  const fee = calculateFee(qty, execPrice, feeRate);
  const rebate = liquidity === 'taker'
    ? round5(fee * ledger.scenario.takerRebateRate)
    : 0;
  ledger.bought[side] += qty;
  ledger.remaining[side] += qty;
  ledger.rawBuyCost += qty * rawPrice;
  ledger.buyCost += qty * execPrice;
  ledger.fees += fee;
  ledger.rebates += rebate;
  ledger.slippageLoss += qty * Math.max(0, execPrice - rawPrice);
  if (liquidity === 'maker') ledger.makerFees += fee;
  else ledger.takerFees += fee;
  ledger.fills.push({
    type: 'entry',
    side,
    qty,
    rawPrice,
    price: execPrice,
    liquidity,
    fee,
    rebate,
    ts,
    reason,
  });
}

function executeSell(ledger, tick, side, requestedQty, liquidity, reason) {
  const held = ledger.remaining[side];
  const desired = Math.min(requestedQty, held);
  const book = sideBook(tick, side);
  if (!validBid(book) || desired <= EPS) return 0;
  const scenario = ledger.scenario;
  const available = book.bidSize * scenario.depthHaircut;
  const filled = Math.min(desired, available);
  if (filled <= EPS) return 0;
  const rawPrice = book.bid;
  const execPrice = clamp(rawPrice - scenario.slippageTicks * CENT, CENT, 0.99);
  const feeRate = liquidity === 'maker' ? scenario.makerFeeRate : scenario.takerFeeRate;
  const fee = calculateFee(filled, execPrice, feeRate);
  const rebate = liquidity === 'taker' ? round5(fee * scenario.takerRebateRate) : 0;
  ledger.sold[side] += filled;
  ledger.remaining[side] -= filled;
  ledger.rawSellProceeds += filled * rawPrice;
  ledger.sellProceeds += filled * execPrice;
  ledger.fees += fee;
  ledger.rebates += rebate;
  ledger.slippageLoss += filled * Math.max(0, rawPrice - execPrice);
  if (liquidity === 'maker') ledger.makerFees += fee;
  else ledger.takerFees += fee;
  ledger.exits.push({
    type: 'exit',
    side,
    qty: filled,
    rawPrice,
    price: execPrice,
    liquidity,
    fee,
    rebate,
    ts: tick.ts,
    reason,
  });
  if (filled + EPS < desired) ledger.partialFill = true;
  return filled;
}

function unwindExcess(ledger, afterIndex, reason) {
  const excessUp = Math.max(0, ledger.remaining.UP - ledger.remaining.DOWN);
  const excessDown = Math.max(0, ledger.remaining.DOWN - ledger.remaining.UP);
  if (excessUp <= EPS && excessDown <= EPS) return;
  const index = findIndexAfter(ledger.eventTicks, afterIndex, ledger.scenario.exitLatencyMs);
  if (index < 0) return;
  const tick = ledger.eventTicks[index];
  if (excessUp > EPS) executeSell(ledger, tick, 'UP', excessUp, 'taker', reason);
  if (excessDown > EPS) executeSell(ledger, tick, 'DOWN', excessDown, 'taker', reason);
}

function finalizeLedger(ledger, { idealNetPnl, entryType }) {
  const winner = inferWinner(ledger.eventTicks);
  const cashBeforeSettlement = ledger.sellProceeds
    - ledger.buyCost
    - ledger.mintCost
    - ledger.fees
    + ledger.rebates;
  const rawCashBeforeSettlement = ledger.rawSellProceeds
    - ledger.rawBuyCost
    - ledger.mintCost;
  const resultIfUp = cashBeforeSettlement + ledger.remaining.UP;
  const resultIfDown = cashBeforeSettlement + ledger.remaining.DOWN;
  const grossIfUp = rawCashBeforeSettlement + ledger.remaining.UP;
  const grossIfDown = rawCashBeforeSettlement + ledger.remaining.DOWN;
  const pnlNet = winner === 'DOWN' ? resultIfDown : resultIfUp;
  const pnlGross = winner === 'DOWN' ? grossIfDown : grossIfUp;
  const matchedShares = Math.min(ledger.bought.UP, ledger.bought.DOWN);
  const entryQty = ledger.bought.UP + ledger.bought.DOWN;
  const entered = entryQty > EPS || ledger.mintCost > EPS;
  const combinedCost = ledger.buyCost + ledger.mintCost + ledger.fees - ledger.rebates;
  const avgUpCost = ledger.bought.UP > EPS
    ? ledger.fills.filter((fill) => fill.side === 'UP').reduce((sum, fill) => sum + fill.qty * fill.price + fill.fee - fill.rebate, 0) / ledger.bought.UP
    : null;
  const avgDownCost = ledger.bought.DOWN > EPS
    ? ledger.fills.filter((fill) => fill.side === 'DOWN').reduce((sum, fill) => sum + fill.qty * fill.price + fill.fee - fill.rebate, 0) / ledger.bought.DOWN
    : null;
  const ideal = Number.isFinite(idealNetPnl) ? idealNetPnl : null;
  const partialDeterioration = ideal == null ? 0 : Math.max(0, ideal - pnlNet);

  return {
    eventId: ledger.signal.condition_id,
    eventStart: ledger.signal.event_start,
    eventEnd: ledger.signal.event_end,
    signalTs: ledger.signal.ts,
    entryTauSec: secondsRemaining(ledger.signal),
    eventOrdinal: null,
    strategyId: ledger.variant.id,
    family: ledger.variant.family,
    frequency: ledger.variant.frequency,
    scenario: ledger.scenario.id,
    entryType,
    entered,
    winnerProxy: winner,
    qtyRequested: ledger.qtyRequested,
    upSharesBought: ledger.bought.UP,
    downSharesBought: ledger.bought.DOWN,
    upSharesSold: ledger.sold.UP,
    downSharesSold: ledger.sold.DOWN,
    upSharesSettlement: ledger.remaining.UP,
    downSharesSettlement: ledger.remaining.DOWN,
    matchedShares,
    upCost: ledger.fills.filter((fill) => fill.side === 'UP')
      .reduce((sum, fill) => sum + fill.qty * fill.price, 0),
    downCost: ledger.fills.filter((fill) => fill.side === 'DOWN')
      .reduce((sum, fill) => sum + fill.qty * fill.price, 0),
    combinedCost,
    mintCost: ledger.mintCost,
    fees: ledger.fees,
    makerFees: ledger.makerFees,
    takerFees: ledger.takerFees,
    rebates: ledger.rebates,
    slippage: ledger.slippageLoss,
    spreadLoss: ledger.spreadLoss,
    pnlGross,
    pnlNetAfterFees: pnlGross - ledger.fees + ledger.rebates,
    pnlNet,
    resultIfUp,
    resultIfDown,
    worstCase: Math.min(resultIfUp, resultIfDown),
    bestCase: Math.max(resultIfUp, resultIfDown),
    payoffRiskAsymmetry: Math.max(resultIfUp, resultIfDown) / Math.max(EPS, Math.abs(Math.min(0, resultIfUp, resultIfDown))),
    breakEvenUp: avgUpCost,
    breakEvenDown: avgDownCost,
    marginSafety: ledger.marginSafety,
    maxRiskPreEntry: ledger.maxRiskPreEntry,
    requiresPreSettlementExit: ledger.requiresPreSettlementExit,
    locked: ledger.locked,
    freeRoll: ledger.freeRoll,
    partialFill: ledger.partialFill,
    partialDeterioration,
    orderAttempts: ledger.orderAttempts,
    orderMisses: ledger.orderMisses,
    makerFilledSides: ledger.makerFilledSides ?? null,
    turnover: ledger.buyCost + ledger.sellProceeds + ledger.mintCost,
    fills: ledger.fills,
    exits: ledger.exits,
  };
}

function projectedPairBuy(up, down, qty, scenario) {
  const upPrice = clamp(up.ask + scenario.slippageTicks * CENT, CENT, 0.99);
  const downPrice = clamp(down.ask + scenario.slippageTicks * CENT, CENT, 0.99);
  const fillableQty = Math.min(up.askSize, down.askSize) * scenario.depthHaircut;
  const fee = calculateFee(qty, upPrice, scenario.takerFeeRate)
    + calculateFee(qty, downPrice, scenario.takerFeeRate);
  const rebate = fee * scenario.takerRebateRate;
  const cost = qty * (upPrice + downPrice) + fee - rebate;
  return {
    fillableQty,
    lockedPnl: qty - cost,
    marginPerPair: (qty - cost) / qty,
    maxOrphanRisk: qty * Math.max(upPrice, downPrice)
      + Math.max(
        calculateFee(qty, upPrice, scenario.takerFeeRate),
        calculateFee(qty, downPrice, scenario.takerFeeRate),
      ),
  };
}

function projectedPairSell(up, down, qty, scenario) {
  const upPrice = clamp(up.bid - scenario.slippageTicks * CENT, CENT, 0.99);
  const downPrice = clamp(down.bid - scenario.slippageTicks * CENT, CENT, 0.99);
  const fillableQty = Math.min(up.bidSize, down.bidSize) * scenario.depthHaircut;
  const fee = calculateFee(qty, upPrice, scenario.takerFeeRate)
    + calculateFee(qty, downPrice, scenario.takerFeeRate);
  const rebate = fee * scenario.takerRebateRate;
  const proceeds = qty * (upPrice + downPrice) - fee + rebate;
  return {
    fillableQty,
    lockedPnl: proceeds - qty,
    marginPerPair: (proceeds - qty) / qty,
    maxOrphanRisk: qty * (1 - Math.min(upPrice, downPrice)),
  };
}

function projectPairedExit(tick, ledger, scenario) {
  const up = sideBook(tick, 'UP');
  const down = sideBook(tick, 'DOWN');
  if (!validBid(up) || !validBid(down)) return { fillableQty: 0, netProceeds: 0 };
  const qty = Math.min(ledger.remaining.UP, ledger.remaining.DOWN);
  const fillableQty = Math.min(qty, up.bidSize * scenario.depthHaircut, down.bidSize * scenario.depthHaircut);
  const upPrice = clamp(up.bid - scenario.slippageTicks * CENT, CENT, 0.99);
  const downPrice = clamp(down.bid - scenario.slippageTicks * CENT, CENT, 0.99);
  const fee = calculateFee(fillableQty, upPrice, scenario.takerFeeRate)
    + calculateFee(fillableQty, downPrice, scenario.takerFeeRate);
  return {
    fillableQty,
    netProceeds: fillableQty * (upPrice + downPrice) - fee + fee * scenario.takerRebateRate,
  };
}

function projectFreeRoll(tick, ledger, scenario, outlay) {
  let best = null;
  for (const side of ['UP', 'DOWN']) {
    const qty = ledger.remaining[side];
    const book = sideBook(tick, side);
    if (!(qty > EPS && validBid(book) && book.bidSize * scenario.depthHaircut + EPS >= qty)) continue;
    const price = clamp(book.bid - scenario.slippageTicks * CENT, CENT, 0.99);
    const fee = calculateFee(qty, price, scenario.takerFeeRate);
    const proceeds = qty * price - fee + fee * scenario.takerRebateRate;
    if (proceeds + EPS < outlay) continue;
    if (!best || proceeds > best.proceeds) best = { side, proceeds };
  }
  return best;
}

function sideBook(tick, side) {
  const prefix = side === 'UP' ? 'up' : 'down';
  const asks = tick?.[`${prefix}_book_asks`];
  const bids = tick?.[`${prefix}_book_bids`];
  return {
    ask: finiteOrNull(tick?.[`${prefix}_best_ask`] ?? asks?.[0]?.price),
    askSize: finiteOrNull(asks?.[0]?.size),
    bid: finiteOrNull(tick?.[`${prefix}_best_bid`] ?? bids?.[0]?.price),
    bidSize: finiteOrNull(bids?.[0]?.size),
  };
}

function validAsk(book) {
  return book.ask > 0 && book.ask < 1 && book.askSize > 0;
}

function validBid(book) {
  return book.bid > 0 && book.bid < 1 && book.bidSize > 0;
}

function validTwoSided(book) {
  return validAsk(book) && validBid(book) && book.ask + EPS >= book.bid;
}

function findTargetTauIndex(ticks, targetTau) {
  let best = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ticks.length; index += 1) {
    const delta = Math.abs(secondsRemaining(ticks[index]) - targetTau);
    if (delta < bestDelta) {
      best = index;
      bestDelta = delta;
    }
  }
  return bestDelta <= 2 ? best : -1;
}

function findIndexAfter(ticks, index, delayMs) {
  if (index < 0 || index >= ticks.length) return -1;
  const target = Date.parse(ticks[index].ts) + delayMs;
  return findIndexAtOrAfter(ticks, target, index + 1);
}

function findIndexAtOrAfter(ticks, targetMs, start = 0) {
  for (let index = Math.max(0, start); index < ticks.length; index += 1) {
    if (Date.parse(ticks[index].ts) >= targetMs) return index;
  }
  return -1;
}

function deterministicSideOrder(key) {
  const digest = createHash('sha256').update(String(key)).digest();
  return digest[0] % 2 === 0 ? ['UP', 'DOWN'] : ['DOWN', 'UP'];
}

function inferWinner(ticks) {
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const spot = finiteOrNull(ticks[index].btc_price);
    const ptb = finiteOrNull(ticks[index].price_to_beat);
    if (spot != null && ptb != null) return spot >= ptb ? 'UP' : 'DOWN';
  }
  return null;
}

function secondsRemaining(tick) {
  return (Date.parse(tick.event_end) - Date.parse(tick.ts)) / 1000;
}

function eventFeatures(ticks, signalTs) {
  const signalMs = Date.parse(signalTs);
  const prior = ticks.filter((tick) => Date.parse(tick.ts) <= signalMs);
  const prices = prior.map((tick) => finiteOrNull(tick.btc_price)).filter((value) => value != null);
  const range = prices.length ? Math.max(...prices) - Math.min(...prices) : null;
  const last = prior.at(-1);
  const up = sideBook(last, 'UP');
  const down = sideBook(last, 'DOWN');
  return {
    btcRange: range,
    minPairedDepth: validTwoSided(up) && validTwoSided(down)
      ? Math.min(up.askSize, down.askSize, up.bidSize, down.bidSize)
      : null,
    combinedSpread: validTwoSided(up) && validTwoSided(down)
      ? up.ask - up.bid + down.ask - down.bid
      : null,
    absDistanceToPtb: last && finiteOrNull(last.btc_price) != null && finiteOrNull(last.price_to_beat) != null
      ? Math.abs(last.btc_price - last.price_to_beat)
      : null,
  };
}

function createAudit() {
  return {
    ticks: 0,
    events: 0,
    firstTs: null,
    lastTs: null,
    validUpAskBook: 0,
    validDownAskBook: 0,
    validUpBidBook: 0,
    validDownBidBook: 0,
    validBothAskBid: 0,
    theoreticalBuyPairUnder1: 0,
    feeNetBuyPairUnder1: 0,
    theoreticalSellPairOver1: 0,
    feeNetSellPairOver1: 0,
    theoreticalBuyEvents: new Set(),
    feeNetBuyEvents: new Set(),
    theoreticalSellEvents: new Set(),
    feeNetSellEvents: new Set(),
    askSumHistogram: new Map(),
    bidSumHistogram: new Map(),
    daily: new Map(),
    eventTickCounts: [],
    eventStartGaps: [],
    relevantGaps: [],
    previousEventStartMs: null,
  };
}

function auditTick(audit, tick) {
  audit.ticks += 1;
  audit.firstTs ??= tick.ts;
  audit.lastTs = tick.ts;
  const up = sideBook(tick, 'UP');
  const down = sideBook(tick, 'DOWN');
  if (validAsk(up)) audit.validUpAskBook += 1;
  if (validAsk(down)) audit.validDownAskBook += 1;
  if (validBid(up)) audit.validUpBidBook += 1;
  if (validBid(down)) audit.validDownBidBook += 1;
  if (validTwoSided(up) && validTwoSided(down)) {
    audit.validBothAskBid += 1;
    const askSum = up.ask + down.ask;
    const bidSum = up.bid + down.bid;
    histogramAdd(audit.askSumHistogram, askSum);
    histogramAdd(audit.bidSumHistogram, bidSum);
    const buyFee = calculateFee(1, up.ask, 0.07) + calculateFee(1, down.ask, 0.07);
    const sellFee = calculateFee(1, up.bid, 0.07) + calculateFee(1, down.bid, 0.07);
    if (askSum < 1 - EPS) {
      audit.theoreticalBuyPairUnder1 += 1;
      audit.theoreticalBuyEvents.add(tick.condition_id);
    }
    if (askSum + buyFee < 1 - EPS) {
      audit.feeNetBuyPairUnder1 += 1;
      audit.feeNetBuyEvents.add(tick.condition_id);
    }
    if (bidSum > 1 + EPS) {
      audit.theoreticalSellPairOver1 += 1;
      audit.theoreticalSellEvents.add(tick.condition_id);
    }
    if (bidSum - sellFee > 1 + EPS) {
      audit.feeNetSellPairOver1 += 1;
      audit.feeNetSellEvents.add(tick.condition_id);
    }
  }
  const day = tick.ts.slice(0, 10);
  if (!audit.daily.has(day)) {
    audit.daily.set(day, {
      day,
      ticks: 0,
      events: new Set(),
      firstTs: tick.ts,
      lastTs: tick.ts,
      bothValidTicks: 0,
    });
  }
  const daily = audit.daily.get(day);
  daily.ticks += 1;
  daily.events.add(tick.condition_id);
  daily.lastTs = tick.ts;
  if (validTwoSided(up) && validTwoSided(down)) daily.bothValidTicks += 1;
}

function auditEvent(audit, ticks) {
  audit.events += 1;
  audit.eventTickCounts.push(ticks.length);
  const startMs = Date.parse(ticks[0].event_start);
  if (audit.previousEventStartMs != null) {
    const gapSec = (startMs - audit.previousEventStartMs) / 1000;
    audit.eventStartGaps.push(gapSec);
    if (gapSec > 301) {
      audit.relevantGaps.push({
        previousEventStart: new Date(audit.previousEventStartMs).toISOString(),
        nextEventStart: new Date(startMs).toISOString(),
        gapSec,
      });
    }
  }
  audit.previousEventStartMs = startMs;
}

function finalizeAudit(audit) {
  return {
    ticks: audit.ticks,
    events: audit.events,
    firstTs: audit.firstTs,
    lastTs: audit.lastTs,
    validUpAskBookTicks: audit.validUpAskBook,
    validDownAskBookTicks: audit.validDownAskBook,
    validUpBidBookTicks: audit.validUpBidBook,
    validDownBidBookTicks: audit.validDownBidBook,
    bothSidesValidTicks: audit.validBothAskBid,
    bothSidesValidFrequency: ratio(audit.validBothAskBid, audit.ticks),
    askSumDistribution: histogramPercentiles(audit.askSumHistogram),
    bidSumDistribution: histogramPercentiles(audit.bidSumHistogram),
    theoreticalBuyPairUnder1Ticks: audit.theoreticalBuyPairUnder1,
    theoreticalBuyPairUnder1Events: audit.theoreticalBuyEvents.size,
    feeNetBuyPairUnder1Ticks: audit.feeNetBuyPairUnder1,
    feeNetBuyPairUnder1Events: audit.feeNetBuyEvents.size,
    theoreticalSellPairOver1Ticks: audit.theoreticalSellPairOver1,
    theoreticalSellPairOver1Events: audit.theoreticalSellEvents.size,
    feeNetSellPairOver1Ticks: audit.feeNetSellPairOver1,
    feeNetSellPairOver1Events: audit.feeNetSellEvents.size,
    ticksPerEvent: percentiles(audit.eventTickCounts),
    maxEventStartGapSec: audit.eventStartGaps.length ? Math.max(...audit.eventStartGaps) : null,
    relevantGaps: audit.relevantGaps,
    dailyCoverage: Array.from(audit.daily.values()).map((day) => ({
      day: day.day,
      ticks: day.ticks,
      events: day.events.size,
      firstTs: day.firstTs,
      lastTs: day.lastTs,
      bothValidTicks: day.bothValidTicks,
      bothValidFrequency: ratio(day.bothValidTicks, day.ticks),
    })),
  };
}

function summarize(records) {
  const entered = records.filter((record) => record?.entered);
  const pnls = entered.map((record) => record.pnlNet);
  const grossPnls = entered.map((record) => record.pnlGross);
  const wins = pnls.filter((value) => value > 0.005);
  const losses = pnls.filter((value) => value < -0.005);
  const grossProfit = wins.reduce(sum, 0);
  const grossLoss = Math.abs(losses.reduce(sum, 0));
  const totalPnl = pnls.reduce(sum, 0);
  const totalGrossPnl = grossPnls.reduce(sum, 0);
  const totalFees = entered.reduce((acc, record) => acc + record.fees, 0);
  const totalRebates = entered.reduce((acc, record) => acc + record.rebates, 0);
  const totalSlippage = entered.reduce((acc, record) => acc + record.slippage, 0);
  const risk = entered.reduce((acc, record) => acc + record.maxRiskPreEntry, 0);
  return {
    attempts: records.length,
    entries: entered.length,
    wins: wins.length,
    losses: losses.length,
    ties: entered.length - wins.length - losses.length,
    winRate: ratio(wins.length, entered.length),
    lossRate: ratio(losses.length, entered.length),
    tieRate: ratio(entered.length - wins.length - losses.length, entered.length),
    nearTieRate: ratio(entered.filter((record) => Math.abs(record.pnlNet) <= 0.05).length, entered.length),
    bothSettlementsNonNegativeRate: ratio(
      entered.filter((record) => record.resultIfUp >= -EPS && record.resultIfDown >= -EPS).length,
      entered.length,
    ),
    nearZeroWorstCaseRate: ratio(
      entered.filter((record) => record.worstCase >= -0.05).length,
      entered.length,
    ),
    outcomeNeutralRate: ratio(
      entered.filter((record) => Math.abs(record.resultIfUp - record.resultIfDown) <= 0.01).length,
      entered.length,
    ),
    lockRate: ratio(entered.filter((record) => record.locked).length, entered.length),
    freeRollRate: ratio(entered.filter((record) => record.freeRoll).length, entered.length),
    partialFillRate: ratio(entered.filter((record) => record.partialFill).length, entered.length),
    missRate: ratio(entered.reduce((acc, record) => acc + record.orderMisses, 0), entered.reduce((acc, record) => acc + record.orderAttempts, 0)),
    totalGrossPnl,
    totalFees,
    totalRebates,
    totalSlippage,
    totalPnl,
    expectancy: ratio(totalPnl, entered.length),
    expectancyPerDollarRisked: ratio(totalPnl, risk),
    profitFactor: grossLoss > EPS ? grossProfit / grossLoss : (grossProfit > EPS ? null : 0),
    maxLoss: pnls.length ? Math.min(...pnls) : 0,
    maxWin: pnls.length ? Math.max(...pnls) : 0,
    maxDrawdown: maxDrawdown(entered),
    avgCombinedCost: ratio(entered.reduce((acc, record) => acc + record.combinedCost, 0), entered.length),
    avgWorstCase: ratio(entered.reduce((acc, record) => acc + record.worstCase, 0), entered.length),
    avgBestCase: ratio(entered.reduce((acc, record) => acc + record.bestCase, 0), entered.length),
    maxRiskPreEntry: entered.length ? Math.max(...entered.map((record) => record.maxRiskPreEntry)) : 0,
    turnover: entered.reduce((acc, record) => acc + record.turnover, 0),
    feeDragPct: totalGrossPnl > EPS ? totalFees / totalGrossPnl : null,
    partialFillDeterioration: entered.reduce((acc, record) => acc + record.partialDeterioration, 0),
    concentratedWinnerShare: pnlConcentration(pnls),
  };
}

function summarizeBySplit(records, totalEvents, maxTs) {
  const trainEnd = Math.floor(totalEvents * 0.6);
  const validationEnd = Math.floor(totalEvents * 0.8);
  const maxMs = Date.parse(maxTs);
  const filterOrdinal = (min, max) => records.filter((record) => record.eventOrdinal >= min && record.eventOrdinal < max);
  return {
    full: summarize(records),
    train60: summarize(filterOrdinal(0, trainEnd)),
    validation20: summarize(filterOrdinal(trainEnd, validationEnd)),
    holdout20: summarize(filterOrdinal(validationEnd, totalEvents)),
    last72h: summarize(records.filter((record) => Date.parse(record.eventStart) >= maxMs - 72 * 3600_000)),
    last24h: summarize(records.filter((record) => Date.parse(record.eventStart) >= maxMs - 24 * 3600_000)),
  };
}

function groupDiagnostics(records) {
  const entered = records.filter((record) => record.entered);
  const withFeatures = entered.filter((record) => record.features);
  const volCuts = quantileCuts(withFeatures.map((record) => record.features.btcRange));
  const liqCuts = quantileCuts(withFeatures.map((record) => record.features.minPairedDepth));
  const groups = {
    byDay: groupSummaries(entered, (record) => record.eventStart.slice(0, 10)),
    byTimeRemaining: groupSummaries(entered, (record) => tauBucket(record.entryTauSec)),
    byVolatility: groupSummaries(withFeatures, (record) => regime(record.features.btcRange, volCuts)),
    byLiquidity: groupSummaries(withFeatures, (record) => regime(record.features.minPairedDepth, liqCuts)),
  };
  return groups;
}

function loadReferenceRunners(enabled) {
  if (!enabled) return new Map();
  const runners = new Map();
  for (const [id, relPath] of REFERENCE_RUNNERS) {
    const source = readFileSync(path.resolve(relPath), 'utf8');
    const factory = new Function(
      'params',
      `"use strict";\n${source}\nif (typeof createBacktestRunner !== "function") throw new Error("missing createBacktestRunner"); return createBacktestRunner(params);`,
    );
    runners.set(id, factory({}));
  }
  return runners;
}

function finalizeReferenceRunners(runners) {
  const results = {};
  for (const [id, runner] of runners) {
    const raw = runner.finish();
    const withFees = applyPolymarketFeesToBacktestResult(raw, {
      feeRate: 0.07,
      takerRebateRate: 0,
    });
    results[id] = {
      executionCaveat: 'legacy runner on actual recorded top level only; taker fees applied after runner finish',
      summary: withFees.summary,
      dailyPnl: dailyPnlFromReferenceEvents(withFees.events),
    };
  }
  return results;
}

function parseArgs(argv) {
  const args = {
    from: DEFAULT_FROM,
    to: null,
    mode: 'full',
    batchSize: 50_000,
    qty: 5,
    riskCapUsd: 5,
    feeScenario: null,
    feeOverride: null,
    makerFee: null,
    takerFee: null,
    rebateRate: null,
    maxEvents: null,
    output: null,
    compareReferences: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inline ?? argv[++index];
    if (['batchSize', 'qty', 'riskCapUsd', 'feeOverride', 'makerFee', 'takerFee', 'rebateRate', 'maxEvents'].includes(key)) {
      args[key] = value == null ? null : Number(value);
    } else if (key === 'compareReferences') {
      args.compareReferences = value !== 'false';
    } else {
      args[key] = value;
    }
  }
  if (!['quick', 'research', 'full'].includes(args.mode)) {
    throw new Error(`Invalid mode: ${args.mode}`);
  }
  return args;
}

function resolveScenarios(args) {
  const ids = args.feeScenario
    ? [args.feeScenario]
    : (args.mode === 'full' ? ['optimistic', 'base', 'pessimistic'] : ['base']);
  return ids.map((id) => {
    const base = EXECUTION_SCENARIOS[id];
    if (!base) throw new Error(`Invalid fee scenario: ${id}`);
    const feeOverride = finiteOrNull(args.feeOverride);
    return {
      ...base,
      makerFeeRate: finiteOrNull(args.makerFee) ?? feeOverride ?? base.makerFeeRate,
      takerFeeRate: finiteOrNull(args.takerFee) ?? feeOverride ?? base.takerFeeRate,
      takerRebateRate: finiteOrNull(args.rebateRate) ?? base.takerRebateRate,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = await getBacktestRange(args.from);
  const to = args.to ? new Date(args.to).toISOString() : range.lastTs;
  const from = new Date(args.from).toISOString();
  const scenarios = resolveScenarios(args);
  const quickLimit = args.mode === 'quick' ? 500 : null;
  const maxEvents = args.maxEvents ?? quickLimit;
  const compareReferences = args.compareReferences ?? args.mode === 'full';
  const references = loadReferenceRunners(compareReferences);
  const audit = createAudit();
  const attempts = [];
  const baselineAttempts = [];
  const eventStarts = [];
  let ticksProcessed = 0;
  let eventOrdinal = 0;
  let currentEventId = null;
  let eventTicks = [];

  const processEvent = (ticks) => {
    if (!ticks.length) return;
    auditEvent(audit, ticks);
    eventStarts.push(ticks[0].event_start);
    const featureCache = new Map();
    const attach = (record) => attachEventContext(record, ticks, eventOrdinal, featureCache);
    for (const scenario of scenarios) {
      for (const variant of IMMEDIATE_VARIANTS) {
        const record = variant.family === 'net-complete-set'
          ? simulateNetCompleteSet(ticks, variant, scenario, args)
          : simulateSplitSell(ticks, variant, scenario, args);
        if (record) attempts.push(attach(record));
      }
      for (const variant of TEMPORAL_VARIANTS) {
        const record = simulateExpansionLock(ticks, variant, scenario, args);
        if (record) attempts.push(attach(record));
      }
      for (const variant of PASSIVE_VARIANTS) {
        const record = simulatePassivePair(ticks, variant, scenario, args);
        if (record) attempts.push(attach(record));
      }
    }
    if (scenarios.some((scenario) => scenario.id === 'base')) {
      const base = scenarios.find((scenario) => scenario.id === 'base');
      for (const id of [
        'baseline-up-only',
        'baseline-down-only',
        'baseline-random-side',
        'baseline-random-dual',
      ]) {
        const record = simulateBaseline(ticks, id, base, args);
        if (record) baselineAttempts.push(attach(record));
      }
    }
    eventOrdinal += 1;
  };

  try {
    outer:
    for await (const batch of getTicksForBacktestBatches(from, to, {
      batchSize: args.batchSize,
      bookMode: 'top',
    })) {
      for (const tick of batch) {
        if (currentEventId != null && tick.condition_id !== currentEventId) {
          processEvent(eventTicks);
          eventTicks = [];
          if (maxEvents != null && eventOrdinal >= maxEvents) break outer;
        }
        auditTick(audit, tick);
        ticksProcessed += 1;
        for (const runner of references.values()) runner.processTick(tick);
        currentEventId = tick.condition_id;
        eventTicks.push(tick);
      }
      if (ticksProcessed % 500_000 < batch.length) {
        console.error(`[paired-liquidity] ticks=${ticksProcessed} events=${eventOrdinal}`);
      }
    }
    if (eventTicks.length && (maxEvents == null || eventOrdinal < maxEvents)) processEvent(eventTicks);

    const auditResult = finalizeAudit(audit);
    const evaluations = {};
    for (const scenario of scenarios) {
      evaluations[scenario.id] = {};
      for (const variant of ALL_VARIANTS) {
        const records = attempts.filter((record) => record.scenario === scenario.id && record.strategyId === variant.id);
        evaluations[scenario.id][variant.id] = summarizeBySplit(records, eventOrdinal, auditResult.lastTs);
      }
    }
    const baselines = {};
    for (const id of ['baseline-up-only', 'baseline-down-only', 'baseline-random-side', 'baseline-random-dual']) {
      baselines[id] = summarizeBySplit(
        baselineAttempts.filter((record) => record.strategyId === id),
        eventOrdinal,
        auditResult.lastTs,
      );
    }
    const selectedScenarioId = evaluations.base ? 'base' : scenarios[0].id;
    const selection = selectVariant(evaluations[selectedScenarioId]);
    const selectedRecords = attempts.filter(
      (record) => record.scenario === selectedScenarioId && record.strategyId === selection.variantId,
    );
    const referenceResults = finalizeReferenceRunners(references);
    const selectedDaily = dailyPnlFromRecords(selectedRecords);
    const correlations = Object.fromEntries(
      Object.entries(referenceResults).map(([id, result]) => [
        id,
        correlationOnKeys(selectedDaily, result.dailyPnl),
      ]),
    );
    const criteria = evaluateInterestCriteria(
      evaluations[selectedScenarioId][selection.variantId],
    );
    const immediateVariantIds = new Set(['net-complete-set', 'split-sell-inversion']);
    const reportLedger = attempts.filter(
      (record) =>
        record.entered &&
        (
          (record.scenario === selectedScenarioId && record.strategyId === selection.variantId) ||
          immediateVariantIds.has(record.strategyId)
        ),
    );
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      experiment: 'Paired Liquidity Reconstitution V1',
      status: criteria.interesting ? 'RESEARCH_CANDIDATE_NOT_LIVE' : 'REJECTED_NO_DUAL_SIDE_EDGE',
      scope: {
        from,
        to,
        mode: args.mode,
        batchSize: args.batchSize,
        qty: args.qty,
        riskCapUsd: args.riskCapUsd,
        localRange: range,
        winnerProxyCaveat: 'Directional baselines use last local BTC >= PTB; dual-side counterfactuals do not depend on this proxy.',
      },
      feeModel: {
        officialSource: OFFICIAL_FEE_SOURCE,
        formula: 'shares * feeRate * price * (1 - price)',
        officialCryptoTakerRate: 0.07,
        officialMakerFeeRate: 0,
        roundingDecimals: 5,
        scenarios,
        rebateCaveat: 'Optimistic taker rebate is a configurable research overlay, never assumed by the base case.',
      },
      hypotheses: HYPOTHESES,
      dataAudit: auditResult,
      selection,
      criteria,
      evaluations,
      baselines,
      references: referenceResults,
      dailyCurveCorrelations: correlations,
      selectedDiagnostics: groupDiagnostics(selectedRecords),
      ledgerCoverage: {
        selectedScenarioId,
        selectedVariantId: selection.variantId,
        selectedEnteredRecords: selectedRecords.filter((record) => record.entered).length,
        immediateVariants: [...immediateVariantIds],
        note: 'Detailed ledgers retain the selected base variant and every entered immediate-arbitrage attempt. Aggregate metrics for every scenario and variant remain in evaluations.',
      },
      ledger: reportLedger,
      missedAttemptSample: attempts.filter((record) => !record.entered).slice(0, 100),
    };

    const output = resolveOutputPath(args.output);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output,
      status: report.status,
      range: report.scope,
      dataAudit: {
        ticks: auditResult.ticks,
        events: auditResult.events,
        firstTs: auditResult.firstTs,
        lastTs: auditResult.lastTs,
        bothSidesValidTicks: auditResult.bothSidesValidTicks,
        feeNetBuyPairUnder1Ticks: auditResult.feeNetBuyPairUnder1Ticks,
        feeNetSellPairOver1Ticks: auditResult.feeNetSellPairOver1Ticks,
      },
      selection,
      criteria,
      selected: compactSplitEvaluation(evaluations[selectedScenarioId][selection.variantId]),
      baselines: Object.fromEntries(Object.entries(baselines).map(([id, value]) => [id, compactSummary(value.full)])),
      references: Object.fromEntries(Object.entries(referenceResults).map(([id, value]) => [id, compactReferenceSummary(value.summary)])),
    }, null, 2));
  } finally {
    await closeDatabasePool();
  }
}

function attachEventContext(record, ticks, ordinal, cache = new Map()) {
  let features = cache.get(record.signalTs);
  if (!features) {
    features = eventFeatures(ticks, record.signalTs);
    cache.set(record.signalTs, features);
  }
  return {
    ...record,
    eventOrdinal: ordinal,
    features,
  };
}

function selectVariant(baseEvaluations) {
  const candidates = [...TEMPORAL_VARIANTS, ...PASSIVE_VARIANTS].map((variant) => {
    const evaluation = baseEvaluations?.[variant.id];
    const train = evaluation?.train60 ?? {};
    const validation = evaluation?.validation20 ?? {};
    const hasEvidence = (train.entries ?? 0) >= 10 && (validation.entries ?? 0) >= 5;
    const score = hasEvidence
      ? (validation.expectancyPerDollarRisked ?? -Infinity)
        - Math.max(0, -(train.expectancyPerDollarRisked ?? 0))
        - 0.5 * (validation.concentratedWinnerShare ?? 1)
      : -1000 + (train.entries ?? 0) + (validation.entries ?? 0) / 1000;
    return {
      variantId: variant.id,
      family: variant.family,
      score,
      trainNetPnl: train.totalPnl ?? 0,
      validationNetPnl: validation.totalPnl ?? 0,
      validationWorstCase: validation.avgWorstCase ?? null,
      entries: validation.entries ?? 0,
      hasEvidence,
    };
  }).sort((left, right) => right.score - left.score);
  const chosen = candidates[0] ?? {
    variantId: 'maker-pair-medium',
    family: 'paired-maker-reconstitution',
    score: null,
  };
  return {
    ...chosen,
    rule: 'rank frozen variants on train plus validation risk-adjusted expectancy; holdout is not used for selection',
    ranking: candidates,
  };
}

function evaluateInterestCriteria(evaluation) {
  const holdout = evaluation?.holdout20 ?? {};
  const last72 = evaluation?.last72h ?? {};
  const last24 = evaluation?.last24h ?? {};
  const checks = {
    holdoutNetPositive: (holdout.totalPnl ?? 0) > 0,
    holdoutProfitFactorAbove2: (holdout.profitFactor ?? 0) > 2,
    holdoutControlledWorstCase: (holdout.avgWorstCase ?? -Infinity) >= -0.05,
    holdoutOutcomeNeutral: (holdout.outcomeNeutralRate ?? 0) >= 0.95,
    notOneTradeDependent: (holdout.concentratedWinnerShare ?? 1) <= 0.5,
    last72hPositive: (last72.totalPnl ?? 0) > 0,
    last24hAcceptable: (last24.totalPnl ?? 0) >= -0.05,
    partialRobust: (holdout.partialFillRate ?? 1) < 0.5 || (holdout.totalPnl ?? 0) > 0,
  };
  return {
    checks,
    interesting: Object.values(checks).every(Boolean),
  };
}

function resolveOutputPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve('reports', 'paired-liquidity-reconstitution-v1', `${stamp}.json`);
}

function histogramAdd(histogram, value) {
  const key = Math.round(value * 1000) / 1000;
  histogram.set(key, (histogram.get(key) ?? 0) + 1);
}

function histogramPercentiles(histogram) {
  const entries = Array.from(histogram.entries()).sort((left, right) => left[0] - right[0]);
  const total = entries.reduce((acc, [, count]) => acc + count, 0);
  const probs = [0, 0.001, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 0.999, 1];
  return Object.fromEntries(probs.map((prob) => {
    const target = Math.max(1, Math.ceil(total * prob));
    let cumulative = 0;
    for (const [value, count] of entries) {
      cumulative += count;
      if (cumulative >= target) return [String(prob), value];
    }
    return [String(prob), entries.at(-1)?.[0] ?? null];
  }));
}

function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const probs = [0, 0.01, 0.05, 0.5, 0.95, 0.99, 1];
  return Object.fromEntries(probs.map((prob) => [String(prob), quantile(sorted, prob)]));
}

function quantileCuts(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return [quantile(sorted, 1 / 3), quantile(sorted, 2 / 3)];
}

function quantile(sorted, prob) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * prob;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function regime(value, cuts) {
  if (!Number.isFinite(value) || !Number.isFinite(cuts[0]) || !Number.isFinite(cuts[1])) return 'unknown';
  if (value <= cuts[0]) return 'low';
  if (value <= cuts[1]) return 'medium';
  return 'high';
}

function tauBucket(tau) {
  if (tau <= 30) return '0-30s';
  if (tau <= 60) return '31-60s';
  if (tau <= 120) return '61-120s';
  if (tau <= 180) return '121-180s';
  return '181-300s';
}

function groupSummaries(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return Object.fromEntries(Array.from(groups.entries()).map(([key, group]) => [key, summarize(group)]));
}

function dailyPnlFromRecords(records) {
  const result = {};
  for (const record of records.filter((item) => item.entered)) {
    const day = record.eventStart.slice(0, 10);
    result[day] = (result[day] ?? 0) + record.pnlNet;
  }
  return result;
}

function dailyPnlFromReferenceEvents(events) {
  const result = {};
  for (const event of events ?? []) {
    if (event?.reason === 'no_entry') continue;
    const ts = event.eventStart ?? event.entryTime ?? event.closedAt;
    const pnl = finiteOrNull(event.finalPnl);
    if (!ts || pnl == null) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    result[day] = (result[day] ?? 0) + pnl;
  }
  return result;
}

function correlationOnKeys(left, right) {
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
  if (keys.length < 2) return null;
  const xs = keys.map((key) => left[key] ?? 0);
  const ys = keys.map((key) => right[key] ?? 0);
  const mx = xs.reduce(sum, 0) / xs.length;
  const my = ys.reduce(sum, 0) / ys.length;
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index] - mx;
    const dy = ys[index] - my;
    covariance += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return vx > EPS && vy > EPS ? covariance / Math.sqrt(vx * vy) : null;
}

function compactSplitEvaluation(evaluation) {
  return Object.fromEntries(
    Object.entries(evaluation ?? {}).map(([key, value]) => [key, compactSummary(value)]),
  );
}

function compactSummary(summary) {
  if (!summary) return null;
  return {
    attempts: summary.attempts,
    entries: summary.entries,
    totalPnl: summary.totalPnl,
    expectancy: summary.expectancy,
    profitFactor: summary.profitFactor,
    winRate: summary.winRate,
    tieRate: summary.tieRate,
    lossRate: summary.lossRate,
    bothSettlementsNonNegativeRate: summary.bothSettlementsNonNegativeRate,
    nearZeroWorstCaseRate: summary.nearZeroWorstCaseRate,
    outcomeNeutralRate: summary.outcomeNeutralRate,
    lockRate: summary.lockRate,
    freeRollRate: summary.freeRollRate,
    partialFillRate: summary.partialFillRate,
    totalFees: summary.totalFees,
    totalSlippage: summary.totalSlippage,
    maxLoss: summary.maxLoss,
    maxDrawdown: summary.maxDrawdown,
  };
}

function compactReferenceSummary(summary) {
  if (!summary) return null;
  return {
    entries: summary.totalEntries ?? summary.entries ?? 0,
    totalPnl: summary.totalPnl ?? summary.pnl ?? 0,
    profitFactor: summary.profitFactor ?? 0,
    winRate: summary.winRate ?? 0,
    maxLoss: summary.maxLoss ?? 0,
    maxDrawdown: summary.maxDrawdown ?? 0,
    fees: summary.totalFees ?? summary.feesPaid ?? summary.fees?.totalFee ?? 0,
  };
}

function maxDrawdown(records) {
  const sorted = [...records].sort((left, right) => Date.parse(left.eventStart) - Date.parse(right.eventStart));
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const record of sorted) {
    equity += record.pnlNet;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function pnlConcentration(pnls) {
  const positives = pnls.filter((value) => value > 0).sort((a, b) => b - a);
  const total = positives.reduce(sum, 0);
  return total > EPS ? positives[0] / total : 1;
}

function sum(acc, value) {
  return acc + value;
}

function ratio(numerator, denominator) {
  return denominator > EPS ? numerator / denominator : 0;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round5(value) {
  return Math.round((value + Number.EPSILON) * 100_000) / 100_000;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(async (error) => {
    console.error(error?.stack || error);
    try {
      await closeDatabasePool();
    } catch {
      // Best effort shutdown.
    }
    process.exitCode = 1;
  });
}
