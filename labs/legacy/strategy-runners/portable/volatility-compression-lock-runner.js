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
  entryWindowStart: 110,
  entryWindowEnd: 20,
  minAheadDist: 15,
  maxAheadDist: 60,
  minAsk: 0.05,
  maxAsk: 0.50,
  maxSpread: 0.10,
  minOddsSum: 0.95,
  maxOddsSum: 1.10,
  minModelEdge: 0.08,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.60,
  fallbackBookSize: 0,
  fastVolLookbackSec: 10,
  fastVolThreshold: 3.0,
  minSigma: 2.0,
  stopIfCrossed: false,
  stopCrossDist: -2,
  stopMinBid: 0.04,
  allowedPositionSide: 'BOTH',
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

function normalizeAllowedPositionSide(value) {
  const side = String(value || 'BOTH').toUpperCase();
  return ['BOTH', 'UP', 'DOWN'].includes(side) ? side : 'BOTH';
}

function mergeVclParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'maxOrderValue', 'minShares', 'entryWindowStart', 'entryWindowEnd',
    'minAheadDist', 'maxAheadDist', 'minAsk', 'maxAsk', 'maxSpread', 'minOddsSum',
    'maxOddsSum', 'minModelEdge', 'entrySlippageMax', 'minLiquidityRatio', 'fallbackBookSize',
    'fastVolLookbackSec', 'fastVolThreshold', 'minSigma', 'stopCrossDist', 'stopMinBid',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.walletSize = Math.max(1, params.walletSize);
  params.maxOrderValue = Math.max(0.01, params.maxOrderValue);
  params.minShares = Math.max(0.000001, params.minShares);
  params.entryWindowStart = clamp(params.entryWindowStart, 0, 300);
  params.entryWindowEnd = clamp(params.entryWindowEnd, 0, 300);
  if (params.entryWindowStart < params.entryWindowEnd) {
    [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  }
  params.minAheadDist = Math.max(0, params.minAheadDist);
  params.maxAheadDist = Math.max(0, params.maxAheadDist);
  if (params.maxAheadDist < params.minAheadDist) {
    [params.maxAheadDist, params.minAheadDist] = [params.minAheadDist, params.maxAheadDist];
  }
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.minOddsSum = clamp(params.minOddsSum, 0.01, 1.99);
  params.maxOddsSum = clamp(params.maxOddsSum, 0.01, 1.99);
  if (params.maxOddsSum < params.minOddsSum) {
    [params.maxOddsSum, params.minOddsSum] = [params.minOddsSum, params.maxOddsSum];
  }
  params.minModelEdge = clamp(params.minModelEdge, -0.99, 0.99);
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.fallbackBookSize = Math.max(0, params.fallbackBookSize);
  params.fastVolLookbackSec = clamp(params.fastVolLookbackSec, 3, 90);
  params.fastVolThreshold = Math.max(0.1, params.fastVolThreshold);
  params.minSigma = Math.max(0.1, params.minSigma);
  params.stopIfCrossed = toBool(raw.stopIfCrossed, params.stopIfCrossed);
  params.stopCrossDist = clamp(params.stopCrossDist, -1000, 1000);
  params.stopMinBid = normalizePrice(params.stopMinBid, DEFAULT_PARAMS.stopMinBid);
  params.allowedPositionSide = normalizeAllowedPositionSide(raw.allowedPositionSide ?? params.allowedPositionSide);
  applyStopReverseParams(params, raw);
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
  state.samples.push({ timeMs, ts: tick.ts, btc: toFiniteNumber(tick.btc_price) });
  while (state.samples.length > 1 && timeMs - state.samples[0].timeMs > 90000) {
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
    position: null,
    entry: null,
    realizedPnl: 0,
    exits: [],
    reversals: [],
    stopReverseCount: 0,
  };
}

function vclModelForSide(state, tick, side, params) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  const latest = state.samples[state.samples.length - 1];
  if (btcPrice == null || priceToBeat == null || !latest) {
    return { probability: 0.5, sigmaFast: params.minSigma, signedDistance: 0, rawVol: 0 };
  }

  const signedSide = side === 'UP' ? 1 : -1;
  const signedDistance = signedSide * (btcPrice - priceToBeat);
  const timeRemainingSec = Math.max(1, secondsRemaining(state, tick));
  const rawVol = recentVol(state.samples, params.fastVolLookbackSec);
  const sigmaFast = Math.max(params.minSigma, rawVol * Math.sqrt(timeRemainingSec));
  
  const z = signedDistance / sigmaFast;
  const probability = clamp(normalCdf(z), 0.001, 0.999);
  
  return { probability, sigmaFast, signedDistance, rawVol, z };
}

function scoreCandidates(state, tick, params) {
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  const askSum = (upFields.ask ?? 0.5) + (downFields.ask ?? 0.5);
  if (askSum < params.minOddsSum || askSum > params.maxOddsSum) return [];
  const marketUp = marketProbUp(tick);

  return ['UP', 'DOWN']
    .filter((side) => params.allowedPositionSide === 'BOTH' || params.allowedPositionSide === side)
    .map((side) => {
      const fields = side === 'UP' ? upFields : downFields;
      const ask = fields.ask;
      const bid = fields.bid;
      const model = vclModelForSide(state, tick, side, params);
      const marketProbability = side === 'UP' ? marketUp : 1 - marketUp;
      const spread = ask != null && bid != null ? Math.max(0, ask - bid) : Number.POSITIVE_INFINITY;
      const modelEdge = ask != null ? model.probability - ask : Number.NEGATIVE_INFINITY;
      const marketLag = model.probability - marketProbability;
      
      const volRatio = clamp(model.rawVol / params.fastVolThreshold, 0.0001, 1.0);
      const compressionScore = modelEdge * (1 - volRatio) / Math.max(0.01, spread);
      
      return {
        side,
        fields,
        ask,
        bid,
        askSum,
        spread,
        timeRemainingSec: secondsRemaining(state, tick),
        modelProbability: model.probability,
        modelEdge,
        marketProbability,
        marketLag,
        sigmaFast: model.sigmaFast,
        rawVol: model.rawVol,
        signedDistance: model.signedDistance,
        compressionScore,
      };
    })
    .filter((candidate) => {
      if (candidate.ask == null || candidate.bid == null) return false;
      if (candidate.timeRemainingSec > params.entryWindowStart || candidate.timeRemainingSec < params.entryWindowEnd) return false;
      if (candidate.signedDistance < params.minAheadDist || candidate.signedDistance > params.maxAheadDist) return false;
      if (candidate.ask < params.minAsk || candidate.ask > params.maxAsk) return false;
      if (candidate.spread > params.maxSpread) return false;
      if (candidate.rawVol > params.fastVolThreshold) return false;
      if (candidate.modelProbability < 0.70) return false;
      if (candidate.modelEdge < params.minModelEdge) return false;
      
      return true;
    })
    .sort((left, right) => right.compressionScore - left.compressionScore || right.modelEdge - left.modelEdge);
}

function formatPrice(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatQty(value) {
  const numberValue = Number(value || 0);
  return Number.isInteger(numberValue) ? String(numberValue) : numberValue.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
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
  const params = mergeVclParams(rawParams);
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
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();

    if (!current.position) {
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

    let winnerSide = null;
    let expiryPnl = 0;
    let finalPnl = current.realizedPnl || 0;
    const exit = current.position.exit ? { ...current.position.exit } : null;

    if (current.position.closed) {
      finalPnl += current.position.realizedPnl;
    } else {
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      const btcPrice = toFiniteNumber(tick.btc_price);
      winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
      expiryPnl = current.position.side === winnerSide
        ? current.position.qty - current.position.cost
        : -current.position.cost;
      finalPnl += expiryPnl;
    }

    totalPnl += finalPnl;
    totalEntries++;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    const expirationResult = finalPnl > 0 ? 'WIN' : finalPnl < 0 ? 'LOSS' : 'FLAT';
    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: current.position.side,
      entryTime: current.entry?.time ?? null,
      entryDistanceToPtb: current.entry ? Math.abs(current.entry.signedDistance) : null,
      entryTimeRemaining: current.entry?.timeRemainingSec ?? null,
      quantity: current.position.qty,
      cost: current.position.cost,
      avgEntryPrice: current.position.avgEntryPrice,
      fills: current.position.fills.map((fill) => ({ ...fill })),
      profitOrders: [],
      exits: [...current.exits.map((item) => ({ ...item })), ...(exit ? [exit] : [])],
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
      `EVENTO FIN | VCL ${current.position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
    current = null;
  };

  const maybeClosePosition = (tick) => {
    if (!current?.position || current.position.closed) return false;
    const fields = sideFields(tick, current.position.side);
    const bid = fields.bid;
    if (bid == null || bid <= 0) return false;

    const timeRemainingSec = secondsRemaining(current, tick);

    const tryStopReverse = (signal) => {
      if (bid < params.stopReverseMinBid) return false;
      const reverseFields = sideFields(tick, signal.toSide);
      if (reverseFields.ask == null || reverseFields.ask <= 0) return false;

      const exitQty = current.position.qty;
      const exitPnl = (bid * exitQty) - current.position.cost;
      const budget = stopReverseBudget({
        params,
        maxOrderValue: params.maxOrderValue,
        equityNow: equityNow(),
        totalCost: current.position.cost,
        openCost: current.position.cost,
        proceeds: bid * exitQty,
      });
      const maxFillPrice = Math.min(params.stopReverseMaxAsk, reverseFields.ask + params.stopReverseSlippageMax);
      const targetQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));
      if (targetQty < params.minShares) return false;

      const fallbackKey = `${tick.ts}:vcl:stop-reverse:${signal.toSide}`;
      const availableQty = availableAskQty(reverseFields.rawAsks, maxFillPrice, reverseFields.ask, params.fallbackBookSize, fallbackKey);
      if (availableQty < targetQty * params.stopReverseMinLiquidityRatio) return false;

      const consumedClone = new Map(current.consumedAsksBySide[signal.toSide]);
      const fills = consumeAsksFromTick(
        reverseFields.rawAsks,
        maxFillPrice,
        targetQty,
        consumedClone,
        reverseFields.ask,
        params.fallbackBookSize,
        fallbackKey,
      );
      const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
      const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
      if (filledQty < params.minShares || totalCost <= 0 || totalCost > budget + 0.000001) return false;

      const fromSide = current.position.side;
      current.realizedPnl += exitPnl;
      current.exits.push({ time: tick.ts, qty: exitQty, price: bid, pnl: exitPnl, reason: 'stop_reverse_exit', side: fromSide });
      current.consumedAsksBySide[signal.toSide] = consumedClone;
      const timedFills = fills.map((fill) => ({ ...fill, time: tick.ts }));
      current.position = {
        side: signal.toSide,
        qty: filledQty,
        cost: totalCost,
        avgEntryPrice: totalCost / filledQty,
        fills: timedFills,
        closed: false,
      };
      current.entry = {
        ...(current.entry || {}),
        time: tick.ts,
        side: signal.toSide,
        qty: filledQty,
        cost: totalCost,
        avgEntryPrice: totalCost / filledQty,
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
        soldQty: exitQty,
        exitPrice: bid,
        exitProceeds: bid * exitQty,
        exitPnl,
        adverseDistance: signal.adverseDistance,
        timeRemainingSec: signal.timeRemainingSec,
        budget,
        entryQty: filledQty,
        entryCost: totalCost,
        avgEntryPrice: totalCost / filledQty,
        entryFills: timedFills,
      });
      addLog(tick.ts, `STOP REVERSE | ${fromSide}->${signal.toSide} | saiu ${formatQty(exitQty)} @ ${formatPrice(bid)} | entrou ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | dist $${signal.adverseDistance.toFixed(2)} | ${Math.round(signal.timeRemainingSec)}s`, 'stop');
      return true;
    };

    const reverseSignal = stopReverseTrigger({
      tick,
      priceToBeat: current.priceToBeat,
      positionSide: current.position.side,
      timeRemainingSec,
      attempts: current.stopReverseCount,
      params,
    });
    if (reverseSignal && tryStopReverse(reverseSignal)) return true;

    if (params.stopIfCrossed) {
      const btcPrice = toFiniteNumber(tick.btc_price);
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      if (btcPrice != null && priceToBeat != null) {
        const signedSide = current.position.side === 'UP' ? 1 : -1;
        const signedDistance = signedSide * (btcPrice - priceToBeat);
        if (signedDistance <= params.stopCrossDist && bid >= params.stopMinBid) {
          const pnl = (bid * current.position.qty) - current.position.cost;
          current.position.closed = true;
          current.position.realizedPnl = pnl;
          current.position.exit = { time: tick.ts, qty: current.position.qty, price: bid, pnl, reason: 'cross_stop' };
          addLog(tick.ts, `CROSS STOP | ${current.position.side} ${formatQty(current.position.qty)} @ ${formatPrice(bid)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? 'profit' : 'stop');
          finalizeCurrentEvent('cross_stop', tick.ts);
          return true;
        }
      }
    }

    return false;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    const candidates = scoreCandidates(current, tick, params);
    const candidate = candidates[0];
    if (!candidate) return;

    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const targetValue = Math.min(params.maxOrderValue, equityNow());
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return;

    const fallbackKey = `${tick.ts}:vcl:${candidate.side}`;
    const availableQty = availableAskQty(candidate.fields.rawAsks, maxFillPrice, candidate.fields.ask, params.fallbackBookSize, fallbackKey);
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
      cost: totalCost,
      avgEntryPrice: totalCost / filledQty,
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
      timeRemainingSec: candidate.timeRemainingSec,
      signedDistance: candidate.signedDistance,
      modelProbability: candidate.modelProbability,
      modelEdge: candidate.modelEdge,
      marketProbability: candidate.marketProbability,
      marketLag: candidate.marketLag,
      rawVol: candidate.rawVol,
      sigmaFast: candidate.sigmaFast,
      compressionScore: candidate.compressionScore,
    };

    addLog(
      tick.ts,
      `ENTRADA VCL | ${candidate.side} ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | prob ${(candidate.modelProbability * 100).toFixed(1)}% | edge ${(candidate.modelEdge * 100).toFixed(1)}pp | vol ${candidate.rawVol.toFixed(3)} | dist $${candidate.signedDistance.toFixed(2)} | ${Math.round(candidate.timeRemainingSec)}s`,
      'entry',
    );
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

    if (maybeClosePosition(tick)) return;
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
      strategy: 'VOLATILITY_COMPRESSION_LOCK_V1',
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

function runVolatilityCompressionLockBacktest(rawParams, ticks) {
  const runner = createVolatilityCompressionLockBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runVolatilityCompressionLockBacktestInBatches(rawParams, tickBatches) {
  const runner = createVolatilityCompressionLockBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
