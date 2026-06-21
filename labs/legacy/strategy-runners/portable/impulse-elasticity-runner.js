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
  maxOrderValue: 15,
  minShares: 5,
  thesis: 'inertia',
  entryWindowStart: 95,
  entryWindowEnd: 24,
  impulseSec: 5,
  volLookbackSec: 45,
  minShockAbs: 18,
  minShockZ: 1.05,
  minResponse: -0.04,
  maxResponse: 0.065,
  minOverResponse: 0.12,
  maxCompressionDist: 12,
  minCompressionVol: 3.5,
  minSignedDistance: 4,
  maxSignedDistance: 120,
  allowedPositionSide: 'BOTH',
  minAsk: 0.06,
  maxAsk: 0.72,
  maxSpread: 0.10,
  minOddsSum: 0.98,
  maxOddsSum: 1.07,
  minModelProb: 0.42,
  minModelEdge: 0.025,
  minDecisionMetric: 0.025,
  minSigma: 8,
  sigmaMultiplier: 1.10,
  impulseCarryWeight: 0.32,
  fadeCarryWeight: 0.42,
  carryHorizonSec: 16,
  carryClampSigma: 0.80,
  responseScale: 0.08,
  inertiaProbabilityWeight: 0.10,
  entrySlippageMax: 0.02,
  exitSlippageMax: 0.02,
  minLiquidityRatio: 0.65,
  exitLiquidityRatio: 0.40,
  fallbackBookSize: 0,
  takeProfitBid: 0.88,
  catchUpMinBid: 0.62,
  exitCatchUpProb: 0.13,
  stopBid: 0.16,
  stopMinBid: 0.05,
  reversalSec: 4,
  reversalShockAbs: 16,
  lateExitSec: 12,
  lateExitMinBid: 0.72,
};

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
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

function normalizePrice(value, fallback) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return fallback;
  return clamp(numberValue, 0.001, 0.99);
}

function normalizeThesis(value) {
  const thesis = String(value || DEFAULT_PARAMS.thesis).toLowerCase();
  return ['inertia', 'fade', 'compression', 'random'].includes(thesis) ? thesis : DEFAULT_PARAMS.thesis;
}

function normalizeAllowedPositionSide(value) {
  const side = String(value || 'BOTH').toUpperCase();
  return ['BOTH', 'UP', 'DOWN'].includes(side) ? side : 'BOTH';
}

function mergeImpulseElasticityParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'maxOrderValue', 'minShares', 'entryWindowStart', 'entryWindowEnd',
    'impulseSec', 'volLookbackSec', 'minShockAbs', 'minShockZ', 'minResponse',
    'maxResponse', 'minOverResponse', 'maxCompressionDist', 'minCompressionVol',
    'minSignedDistance', 'maxSignedDistance', 'minAsk', 'maxAsk', 'maxSpread',
    'minOddsSum', 'maxOddsSum', 'minModelProb', 'minModelEdge', 'minDecisionMetric',
    'minSigma', 'sigmaMultiplier', 'impulseCarryWeight', 'fadeCarryWeight',
    'carryHorizonSec', 'carryClampSigma', 'responseScale', 'inertiaProbabilityWeight',
    'entrySlippageMax', 'exitSlippageMax', 'minLiquidityRatio', 'exitLiquidityRatio',
    'fallbackBookSize', 'takeProfitBid', 'catchUpMinBid', 'exitCatchUpProb', 'stopBid',
    'stopMinBid', 'reversalSec', 'reversalShockAbs', 'lateExitSec', 'lateExitMinBid',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.thesis = normalizeThesis(raw.thesis ?? params.thesis);
  params.allowedPositionSide = normalizeAllowedPositionSide(raw.allowedPositionSide ?? params.allowedPositionSide);
  params.walletSize = Math.max(1, params.walletSize);
  params.maxOrderValue = Math.max(0.01, params.maxOrderValue);
  params.minShares = Math.max(0.000001, params.minShares);
  params.entryWindowStart = clamp(params.entryWindowStart, 0, 300);
  params.entryWindowEnd = clamp(params.entryWindowEnd, 0, 300);
  if (params.entryWindowStart < params.entryWindowEnd) {
    [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  }
  params.impulseSec = clamp(params.impulseSec, 1, 60);
  params.volLookbackSec = clamp(params.volLookbackSec, params.impulseSec, 180);
  params.minShockAbs = Math.max(0, params.minShockAbs);
  params.minShockZ = Math.max(0, params.minShockZ);
  params.minOverResponse = clamp(params.minOverResponse, -0.99, 0.99);
  params.maxCompressionDist = Math.max(0.1, params.maxCompressionDist);
  params.minCompressionVol = Math.max(0, params.minCompressionVol);
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.minOddsSum = clamp(params.minOddsSum, 0.01, 1.99);
  params.maxOddsSum = clamp(params.maxOddsSum, params.minOddsSum, 1.99);
  params.minModelProb = clamp(params.minModelProb, 0.001, 0.999);
  params.minModelEdge = clamp(params.minModelEdge, -0.99, 0.99);
  params.minDecisionMetric = Math.max(0, params.minDecisionMetric);
  params.minSigma = Math.max(0.01, params.minSigma);
  params.sigmaMultiplier = clamp(params.sigmaMultiplier, 0.1, 5);
  params.carryHorizonSec = clamp(params.carryHorizonSec, 1, 120);
  params.carryClampSigma = clamp(params.carryClampSigma, 0, 5);
  params.responseScale = Math.max(0.001, params.responseScale);
  params.inertiaProbabilityWeight = clamp(params.inertiaProbabilityWeight, -1, 1);
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.exitSlippageMax = clamp(params.exitSlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.exitLiquidityRatio = clamp(params.exitLiquidityRatio, 0.01, 1);
  params.fallbackBookSize = Math.max(0, params.fallbackBookSize);
  params.takeProfitBid = normalizePrice(params.takeProfitBid, DEFAULT_PARAMS.takeProfitBid);
  params.catchUpMinBid = normalizePrice(params.catchUpMinBid, DEFAULT_PARAMS.catchUpMinBid);
  params.exitCatchUpProb = clamp(params.exitCatchUpProb, -0.99, 0.99);
  params.stopBid = normalizePrice(params.stopBid, DEFAULT_PARAMS.stopBid);
  params.stopMinBid = normalizePrice(params.stopMinBid, DEFAULT_PARAMS.stopMinBid);
  params.reversalSec = clamp(params.reversalSec, 1, 60);
  params.reversalShockAbs = Math.max(0, params.reversalShockAbs);
  params.lateExitSec = clamp(params.lateExitSec, 0, 120);
  params.lateExitMinBid = normalizePrice(params.lateExitMinBid, DEFAULT_PARAMS.lateExitMinBid);
  applyStopReverseParams(params, raw);
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
  const parsed = levels
    .map((level) => ({ price: toFiniteNumber(level?.price), size: toFiniteNumber(level?.size) }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }));
  return parsed.sort((left, right) => (direction === 'bid' ? right.price - left.price : left.price - right.price));
}

function withFallbackLevel(levels, fallbackPrice, fallbackBookSize, fallbackKeySuffix) {
  if (levels.length) return levels;
  const fallback = toFiniteNumber(fallbackPrice);
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
  const levels = withFallbackLevel(parseBookLevels(rawAsks, 'ask'), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
  return levels.reduce((sum, level) => sum + (level.price <= maxPrice ? level.size : 0), 0);
}

function consumeAsksFromTick(rawAsks, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackLevel(parseBookLevels(rawAsks, 'ask'), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
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
    consumedByPrice.set(level.key, reservedQty + fillQty);
    fills.push({ price: level.price, qty: fillQty });
    remainingQty -= fillQty;
  }
  return fills;
}

function availableBidQty(rawBids, minPrice, fallbackBestBid, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackLevel(parseBookLevels(rawBids, 'bid'), fallbackBestBid, fallbackBookSize, fallbackKeySuffix);
  return levels.reduce((sum, level) => sum + (level.price >= minPrice ? level.size : 0), 0);
}

function consumeBidsFromTick(rawBids, minPrice, requestedQty, consumedByPrice, fallbackBestBid, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackLevel(parseBookLevels(rawBids, 'bid'), fallbackBestBid, fallbackBookSize, fallbackKeySuffix);
  if (!levels.length || requestedQty <= 0) return [];
  pruneConsumedByVisibleLevels(levels, consumedByPrice);

  const fills = [];
  let remainingQty = requestedQty;
  for (const level of levels) {
    if (remainingQty <= 0) break;
    if (level.price < minPrice) continue;
    const reservedQty = Math.min(consumedByPrice.get(level.key) || 0, level.size);
    if (reservedQty > 0) consumedByPrice.set(level.key, reservedQty);
    else consumedByPrice.delete(level.key);
    const availableQty = level.size - reservedQty;
    if (availableQty <= 0) continue;
    const fillQty = Math.min(availableQty, remainingQty);
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
      rawBids: tick.up_book_bids,
      price: fallbackPrice,
    };
  }
  const fallbackPrice = toFiniteNumber(tick.down_price);
  return {
    ask: toFiniteNumber(tick.down_best_ask) ?? fallbackPrice,
    bid: toFiniteNumber(tick.down_best_bid) ?? fallbackPrice,
    rawAsks: tick.down_book_asks,
    rawBids: tick.down_book_bids,
    price: fallbackPrice,
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
  return `${tickOrState.event_start ?? tickOrState.eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEnd - new Date(tick.ts)) / 1000);
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

function addSample(state, tick) {
  const timeMs = new Date(tick.ts).getTime();
  state.samples.push({
    timeMs,
    ts: tick.ts,
    btc: toFiniteNumber(tick.btc_price),
    pUp: marketProbUp(tick),
  });
  while (state.samples.length > 1 && timeMs - state.samples[0].timeMs > 180000) {
    state.samples.shift();
  }
}

function createEventState(tick) {
  return {
    eventId: tick.condition_id,
    eventStart: tick.event_start,
    eventEnd: new Date(new Date(tick.event_start).getTime() + 300000),
    priceToBeat: toFiniteNumber(tick.price_to_beat),
    lastTick: tick,
    samples: [],
    consumedAsksBySide: { UP: new Map(), DOWN: new Map() },
    consumedBidsBySide: { UP: new Map(), DOWN: new Map() },
    position: null,
    entry: null,
    realizedPnl: 0,
    exits: [],
    reversals: [],
    stopReverseCount: 0,
  };
}

function seededSide(key) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? 'UP' : 'DOWN';
}

function formatPrice(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatQty(value) {
  const numberValue = Number(value || 0);
  return Number.isInteger(numberValue) ? String(numberValue) : numberValue.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function buildSignalFeatures(state, tick, params) {
  const latest = state.samples[state.samples.length - 1];
  const impulseSample = sampleAgo(state.samples, params.impulseSec);
  if (!latest || !impulseSample || latest === impulseSample) return null;
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null) return null;
  const shock = btcPrice - impulseSample.btc;
  const shockAbs = Math.abs(shock);
  const shockSide = shock >= 0 ? 'UP' : 'DOWN';
  const shockSign = shock >= 0 ? 1 : -1;
  const pUp = marketProbUp(tick);
  const pUpChange = pUp - impulseSample.pUp;
  const shockResponse = shockSign * pUpChange;
  const vol = Math.max(0.000001, recentVol(state.samples, params.volLookbackSec));
  const shockZ = shockAbs / Math.max(0.000001, vol * Math.sqrt(Math.max(1, params.impulseSec)));
  return { shock, shockAbs, shockSide, shockSign, shockResponse, pUp, pUpChange, vol, shockZ };
}

function currentCanEnter(state, tick, params) {
  if (!state || state.position) return false;
  const rem = secondsRemaining(state, tick);
  return rem <= params.entryWindowStart && rem >= params.entryWindowEnd;
}

function modelCandidate(state, tick, side, params, features) {
  const fields = sideFields(tick, side);
  const opposite = side === 'UP' ? sideFields(tick, 'DOWN') : sideFields(tick, 'UP');
  const ask = fields.ask;
  const bid = fields.bid;
  const spread = ask != null && bid != null ? Math.max(0, ask - bid) : Number.POSITIVE_INFINITY;
  const askSum = (fields.ask ?? 0.5) + (opposite.ask ?? 0.5);
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  const sideSign = side === 'UP' ? 1 : -1;
  const signedDistance = btcPrice != null && priceToBeat != null ? sideSign * (btcPrice - priceToBeat) : 0;
  const rem = secondsRemaining(state, tick);
  const vol = Math.max(0.000001, recentVol(state.samples, params.volLookbackSec));
  const sigmaTau = Math.max(params.minSigma, vol * Math.sqrt(Math.max(1, rem)) * params.sigmaMultiplier);
  const carryVelocity = features.sideShock / Math.max(1, params.impulseSec);
  const carryWeight = params.thesis === 'fade' ? params.fadeCarryWeight : params.impulseCarryWeight;
  const carry = clamp(
    carryVelocity * Math.min(rem, params.carryHorizonSec) * carryWeight,
    -sigmaTau * params.carryClampSigma,
    sigmaTau * params.carryClampSigma,
  );
  const terminalProbability = clamp(normalCdf((signedDistance + carry) / Math.max(0.000001, sigmaTau)), 0.001, 0.999);
  const responsePenalty = Math.max(0, features.sideResponse) / params.responseScale;
  const inertia = clamp(features.shockZ - responsePenalty, 0, 4);
  const overreaction = clamp(responsePenalty - (features.shockZ * 0.55), 0, 4);
  const compressionBoost = params.thesis === 'compression'
    ? clamp((params.maxCompressionDist - Math.abs(btcPrice - priceToBeat)) / Math.max(1, params.maxCompressionDist), 0, 1)
    : 0;
  const anomalyBoost = params.thesis === 'fade' ? overreaction : Math.max(inertia, compressionBoost * features.shockZ);
  const modelProbability = clamp(
    terminalProbability + (params.inertiaProbabilityWeight * Math.min(1, anomalyBoost / 4) * (1 - terminalProbability)),
    0.001,
    0.999,
  );
  const modelEdge = ask != null ? modelProbability - ask : Number.NEGATIVE_INFINITY;
  const maxFillPrice = ask != null ? Math.min(params.maxAsk, ask + params.entrySlippageMax) : 0;
  const liquidityQty = ask != null ? availableAskQty(
    fields.rawAsks,
    maxFillPrice,
    ask,
    params.fallbackBookSize,
    `${tick.ts}:impulse-elasticity:${side}`,
  ) : 0;
  const targetQty = ask != null ? Math.floor(params.maxOrderValue / Math.max(maxFillPrice, 0.001)) : 0;
  const liquidityRatio = targetQty > 0 ? Math.min(1, liquidityQty / targetQty) : 0;
  const decisionMetric = Math.max(0, modelEdge) * Math.max(0.001, anomalyBoost) * Math.max(0.2, liquidityRatio) / Math.max(0.01, spread);

  return {
    side,
    fields,
    ask,
    bid,
    spread,
    askSum,
    rem,
    signedDistance,
    sigmaTau,
    carry,
    terminalProbability,
    modelProbability,
    modelEdge,
    sideResponse: features.sideResponse,
    sideShock: features.sideShock,
    shockAbs: features.shockAbs,
    shockZ: features.shockZ,
    inertia,
    overreaction,
    compressionBoost,
    anomalyBoost,
    liquidityQty,
    targetQty,
    liquidityRatio,
    decisionMetric,
    marketProbability: side === 'UP' ? marketProbUp(tick) : 1 - marketProbUp(tick),
  };
}

function scoreCandidate(state, tick, params) {
  if (!currentCanEnter(state, tick, params)) return null;
  const features = buildSignalFeatures(state, tick, params);
  if (!features) return null;
  if (features.shockAbs < params.minShockAbs || features.shockZ < params.minShockZ) return null;

  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  let side = features.shockSide;
  let sideShock = features.shockAbs;
  let sideResponse = features.shockResponse;

  if (params.thesis === 'fade') {
    if (features.shockResponse < params.minOverResponse) return null;
    side = features.shockSide === 'UP' ? 'DOWN' : 'UP';
    sideShock = features.shockAbs;
    sideResponse = -features.shockResponse;
  } else if (params.thesis === 'compression') {
    if (Math.abs(btcPrice - priceToBeat) > params.maxCompressionDist) return null;
    if (features.vol < params.minCompressionVol) return null;
    if (features.shockResponse > params.maxResponse) return null;
  } else if (params.thesis === 'random') {
    if (features.shockResponse < params.minResponse || features.shockResponse > params.maxResponse) return null;
    side = seededSide(`${state.eventStart}:${tick.ts}:impulse-elasticity`);
    const sideSign = side === 'UP' ? 1 : -1;
    sideShock = sideSign * features.shock;
    sideResponse = sideSign * features.pUpChange;
  } else if (features.shockResponse < params.minResponse || features.shockResponse > params.maxResponse) {
    return null;
  }

  if (params.allowedPositionSide !== 'BOTH' && params.allowedPositionSide !== side) return null;

  const candidate = modelCandidate(state, tick, side, params, { ...features, sideShock, sideResponse });
  if (candidate.ask == null || candidate.bid == null) return null;
  if (candidate.ask < params.minAsk || candidate.ask > params.maxAsk) return null;
  if (candidate.spread > params.maxSpread) return null;
  if (candidate.askSum < params.minOddsSum || candidate.askSum > params.maxOddsSum) return null;
  if (candidate.signedDistance < params.minSignedDistance || candidate.signedDistance > params.maxSignedDistance) return null;
  if (candidate.modelProbability < params.minModelProb) return null;
  if (candidate.modelEdge < params.minModelEdge) return null;
  if (candidate.decisionMetric < params.minDecisionMetric) return null;
  return candidate;
}

function sellFromBook(state, tick, params, reason) {
  const position = state.position;
  if (!position || position.remainingQty <= 0) return false;
  const fields = sideFields(tick, position.side);
  const bid = fields.bid;
  if (bid == null || bid <= 0) return false;
  const minPrice = Math.max(0.001, bid - params.exitSlippageMax);
  const fallbackKey = `${tick.ts}:impulse-elasticity:${position.side}:exit:${reason}`;
  const availableQty = availableBidQty(fields.rawBids, minPrice, bid, params.fallbackBookSize, fallbackKey);
  if (availableQty < position.remainingQty * params.exitLiquidityRatio) return false;
  const consumedClone = new Map(state.consumedBidsBySide[position.side]);
  const fills = consumeBidsFromTick(
    fields.rawBids,
    minPrice,
    position.remainingQty,
    consumedClone,
    bid,
    params.fallbackBookSize,
    fallbackKey,
  );
  const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
  if (filledQty <= 0) return false;
  const proceeds = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
  const pnl = proceeds - (position.avgEntryPrice * filledQty);
  state.consumedBidsBySide[position.side] = consumedClone;
  position.remainingQty -= filledQty;
  position.realizedProceeds += proceeds;
  position.exits.push({
    time: tick.ts,
    reason,
    qty: filledQty,
    proceeds,
    avgPrice: proceeds / filledQty,
    price: proceeds / filledQty,
    pnl,
    fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
  });
  if (position.remainingQty <= 0.000001) {
    position.remainingQty = 0;
    position.closed = true;
  }
  return true;
}

function maybeExitPosition(state, tick, params) {
  if (!state?.position || state.position.closed) return false;
  const position = state.position;
  const fields = sideFields(tick, position.side);
  const bid = fields.bid;
  if (bid == null || bid <= 0) return false;
  const rem = secondsRemaining(state, tick);
  const sideProb = position.side === 'UP' ? marketProbUp(tick) : 1 - marketProbUp(tick);

  if (bid >= params.takeProfitBid) return sellFromBook(state, tick, params, 'take_profit');
  if (bid >= params.catchUpMinBid && sideProb - position.entrySideProb >= params.exitCatchUpProb) {
    return sellFromBook(state, tick, params, 'elasticity_catchup');
  }
  if (rem <= params.lateExitSec && bid >= params.lateExitMinBid) {
    return sellFromBook(state, tick, params, 'late_bid_exit');
  }

  const latest = state.samples[state.samples.length - 1];
  const reversalSample = sampleAgo(state.samples, params.reversalSec);
  if (latest && reversalSample) {
    const sideSign = position.side === 'UP' ? 1 : -1;
    const reversalMove = sideSign * (latest.btc - reversalSample.btc);
    if (reversalMove <= -params.reversalShockAbs && bid >= params.stopMinBid) {
      return sellFromBook(state, tick, params, 'impulse_reversal_stop');
    }
  }
  if (bid <= params.stopBid && bid >= params.stopMinBid) {
    return sellFromBook(state, tick, params, 'bid_stop');
  }
  return false;
}

function computeAdvancedMetrics(events, params, totalPnl, totalEntries, totalWins, totalLosses) {
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
  const riskUnits = avgLoss > 0 ? Math.max(1, Math.floor(params.walletSize / avgLoss)) : 99;
  const ruinBase = payoff > 0 && winProbability > 0 ? lossProbability / Math.max(0.000001, winProbability * payoff) : 1;

  return {
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    payoff,
    expectancy: avgPnl,
    sharpe: pnlStd > 0 ? avgPnl / pnlStd : 0,
    sortino: downsideStd > 0 ? avgPnl / downsideStd : 0,
    riskOfRuin: edgePerTrade > 0 ? clamp01(Math.pow(clamp01(ruinBase), riskUnits)) : 1,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeImpulseElasticityParams(rawParams);
  const log = [];
  const events = [];
  const equity = [];
  const completedEvents = new Set();

  let current = null;
  let totalEvents = 0;
  let totalEntries = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalNoEntry = 0;
  let totalPnl = 0;
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;

  const addLog = (ts, msg, type = 'info') => {
    log.push({ ts, msg, type });
  };

  const equityNow = () => Math.max(0, params.walletSize + totalPnl);

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    completedEvents.add(eventKey(current));
    const position = current.position;
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();

    if (!position) {
      totalNoEntry++;
      events.push({
        eventId: current.eventId,
        eventStart: current.eventStart,
        eventEnd: current.eventEnd.toISOString(),
        positionType: null,
        entryTime: null,
        entryDistanceToPtb: null,
        entryTimeRemaining: null,
        quantity: 0,
        cost: 0,
        profitOrders: [],
        exits: [],
        expirationResult: null,
        winnerSide: null,
        expiryPnl: 0,
        finalPnl: 0,
        reason: 'no_entry',
        closedAt: ts,
        diagnostics: null,
      });
      equity.push({ ts, pnl: totalPnl });
      current = null;
      return;
    }

    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    const winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
    const settlementValue = position.remainingQty > 0 && position.side === winnerSide ? position.remainingQty : 0;
    const expiryPnl = settlementValue - (position.avgEntryPrice * position.remainingQty);
    const finalPnl = (current.realizedPnl || 0) + position.realizedProceeds + settlementValue - position.cost;

    totalPnl += finalPnl;
    totalEntries++;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    const expirationResult = finalPnl > 0 ? 'WIN' : finalPnl < 0 ? 'LOSS' : 'FLAT';
    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: position.side,
      entryTime: current.entry?.time ?? null,
      entryDistanceToPtb: current.entry ? Math.abs(current.entry.signedDistance) : null,
      entryTimeRemaining: current.entry?.timeRemainingSec ?? null,
      quantity: position.qty,
      cost: position.cost,
      avgEntryPrice: position.avgEntryPrice,
      fills: position.fills.map((fill) => ({ ...fill })),
      profitOrders: [],
      exits: [...current.exits.map((exit) => ({ ...exit })), ...position.exits.map((exit) => ({ ...exit }))],
      reversals: current.reversals.map((reversal) => ({ ...reversal, entryFills: reversal.entryFills.map((fill) => ({ ...fill })) })),
      expirationResult,
      winnerSide,
      expiryPnl,
      finalPnl,
      reason,
      closedAt: ts,
      diagnostics: current.entry ? { ...current.entry } : null,
    });
    equity.push({ ts, pnl: totalPnl });
    addLog(
      ts,
      `EVENTO FIN | Impulse Elasticity ${position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
    current = null;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    const candidate = scoreCandidate(current, tick, params);
    if (!candidate) return;

    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const targetValue = Math.min(params.maxOrderValue, equityNow());
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return;

    const fallbackKey = `${tick.ts}:impulse-elasticity:${candidate.side}:entry`;
    const availableQty = availableAskQty(
      candidate.fields.rawAsks,
      maxFillPrice,
      candidate.fields.ask,
      params.fallbackBookSize,
      fallbackKey,
    );
    if (availableQty < targetQty * params.minLiquidityRatio) return;

    const consumedClone = new Map(current.consumedAsksBySide[candidate.side]);
    const fills = consumeAsksFromTick(
      candidate.fields.rawAsks,
      maxFillPrice,
      targetQty,
      consumedClone,
      candidate.fields.ask,
      params.fallbackBookSize,
      fallbackKey,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < params.minShares || totalCost <= 0 || totalCost > targetValue + 0.000001) return;

    current.consumedAsksBySide[candidate.side] = consumedClone;
    current.position = {
      side: candidate.side,
      qty: filledQty,
      remainingQty: filledQty,
      cost: totalCost,
      avgEntryPrice: totalCost / filledQty,
      entrySideProb: candidate.marketProbability,
      realizedProceeds: 0,
      exits: [],
      fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
      closed: false,
    };
    current.entry = {
      time: tick.ts,
      side: candidate.side,
      qty: filledQty,
      cost: totalCost,
      avgEntryPrice: totalCost / filledQty,
      ask: candidate.ask,
      bid: candidate.bid,
      spread: candidate.spread,
      askSum: candidate.askSum,
      timeRemainingSec: candidate.rem,
      signedDistance: candidate.signedDistance,
      shockAbs: candidate.shockAbs,
      shockZ: candidate.shockZ,
      sideShock: candidate.sideShock,
      sideResponse: candidate.sideResponse,
      inertia: candidate.inertia,
      overreaction: candidate.overreaction,
      compressionBoost: candidate.compressionBoost,
      modelProbability: candidate.modelProbability,
      terminalProbability: candidate.terminalProbability,
      modelEdge: candidate.modelEdge,
      decisionMetric: candidate.decisionMetric,
      liquidityRatio: candidate.liquidityRatio,
      marketProbability: candidate.marketProbability,
      sigmaTau: candidate.sigmaTau,
      carry: candidate.carry,
    };

    addLog(
      tick.ts,
      `ENTRADA IE | ${candidate.side} ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | shock $${candidate.shockAbs.toFixed(2)} | resp ${(candidate.sideResponse * 100).toFixed(1)}pp | prob ${(candidate.modelProbability * 100).toFixed(1)}% | edge ${(candidate.modelEdge * 100).toFixed(1)}pp | ${Math.round(candidate.rem)}s`,
      'entry',
    );
  };

  const attemptStopReverse = (tick) => {
    if (!current?.position || current.position.closed) return false;
    const position = current.position;
    const fields = sideFields(tick, position.side);
    const bid = fields.bid;
    if (bid == null || bid < params.stopReverseMinBid || position.remainingQty < params.minShares) return false;
    const timeRemainingSec = secondsRemaining(current, tick);
    const signal = stopReverseTrigger({
      tick,
      priceToBeat: current.priceToBeat,
      positionSide: position.side,
      timeRemainingSec,
      attempts: current.stopReverseCount,
      params,
    });
    if (!signal) return false;

    const reverseFields = sideFields(tick, signal.toSide);
    if (reverseFields.ask == null || reverseFields.ask <= 0) return false;

    const exitMinPrice = Math.max(0.001, bid - params.exitSlippageMax);
    const exitFallbackKey = `${tick.ts}:impulse-elasticity:stop-reverse-exit:${position.side}`;
    const availableExitQty = availableBidQty(fields.rawBids, exitMinPrice, bid, params.fallbackBookSize, exitFallbackKey);
    if (availableExitQty < position.remainingQty * 0.999) return false;

    const budget = stopReverseBudget({
      params,
      maxOrderValue: params.maxOrderValue,
      equityNow: equityNow(),
      totalCost: position.cost,
      openCost: position.avgEntryPrice * position.remainingQty,
      proceeds: position.remainingQty * bid,
    });
    const maxFillPrice = Math.min(params.stopReverseMaxAsk, reverseFields.ask + params.stopReverseSlippageMax);
    const targetQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return false;

    const entryFallbackKey = `${tick.ts}:impulse-elasticity:stop-reverse-entry:${signal.toSide}`;
    const availableEntryQty = availableAskQty(reverseFields.rawAsks, maxFillPrice, reverseFields.ask, params.fallbackBookSize, entryFallbackKey);
    if (availableEntryQty < targetQty * params.stopReverseMinLiquidityRatio) return false;

    const consumedClone = new Map(current.consumedAsksBySide[signal.toSide]);
    const entryFills = consumeAsksFromTick(
      reverseFields.rawAsks,
      maxFillPrice,
      targetQty,
      consumedClone,
      reverseFields.ask,
      params.fallbackBookSize,
      entryFallbackKey,
    );
    const entryQty = entryFills.reduce((sum, fill) => sum + fill.qty, 0);
    const entryCost = entryFills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (entryQty < params.minShares || entryCost <= 0 || entryCost > budget + 0.000001) return false;

    const fromSide = position.side;
    const fromCost = position.cost;
    const closed = sellFromBook(current, tick, params, 'stop_reverse_exit');
    if (!closed || !position.closed) return false;
    const exitPnl = position.realizedProceeds - fromCost;
    current.realizedPnl += exitPnl;
    current.exits.push(...position.exits.map((exit) => ({ ...exit, side: fromSide })));
    current.consumedAsksBySide[signal.toSide] = consumedClone;
    const timedEntryFills = entryFills.map((fill) => ({ ...fill, time: tick.ts }));
    current.position = {
      side: signal.toSide,
      qty: entryQty,
      remainingQty: entryQty,
      cost: entryCost,
      avgEntryPrice: entryCost / entryQty,
      entrySideProb: signal.toSide === 'UP' ? marketProbUp(tick) : 1 - marketProbUp(tick),
      realizedProceeds: 0,
      exits: [],
      fills: timedEntryFills,
      closed: false,
    };
    current.entry = {
      ...(current.entry || {}),
      time: tick.ts,
      side: signal.toSide,
      qty: entryQty,
      cost: entryCost,
      avgEntryPrice: entryCost / entryQty,
      ask: reverseFields.ask,
      bid: reverseFields.bid,
      timeRemainingSec: signal.timeRemainingSec,
      signedDistance: signal.adverseDistance,
      stopReverse: true,
    };
    current.stopReverseCount++;
    current.reversals.push({
      time: tick.ts,
      fromSide,
      toSide: signal.toSide,
      soldQty: position.qty,
      exitPrice: position.realizedProceeds / Math.max(0.000001, position.qty),
      exitProceeds: position.realizedProceeds,
      exitPnl,
      adverseDistance: signal.adverseDistance,
      timeRemainingSec: signal.timeRemainingSec,
      budget,
      entryQty,
      entryCost,
      avgEntryPrice: entryCost / entryQty,
      entryFills: timedEntryFills,
    });
    addLog(tick.ts, `STOP REVERSE IE | ${fromSide}->${signal.toSide} | saiu ${formatQty(position.qty)} @ ${formatPrice(position.realizedProceeds / Math.max(0.000001, position.qty))} | entrou ${formatQty(entryQty)} @ ${formatPrice(entryCost / entryQty)} | dist $${signal.adverseDistance.toFixed(2)} | ${Math.round(signal.timeRemainingSec)}s`, 'stop');
    return true;
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
      current = createEventState(tick);
      totalEvents++;
      addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | Impulse Elasticity V1`, 'info');
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

    if (attemptStopReverse(tick)) return;

    if (maybeExitPosition(current, tick, params) && current?.position?.closed) {
      const lastExit = current.position.exits[current.position.exits.length - 1];
      addLog(
        tick.ts,
        `SAIDA IE | ${current.position.side} ${formatQty(lastExit.qty)} @ ${formatPrice(lastExit.avgPrice)} | ${lastExit.reason} | PnL ${lastExit.pnl >= 0 ? '+' : ''}$${lastExit.pnl.toFixed(2)}`,
        lastExit.pnl >= 0 ? 'profit' : 'stop',
      );
      finalizeCurrentEvent(lastExit.reason, tick.ts);
      return;
    }

    maybeEnter(tick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd.toISOString());
    const enteredEvents = events.filter((item) => item.reason !== 'no_entry');
    const winRate = totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0;
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

    const advanced = computeAdvancedMetrics(events, params, totalPnl, totalEntries, totalWins, totalLosses);
    return {
      params,
      strategy: 'IMPULSE_ELASTICITY_V1',
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins,
        totalLosses,
        winRate: parseFloat(winRate.toFixed(1)),
        totalPnl,
        avgPnl,
        maxWin,
        maxLoss,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
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

function runImpulseElasticityBacktest(rawParams, ticks) {
  const runner = createImpulseElasticityBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runImpulseElasticityBacktestInBatches(rawParams, tickBatches) {
  const runner = createImpulseElasticityBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
