/**
 * Escada Adaptativa Hibrida V1 — research runner.
 *
 * Buy-only, maker-first e risk-first:
 * - abre um residual pequeno somente quando o valor justo indica edge;
 * - procura a perna oposta para melhorar o pior PnL do evento;
 * - so libera um novo degrau direcional depois da protecao;
 * - taker e permitido apenas para completar um par com lucro protegido.
 *
 * O runner e autocontido para empacotamento em strategy-library.
 */

const DEFAULT_PARAMS = {
  walletSize: 1000,
  riskPerEventPct: 0.0025,
  minShares: 5,
  tickSize: 0.01,
  maxGrossExposurePct: 0.025,
  maxCycles: 3,
  entryWindowStartSec: 240,
  entryWindowEndSec: 60,
  hedgeCutoffSec: 10,
  minEdge: 0.06,
  cancelEdge: 0.03,
  minDirectionalProbability: 0.57,
  maxSpread: 0.05,
  cancelSpread: 0.07,
  rungEdgeStep: 0.02,
  hedgeMinWorstImprovementUsd: 0.05,
  hedgeMinProtectedProfitUsd: 0.02,
  makerTimeoutSec: 20,
  makerFillMode: 'strict_cross', // strict_cross | adverse_entry_touch
  cancelLatencyTicks: 1,
  takerLatencyTicks: 1,
  requireQuality: true,
  minCoverage: 0.99,
  minTicksBeforeEntry: 8,
  shockSigma: 2.5,
  minSigma: 8,
  sigmaMultiplier: 1,
  modelWeight: 0.66,
  driftWeight: 0.42,
  driftClampSigma: 0.9,
  accelerationWeight: 0.28,
  bookImbalanceWeight: 0.20,
  momentumSec: 7,
  slowMomentumSec: 26,
  slowMomentumWeight: 0.28,
  volLookbackSec: 55,
  applyPolymarketFees: true,
  polymarketFeeCategory: 'crypto',
  polymarketFeeRate: 0.07,
};

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, decimals = 8) {
  const scale = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function roundFee(value) {
  return roundTo(value, 5);
}

function roundDownToTick(value, tickSize) {
  const ticks = Math.floor((Number(value) + 1e-10) / tickSize);
  return roundTo(ticks * tickSize, 8);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + (0.3275911 * x));
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function mergeEscadaAdaptativaParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'riskPerEventPct', 'minShares', 'tickSize', 'maxGrossExposurePct',
    'maxCycles', 'entryWindowStartSec', 'entryWindowEndSec', 'hedgeCutoffSec',
    'minEdge', 'cancelEdge', 'minDirectionalProbability', 'maxSpread', 'cancelSpread',
    'rungEdgeStep', 'hedgeMinWorstImprovementUsd', 'hedgeMinProtectedProfitUsd',
    'makerTimeoutSec', 'cancelLatencyTicks', 'takerLatencyTicks', 'minCoverage',
    'minTicksBeforeEntry', 'shockSigma', 'minSigma', 'sigmaMultiplier', 'modelWeight',
    'driftWeight', 'driftClampSigma', 'accelerationWeight', 'bookImbalanceWeight',
    'momentumSec', 'slowMomentumSec', 'slowMomentumWeight', 'volLookbackSec',
    'polymarketFeeRate',
  ];
  for (const key of numericKeys) {
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.walletSize = Math.max(1, params.walletSize);
  params.riskPerEventPct = clamp(params.riskPerEventPct, 0.0001, 0.25);
  params.minShares = Math.max(0.000001, params.minShares);
  params.tickSize = clamp(params.tickSize, 0.0001, 0.1);
  params.maxGrossExposurePct = clamp(params.maxGrossExposurePct, params.riskPerEventPct, 1);
  params.maxCycles = Math.max(1, Math.floor(params.maxCycles));
  params.entryWindowStartSec = clamp(params.entryWindowStartSec, 0, 300);
  params.entryWindowEndSec = clamp(params.entryWindowEndSec, 0, 300);
  if (params.entryWindowStartSec < params.entryWindowEndSec) {
    [params.entryWindowStartSec, params.entryWindowEndSec] = [params.entryWindowEndSec, params.entryWindowStartSec];
  }
  params.hedgeCutoffSec = clamp(params.hedgeCutoffSec, 0, params.entryWindowStartSec);
  params.minEdge = clamp(params.minEdge, 0, 0.50);
  params.cancelEdge = clamp(params.cancelEdge, -0.50, params.minEdge);
  params.minDirectionalProbability = clamp(params.minDirectionalProbability, 0.50, 0.999);
  params.maxSpread = clamp(params.maxSpread, params.tickSize, 0.99);
  params.cancelSpread = clamp(params.cancelSpread, params.maxSpread, 0.99);
  params.rungEdgeStep = clamp(params.rungEdgeStep, 0, 0.25);
  params.hedgeMinWorstImprovementUsd = Math.max(0, params.hedgeMinWorstImprovementUsd);
  params.hedgeMinProtectedProfitUsd = Math.max(0, params.hedgeMinProtectedProfitUsd);
  params.makerTimeoutSec = clamp(params.makerTimeoutSec, 1, 120);
  params.cancelLatencyTicks = clamp(Math.floor(params.cancelLatencyTicks), 0, 10);
  params.takerLatencyTicks = clamp(Math.floor(params.takerLatencyTicks), 0, 10);
  params.minCoverage = clamp(params.minCoverage, 0, 1);
  params.minTicksBeforeEntry = Math.max(1, Math.floor(params.minTicksBeforeEntry));
  params.shockSigma = clamp(params.shockSigma, 0.25, 10);
  params.minSigma = Math.max(0.01, params.minSigma);
  params.sigmaMultiplier = clamp(params.sigmaMultiplier, 0.1, 5);
  params.modelWeight = clamp(params.modelWeight, 0, 1);
  params.driftWeight = clamp(params.driftWeight, -3, 3);
  params.driftClampSigma = clamp(params.driftClampSigma, 0, 4);
  params.accelerationWeight = clamp(params.accelerationWeight, -4, 4);
  params.bookImbalanceWeight = clamp(params.bookImbalanceWeight, -3, 3);
  params.momentumSec = clamp(params.momentumSec, 1, 90);
  params.slowMomentumSec = clamp(params.slowMomentumSec, params.momentumSec, 180);
  params.slowMomentumWeight = clamp(params.slowMomentumWeight, -3, 3);
  params.volLookbackSec = clamp(params.volLookbackSec, 5, 180);
  params.polymarketFeeRate = Math.max(0, params.polymarketFeeRate);
  params.requireQuality = toBool(raw.requireQuality, params.requireQuality);
  params.applyPolymarketFees = toBool(raw.applyPolymarketFees, params.applyPolymarketFees);
  params.polymarketFeeCategory = String(raw.polymarketFeeCategory || params.polymarketFeeCategory);
  const fillMode = String(raw.makerFillMode || params.makerFillMode).trim().toLowerCase();
  params.makerFillMode = fillMode === 'adverse_entry_touch' ? fillMode : 'strict_cross';
  params.maxRiskUsd = params.walletSize * params.riskPerEventPct;
  params.maxGrossExposureUsd = params.walletSize * params.maxGrossExposurePct;
  return params;
}

function parseBookLevels(rawLevels, direction = 'ask') {
  let levels = rawLevels;
  if (typeof rawLevels === 'string') {
    try {
      levels = JSON.parse(rawLevels);
    } catch {
      levels = [];
    }
  }
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => ({
      price: toFiniteNumber(level?.price),
      size: toFiniteNumber(level?.size),
    }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.price < 1 && level.size > 0)
    .sort((left, right) => (direction === 'bid' ? right.price - left.price : left.price - right.price));
}

function sideFields(tick, side) {
  if (side === 'UP') {
    const fallback = toFiniteNumber(tick.up_price);
    return {
      ask: toFiniteNumber(tick.up_best_ask, fallback),
      bid: toFiniteNumber(tick.up_best_bid, fallback),
      rawAsks: tick.up_book_asks,
      rawBids: tick.up_book_bids,
      price: fallback,
    };
  }
  const fallback = toFiniteNumber(tick.down_price);
  return {
    ask: toFiniteNumber(tick.down_best_ask, fallback),
    bid: toFiniteNumber(tick.down_best_bid, fallback),
    rawAsks: tick.down_book_asks,
    rawBids: tick.down_book_bids,
    price: fallback,
  };
}

function sideMid(fields) {
  if (fields.ask != null && fields.bid != null) return (fields.ask + fields.bid) / 2;
  return fields.ask ?? fields.bid ?? fields.price ?? null;
}

function marketProbUp(tick) {
  const upMid = sideMid(sideFields(tick, 'UP'));
  const downMid = sideMid(sideFields(tick, 'DOWN'));
  if (upMid == null || downMid == null || upMid + downMid <= 0) return 0.5;
  return clamp(upMid / (upMid + downMid), 0.001, 0.999);
}

function eventKey(tickOrState) {
  const eventStart = tickOrState.event_start ?? tickOrState.eventStart;
  return `${new Date(eventStart).toISOString()}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function oppositeSide(side) {
  return side === 'UP' ? 'DOWN' : 'UP';
}

function calculateTakerFee(shares, price, feeRate) {
  const qty = Math.max(0, toFiniteNumber(shares, 0));
  const p = clamp(toFiniteNumber(price, 0), 0, 1);
  return roundFee(qty * Math.max(0, feeRate) * p * (1 - p));
}

function walkBookAsks(rawAsks, qty, fallbackAsk, maxPrice = 0.999) {
  let levels = parseBookLevels(rawAsks, 'ask');
  if (!levels.length && fallbackAsk != null) {
    levels = [{ price: fallbackAsk, size: qty }];
  }
  let remaining = qty;
  let cost = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 1e-9) break;
    if (level.price > maxPrice + 1e-9) break;
    const fillQty = Math.min(remaining, level.size);
    if (fillQty <= 0) continue;
    fills.push({ price: level.price, qty: fillQty });
    cost += fillQty * level.price;
    remaining -= fillQty;
  }
  const filledQty = qty - remaining;
  return {
    full: remaining <= 1e-9,
    requestedQty: qty,
    filledQty,
    cost,
    avgPrice: filledQty > 0 ? cost / filledQty : null,
    maxPrice: fills.length ? Math.max(...fills.map((fill) => fill.price)) : null,
    fills,
  };
}

function riskSnapshot({ shares, cost, estimatedFees = 0 }) {
  const totalCost = Math.max(0, toFiniteNumber(cost, 0));
  const fees = Math.max(0, toFiniteNumber(estimatedFees, 0));
  const pnlIfUp = toFiniteNumber(shares?.UP, 0) - totalCost - fees;
  const pnlIfDown = toFiniteNumber(shares?.DOWN, 0) - totalCost - fees;
  return {
    pnlIfUp,
    pnlIfDown,
    worstPnl: Math.min(pnlIfUp, pnlIfDown),
    bestPnl: Math.max(pnlIfUp, pnlIfDown),
    totalCost,
    estimatedFees: fees,
  };
}

function simulateBuy(state, side, fills, liquidity, params) {
  const normalizedFills = Array.isArray(fills) ? fills : [];
  const qty = normalizedFills.reduce((sum, fill) => sum + Math.max(0, toFiniteNumber(fill.qty, 0)), 0);
  const addCost = normalizedFills.reduce(
    (sum, fill) => sum + (Math.max(0, toFiniteNumber(fill.qty, 0)) * clamp(toFiniteNumber(fill.price, 0), 0, 1)),
    0,
  );
  const addFees = liquidity === 'taker'
    ? normalizedFills.reduce(
      (sum, fill) => sum + calculateTakerFee(fill.qty, fill.price, params.polymarketFeeRate),
      0,
    )
    : 0;
  const nextShares = {
    UP: state.shares.UP + (side === 'UP' ? qty : 0),
    DOWN: state.shares.DOWN + (side === 'DOWN' ? qty : 0),
  };
  const nextCost = state.cost + addCost;
  const nextFees = state.estimatedFees + addFees;
  const risk = riskSnapshot({ shares: nextShares, cost: nextCost, estimatedFees: nextFees });
  return {
    qty,
    addCost,
    addFees,
    shares: nextShares,
    cost: nextCost,
    estimatedFees: nextFees,
    risk,
    grossExposure: nextCost,
    allowed: qty >= params.minShares - 1e-9
      && risk.worstPnl >= -params.maxRiskUsd - 1e-9
      && nextCost <= params.maxGrossExposureUsd + 1e-9,
  };
}

function sampleAgo(samples, seconds) {
  if (!samples.length) return null;
  const latest = samples[samples.length - 1];
  const targetMs = latest.timeMs - (seconds * 1000);
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].timeMs <= targetMs) return samples[index];
  }
  return samples[0];
}

function recentVol(samples, lookbackSec) {
  if (samples.length < 3) return 0;
  const latest = samples[samples.length - 1];
  const recent = samples.filter(
    (sample) => sample.btc != null && latest.timeMs - sample.timeMs <= lookbackSec * 1000,
  );
  const changes = [];
  for (let index = 1; index < recent.length; index += 1) {
    const dtSec = Math.max(0.25, (recent[index].timeMs - recent[index - 1].timeMs) / 1000);
    changes.push((recent[index].btc - recent[index - 1].btc) / Math.sqrt(dtSec));
  }
  return std(changes);
}

function bookImbalance(tick) {
  const up = sideFields(tick, 'UP');
  const down = sideFields(tick, 'DOWN');
  const upSpread = up.ask != null && up.bid != null ? up.ask - up.bid : 0;
  const downSpread = down.ask != null && down.bid != null ? down.ask - down.bid : 0;
  const spreadTilt = clamp((downSpread - upSpread) * 3, -0.20, 0.20);
  const marketTilt = marketProbUp(tick) - 0.5;
  return clamp((marketTilt * 0.35) + spreadTilt, -0.35, 0.35);
}

function modelProbability(state, tick, params) {
  const samples = state.samples;
  const latest = samples[samples.length - 1];
  const btcPrice = toFiniteNumber(tick.btc_price ?? tick.underlying_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null || !latest) {
    return {
      pUp: 0.5,
      pStat: 0.5,
      pMarket: marketProbUp(tick),
      sigma: params.minSigma,
      distance: 0,
      drift: 0,
      acceleration: 0,
      imbalance: 0,
      shock: false,
    };
  }

  const timeRemainingSec = Math.max(1, (state.eventEndMs - new Date(tick.ts).getTime()) / 1000);
  const fastSample = sampleAgo(samples, params.momentumSec) || latest;
  const slowSample = sampleAgo(samples, params.slowMomentumSec) || fastSample;
  const fastSec = Math.max(1, (latest.timeMs - fastSample.timeMs) / 1000);
  const slowSec = Math.max(fastSec, (latest.timeMs - slowSample.timeMs) / 1000);
  const fastMove = btcPrice - (fastSample?.btc ?? btcPrice);
  const slowMove = btcPrice - (slowSample?.btc ?? btcPrice);
  const fastDrift = fastMove / fastSec;
  const slowDrift = slowMove / slowSec;
  const acceleration = fastDrift - slowDrift;
  const drift = fastDrift
    + (params.slowMomentumWeight * slowDrift)
    + (params.accelerationWeight * acceleration);
  const volPerSec = recentVol(samples, params.volLookbackSec);
  const sigma = Math.max(
    params.minSigma,
    volPerSec * Math.sqrt(timeRemainingSec) * params.sigmaMultiplier,
  );
  const driftContribution = clamp(
    drift * timeRemainingSec * params.driftWeight,
    -sigma * params.driftClampSigma,
    sigma * params.driftClampSigma,
  );
  const distance = btcPrice - priceToBeat;
  const pStat = normalCdf((distance + driftContribution) / sigma);
  const pMarket = marketProbUp(tick);
  const imbalance = bookImbalance(tick);
  const pWithBook = clamp(pStat + (params.bookImbalanceWeight * imbalance), 0.001, 0.999);
  const pUp = clamp(
    (params.modelWeight * pWithBook) + ((1 - params.modelWeight) * pMarket),
    0.001,
    0.999,
  );
  const shockScale = Math.max(params.minSigma, volPerSec * Math.sqrt(Math.max(1, params.momentumSec)));
  const shock = Math.abs(fastMove) > params.shockSigma * shockScale;
  return {
    pUp,
    pStat,
    pMarket,
    sigma,
    distance,
    drift,
    acceleration,
    imbalance,
    volPerSec,
    shock,
  };
}

function shouldFillMaker(order, prevAsk, currAsk, params) {
  if (!order || prevAsk == null || currAsk == null) return false;
  if (order.purpose === 'directional' && params.makerFillMode === 'adverse_entry_touch') {
    return currAsk <= order.price + 1e-9;
  }
  return prevAsk >= order.price - 1e-9
    && currAsk <= order.price - params.tickSize + 1e-9;
}

function qualityOk(tick, params) {
  if (!params.requireQuality) return true;
  if (tick.degraded === true || tick.degraded === 1 || tick.degraded === 'true') return false;
  const coverage = toFiniteNumber(tick.coverage);
  if (coverage == null || coverage < params.minCoverage) return false;
  const btc = toFiniteNumber(tick.btc_price ?? tick.underlying_price);
  const ptb = toFiniteNumber(tick.price_to_beat);
  return btc != null && ptb != null;
}

function createEventState(tick) {
  const eventStartMs = new Date(tick.event_start).getTime();
  const explicitEndMs = tick.event_end ? new Date(tick.event_end).getTime() : null;
  return {
    eventId: tick.condition_id,
    eventStart: new Date(eventStartMs).toISOString(),
    eventEndMs: Number.isFinite(explicitEndMs) ? explicitEndMs : eventStartMs + 300000,
    priceToBeat: toFiniteNumber(tick.price_to_beat),
    lastTick: tick,
    tickIndex: 0,
    samples: [],
    shares: { UP: 0, DOWN: 0 },
    cost: 0,
    estimatedFees: 0,
    makerOrder: null,
    pendingTaker: null,
    fills: [],
    orders: [],
    orderAttempts: [],
    cycles: 0,
    protectedCycles: 0,
    minWorstPnl: 0,
    maxGrossExposure: 0,
    model: null,
    stats: {
      makerPlaced: 0,
      makerFilled: 0,
      makerCancelled: 0,
      makerTimeouts: 0,
      takerScheduled: 0,
      takerFilled: 0,
      takerMisses: 0,
      riskRejected: 0,
      qualityRejected: 0,
      signalRejected: 0,
    },
  };
}

function addSample(state, tick) {
  const timeMs = new Date(tick.ts).getTime();
  state.samples.push({
    timeMs,
    btc: toFiniteNumber(tick.btc_price ?? tick.underlying_price),
  });
  while (state.samples.length > 1 && timeMs - state.samples[0].timeMs > 180000) {
    state.samples.shift();
  }
}

function updateMarkouts(state, tick) {
  const nowMs = new Date(tick.ts).getTime();
  for (const fill of state.fills) {
    if (!fill.markouts) fill.markouts = {};
    for (const seconds of [1, 3, 5]) {
      if (fill.markouts[String(seconds)] != null) continue;
      if (nowMs - fill.timeMs < seconds * 1000) continue;
      const mid = sideMid(sideFields(tick, fill.side));
      fill.markouts[String(seconds)] = mid == null ? null : roundTo(mid - fill.price, 8);
    }
  }
}

function sideProbability(model, side) {
  return side === 'UP' ? model.pUp : 1 - model.pUp;
}

function fillState(state, {
  side,
  fills,
  liquidity,
  purpose,
  ts,
  model,
  params,
  attemptId = null,
}) {
  const simulated = simulateBuy(state, side, fills, liquidity, params);
  if (!simulated.allowed) return { ok: false, reason: 'risk', simulated };
  const avgPrice = simulated.qty > 0 ? simulated.addCost / simulated.qty : 0;
  const riskBefore = riskSnapshot(state);
  state.shares = simulated.shares;
  state.cost = simulated.cost;
  state.estimatedFees = simulated.estimatedFees;
  state.minWorstPnl = Math.min(state.minWorstPnl, simulated.risk.worstPnl);
  state.maxGrossExposure = Math.max(state.maxGrossExposure, state.cost);
  if (purpose === 'directional') state.cycles += 1;
  if (purpose === 'hedge' && Math.abs(state.shares.UP - state.shares.DOWN) <= 1e-9) {
    state.protectedCycles += 1;
  }

  const fillId = `${state.eventId}|${state.fills.length + 1}`;
  const fill = {
    id: fillId,
    side,
    qty: simulated.qty,
    price: avgPrice,
    cost: simulated.addCost,
    liquidity,
    purpose,
    source: purpose,
    time: ts,
    timeMs: new Date(ts).getTime(),
    edgeAtFill: model ? roundTo(sideProbability(model, side) - avgPrice, 8) : null,
    pFairAtFill: model ? sideProbability(model, side) : null,
    riskBefore,
    riskAfter: simulated.risk,
    estimatedFee: simulated.addFees,
    attemptId,
    markouts: {},
  };
  state.fills.push(fill);
  state.orders.push({
    id: fillId,
    type: 'entry',
    side,
    qty: simulated.qty,
    filledQty: simulated.qty,
    price: avgPrice,
    avgPrice,
    cost: simulated.addCost,
    liquidity,
    source: purpose,
    reason: purpose,
    createdAt: ts,
    status: 'filled',
    fills: fills.map((item) => ({ ...item })),
  });
  return { ok: true, fill, simulated };
}

function maxRiskPrice(state, side, qty, liquidity, params, targetWorstPnl = -params.maxRiskUsd) {
  const maxTick = Math.floor(0.99 / params.tickSize);
  for (let tick = maxTick; tick >= 1; tick -= 1) {
    const price = roundTo(tick * params.tickSize, 8);
    const simulated = simulateBuy(state, side, [{ qty, price }], liquidity, params);
    if (simulated.allowed && simulated.risk.worstPnl >= targetWorstPnl - 1e-9) return price;
  }
  return null;
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeEscadaAdaptativaParams(rawParams);
  const events = [];
  const log = [];
  const equity = [];
  const completedEvents = new Set();
  const aggregateStats = {
    makerPlaced: 0,
    makerFilled: 0,
    makerCancelled: 0,
    makerTimeouts: 0,
    takerScheduled: 0,
    takerFilled: 0,
    takerMisses: 0,
    riskRejected: 0,
    qualityRejected: 0,
    signalRejected: 0,
  };
  let current = null;
  let totalPnl = 0;
  let totalEntries = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalNoEntry = 0;
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;
  let attemptSequence = 0;

  const addLog = (ts, msg, type = 'info') => {
    log.push({ ts, msg, type });
  };

  const secondsRemaining = (tick) => Math.max(
    0,
    (current.eventEndMs - new Date(tick.ts).getTime()) / 1000,
  );

  const updateAggregateStats = () => {
    for (const key of Object.keys(aggregateStats)) aggregateStats[key] += current.stats[key] || 0;
  };

  const finalizeCurrentEvent = (reason = 'event_end', closeTs = null) => {
    if (!current) return;
    completedEvents.add(eventKey(current));
    if (current.makerOrder) {
      current.makerOrder.status = 'cancelled';
      current.makerOrder.cancelReason = 'event_end';
      current.stats.makerCancelled += 1;
      current.makerOrder = null;
    }
    if (current.pendingTaker) {
      current.stats.takerMisses += 1;
      current.pendingTaker = null;
    }
    updateAggregateStats();

    const tick = current.lastTick;
    const closedAt = closeTs || new Date(current.eventEndMs).toISOString();
    const risk = riskSnapshot(current);
    const maxObservedWorstLoss = Math.max(0, -current.minWorstPnl);
    if (!current.fills.length) {
      totalNoEntry += 1;
      events.push({
        eventId: current.eventId,
        eventStart: current.eventStart,
        eventEnd: new Date(current.eventEndMs).toISOString(),
        reason: 'no_entry',
        closedAt,
        fills: [],
        orders: [],
        orderAttempts: current.orderAttempts,
        finalPnl: 0,
        finalPnlBeforeFees: 0,
        risk,
        maxObservedWorstLoss,
        diagnostics: {
          cycles: current.cycles,
          protectedCycles: current.protectedCycles,
          ...current.stats,
        },
      });
      equity.push({ ts: closedAt, pnl: totalPnl });
      current = null;
      return;
    }

    const btcPrice = toFiniteNumber(tick.btc_price ?? tick.underlying_price);
    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const winnerSide = btcPrice != null && priceToBeat != null && btcPrice >= priceToBeat ? 'UP' : 'DOWN';
    const settlementValue = current.shares[winnerSide];
    const finalPnlBeforeFees = settlementValue - current.cost;
    totalPnl += finalPnlBeforeFees;
    totalEntries += 1;
    if (finalPnlBeforeFees > 0) totalWins += 1;
    else if (finalPnlBeforeFees < 0) totalLosses += 1;
    const firstFill = current.fills[0];
    const positionType = current.shares.UP > 0 && current.shares.DOWN > 0
      ? 'BOTH'
      : (current.shares.UP > 0 ? 'UP' : 'DOWN');

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: new Date(current.eventEndMs).toISOString(),
      entryTime: firstFill.time,
      positionType,
      quantity: firstFill.qty,
      cost: current.cost,
      avgEntryPrice: current.fills.reduce((sum, fill) => sum + fill.cost, 0)
        / current.fills.reduce((sum, fill) => sum + fill.qty, 0),
      shares: { ...current.shares },
      fills: current.fills,
      orders: current.orders,
      orderAttempts: current.orderAttempts,
      winnerSide,
      settlementValue,
      finalPnlBeforeFees,
      finalPnl: finalPnlBeforeFees,
      estimatedTakerFees: current.estimatedFees,
      finalPnlAfterEstimatedFees: finalPnlBeforeFees - current.estimatedFees,
      risk,
      maxObservedWorstLoss,
      protectedAtEnd: risk.worstPnl >= 0,
      reason,
      closedAt,
      diagnostics: {
        cycles: current.cycles,
        protectedCycles: current.protectedCycles,
        maxGrossExposure: current.maxGrossExposure,
        ...current.stats,
      },
    });
    equity.push({ ts: closedAt, pnl: totalPnl });
    addLog(
      closedAt,
      `EAH EVENTO FIN | ${winnerSide} | PnL bruto ${finalPnlBeforeFees.toFixed(4)} | risco max ${maxObservedWorstLoss.toFixed(4)}`,
      finalPnlBeforeFees >= 0 ? 'profit' : 'loss',
    );
    current = null;
  };

  const cancelMaker = (reason, tick) => {
    if (!current?.makerOrder) return;
    const order = current.makerOrder;
    order.status = 'cancelled';
    order.cancelReason = reason;
    current.stats.makerCancelled += 1;
    if (reason === 'timeout') current.stats.makerTimeouts += 1;
    const attempt = current.orderAttempts.find((item) => item.id === order.id);
    if (attempt) {
      attempt.status = 'cancelled';
      attempt.cancelReason = reason;
      attempt.cancelledAt = tick.ts;
    }
    addLog(tick.ts, `EAH CANCEL ${order.purpose} ${order.side} @ ${order.price} | ${reason}`);
    current.makerOrder = null;
  };

  const scheduleCancel = (reason) => {
    if (!current?.makerOrder || current.makerOrder.cancelDueTick != null) return;
    current.makerOrder.cancelReason = reason;
    current.makerOrder.cancelDueTick = current.tickIndex + params.cancelLatencyTicks;
  };

  const placeMaker = ({ side, qty, price, purpose, tick, model }) => {
    const fields = sideFields(tick, side);
    const riskBefore = riskSnapshot(current);
    const simulated = simulateBuy(current, side, [{ qty, price }], 'maker', params);
    if (!simulated.allowed) {
      current.stats.riskRejected += 1;
      return false;
    }
    attemptSequence += 1;
    const id = `eah-attempt-${attemptSequence}`;
    const order = {
      id,
      side,
      qty,
      price,
      purpose,
      status: 'open',
      placedAt: tick.ts,
      placedTimeMs: new Date(tick.ts).getTime(),
      placedTick: current.tickIndex,
      lastAsk: fields.ask,
      cancelDueTick: null,
      cancelReason: null,
      edgeAtPlacement: model ? sideProbability(model, side) - price : null,
      pFairAtPlacement: model ? sideProbability(model, side) : null,
      riskBefore,
      projectedRisk: simulated.risk,
    };
    current.makerOrder = order;
    current.orderAttempts.push({ ...order });
    current.stats.makerPlaced += 1;
    addLog(
      tick.ts,
      `EAH MAKER ${purpose} ${side} ${qty}sh @ ${price.toFixed(4)} | worst ${simulated.risk.worstPnl.toFixed(4)}`,
    );
    return true;
  };

  const processMaker = (tick, model) => {
    const order = current.makerOrder;
    if (!order) return false;
    const fields = sideFields(tick, order.side);
    const currAsk = fields.ask;
    const crossed = shouldFillMaker(order, order.lastAsk, currAsk, params);
    order.lastAsk = currAsk;
    if (crossed) {
      const result = fillState(current, {
        side: order.side,
        fills: [{ qty: order.qty, price: order.price }],
        liquidity: 'maker',
        purpose: order.purpose,
        ts: tick.ts,
        model,
        params,
        attemptId: order.id,
      });
      const attempt = current.orderAttempts.find((item) => item.id === order.id);
      if (result.ok) {
        current.stats.makerFilled += 1;
        if (attempt) {
          attempt.status = 'filled';
          attempt.filledAt = tick.ts;
          attempt.edgeAtFill = result.fill.edgeAtFill;
        }
        addLog(
          tick.ts,
          `EAH FILL maker ${order.purpose} ${order.side} ${order.qty}sh @ ${order.price.toFixed(4)}`,
          'trade',
        );
      } else {
        current.stats.riskRejected += 1;
        if (attempt) {
          attempt.status = 'rejected_after_cross';
          attempt.cancelReason = 'risk_changed';
        }
      }
      current.makerOrder = null;
      return true;
    }

    if (order.cancelDueTick != null && current.tickIndex >= order.cancelDueTick) {
      cancelMaker(order.cancelReason || 'cancelled', tick);
      return true;
    }

    const elapsedSec = (new Date(tick.ts).getTime() - order.placedTimeMs) / 1000;
    if (elapsedSec >= params.makerTimeoutSec) scheduleCancel('timeout');
    if (!qualityOk(tick, params)) scheduleCancel('quality');
    const spread = fields.ask != null && fields.bid != null ? fields.ask - fields.bid : Number.POSITIVE_INFINITY;
    if (spread > params.cancelSpread) scheduleCancel('spread');
    if (model.shock) scheduleCancel('shock');
    if (order.purpose === 'directional') {
      const probability = sideProbability(model, order.side);
      if (probability - order.price < params.cancelEdge) scheduleCancel('edge');
      if ((model.pUp >= 0.5 ? 'UP' : 'DOWN') !== order.side) scheduleCancel('signal_flip');
    } else {
      const diff = current.shares.UP - current.shares.DOWN;
      const stillUnderweight = order.side === 'UP' ? diff < -1e-9 : diff > 1e-9;
      const projected = simulateBuy(current, order.side, [{ qty: order.qty, price: order.price }], 'maker', params);
      const before = riskSnapshot(current);
      if (!stillUnderweight
        || !projected.allowed
        || projected.risk.worstPnl < before.worstPnl + params.hedgeMinWorstImprovementUsd - 1e-9) {
        scheduleCancel('hedge_no_longer_improves');
      }
    }
    return true;
  };

  const processPendingTaker = (tick, model) => {
    const pending = current.pendingTaker;
    if (!pending || current.tickIndex < pending.dueTick) return false;
    current.pendingTaker = null;
    const fields = sideFields(tick, pending.side);
    const walk = walkBookAsks(fields.rawAsks, pending.qty, fields.ask, pending.maxPrice);
    if (!walk.full) {
      current.stats.takerMisses += 1;
      addLog(tick.ts, `EAH TAKER MISS ${pending.side} | profundidade/cap`, 'warn');
      return true;
    }
    const simulated = simulateBuy(current, pending.side, walk.fills, 'taker', params);
    const balanced = Math.abs(simulated.shares.UP - simulated.shares.DOWN) <= 1e-9;
    if (!simulated.allowed || !balanced || simulated.risk.worstPnl < params.hedgeMinProtectedProfitUsd - 1e-9) {
      current.stats.takerMisses += 1;
      addLog(tick.ts, `EAH TAKER MISS ${pending.side} | protecao desapareceu`, 'warn');
      return true;
    }
    const result = fillState(current, {
      side: pending.side,
      fills: walk.fills,
      liquidity: 'taker',
      purpose: 'hedge',
      ts: tick.ts,
      model,
      params,
      attemptId: pending.id,
    });
    if (result.ok) {
      current.stats.takerFilled += 1;
      addLog(
        tick.ts,
        `EAH FILL taker hedge ${pending.side} ${walk.filledQty}sh @ ${walk.avgPrice.toFixed(4)} | protegido ${result.simulated.risk.worstPnl.toFixed(4)}`,
        'trade',
      );
    } else {
      current.stats.takerMisses += 1;
    }
    return true;
  };

  const tryScheduleTakerHedge = (tick, model, side, qty) => {
    const cap = maxRiskPrice(
      current,
      side,
      qty,
      'taker',
      params,
      params.hedgeMinProtectedProfitUsd,
    );
    if (cap == null) return false;
    const fields = sideFields(tick, side);
    const walk = walkBookAsks(fields.rawAsks, qty, fields.ask, cap);
    if (!walk.full) return false;
    const simulated = simulateBuy(current, side, walk.fills, 'taker', params);
    const balanced = Math.abs(simulated.shares.UP - simulated.shares.DOWN) <= 1e-9;
    if (!simulated.allowed || !balanced || simulated.risk.worstPnl < params.hedgeMinProtectedProfitUsd - 1e-9) {
      return false;
    }
    attemptSequence += 1;
    current.pendingTaker = {
      id: `eah-taker-${attemptSequence}`,
      side,
      qty,
      maxPrice: cap,
      dueTick: current.tickIndex + params.takerLatencyTicks,
      scheduledAt: tick.ts,
      projectedWorstPnl: simulated.risk.worstPnl,
    };
    current.stats.takerScheduled += 1;
    addLog(
      tick.ts,
      `EAH TAKER AGENDADO hedge ${side} ${qty}sh cap ${cap.toFixed(4)} | protegido ${simulated.risk.worstPnl.toFixed(4)}`,
    );
    if (params.takerLatencyTicks === 0) processPendingTaker(tick, model);
    return true;
  };

  const tryPlaceHedgeMaker = (tick, model, side, qty) => {
    const fields = sideFields(tick, side);
    if (fields.bid == null || fields.ask == null) return false;
    const spread = fields.ask - fields.bid;
    if (spread > params.maxSpread) return false;
    const riskBefore = riskSnapshot(current);
    const maxAllowed = maxRiskPrice(
      current,
      side,
      qty,
      'maker',
      params,
      params.hedgeMinProtectedProfitUsd,
    );
    if (maxAllowed == null) {
      current.stats.riskRejected += 1;
      return false;
    }
    const price = roundDownToTick(Math.min(fields.bid, maxAllowed), params.tickSize);
    if (price <= 0 || price >= 1) return false;
    const simulated = simulateBuy(current, side, [{ qty, price }], 'maker', params);
    if (!simulated.allowed
      || simulated.risk.worstPnl < params.hedgeMinProtectedProfitUsd - 1e-9
      || simulated.risk.worstPnl < riskBefore.worstPnl + params.hedgeMinWorstImprovementUsd - 1e-9) {
      current.stats.riskRejected += 1;
      return false;
    }
    return placeMaker({ side, qty, price, purpose: 'hedge', tick, model });
  };

  const tryPlaceDirectionalMaker = (tick, model) => {
    const remaining = secondsRemaining(tick);
    if (remaining > params.entryWindowStartSec || remaining < params.entryWindowEndSec) return false;
    if (current.samples.length < params.minTicksBeforeEntry) return false;
    if (current.cycles >= params.maxCycles) return false;
    if (model.shock) return false;
    const side = model.pUp >= 0.5 ? 'UP' : 'DOWN';
    const probability = sideProbability(model, side);
    if (probability < params.minDirectionalProbability) {
      current.stats.signalRejected += 1;
      return false;
    }
    const fields = sideFields(tick, side);
    if (fields.bid == null || fields.ask == null) return false;
    const spread = fields.ask - fields.bid;
    if (spread > params.maxSpread) return false;
    const requiredEdge = params.minEdge + (current.cycles * params.rungEdgeStep);
    const price = roundDownToTick(Math.min(fields.bid, probability - requiredEdge), params.tickSize);
    if (price <= 0 || price >= 1 || probability - price < requiredEdge - 1e-9) return false;
    const simulated = simulateBuy(
      current,
      side,
      [{ qty: params.minShares, price }],
      'maker',
      params,
    );
    if (!simulated.allowed) {
      current.stats.riskRejected += 1;
      return false;
    }
    return placeMaker({
      side,
      qty: params.minShares,
      price,
      purpose: 'directional',
      tick,
      model,
    });
  };

  const processTick = (tick) => {
    if (!tick?.ts || !tick?.event_start || !tick?.condition_id) return;
    ticksProcessed += 1;
    periodStart = periodStart || tick.ts;
    periodEnd = tick.ts;
    const key = eventKey(tick);
    if (current && eventKey(current) !== key) finalizeCurrentEvent('event_end');
    if (!current) {
      if (completedEvents.has(key)) return;
      current = createEventState(tick);
    }

    current.tickIndex += 1;
    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);
    addSample(current, tick);
    updateMarkouts(current, tick);
    const model = modelProbability(current, tick, params);
    current.model = model;

    if (current.makerOrder) {
      processMaker(tick, model);
      return;
    }
    if (current.pendingTaker) {
      processPendingTaker(tick, model);
      return;
    }
    if (!qualityOk(tick, params)) {
      current.stats.qualityRejected += 1;
      return;
    }

    const remaining = secondsRemaining(tick);
    const diff = current.shares.UP - current.shares.DOWN;
    if (Math.abs(diff) > 1e-9) {
      if (remaining < params.hedgeCutoffSec) return;
      const hedgeSide = diff > 0 ? 'DOWN' : 'UP';
      const qty = Math.abs(diff);
      if (tryScheduleTakerHedge(tick, model, hedgeSide, qty)) return;
      tryPlaceHedgeMaker(tick, model, hedgeSide, qty);
      return;
    }

    tryPlaceDirectionalMaker(tick, model);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('finish', periodEnd);
    const entered = events.filter((event) => event.reason !== 'no_entry');
    const pnls = entered.map((event) => Number(event.finalPnl || 0));
    const wins = pnls.filter((value) => value > 0);
    const losses = pnls.filter((value) => value < 0);
    const grossProfit = wins.reduce((sum, value) => sum + value, 0);
    const grossLoss = losses.reduce((sum, value) => sum + Math.abs(value), 0);
    const avgPnl = totalEntries > 0 ? totalPnl / totalEntries : 0;
    const pnlStd = std(pnls);
    const downsideStd = std(losses);
    const maxObservedWorstLoss = events.reduce(
      (max, event) => Math.max(max, Number(event.maxObservedWorstLoss || 0)),
      0,
    );
    return {
      strategy: 'ESCADA_ADAPTATIVA_HIBRIDA_V1',
      params,
      period: { start: periodStart, end: periodEnd },
      summary: {
        totalEvents: events.length,
        eventsWithEntries: totalEntries,
        totalEntries,
        entries: totalEntries,
        totalWins,
        totalLosses,
        wins: totalWins,
        losses: totalLosses,
        totalNoEntry,
        totalPnl,
        pnl: totalPnl,
        avgPnl,
        winRate: totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0,
        grossProfit,
        grossLoss,
        profitFactor: grossLoss > 0
          ? grossProfit / grossLoss
          : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
        sharpe: pnlStd > 0 ? avgPnl / pnlStd : 0,
        sortino: downsideStd > 0 ? avgPnl / downsideStd : 0,
        maxObservedWorstLoss,
        riskLimitUsd: params.maxRiskUsd,
        ticksProcessed,
        ...aggregateStats,
      },
      events,
      equity,
      log,
    };
  };

  return { processTick, finish };
}

function runEscadaAdaptativaHibridaBacktest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks || []) runner.processTick(tick);
  return runner.finish();
}

async function runEscadaAdaptativaHibridaBacktestInBatches(rawParams, tickBatches) {
  const runner = createBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch || []) runner.processTick(tick);
  }
  return runner.finish();
}

var __escadaAdaptativaExports = {
  DEFAULT_PARAMS,
  mergeEscadaAdaptativaParams,
  parseBookLevels,
  walkBookAsks,
  calculateTakerFee,
  riskSnapshot,
  simulateBuy,
  modelProbability,
  shouldFillMaker,
  createBacktestRunner,
  runEscadaAdaptativaHibridaBacktest,
  runEscadaAdaptativaHibridaBacktestInBatches,
};
