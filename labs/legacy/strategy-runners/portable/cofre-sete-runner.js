const DEFAULT_STOP_REVERSE_PARAMS = {
  stopReverseEnabled: false,
  stopReverseMaxAttempts: 1,
  stopReverseMaxSecondsRemaining: 60,
  stopReverseMinSecondsRemaining: 2,
  stopReverseMinDistanceAbs: 10,
  stopReverseDistanceSchedule: null,
  stopReverseMaxAsk: 0.98,
  stopReverseSlippageMax: 0.02,
  stopReverseMinLiquidityRatio: 0.50,
  stopReverseMinBid: 0.001,
  stopReverseBudgetMode: 'same-cost',
  stopReverseBudgetFactor: 1,
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

function normalizeBudgetMode(value, fallback) {
  const mode = String(value || fallback || '').toLowerCase();
  return ['same-cost', 'open-cost', 'sale-proceeds', 'max-order'].includes(mode) ? mode : DEFAULT_STOP_REVERSE_PARAMS.stopReverseBudgetMode;
}

function normalizeDistanceSchedule(value) {
  let rawSchedule = value;
  if (typeof rawSchedule === 'string') {
    try {
      rawSchedule = JSON.parse(rawSchedule);
    } catch {
      rawSchedule = null;
    }
  }
  if (!Array.isArray(rawSchedule)) return null;

  const schedule = rawSchedule
    .map((item) => {
      const minSecondsRemaining = toFiniteNumber(
        item?.minSecondsRemaining ?? item?.minSec ?? item?.secondsRemaining ?? item?.seconds,
      );
      const minDistanceAbs = toFiniteNumber(
        item?.minDistanceAbs ?? item?.distanceAbs ?? item?.distance ?? item?.dist,
      );
      if (minSecondsRemaining == null || minDistanceAbs == null) return null;
      return {
        minSecondsRemaining: clamp(minSecondsRemaining, 0, 300),
        minDistanceAbs: Math.max(0, minDistanceAbs),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.minSecondsRemaining - left.minSecondsRemaining);

  return schedule.length ? schedule : null;
}

function resolveStopReverseMinDistance(params, timeRemainingSec) {
  if (Array.isArray(params.stopReverseDistanceSchedule) && params.stopReverseDistanceSchedule.length) {
    const bucket = params.stopReverseDistanceSchedule.find((item) => timeRemainingSec >= item.minSecondsRemaining);
    if (bucket) return bucket.minDistanceAbs;
  }
  return params.stopReverseMinDistanceAbs;
}

function mergeStopReverseParams(raw = {}, defaults = {}) {
  const params = { ...DEFAULT_STOP_REVERSE_PARAMS, ...defaults };
  const numericKeys = [
    'stopReverseMaxAttempts',
    'stopReverseMaxSecondsRemaining',
    'stopReverseMinSecondsRemaining',
    'stopReverseMinDistanceAbs',
    'stopReverseMaxAsk',
    'stopReverseSlippageMax',
    'stopReverseMinLiquidityRatio',
    'stopReverseMinBid',
    'stopReverseBudgetFactor',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.stopReverseEnabled = toBool(raw.stopReverseEnabled, params.stopReverseEnabled);
  params.stopReverseMaxAttempts = Math.max(0, Math.floor(params.stopReverseMaxAttempts));
  params.stopReverseMaxSecondsRemaining = clamp(params.stopReverseMaxSecondsRemaining, 0, 300);
  params.stopReverseMinSecondsRemaining = clamp(params.stopReverseMinSecondsRemaining, 0, params.stopReverseMaxSecondsRemaining);
  params.stopReverseMinDistanceAbs = Math.max(0, params.stopReverseMinDistanceAbs);
  params.stopReverseMaxAsk = clamp(params.stopReverseMaxAsk, 0.001, 0.999);
  params.stopReverseSlippageMax = clamp(params.stopReverseSlippageMax, 0, 0.99);
  params.stopReverseMinLiquidityRatio = clamp(params.stopReverseMinLiquidityRatio, 0.01, 1);
  params.stopReverseMinBid = clamp(params.stopReverseMinBid, 0.001, 0.999);
  params.stopReverseBudgetMode = normalizeBudgetMode(raw.stopReverseBudgetMode, params.stopReverseBudgetMode);
  params.stopReverseBudgetFactor = Math.max(0, params.stopReverseBudgetFactor);
  params.stopReverseDistanceSchedule = normalizeDistanceSchedule(
    raw.stopReverseDistanceSchedule ?? params.stopReverseDistanceSchedule,
  );
  return params;
}

function applyStopReverseParams(params, raw = {}, defaults = {}) {
  Object.assign(params, mergeStopReverseParams(raw, defaults));
  return params;
}

function stopReverseTrigger({ tick, priceToBeat, positionSide, timeRemainingSec, attempts = 0, params }) {
  if (!params.stopReverseEnabled || attempts >= params.stopReverseMaxAttempts) return null;
  if (timeRemainingSec > params.stopReverseMaxSecondsRemaining || timeRemainingSec < params.stopReverseMinSecondsRemaining) return null;

  const btcPrice = toFiniteNumber(tick?.btc_price ?? tick?.currentBtcPrice);
  const ptb = toFiniteNumber(priceToBeat ?? tick?.price_to_beat ?? tick?.priceToBeat);
  if (btcPrice == null || ptb == null) return null;

  const adverseDistance = positionSide === 'UP' ? ptb - btcPrice : btcPrice - ptb;
  const minDistanceAbs = resolveStopReverseMinDistance(params, timeRemainingSec);
  if (adverseDistance < minDistanceAbs) return null;

  return {
    fromSide: positionSide,
    toSide: positionSide === 'UP' ? 'DOWN' : 'UP',
    btcPrice,
    priceToBeat: ptb,
    adverseDistance,
    minDistanceAbs,
    timeRemainingSec,
  };
}

function stopReverseBudget({ params, maxOrderValue, equityNow, totalCost = 0, openCost = 0, proceeds = 0 }) {
  const cappedMaxOrder = Math.max(0, toFiniteNumber(maxOrderValue, 0));
  const availableEquity = Math.max(0, toFiniteNumber(equityNow, cappedMaxOrder));
  let rawBudget = 0;

  if (params.stopReverseBudgetMode === 'sale-proceeds') rawBudget = proceeds;
  else if (params.stopReverseBudgetMode === 'open-cost') rawBudget = openCost;
  else if (params.stopReverseBudgetMode === 'max-order') rawBudget = cappedMaxOrder;
  else rawBudget = totalCost || openCost;

  return Math.min(cappedMaxOrder, availableEquity, Math.max(0, rawBudget * params.stopReverseBudgetFactor));
}


const DEFAULT_PARAMS = {
  walletSize: 100,
  entryWindowStart: 118,
  entryWindowEnd: 3,
  maxEventExposure: 36,
  maxEntryValue: 8,
  minShares: 4,
  maxEntriesPerEvent: 8,
  cooldownSec: 8,
  minAsk: 0.035,
  maxAsk: 0.74,
  minEdge: 0.055,
  minDirectionalProb: 0.57,
  minDistanceAbs: 25,
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
  maxSpread: 0.10,
  maxOddsSum: 1.20,
  minOddsSum: 0.80,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.68,
  fallbackBookSize: 0,
  kellyFraction: 0.22,
  maxKellyPct: 0.20,
  riskBudgetPct: 0.45,
  maxWorstLossAbs: 45,
  vaultBoxEnabled: true,
  boxMaxSumAsk: 0.992,
  boxMinProfit: 0.008,
  boxMaxPairValue: 15,
  hedgeEnabled: false,
  hedgeMaxAsk: 0.60,
  hedgeMinLockedProfit: 0.08,
  hedgeMinWorstCaseImprovement: 0.65,
  maxHedgesPerEvent: 2,
  trapEnabled: false,
  trapMaxValue: 4,
  trapMinCheapAsk: 0.04,
  trapMaxCheapAsk: 0.34,
  trapMinExpensiveBid: 0.68,
  trapMaxDistanceAbs: 125,
  trapMinDecelZ: 0.20,
  trapMinEdge: -0.04,
  takeProfitBid: 0.90,
  takeProfitPct: 0.35,
  trailAfterBid: 0.76,
  trailDrop: 0.13,
  stopBid: 0.10,
  edgeExitBelow: -0.06,
  lateExitSec: 7,
  lateExitMinBid: 0.64,
  protectedExitSkipProfit: 0.04,
  minTicksBeforeEntry: 8,
};

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePrice(value, fallback) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return fallback;
  return clamp(numberValue, 0.001, 0.999);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const absValue = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const factor = 1 / (1 + (p * absValue));
  const result = 1 - (((((a5 * factor + a4) * factor) + a3) * factor + a2) * factor + a1) * factor * Math.exp(-absValue * absValue);
  return sign * result;
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function mergeCofreSeteParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'entryWindowStart', 'entryWindowEnd', 'maxEventExposure',
    'maxEntryValue', 'minShares', 'maxEntriesPerEvent', 'cooldownSec', 'minAsk',
    'maxAsk', 'minEdge', 'minDirectionalProb', 'minDistanceAbs', 'minSigma',
    'sigmaMultiplier', 'modelWeight', 'driftWeight', 'driftClampSigma',
    'accelerationWeight', 'bookImbalanceWeight', 'momentumSec', 'slowMomentumSec',
    'slowMomentumWeight', 'volLookbackSec', 'maxSpread', 'maxOddsSum',
    'minOddsSum', 'entrySlippageMax', 'minLiquidityRatio', 'fallbackBookSize',
    'kellyFraction', 'maxKellyPct', 'riskBudgetPct', 'maxWorstLossAbs',
    'boxMaxSumAsk', 'boxMinProfit', 'boxMaxPairValue', 'hedgeMaxAsk',
    'hedgeMinLockedProfit', 'hedgeMinWorstCaseImprovement', 'maxHedgesPerEvent',
    'trapMaxValue', 'trapMinCheapAsk', 'trapMaxCheapAsk', 'trapMinExpensiveBid',
    'trapMaxDistanceAbs', 'trapMinDecelZ', 'trapMinEdge', 'takeProfitBid',
    'takeProfitPct', 'trailAfterBid', 'trailDrop', 'stopBid', 'edgeExitBelow',
    'lateExitSec', 'lateExitMinBid', 'protectedExitSkipProfit', 'minTicksBeforeEntry',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.walletSize = Math.max(1, params.walletSize);
  params.entryWindowStart = clamp(params.entryWindowStart, 0, 300);
  params.entryWindowEnd = clamp(params.entryWindowEnd, 0, 300);
  if (params.entryWindowStart < params.entryWindowEnd) {
    [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  }
  params.maxEventExposure = Math.max(0.01, params.maxEventExposure);
  params.maxEntryValue = Math.max(0.01, params.maxEntryValue);
  params.minShares = Math.max(0.000001, params.minShares);
  params.maxEntriesPerEvent = Math.max(1, Math.floor(params.maxEntriesPerEvent));
  params.cooldownSec = Math.max(0, params.cooldownSec);
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.minEdge = clamp(params.minEdge, -0.5, 0.75);
  params.minDirectionalProb = clamp(params.minDirectionalProb, 0.01, 0.99);
  params.minDistanceAbs = Math.max(0, params.minDistanceAbs);
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
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.maxOddsSum = clamp(params.maxOddsSum, 0.01, 2);
  params.minOddsSum = clamp(params.minOddsSum, 0.01, 2);
  if (params.maxOddsSum < params.minOddsSum) [params.maxOddsSum, params.minOddsSum] = [params.minOddsSum, params.maxOddsSum];
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.50);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.fallbackBookSize = Math.max(0, params.fallbackBookSize);
  params.kellyFraction = clamp(params.kellyFraction, 0, 1);
  params.maxKellyPct = clamp(params.maxKellyPct, 0.001, 1);
  params.riskBudgetPct = clamp(params.riskBudgetPct, 0, 1);
  params.maxWorstLossAbs = Math.max(0.01, params.maxWorstLossAbs);
  params.vaultBoxEnabled = toBool(raw.vaultBoxEnabled, params.vaultBoxEnabled);
  params.boxMaxSumAsk = clamp(params.boxMaxSumAsk, 0.01, 1.99);
  params.boxMinProfit = Math.max(0, params.boxMinProfit);
  params.boxMaxPairValue = Math.max(0.01, params.boxMaxPairValue);
  params.hedgeEnabled = toBool(raw.hedgeEnabled, params.hedgeEnabled);
  params.hedgeMaxAsk = normalizePrice(params.hedgeMaxAsk, DEFAULT_PARAMS.hedgeMaxAsk);
  params.hedgeMinLockedProfit = Math.max(0, params.hedgeMinLockedProfit);
  params.hedgeMinWorstCaseImprovement = Math.max(0, params.hedgeMinWorstCaseImprovement);
  params.maxHedgesPerEvent = Math.max(0, Math.floor(params.maxHedgesPerEvent));
  params.trapEnabled = toBool(raw.trapEnabled, params.trapEnabled);
  params.trapMaxValue = Math.max(0.01, params.trapMaxValue);
  params.trapMinCheapAsk = normalizePrice(params.trapMinCheapAsk, DEFAULT_PARAMS.trapMinCheapAsk);
  params.trapMaxCheapAsk = normalizePrice(params.trapMaxCheapAsk, DEFAULT_PARAMS.trapMaxCheapAsk);
  if (params.trapMaxCheapAsk < params.trapMinCheapAsk) [params.trapMaxCheapAsk, params.trapMinCheapAsk] = [params.trapMinCheapAsk, params.trapMaxCheapAsk];
  params.trapMinExpensiveBid = normalizePrice(params.trapMinExpensiveBid, DEFAULT_PARAMS.trapMinExpensiveBid);
  params.trapMaxDistanceAbs = Math.max(0, params.trapMaxDistanceAbs);
  params.trapMinDecelZ = Math.max(0, params.trapMinDecelZ);
  params.trapMinEdge = clamp(params.trapMinEdge, -0.99, 0.99);
  params.takeProfitBid = normalizePrice(params.takeProfitBid, DEFAULT_PARAMS.takeProfitBid);
  params.takeProfitPct = clamp(params.takeProfitPct, 0, 1);
  params.trailAfterBid = normalizePrice(params.trailAfterBid, DEFAULT_PARAMS.trailAfterBid);
  params.trailDrop = clamp(params.trailDrop, 0.001, 0.99);
  params.stopBid = normalizePrice(params.stopBid, DEFAULT_PARAMS.stopBid);
  params.edgeExitBelow = clamp(params.edgeExitBelow, -0.99, 0.99);
  params.lateExitSec = clamp(params.lateExitSec, 0, 120);
  params.lateExitMinBid = normalizePrice(params.lateExitMinBid, DEFAULT_PARAMS.lateExitMinBid);
  params.protectedExitSkipProfit = Math.max(0, params.protectedExitSkipProfit);
  params.minTicksBeforeEntry = Math.max(1, Math.floor(params.minTicksBeforeEntry));
  applyStopReverseParams(params, raw, { stopReverseBudgetMode: 'open-cost' });
  return params;
}

function parseBookLevels(rawLevels) {
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
    .map((level) => ({ price: toFiniteNumber(level?.price), size: toFiniteNumber(level?.size) }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }))
    .sort((left, right) => left.price - right.price);
}

function withFallbackAsk(levels, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  if (levels.length) return levels;
  const fallback = toFiniteNumber(fallbackBestAsk);
  if (fallback == null || fallback <= 0 || fallbackBookSize <= 0) return [];
  return [{ price: fallback, size: fallbackBookSize, key: `fallback:${fallback}:${fallbackKeySuffix}` }];
}

function pruneConsumedByVisibleLevels(levels, consumedByPrice) {
  const visiblePriceKeys = new Set(levels.map((level) => level.key));
  for (const key of Array.from(consumedByPrice.keys())) {
    if (!visiblePriceKeys.has(key)) consumedByPrice.delete(key);
  }
}

function availableAskQty(rawAsks, maxPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
  return levels.reduce((sum, level) => sum + (level.price <= maxPrice ? level.size : 0), 0);
}

function consumeAsksFromTick(rawAsks, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
  if (!levels.length || requestedQty <= 0) return [];
  pruneConsumedByVisibleLevels(levels, consumedByPrice);

  const fills = [];
  let remainingQty = requestedQty;

  for (const level of levels) {
    if (remainingQty <= 0) break;
    if (level.price > maxPrice) continue;

    const reservedQty = Math.min(consumedByPrice.get(level.key) || 0, level.size);
    if (reservedQty > 0) consumedByPrice.set(level.key, reservedQty);
    else consumedByPrice.delete(level.key);

    const availableQty = level.size - reservedQty;
    if (availableQty <= 0) continue;

    const fillQty = Math.min(availableQty, remainingQty);
    if (fillQty <= 0) continue;

    consumedByPrice.set(level.key, reservedQty + fillQty);
    fills.push({ price: level.price, qty: fillQty });
    remainingQty -= fillQty;
  }

  return fills;
}

function sideFields(tick, side) {
  if (side === 'UP') {
    const fallbackPrice = toFiniteNumber(tick.up_price);
    return {
      ask: toFiniteNumber(tick.up_best_ask) ?? fallbackPrice,
      bid: toFiniteNumber(tick.up_best_bid) ?? fallbackPrice,
      rawAsks: tick.up_book_asks,
      price: fallbackPrice,
    };
  }
  const fallbackPrice = toFiniteNumber(tick.down_price);
  return {
    ask: toFiniteNumber(tick.down_best_ask) ?? fallbackPrice,
    bid: toFiniteNumber(tick.down_best_bid) ?? fallbackPrice,
    rawAsks: tick.down_book_asks,
    price: fallbackPrice,
  };
}

function sideMid(fields) {
  if (fields.ask != null && fields.bid != null) return (fields.ask + fields.bid) / 2;
  return fields.ask ?? fields.bid ?? fields.price ?? null;
}

function oppositeSide(side) {
  return side === 'UP' ? 'DOWN' : 'UP';
}

function marketProbUp(tick) {
  const upMid = sideMid(sideFields(tick, 'UP'));
  const downMid = sideMid(sideFields(tick, 'DOWN'));
  if (upMid == null || downMid == null || upMid + downMid <= 0) return 0.5;
  return clamp(upMid / (upMid + downMid), 0.001, 0.999);
}

function eventKey(tickOrState) {
  return `${tickOrState.event_start ?? tickOrState.eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEnd - new Date(tick.ts)) / 1000);
}

function eventElapsedSec(state, tick) {
  return Math.max(0, (new Date(tick.ts) - new Date(state.eventStart)) / 1000);
}

function sampleAgo(samples, seconds) {
  if (!samples.length) return null;
  const latest = samples[samples.length - 1];
  const targetMs = latest.timeMs - (seconds * 1000);
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index].timeMs <= targetMs) return samples[index];
  }
  return samples[0];
}

function recentVol(samples, lookbackSec) {
  if (samples.length < 3) return 0;
  const latest = samples[samples.length - 1];
  const recent = samples.filter((sample) => latest.timeMs - sample.timeMs <= lookbackSec * 1000 && sample.btc != null);
  const normalizedChanges = [];
  for (let index = 1; index < recent.length; index++) {
    const dtSec = Math.max(0.25, (recent[index].timeMs - recent[index - 1].timeMs) / 1000);
    normalizedChanges.push((recent[index].btc - recent[index - 1].btc) / Math.sqrt(dtSec));
  }
  return std(normalizedChanges);
}

function formatPrice(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatQty(value) {
  const numberValue = Number(value || 0);
  return Number.isInteger(numberValue) ? String(numberValue) : numberValue.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function createSideInventory(side) {
  return {
    side,
    totalQty: 0,
    remainingQty: 0,
    totalCost: 0,
    openCost: 0,
    fills: [],
    maxBid: 0,
    tookProfit: false,
  };
}

function createEventState(tick) {
  const eventStart = tick.event_start;
  const eventEnd = new Date(new Date(tick.event_start).getTime() + 300000);
  return {
    eventId: tick.condition_id,
    eventStart,
    eventEnd,
    priceToBeat: toFiniteNumber(tick.price_to_beat),
    lastTick: tick,
    samples: [],
    inventory: {
      UP: createSideInventory('UP'),
      DOWN: createSideInventory('DOWN'),
    },
    consumedAsksBySide: { UP: new Map(), DOWN: new Map() },
    realizedPnl: 0,
    entries: [],
    exits: [],
    orders: [],
    boxes: [],
    hedges: [],
    traps: [],
    partials: [],
    lastEntryMs: 0,
    lastBoxEntryMs: 0,
    lastTrapEntryMs: 0,
    directionalEntries: 0,
    boxEntries: 0,
    trapEntries: 0,
    totalOpenCost: 0,
    stopReverseCount: 0,
    reversals: [],
    lastDiagnostics: null,
  };
}

function addSample(state, tick) {
  const tickTime = new Date(tick.ts).getTime();
  state.samples.push({ timeMs: tickTime, ts: tick.ts, btc: toFiniteNumber(tick.btc_price) });

  while (state.samples.length > 1 && tickTime - state.samples[0].timeMs > 180000) {
    state.samples.shift();
  }
}

function bookImbalance(tick) {
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  const upSpread = upFields.ask != null && upFields.bid != null ? upFields.ask - upFields.bid : 0;
  const downSpread = downFields.ask != null && downFields.bid != null ? downFields.ask - downFields.bid : 0;
  const spreadTilt = clamp((downSpread - upSpread) * 3, -0.20, 0.20);
  const marketTilt = marketProbUp(tick) - 0.5;
  return clamp((marketTilt * 0.35) + spreadTilt, -0.35, 0.35);
}

function modelProbUpDetailed(state, tick, params) {
  const samples = state.samples;
  const latest = samples[samples.length - 1];
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null || !latest) {
    return { probability: 0.5, pStat: 0.5, pMarket: 0.5, sigma: params.minSigma, distance: 0, drift: 0, acceleration: 0, imbalance: 0 };
  }

  const timeRemainingSec = Math.max(1, secondsRemaining(state, tick));
  const fastSample = sampleAgo(samples, params.momentumSec) || latest;
  const slowSample = sampleAgo(samples, params.slowMomentumSec) || fastSample;
  const fastSec = Math.max(1, (latest.timeMs - fastSample.timeMs) / 1000);
  const slowSec = Math.max(fastSec, (latest.timeMs - slowSample.timeMs) / 1000);
  const fastMove = btcPrice - (fastSample?.btc ?? btcPrice);
  const slowMove = btcPrice - (slowSample?.btc ?? btcPrice);
  const fastDrift = fastMove / fastSec;
  const slowDrift = slowMove / slowSec;
  const acceleration = fastDrift - slowDrift;
  const drift = fastDrift + (params.slowMomentumWeight * slowDrift) + (params.accelerationWeight * acceleration);
  const sigma = Math.max(params.minSigma, recentVol(samples, params.volLookbackSec) * Math.sqrt(timeRemainingSec) * params.sigmaMultiplier);
  const driftContribution = clamp(drift * timeRemainingSec * params.driftWeight, -sigma * params.driftClampSigma, sigma * params.driftClampSigma);
  const distance = btcPrice - priceToBeat;
  const pStat = normalCdf((distance + driftContribution) / sigma);
  const pMarket = marketProbUp(tick);
  const imbalance = bookImbalance(tick);
  const pWithBook = clamp(pStat + (params.bookImbalanceWeight * imbalance), 0.001, 0.999);
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  const askSum = (upFields.ask ?? 0.5) + (downFields.ask ?? 0.5);
  const oddsPenalty = askSum > params.maxOddsSum || askSum < params.minOddsSum ? 0.10 : 0;
  const blended = (params.modelWeight * pWithBook) + ((1 - params.modelWeight) * pMarket);
  const probability = clamp(blended > pMarket ? blended - oddsPenalty : blended + oddsPenalty, 0.001, 0.999);
  return { probability, pStat, pMarket, sigma, distance, drift, acceleration, imbalance, askSum };
}

function scoreDirectionalCandidates(state, tick, params) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null) return [];
  if (Math.abs(btcPrice - priceToBeat) < params.minDistanceAbs) return [];

  const model = modelProbUpDetailed(state, tick, params);
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  const askSum = (upFields.ask ?? 0.5) + (downFields.ask ?? 0.5);
  if (askSum > params.maxOddsSum || askSum < params.minOddsSum) return [];

  return ['UP', 'DOWN']
    .map((side) => {
      const fields = side === 'UP' ? upFields : downFields;
      const ask = fields.ask;
      const bid = fields.bid;
      const probability = side === 'UP' ? model.probability : 1 - model.probability;
      const spread = ask != null && bid != null ? Math.max(0, ask - bid) : Number.POSITIVE_INFINITY;
      const edge = ask != null ? probability - ask : Number.NEGATIVE_INFINITY;
      const confidence = Math.abs(probability - 0.5) * 2;
      const qualityScore = clamp(0.25 + (edge * 4.5) + (confidence * 0.45) - (spread * 1.2), 0.10, 1.25);
      return { side, fields, ask, bid, probability, edge, spread, askSum, qualityScore, model };
    })
    .filter((candidate) => candidate.ask != null
      && candidate.ask >= params.minAsk
      && candidate.ask <= params.maxAsk
      && candidate.probability >= params.minDirectionalProb
      && candidate.edge >= params.minEdge
      && candidate.spread <= params.maxSpread)
    .sort((left, right) => (right.edge * right.qualityScore) - (left.edge * left.qualityScore));
}

function averageOpenPrice(sideInventory) {
  if (!sideInventory || sideInventory.remainingQty <= 0) return 0;
  return sideInventory.openCost / Math.max(0.000001, sideInventory.remainingQty);
}

function addInventoryFills(sideInventory, fills) {
  for (const fill of fills) {
    const cost = fill.qty * fill.price;
    sideInventory.totalQty += fill.qty;
    sideInventory.remainingQty += fill.qty;
    sideInventory.totalCost += cost;
    sideInventory.openCost += cost;
    sideInventory.fills.push(fill);
  }
}

function openCost(state) {
  return state.inventory.UP.openCost + state.inventory.DOWN.openCost;
}

function payoffSnapshot(state, extraSide = null, extraQty = 0, extraCost = 0) {
  const upQty = state.inventory.UP.remainingQty + (extraSide === 'UP' ? extraQty : 0);
  const downQty = state.inventory.DOWN.remainingQty + (extraSide === 'DOWN' ? extraQty : 0);
  const totalOpenCost = openCost(state) + extraCost;
  const upPnl = state.realizedPnl + upQty - totalOpenCost;
  const downPnl = state.realizedPnl + downQty - totalOpenCost;
  return {
    upPnl,
    downPnl,
    worstPnl: Math.min(upPnl, downPnl),
    bestPnl: Math.max(upPnl, downPnl),
    lockedProfit: Math.min(upPnl, downPnl),
  };
}

function computeAdvancedMetrics(events, totalPnl, totalEntries, totalWins, totalLosses) {
  const enteredEvents = events.filter((item) => item.reason !== 'no_entry');
  const pnls = enteredEvents.map((item) => Number(item.finalPnl || 0));
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + Math.abs(value), 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgPnl = totalEntries > 0 ? totalPnl / totalEntries : 0;
  const pnlStd = std(pnls);
  const downsideStd = std(losses);
  const winProbability = totalEntries > 0 ? totalWins / totalEntries : 0;
  const lossProbability = totalEntries > 0 ? totalLosses / totalEntries : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Number.POSITIVE_INFINITY : 0);
  const edgePerTrade = (winProbability * avgWin) - (lossProbability * avgLoss);

  return {
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    payoff,
    expectancy: avgPnl,
    sharpe: pnlStd > 0 ? avgPnl / pnlStd : 0,
    sortino: downsideStd > 0 ? avgPnl / downsideStd : 0,
    edgePerEntry: edgePerTrade,
    riskOfRuin: grossProfit > grossLoss && avgLoss > 0 ? Math.max(0, Math.min(1, (grossLoss / grossProfit) ** Math.max(1, DEFAULT_PARAMS.walletSize / avgLoss))) : null,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeCofreSeteParams(rawParams);
  const log = [];
  const events = [];
  const equity = [];
  const completedEvents = new Set();

  let totalEvents = 0;
  let totalEntries = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalNoEntry = 0;
  let totalPnl = 0;
  let totalDirectionalEntries = 0;
  let totalBoxEntries = 0;
  let totalTrapEntries = 0;
  let totalHedges = 0;
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;
  let current = null;

  const addLog = (ts, msg, type = 'info') => {
    log.push({ ts, msg, type });
  };

  const equityNow = () => Math.max(0, params.walletSize + totalPnl);

  const riskLimit = () => Math.min(params.maxWorstLossAbs, equityNow() * params.riskBudgetPct);

  const canAddTrade = (side, qty, cost) => {
    if (!current) return false;
    if (openCost(current) + cost > params.maxEventExposure + 0.000001) return false;
    const projected = payoffSnapshot(current, side, qty, cost);
    return projected.worstPnl >= -riskLimit() - 0.000001;
  };

  const sellSide = (tick, side, qty, price, reason, type = 'profit') => {
    const sideInventory = current?.inventory?.[side];
    if (!sideInventory || sideInventory.remainingQty <= 0 || qty <= 0 || price == null || price <= 0) return 0;
    const sellQty = Math.min(qty, sideInventory.remainingQty);
    const avgOpenCost = averageOpenPrice(sideInventory);
    const consumedCost = avgOpenCost * sellQty;
    const pnl = (price - avgOpenCost) * sellQty;
    sideInventory.remainingQty -= sellQty;
    sideInventory.openCost = Math.max(0, sideInventory.openCost - consumedCost);
    current.realizedPnl += pnl;
    current.exits.push({ time: tick.ts, side, qty: sellQty, price, pnl, reason });
    addLog(tick.ts, `${reason.toUpperCase()} | ${side} ${formatQty(sellQty)} @ ${formatPrice(price)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, type);
    return sellQty;
  };

  const pushNoEntryEvent = (closeTs) => {
    totalNoEntry++;
    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: null,
      quantity: 0,
      cost: 0,
      avgEntryPrice: 0,
      entries: [],
      fills: [],
      exits: [],
      boxes: [],
      hedges: [],
      traps: [],
      expirationResult: null,
      finalPnl: 0,
      reason: 'no_entry',
      closedAt: closeTs,
      diagnostics: current.lastDiagnostics,
    });
    equity.push({ ts: closeTs, pnl: totalPnl });
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    const key = eventKey(current);
    completedEvents.add(key);
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();
    const upInventory = current.inventory.UP;
    const downInventory = current.inventory.DOWN;
    const hasPosition = upInventory.remainingQty > 0 || downInventory.remainingQty > 0 || current.entries.length > 0;

    if (!hasPosition) {
      pushNoEntryEvent(ts);
      current = null;
      return;
    }

    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    const winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
    let expiryPnl = 0;
    for (const side of ['UP', 'DOWN']) {
      const sideInventory = current.inventory[side];
      if (sideInventory.remainingQty <= 0) continue;
      const payout = side === winnerSide ? sideInventory.remainingQty : 0;
      const sidePnl = payout - sideInventory.openCost;
      expiryPnl += sidePnl;
      sideInventory.remainingQty = 0;
      sideInventory.openCost = 0;
    }
    current.realizedPnl += expiryPnl;

    const finalPnl = current.realizedPnl;
    totalPnl += finalPnl;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    const allFills = [...upInventory.fills, ...downInventory.fills].sort((left, right) => new Date(left.time) - new Date(right.time));
    const totalQty = upInventory.totalQty + downInventory.totalQty;
    const totalCost = upInventory.totalCost + downInventory.totalCost;
    const dominantSide = upInventory.totalCost >= downInventory.totalCost ? 'UP' : 'DOWN';

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: upInventory.totalQty > 0 && downInventory.totalQty > 0 ? 'BOTH' : dominantSide,
      entryTime: current.entries[0]?.time ?? null,
      entryDistanceToPtb: current.entries[0]?.distanceToPtb ?? null,
      entryTimeRemaining: current.entries[0]?.timeRemainingSec ?? null,
      quantity: totalQty,
      cost: totalCost,
      avgEntryPrice: totalQty > 0 ? totalCost / totalQty : 0,
      fills: allFills.map((fill) => ({ ...fill })),
      entries: current.entries.map((entry) => ({ ...entry })),
      profitOrders: current.partials.map((partial) => ({ ...partial })),
      exits: current.exits.map((exit) => ({ ...exit })),
      reversals: current.reversals.map((reversal) => ({ ...reversal, entryFills: reversal.entryFills.map((fill) => ({ ...fill })) })),
      boxes: current.boxes.map((box) => ({ ...box })),
      hedges: current.hedges.map((hedge) => ({ ...hedge })),
      traps: current.traps.map((trap) => ({ ...trap })),
      expirationResult: finalPnl >= 0 ? 'WIN' : 'LOSS',
      winnerSide,
      expiryPnl,
      finalPnl,
      reason,
      closedAt: ts,
      orders: current.orders.map((order) => ({ ...order, fills: order.fills.map((fill) => ({ ...fill })) })),
      diagnostics: {
        ...current.lastDiagnostics,
        payoffBeforeExpiry: payoffSnapshot(current),
      },
      inventory: {
        UP: { totalQty: upInventory.totalQty, totalCost: upInventory.totalCost },
        DOWN: { totalQty: downInventory.totalQty, totalCost: downInventory.totalCost },
      },
    });

    equity.push({ ts, pnl: totalPnl });
    addLog(ts, `EVENTO FIN | Cofre Sete | ${winnerSide} venceu | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`, finalPnl >= 0 ? 'profit' : 'loss');
    current = null;
  };

  const startEvent = (tick) => {
    current = createEventState(tick);
    totalEvents++;
    addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | Cofre Sete V1`, 'info');
  };

  const executeBuy = (tick, side, requestedQty, maxFillPrice, source, diagnostics = {}) => {
    const fields = sideFields(tick, side);
    const consumedClone = new Map(current.consumedAsksBySide[side]);
    const fills = consumeAsksFromTick(
      fields.rawAsks,
      maxFillPrice,
      requestedQty,
      consumedClone,
      fields.ask,
      params.fallbackBookSize,
      `${tick.ts}:${source}:${side}`,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < params.minShares || totalCost <= 0 || !canAddTrade(side, filledQty, totalCost)) return null;

    current.consumedAsksBySide[side] = consumedClone;
    const timedFills = fills.map((fill) => ({ ...fill, side, time: tick.ts, source }));
    addInventoryFills(current.inventory[side], timedFills);
    current.totalOpenCost += totalCost;
    const projected = payoffSnapshot(current);
    current.orders.push({
      side,
      source,
      requestedQty,
      filledQty,
      maxPrice: maxFillPrice,
      avgPrice: totalCost / filledQty,
      cost: totalCost,
      createdAt: tick.ts,
      projectedWorstPnl: projected.worstPnl,
      projectedBestPnl: projected.bestPnl,
      fills: timedFills.map((fill) => ({ ...fill })),
      ...diagnostics,
    });
    return { side, filledQty, totalCost, avgPrice: totalCost / filledQty, fills: timedFills, projected };
  };

  const attemptVaultBox = (tick) => {
    if (!params.vaultBoxEnabled || current.boxEntries >= params.maxEntriesPerEvent) return false;
    const timeMs = new Date(tick.ts).getTime();
    if (current.lastBoxEntryMs && timeMs - current.lastBoxEntryMs < params.cooldownSec * 1000) return false;

    const upFields = sideFields(tick, 'UP');
    const downFields = sideFields(tick, 'DOWN');
    if (upFields.ask == null || downFields.ask == null) return false;
    const pairAsk = upFields.ask + downFields.ask;
    const lockedProfitPerPair = 1 - pairAsk;
    if (pairAsk > params.boxMaxSumAsk || lockedProfitPerPair < params.boxMinProfit) return false;
    if (upFields.ask - (upFields.bid ?? upFields.ask) > params.maxSpread) return false;
    if (downFields.ask - (downFields.bid ?? downFields.ask) > params.maxSpread) return false;

    const maxPairPrice = pairAsk + (2 * params.entrySlippageMax);
    const targetValue = Math.min(params.boxMaxPairValue, params.maxEntryValue, equityNow() * params.maxKellyPct, params.maxEventExposure - openCost(current));
    const targetQty = Math.floor(targetValue / Math.max(maxPairPrice, 0.001));
    if (targetQty < params.minShares) return false;

    const upMaxPrice = upFields.ask + params.entrySlippageMax;
    const downMaxPrice = downFields.ask + params.entrySlippageMax;
    const upAvailable = availableAskQty(upFields.rawAsks, upMaxPrice, upFields.ask, params.fallbackBookSize, `${tick.ts}:vault:UP`);
    const downAvailable = availableAskQty(downFields.rawAsks, downMaxPrice, downFields.ask, params.fallbackBookSize, `${tick.ts}:vault:DOWN`);
    const pairQty = Math.min(targetQty, Math.floor(upAvailable), Math.floor(downAvailable));
    if (pairQty < params.minShares || pairQty < targetQty * params.minLiquidityRatio) return false;

    const upConsumed = new Map(current.consumedAsksBySide.UP);
    const downConsumed = new Map(current.consumedAsksBySide.DOWN);
    const upFills = consumeAsksFromTick(upFields.rawAsks, upMaxPrice, pairQty, upConsumed, upFields.ask, params.fallbackBookSize, `${tick.ts}:vault:UP`);
    const downFills = consumeAsksFromTick(downFields.rawAsks, downMaxPrice, pairQty, downConsumed, downFields.ask, params.fallbackBookSize, `${tick.ts}:vault:DOWN`);
    const upQty = upFills.reduce((sum, fill) => sum + fill.qty, 0);
    const downQty = downFills.reduce((sum, fill) => sum + fill.qty, 0);
    if (upQty < params.minShares || downQty < params.minShares || Math.abs(upQty - downQty) > 0.000001) return false;

    const qty = Math.min(upQty, downQty);
    const upCost = upFills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    const downCost = downFills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    const cost = upCost + downCost;
    if (openCost(current) + cost > params.maxEventExposure + 0.000001) return false;

    current.consumedAsksBySide.UP = upConsumed;
    current.consumedAsksBySide.DOWN = downConsumed;
    const timedUpFills = upFills.map((fill) => ({ ...fill, side: 'UP', time: tick.ts, source: 'vault_box' }));
    const timedDownFills = downFills.map((fill) => ({ ...fill, side: 'DOWN', time: tick.ts, source: 'vault_box' }));
    addInventoryFills(current.inventory.UP, timedUpFills);
    addInventoryFills(current.inventory.DOWN, timedDownFills);
    current.totalOpenCost += cost;
    const projected = payoffSnapshot(current);
    current.orders.push(
      { side: 'UP', source: 'vault_box', requestedQty: pairQty, filledQty: qty, maxPrice: upMaxPrice, avgPrice: upCost / qty, cost: upCost, createdAt: tick.ts, lockedProfitPerPair, pairAsk, projectedWorstPnl: projected.worstPnl, fills: timedUpFills.map((fill) => ({ ...fill })) },
      { side: 'DOWN', source: 'vault_box', requestedQty: pairQty, filledQty: qty, maxPrice: downMaxPrice, avgPrice: downCost / qty, cost: downCost, createdAt: tick.ts, lockedProfitPerPair, pairAsk, projectedWorstPnl: projected.worstPnl, fills: timedDownFills.map((fill) => ({ ...fill })) },
    );

    current.boxEntries++;
    totalBoxEntries++;
    totalEntries++;
    current.lastBoxEntryMs = timeMs;
    current.entries.push({
      time: tick.ts,
      type: 'vault_box',
      side: 'BOTH',
      qty,
      cost,
      avgEntryPrice: cost / (qty * 2),
      lockedProfit: qty - cost,
      lockedProfitPerPair,
      projectedWorstPnl: projected.worstPnl,
      timeRemainingSec: secondsRemaining(current, tick),
      distanceToPtb: Math.abs(toFiniteNumber(tick.btc_price) - toFiniteNumber(current.priceToBeat ?? tick.price_to_beat)),
    });
    current.boxes.push({ time: tick.ts, qty, cost, lockedProfit: qty - cost, upAvg: upCost / qty, downAvg: downCost / qty, projectedWorstPnl: projected.worstPnl });
    addLog(tick.ts, `VAULT BOX | UP+DOWN ${formatQty(qty)} pares | custo ${formatPrice(cost)} | lock $${(qty - cost).toFixed(2)}`, 'entry');
    return true;
  };

  const directionalSize = (candidate) => {
    const winPayoff = Math.max(0.001, (1 - candidate.ask) / candidate.ask);
    const lossProbability = 1 - candidate.probability;
    const kelly = Math.max(0, ((candidate.probability * winPayoff) - lossProbability) / winPayoff);
    const kellyValue = equityNow() * Math.min(params.maxKellyPct, kelly * params.kellyFraction);
    const qualityValue = params.maxEntryValue * candidate.qualityScore;
    return Math.min(params.maxEntryValue, qualityValue, kellyValue, params.maxEventExposure - openCost(current));
  };

  const attemptFluxSniper = (tick) => {
    if (current.directionalEntries + current.boxEntries + current.trapEntries >= params.maxEntriesPerEvent) return false;
    const timeMs = new Date(tick.ts).getTime();
    if (current.lastEntryMs && timeMs - current.lastEntryMs < params.cooldownSec * 1000) return false;

    const candidates = scoreDirectionalCandidates(current, tick, params);
    const candidate = candidates[0] || null;
    current.lastDiagnostics = candidate ? {
      side: candidate.side,
      ask: candidate.ask,
      bid: candidate.bid,
      probability: candidate.probability,
      edge: candidate.edge,
      spread: candidate.spread,
      askSum: candidate.askSum,
      qualityScore: candidate.qualityScore,
      model: candidate.model,
      timeRemainingSec: secondsRemaining(current, tick),
    } : current.lastDiagnostics;
    if (!candidate) return false;

    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const targetValue = directionalSize(candidate);
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return false;

    const availableQty = availableAskQty(candidate.fields.rawAsks, maxFillPrice, candidate.fields.ask, params.fallbackBookSize, `${tick.ts}:flux:${candidate.side}`);
    if (availableQty < targetQty * params.minLiquidityRatio) return false;

    const buy = executeBuy(tick, candidate.side, targetQty, maxFillPrice, 'flux_sniper', {
      probability: candidate.probability,
      edge: candidate.edge,
      spread: candidate.spread,
      qualityScore: candidate.qualityScore,
    });
    if (!buy) return false;

    current.directionalEntries++;
    totalDirectionalEntries++;
    totalEntries++;
    current.lastEntryMs = timeMs;
    const distanceToPtb = Math.abs(toFiniteNumber(tick.btc_price) - toFiniteNumber(current.priceToBeat ?? tick.price_to_beat));
    current.entries.push({
      time: tick.ts,
      type: 'flux_sniper',
      side: candidate.side,
      qty: buy.filledQty,
      cost: buy.totalCost,
      avgEntryPrice: buy.avgPrice,
      probability: candidate.probability,
      edge: candidate.edge,
      spread: candidate.spread,
      qualityScore: candidate.qualityScore,
      projectedWorstPnl: buy.projected.worstPnl,
      timeRemainingSec: secondsRemaining(current, tick),
      distanceToPtb,
    });
    addLog(tick.ts, `FLUX SNIPER | ${candidate.side} ${formatQty(buy.filledQty)} @ ${formatPrice(buy.avgPrice)} | prob ${(candidate.probability * 100).toFixed(1)}% | edge ${(candidate.edge * 100).toFixed(1)}pp`, 'entry');
    return true;
  };

  const trapDecelScore = (tick, expensiveSide) => {
    const latest = current.samples[current.samples.length - 1];
    if (!latest) return 0;
    const fastSample = sampleAgo(current.samples, params.momentumSec) || latest;
    const slowSample = sampleAgo(current.samples, params.slowMomentumSec) || fastSample;
    const fastSec = Math.max(1, (latest.timeMs - fastSample.timeMs) / 1000);
    const slowSec = Math.max(fastSec, (latest.timeMs - slowSample.timeMs) / 1000);
    const btcPrice = toFiniteNumber(tick.btc_price) ?? latest.btc ?? 0;
    const fastDrift = (btcPrice - (fastSample?.btc ?? btcPrice)) / fastSec;
    const slowDrift = (btcPrice - (slowSample?.btc ?? btcPrice)) / slowSec;
    const acceleration = fastDrift - slowDrift;
    const volatility = Math.max(0.01, recentVol(current.samples, params.volLookbackSec));
    return expensiveSide === 'UP' ? -acceleration / volatility : acceleration / volatility;
  };

  const attemptTrapReversal = (tick) => {
    if (!params.trapEnabled || current.trapEntries > 0) return false;
    if (current.directionalEntries + current.boxEntries + current.trapEntries >= params.maxEntriesPerEvent) return false;
    const timeMs = new Date(tick.ts).getTime();
    if (current.lastTrapEntryMs && timeMs - current.lastTrapEntryMs < params.cooldownSec * 1000) return false;

    const btcPrice = toFiniteNumber(tick.btc_price);
    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    if (btcPrice == null || priceToBeat == null || Math.abs(btcPrice - priceToBeat) > params.trapMaxDistanceAbs) return false;

    const upFields = sideFields(tick, 'UP');
    const downFields = sideFields(tick, 'DOWN');
    const expensiveSide = (upFields.bid ?? 0) >= params.trapMinExpensiveBid ? 'UP' : ((downFields.bid ?? 0) >= params.trapMinExpensiveBid ? 'DOWN' : null);
    if (!expensiveSide) return false;
    const cheapSide = oppositeSide(expensiveSide);
    const cheapFields = cheapSide === 'UP' ? upFields : downFields;
    if (cheapFields.ask == null || cheapFields.ask < params.trapMinCheapAsk || cheapFields.ask > params.trapMaxCheapAsk) return false;
    const spread = cheapFields.ask != null && cheapFields.bid != null ? cheapFields.ask - cheapFields.bid : Number.POSITIVE_INFINITY;
    if (spread > params.maxSpread) return false;

    const decelScore = trapDecelScore(tick, expensiveSide);
    if (decelScore < params.trapMinDecelZ) return false;
    const model = modelProbUpDetailed(current, tick, params);
    const probability = cheapSide === 'UP' ? model.probability : 1 - model.probability;
    const edge = probability - cheapFields.ask;
    if (edge < params.trapMinEdge) return false;

    const maxFillPrice = cheapFields.ask + params.entrySlippageMax;
    const targetValue = Math.min(params.trapMaxValue, params.maxEventExposure - openCost(current));
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return false;
    const availableQty = availableAskQty(cheapFields.rawAsks, maxFillPrice, cheapFields.ask, params.fallbackBookSize, `${tick.ts}:trap:${cheapSide}`);
    if (availableQty < targetQty * params.minLiquidityRatio) return false;

    const buy = executeBuy(tick, cheapSide, targetQty, maxFillPrice, 'trap_reversal', { probability, edge, decelScore, expensiveSide });
    if (!buy) return false;

    current.trapEntries++;
    totalTrapEntries++;
    totalEntries++;
    current.lastTrapEntryMs = timeMs;
    const distanceToPtb = Math.abs(btcPrice - priceToBeat);
    current.entries.push({
      time: tick.ts,
      type: 'trap_reversal',
      side: cheapSide,
      expensiveSide,
      qty: buy.filledQty,
      cost: buy.totalCost,
      avgEntryPrice: buy.avgPrice,
      probability,
      edge,
      decelScore,
      projectedWorstPnl: buy.projected.worstPnl,
      timeRemainingSec: secondsRemaining(current, tick),
      distanceToPtb,
    });
    current.traps.push({ time: tick.ts, side: cheapSide, expensiveSide, qty: buy.filledQty, cost: buy.totalCost, avgEntryPrice: buy.avgPrice, decelScore, edge });
    addLog(tick.ts, `TRAP REVERSAL | ${cheapSide} ${formatQty(buy.filledQty)} @ ${formatPrice(buy.avgPrice)} | decel ${decelScore.toFixed(2)} | edge ${(edge * 100).toFixed(1)}pp`, 'entry');
    return true;
  };

  const attemptHedgeAlchemist = (tick, side) => {
    if (!params.hedgeEnabled || current.hedges.length >= params.maxHedgesPerEvent) return false;
    const sideInventory = current.inventory[side];
    if (!sideInventory || sideInventory.remainingQty < params.minShares) return false;
    const hedgeSide = oppositeSide(side);
    const hedgeFields = sideFields(tick, hedgeSide);
    if (hedgeFields.ask == null || hedgeFields.ask > params.hedgeMaxAsk) return false;
    const imbalanceQty = Math.floor(sideInventory.remainingQty - current.inventory[hedgeSide].remainingQty);
    if (imbalanceQty < params.minShares) return false;

    const maxFillPrice = hedgeFields.ask + params.entrySlippageMax;
    const expectedCost = imbalanceQty * maxFillPrice;
    const before = payoffSnapshot(current);
    const after = payoffSnapshot(current, hedgeSide, imbalanceQty, expectedCost);
    const improvesWorstCase = after.worstPnl - before.worstPnl >= params.hedgeMinWorstCaseImprovement;
    const locksProfit = after.lockedProfit >= params.hedgeMinLockedProfit;
    if (!improvesWorstCase && !locksProfit) return false;
    if (!canAddTrade(hedgeSide, imbalanceQty, expectedCost)) return false;

    const availableQty = availableAskQty(hedgeFields.rawAsks, maxFillPrice, hedgeFields.ask, params.fallbackBookSize, `${tick.ts}:hedge:${hedgeSide}`);
    if (availableQty < imbalanceQty * params.minLiquidityRatio) return false;
    const buy = executeBuy(tick, hedgeSide, imbalanceQty, maxFillPrice, 'hedge_alchemist', { lockedProfit: after.lockedProfit, worstCaseImprovement: after.worstPnl - before.worstPnl });
    if (!buy) return false;

    totalHedges++;
    current.hedges.push({ time: tick.ts, side: hedgeSide, qty: buy.filledQty, cost: buy.totalCost, avgEntryPrice: buy.avgPrice, lockedProfit: buy.projected.lockedProfit, worstCaseImprovement: after.worstPnl - before.worstPnl });
    addLog(tick.ts, `HEDGE ALCHEMIST | ${hedgeSide} ${formatQty(buy.filledQty)} @ ${formatPrice(buy.avgPrice)} | worst ${before.worstPnl.toFixed(2)} -> ${buy.projected.worstPnl.toFixed(2)}`, 'profit');
    return true;
  };

  const attemptStopReverse = (tick, side, signal, bid) => {
    if (bid < params.stopReverseMinBid) return false;
    const sideInventory = current.inventory[side];
    if (!sideInventory || sideInventory.remainingQty < params.minShares) return false;
    const reverseFields = sideFields(tick, signal.toSide);
    if (reverseFields.ask == null || reverseFields.ask <= 0) return false;

    const fromQty = sideInventory.remainingQty;
    const fromOpenCost = sideInventory.openCost;
    const budget = stopReverseBudget({
      params,
      maxOrderValue: params.maxEntryValue,
      equityNow: equityNow(),
      totalCost: fromOpenCost,
      openCost: fromOpenCost,
      proceeds: fromQty * bid,
    });
    const maxFillPrice = Math.min(params.stopReverseMaxAsk, reverseFields.ask + params.stopReverseSlippageMax);
    const targetQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return false;
    if (openCost(current) - fromOpenCost + budget > params.maxEventExposure + 0.000001) return false;

    const availableQty = availableAskQty(
      reverseFields.rawAsks,
      maxFillPrice,
      reverseFields.ask,
      params.fallbackBookSize,
      `${tick.ts}:stop-reverse:${signal.toSide}`,
    );
    if (availableQty < targetQty * params.stopReverseMinLiquidityRatio) return false;

    const soldQty = sellSide(tick, side, fromQty, bid, 'stop reverse cofre exit', 'stop');
    if (soldQty < fromQty * 0.999) return false;

    const buy = executeBuy(tick, signal.toSide, targetQty, maxFillPrice, 'stop_reverse', {
      adverseDistance: signal.adverseDistance,
      timeRemainingSec: signal.timeRemainingSec,
    });
    current.stopReverseCount++;
    if (!buy) {
      current.reversals.push({
        time: tick.ts,
        fromSide: side,
        toSide: signal.toSide,
        status: 'entry_failed',
        soldQty,
        exitPrice: bid,
        exitProceeds: soldQty * bid,
        fromOpenCost,
        adverseDistance: signal.adverseDistance,
        timeRemainingSec: signal.timeRemainingSec,
        budget,
        entryQty: 0,
        entryCost: 0,
        avgEntryPrice: 0,
        entryFills: [],
      });
      if (current.inventory.UP.remainingQty <= 0 && current.inventory.DOWN.remainingQty <= 0) finalizeCurrentEvent('stop_reverse_exit', tick.ts);
      return true;
    }

    current.directionalEntries++;
    totalDirectionalEntries++;
    totalEntries++;
    current.entries.push({
      time: tick.ts,
      type: 'stop_reverse',
      side: signal.toSide,
      fromSide: side,
      qty: buy.filledQty,
      cost: buy.totalCost,
      avgEntryPrice: buy.avgPrice,
      projectedWorstPnl: buy.projected.worstPnl,
      adverseDistance: signal.adverseDistance,
      timeRemainingSec: signal.timeRemainingSec,
      distanceToPtb: signal.adverseDistance,
    });
    current.reversals.push({
      time: tick.ts,
      fromSide: side,
      toSide: signal.toSide,
      status: 'filled',
      soldQty,
      exitPrice: bid,
      exitProceeds: soldQty * bid,
      fromOpenCost,
      adverseDistance: signal.adverseDistance,
      timeRemainingSec: signal.timeRemainingSec,
      budget,
      entryQty: buy.filledQty,
      entryCost: buy.totalCost,
      avgEntryPrice: buy.avgPrice,
      projectedWorstPnl: buy.projected.worstPnl,
      entryFills: buy.fills.map((fill) => ({ ...fill })),
    });
    addLog(tick.ts, `STOP REVERSE COFRE | ${side}->${signal.toSide} | saiu ${formatQty(soldQty)} @ ${formatPrice(bid)} | entrou ${formatQty(buy.filledQty)} @ ${formatPrice(buy.avgPrice)} | dist $${signal.adverseDistance.toFixed(2)} | ${Math.round(signal.timeRemainingSec)}s`, 'stop');
    return true;
  };

  const maybeProcessPositions = (tick) => {
    let closedByStop = false;
    const model = modelProbUpDetailed(current, tick, params);
    const protectedPayoff = payoffSnapshot(current);
    for (const side of ['UP', 'DOWN']) {
      const sideInventory = current.inventory[side];
      if (sideInventory.remainingQty <= 0) continue;
      const fields = sideFields(tick, side);
      const bid = fields.bid;
      if (bid == null || bid <= 0) continue;
      sideInventory.maxBid = Math.max(sideInventory.maxBid, bid);
      const avgOpen = averageOpenPrice(sideInventory);
      const probability = side === 'UP' ? model.probability : 1 - model.probability;
      const edgeToBid = probability - bid;
      const timeRemainingSec = secondsRemaining(current, tick);
      const hasOppositeInventory = current.inventory[oppositeSide(side)].remainingQty >= params.minShares;

      if (hasOppositeInventory && protectedPayoff.worstPnl >= params.protectedExitSkipProfit) {
        continue;
      }

      const reverseSignal = stopReverseTrigger({
        tick,
        priceToBeat: current.priceToBeat,
        positionSide: side,
        timeRemainingSec,
        attempts: current.stopReverseCount,
        params,
      });
      if (reverseSignal && attemptStopReverse(tick, side, reverseSignal, bid)) return true;

      if (!sideInventory.tookProfit && bid >= params.takeProfitBid && params.takeProfitPct > 0) {
        const partialQty = Math.floor(sideInventory.remainingQty * params.takeProfitPct);
        if (partialQty >= params.minShares) {
          const soldQty = sellSide(tick, side, partialQty, bid, 'parcial cofre', 'profit');
          if (soldQty > 0) {
            sideInventory.tookProfit = true;
            current.partials.push({ side, price: bid, qty: soldQty, fillTime: tick.ts, status: 'FILLED' });
          }
        }
      }

      if (sideInventory.maxBid >= params.trailAfterBid && sideInventory.maxBid - bid >= params.trailDrop) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'trailing cofre', bid >= avgOpen ? 'profit' : 'stop');
        continue;
      }

      if (bid <= params.stopBid && edgeToBid < params.edgeExitBelow && timeRemainingSec > params.lateExitSec) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'stop cofre', 'loss');
        closedByStop = true;
        continue;
      }

      if (edgeToBid < params.edgeExitBelow && bid > avgOpen && timeRemainingSec > params.lateExitSec) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'edge fade cofre', 'profit');
        continue;
      }

      if (timeRemainingSec <= params.lateExitSec && bid >= params.lateExitMinBid) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'derisk final cofre', bid >= avgOpen ? 'profit' : 'stop');
        continue;
      }

      attemptHedgeAlchemist(tick, side);
    }

    if (closedByStop && current.inventory.UP.remainingQty <= 0 && current.inventory.DOWN.remainingQty <= 0) {
      finalizeCurrentEvent('stop', tick.ts);
      return true;
    }
    return false;
  };

  const maybeEnter = (tick) => {
    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return;
    if (eventElapsedSec(current, tick) < 2) return;
    if (current.samples.length < params.minTicksBeforeEntry) return;
    if (openCost(current) >= params.maxEventExposure) return;

    if (attemptVaultBox(tick)) return;
    if (attemptFluxSniper(tick)) return;
    attemptTrapReversal(tick);
  };

  const processTick = (tick) => {
    ticksProcessed++;
    if (!periodStart) periodStart = tick.ts;
    periodEnd = tick.ts;

    const key = eventKey(tick);
    if (!current && completedEvents.has(key)) return;

    if (!current || tick.condition_id !== current.eventId) {
      if (current) finalizeCurrentEvent('expired', current.eventEnd.toISOString());
      if (completedEvents.has(key)) return;
      startEvent(tick);
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);

    const tickTime = new Date(tick.ts);
    if (tickTime < new Date(current.eventStart)) return;

    addSample(current, tick);

    if (tickTime >= current.eventEnd) {
      finalizeCurrentEvent('expired', current.eventEnd.toISOString());
      return;
    }

    if (maybeProcessPositions(tick)) return;
    maybeEnter(tick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd.toISOString());
    const enteredEvents = events.filter((item) => item.reason !== 'no_entry');
    const eventWinRate = enteredEvents.length > 0 ? totalWins / enteredEvents.length * 100 : 0;
    const entryAdjustedWinRate = totalEntries > 0 ? totalWins / totalEntries * 100 : 0;
    const avgPnl = totalEntries > 0 ? totalPnl / totalEntries : 0;
    const maxWin = enteredEvents.length ? Math.max(...enteredEvents.map((item) => item.finalPnl)) : 0;
    const maxLoss = enteredEvents.length ? Math.min(...enteredEvents.map((item) => item.finalPnl)) : 0;

    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equity) {
      if (point.pnl > peak) peak = point.pnl;
      const drawdown = peak - point.pnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const advanced = computeAdvancedMetrics(events, totalPnl, totalEntries, totalWins, totalLosses);
    return {
      params,
      strategy: 'COFRE_SETE_V1',
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins,
        totalLosses,
        winRate: parseFloat(eventWinRate.toFixed(1)),
        eventWinRate: parseFloat(eventWinRate.toFixed(1)),
        entryAdjustedWinRate: parseFloat(entryAdjustedWinRate.toFixed(1)),
        totalPnl,
        avgPnl,
        maxWin,
        maxLoss,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
        directionalEntries: totalDirectionalEntries,
        boxEntries: totalBoxEntries,
        trapEntries: totalTrapEntries,
        hedges: totalHedges,
        activeEvents: enteredEvents.length,
        entriesPerActiveEvent: enteredEvents.length ? totalEntries / enteredEvents.length : 0,
        ...advanced,
      },
      equity,
      events,
      log,
      ticksProcessed,
      periodStart,
      periodEnd,
    };
  };

  return { processTick, finish };
}

function runCofreSeteBacktest(rawParams, ticks) {
  const runner = createCofreSeteBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runCofreSeteBacktestInBatches(rawParams, tickBatches) {
  const runner = createCofreSeteBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
