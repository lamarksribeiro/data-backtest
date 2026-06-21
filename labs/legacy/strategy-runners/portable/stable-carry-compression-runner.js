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
  entryWindowStart: 120,
  entryWindowEnd: 30,
  fastLookbackSec: 10,
  slowLookbackSec: 30,
  maxCurveAbs: 0.025,
  minAsk: 0.70,
  maxAsk: 0.82,
  maxSpread: 0.05,
  minOddsSum: 0.99,
  maxOddsSum: 1.06,
  minDistanceAbs: 20,
  maxDistanceAbs: 100,
  minBtcSupport: 5,
  minDecisionMetric: 0,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.65,
  fallbackBookSize: 0,
  profitExitBid: 0.88,
  stopBid: 0,
  exitSlippageMax: 0.02,
  exitLiquidityRatio: 0.65,
  allowedPositionSide: 'BOTH',
};

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
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

function normalizePrice(value, fallback) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return fallback;
  return clamp(numberValue, 0.001, 0.999);
}

function normalizeAllowedPositionSide(value) {
  const side = String(value || 'BOTH').toUpperCase();
  return ['BOTH', 'UP', 'DOWN'].includes(side) ? side : 'BOTH';
}

function mergeStableCarryCompressionParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize',
    'maxOrderValue',
    'minShares',
    'entryWindowStart',
    'entryWindowEnd',
    'fastLookbackSec',
    'slowLookbackSec',
    'maxCurveAbs',
    'minAsk',
    'maxAsk',
    'maxSpread',
    'minOddsSum',
    'maxOddsSum',
    'minDistanceAbs',
    'maxDistanceAbs',
    'minBtcSupport',
    'minDecisionMetric',
    'entrySlippageMax',
    'minLiquidityRatio',
    'fallbackBookSize',
    'profitExitBid',
    'stopBid',
    'exitSlippageMax',
    'exitLiquidityRatio',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.allowedPositionSide = normalizeAllowedPositionSide(raw.allowedPositionSide ?? params.allowedPositionSide);
  params.walletSize = Math.max(1, params.walletSize);
  params.maxOrderValue = Math.max(0.01, params.maxOrderValue);
  params.minShares = Math.max(0.000001, params.minShares);
  params.entryWindowStart = clamp(params.entryWindowStart, 0, 300);
  params.entryWindowEnd = clamp(params.entryWindowEnd, 0, 300);
  if (params.entryWindowStart < params.entryWindowEnd) {
    [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  }
  params.fastLookbackSec = clamp(params.fastLookbackSec, 1, 120);
  params.slowLookbackSec = clamp(params.slowLookbackSec, params.fastLookbackSec, 240);
  params.maxCurveAbs = Math.max(0, params.maxCurveAbs);
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.minOddsSum = clamp(params.minOddsSum, 0.01, 1.99);
  params.maxOddsSum = clamp(params.maxOddsSum, params.minOddsSum, 1.99);
  params.minDistanceAbs = Math.max(0, params.minDistanceAbs);
  params.maxDistanceAbs = Math.max(params.minDistanceAbs, params.maxDistanceAbs);
  params.minBtcSupport = Math.max(0, params.minBtcSupport);
  params.minDecisionMetric = Math.max(0, params.minDecisionMetric);
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.fallbackBookSize = Math.max(0, params.fallbackBookSize);
  params.profitExitBid = params.profitExitBid > 0 ? normalizePrice(params.profitExitBid, 0) : 0;
  params.stopBid = params.stopBid > 0 ? normalizePrice(params.stopBid, 0) : 0;
  params.exitSlippageMax = clamp(params.exitSlippageMax, 0, 0.99);
  params.exitLiquidityRatio = clamp(params.exitLiquidityRatio, 0.01, 1);
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

function consumeAskValue(rawAsks, maxPrice, valueBudget, consumedByPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackLevel(parseBookLevels(rawAsks, 'ask'), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
  if (!levels.length || valueBudget <= 0) return [];
  pruneConsumedByVisibleLevels(levels, consumedByPrice);

  const fills = [];
  let remainingValue = valueBudget;
  for (const level of levels) {
    if (remainingValue <= 0) break;
    if (level.price > maxPrice) continue;
    const reservedQty = Math.min(consumedByPrice.get(level.key) || 0, level.size);
    if (reservedQty > 0) consumedByPrice.set(level.key, reservedQty);
    else consumedByPrice.delete(level.key);
    const availableQty = level.size - reservedQty;
    if (availableQty <= 0) continue;
    const fillQty = Math.min(availableQty, remainingValue / level.price);
    if (fillQty <= 0) continue;
    consumedByPrice.set(level.key, reservedQty + fillQty);
    fills.push({ price: level.price, qty: fillQty });
    remainingValue -= fillQty * level.price;
  }
  return fills;
}

function availableBidQty(rawBids, minPrice, fallbackBestBid, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackLevel(parseBookLevels(rawBids, 'bid'), fallbackBestBid, fallbackBookSize, fallbackKeySuffix);
  return levels.reduce((sum, level) => sum + (level.price >= minPrice ? level.size : 0), 0);
}

function consumeBidQty(rawBids, minPrice, requestedQty, consumedByPrice, fallbackBestBid, fallbackBookSize, fallbackKeySuffix) {
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
      ask: toFiniteNumber(tick.up_best_ask, fallbackPrice),
      bid: toFiniteNumber(tick.up_best_bid, fallbackPrice),
      rawAsks: tick.up_book_asks,
      rawBids: tick.up_book_bids,
      price: fallbackPrice,
    };
  }
  const fallbackPrice = toFiniteNumber(tick.down_price);
  return {
    ask: toFiniteNumber(tick.down_best_ask, fallbackPrice),
    bid: toFiniteNumber(tick.down_best_bid, fallbackPrice),
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
  if (upMid == null || downMid == null || upMid + downMid <= 0) return null;
  return clamp(upMid / (upMid + downMid), 0.001, 0.999);
}

function formatQty(value) {
  const numberValue = Number(value || 0);
  return Number.isInteger(numberValue) ? String(numberValue) : numberValue.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function eventKey(tickOrState) {
  const rawEventStart = tickOrState.event_start ?? tickOrState.eventStart;
  const eventStart = rawEventStart instanceof Date ? rawEventStart.toISOString() : new Date(rawEventStart).toISOString();
  return `${eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEndMs - new Date(tick.ts).getTime()) / 1000);
}

function sampleAgo(samples, seconds, latestTimeMs) {
  if (!samples.length) return null;
  const targetMs = latestTimeMs - (seconds * 1000);
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index].timeMs <= targetMs) return samples[index];
  }
  return null;
}

function addSample(state, tick, currentMarketUp) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(tick.price_to_beat ?? state.priceToBeat);
  if (btcPrice == null || priceToBeat == null || currentMarketUp == null) return;
  const timeMs = new Date(tick.ts).getTime();
  state.samples.push({ timeMs, btcPrice, priceToBeat, marketUp: currentMarketUp });
  const minTimeMs = timeMs - 240000;
  while (state.samples.length && state.samples[0].timeMs < minTimeMs) state.samples.shift();
}

function createEventState(tick) {
  const eventStartMs = new Date(tick.event_start).getTime();
  return {
    eventId: tick.condition_id,
    eventStart: new Date(tick.event_start).toISOString(),
    eventEndMs: eventStartMs + 300000,
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
    lastDiagnostics: null,
  };
}

function closeReasonFromPnl(pnl) {
  if (pnl > 0) return 'WIN';
  if (pnl < 0) return 'LOSS';
  return 'FLAT';
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
  const params = mergeStableCarryCompressionParams(rawParams);
  const log = [];
  const events = [];
  const equity = [];
  const completedEvents = new Set();

  let current = null;
  let totalEvents = 0;
  let totalNoEntry = 0;
  let totalEntries = 0;
  let totalWins = 0;
  let totalLosses = 0;
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
    const closedAt = closeTs || new Date(current.eventEndMs).toISOString();

    if (!current.position) {
      totalNoEntry++;
      events.push({
        eventId: current.eventId,
        eventStart: current.eventStart,
        eventEnd: new Date(current.eventEndMs).toISOString(),
        positionType: null,
        entryTime: null,
        entryDistanceToPtb: null,
        entryTimeRemaining: null,
        quantity: 0,
        cost: 0,
        avgEntryPrice: 0,
        fills: [],
        exits: [],
        expirationResult: null,
        winnerSide: null,
        expiryPnl: 0,
        finalPnl: 0,
        reason: 'no_entry',
        closedAt,
        diagnostics: current.lastDiagnostics,
      });
      equity.push({ ts: closedAt, pnl: totalPnl });
      current = null;
      return;
    }

    const position = current.position;
    let finalPnl = (current.realizedPnl || 0) + (position.realizedPnl || 0);
    let expiryPnl = 0;
    let winnerSide = null;

    if (!position.closed) {
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      const btcPrice = toFiniteNumber(tick.btc_price);
      winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
      const settlementValue = position.side === winnerSide ? position.remainingQty : 0;
      expiryPnl = settlementValue - position.openCost;
      finalPnl += expiryPnl;
      position.remainingQty = 0;
      position.openCost = 0;
      position.closed = true;
    }

    totalPnl += finalPnl;
    totalEntries++;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: new Date(current.eventEndMs).toISOString(),
      positionType: position.side,
      entryTime: current.entry.time,
      entryDistanceToPtb: current.entry.distanceAbs,
      entryTimeRemaining: current.entry.timeRemainingSec,
      quantity: position.qty,
      cost: position.cost,
      avgEntryPrice: position.avgEntryPrice,
      fills: position.fills.map((fill) => ({ ...fill })),
      exits: [...current.exits.map((exit) => ({ ...exit })), ...position.exits.map((exit) => ({ ...exit }))],
      reversals: current.reversals.map((reversal) => ({ ...reversal, entryFills: reversal.entryFills.map((fill) => ({ ...fill })) })),
      expirationResult: closeReasonFromPnl(finalPnl),
      winnerSide,
      expiryPnl,
      finalPnl,
      reason,
      closedAt,
      diagnostics: { ...current.entry },
    });
    equity.push({ ts: closedAt, pnl: totalPnl });
    addLog(
      closedAt,
      `EVENTO FIN | Stable Carry ${position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
    current = null;
  };

  const maybeExitPosition = (tick) => {
    if (!current?.position || current.position.closed) return false;
    const position = current.position;
    const fields = sideFields(tick, position.side);
    const bid = fields.bid;
    if (bid == null || bid <= 0) return false;
    const timeRemainingSec = secondsRemaining(current, tick);

    const tryStopReverse = (signal) => {
      if (bid < params.stopReverseMinBid || position.remainingQty < params.minShares) return false;
      const reverseFields = sideFields(tick, signal.toSide);
      if (reverseFields.ask == null || reverseFields.ask <= 0) return false;

      const exitMinPrice = Math.max(0.001, bid - params.exitSlippageMax);
      const exitFallbackKey = `${tick.ts}:stable-carry:stop-reverse-exit:${position.side}`;
      const availableExitQty = availableBidQty(fields.rawBids, exitMinPrice, bid, params.fallbackBookSize, exitFallbackKey);
      if (availableExitQty < position.remainingQty * 0.999) return false;

      const budget = stopReverseBudget({
        params,
        maxOrderValue: params.maxOrderValue,
        equityNow: equityNow(),
        totalCost: position.cost,
        openCost: position.openCost,
        proceeds: position.remainingQty * bid,
      });
      const maxFillPrice = Math.min(params.stopReverseMaxAsk, reverseFields.ask + params.stopReverseSlippageMax);
      const requestedQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));
      if (requestedQty < params.minShares) return false;

      const entryFallbackKey = `${tick.ts}:stable-carry:stop-reverse-entry:${signal.toSide}`;
      const availableEntryQty = availableAskQty(reverseFields.rawAsks, maxFillPrice, reverseFields.ask, params.fallbackBookSize, entryFallbackKey);
      if (availableEntryQty < requestedQty * params.stopReverseMinLiquidityRatio) return false;

      const bidConsumed = new Map(current.consumedBidsBySide[position.side]);
      const exitFills = consumeBidQty(
        fields.rawBids,
        exitMinPrice,
        position.remainingQty,
        bidConsumed,
        bid,
        params.fallbackBookSize,
        exitFallbackKey,
      );
      const exitQty = exitFills.reduce((sum, fill) => sum + fill.qty, 0);
      const proceeds = exitFills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
      if (exitQty < position.remainingQty * 0.999 || proceeds <= 0) return false;

      const askConsumed = new Map(current.consumedAsksBySide[signal.toSide]);
      const entryFills = consumeAskValue(
        reverseFields.rawAsks,
        maxFillPrice,
        budget,
        askConsumed,
        reverseFields.ask,
        params.fallbackBookSize,
        entryFallbackKey,
      );
      const entryQty = entryFills.reduce((sum, fill) => sum + fill.qty, 0);
      const entryCost = entryFills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
      if (entryQty < params.minShares || entryQty < requestedQty * params.stopReverseMinLiquidityRatio || entryCost <= 0 || entryCost > budget + 0.000001) return false;

      const avgOpenCost = position.openCost / Math.max(0.000001, position.remainingQty);
      const consumedCost = avgOpenCost * exitQty;
      const exitPnl = proceeds - consumedCost;
      const fromSide = position.side;
      current.consumedBidsBySide[fromSide] = bidConsumed;
      current.consumedAsksBySide[signal.toSide] = askConsumed;
      current.realizedPnl += exitPnl;
      current.exits.push({
        time: tick.ts,
        side: fromSide,
        qty: exitQty,
        avgPrice: proceeds / exitQty,
        proceeds,
        pnl: exitPnl,
        reason: 'stop_reverse_exit',
        fills: exitFills.map((fill) => ({ ...fill, time: tick.ts })),
      });
      const timedEntryFills = entryFills.map((fill) => ({ ...fill, time: tick.ts }));
      current.position = {
        side: signal.toSide,
        qty: entryQty,
        remainingQty: entryQty,
        cost: entryCost,
        openCost: entryCost,
        avgEntryPrice: entryCost / entryQty,
        fills: timedEntryFills,
        exits: [],
        realizedPnl: 0,
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
        distanceAbs: signal.adverseDistance,
        signedDistance: signal.adverseDistance,
        stopReverse: true,
      };
      current.stopReverseCount++;
      current.reversals.push({
        time: tick.ts,
        fromSide,
        toSide: signal.toSide,
        soldQty: exitQty,
        exitPrice: proceeds / exitQty,
        exitProceeds: proceeds,
        exitPnl,
        adverseDistance: signal.adverseDistance,
        timeRemainingSec: signal.timeRemainingSec,
        budget,
        entryQty,
        entryCost,
        avgEntryPrice: entryCost / entryQty,
        entryFills: timedEntryFills,
      });
      addLog(tick.ts, `STOP REVERSE | ${fromSide}->${signal.toSide} | saiu ${formatQty(exitQty)} @ $${(proceeds / exitQty).toFixed(4)} | entrou ${formatQty(entryQty)} @ $${(entryCost / entryQty).toFixed(4)} | dist $${signal.adverseDistance.toFixed(2)} | ${Math.round(signal.timeRemainingSec)}s`, 'stop');
      return true;
    };

    const reverseSignal = stopReverseTrigger({
      tick,
      priceToBeat: current.priceToBeat,
      positionSide: position.side,
      timeRemainingSec,
      attempts: current.stopReverseCount,
      params,
    });
    if (reverseSignal && tryStopReverse(reverseSignal)) return true;

    let exitReason = null;
    if (params.profitExitBid > 0 && bid >= params.profitExitBid) exitReason = 'profit_exit';
    if (!exitReason && params.stopBid > 0 && bid <= params.stopBid) exitReason = 'stop_bid';
    if (!exitReason) return false;

    const minExitPrice = Math.max(0.001, bid - params.exitSlippageMax);
    const availableQty = availableBidQty(
      fields.rawBids,
      minExitPrice,
      bid,
      params.fallbackBookSize,
      `${tick.ts}:stable-carry:exit:${position.side}`,
    );
    if (availableQty < position.remainingQty * params.exitLiquidityRatio) return false;

    const consumedClone = new Map(current.consumedBidsBySide[position.side]);
    const fills = consumeBidQty(
      fields.rawBids,
      minExitPrice,
      position.remainingQty,
      consumedClone,
      bid,
      params.fallbackBookSize,
      `${tick.ts}:stable-carry:exit:${position.side}`,
    );
    const exitQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const proceeds = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (exitQty < position.remainingQty * params.exitLiquidityRatio || proceeds <= 0) return false;

    current.consumedBidsBySide[position.side] = consumedClone;
    const avgOpenCost = position.openCost / Math.max(0.000001, position.remainingQty);
    const consumedCost = avgOpenCost * exitQty;
    const exitPnl = proceeds - consumedCost;
    position.realizedPnl += exitPnl;
    position.remainingQty -= exitQty;
    position.openCost = Math.max(0, position.openCost - consumedCost);
    position.exits.push({
      time: tick.ts,
      side: position.side,
      qty: exitQty,
      avgPrice: proceeds / exitQty,
      proceeds,
      pnl: exitPnl,
      reason: exitReason,
      fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
    });
    if (position.remainingQty <= 0.000001) {
      position.remainingQty = 0;
      position.closed = true;
      finalizeCurrentEvent(exitReason, tick.ts);
      return true;
    }
    return false;
  };

  const scoreSignal = (tick, currentMarketUp) => {
    if (!current || current.position) return null;
    const tickTimeMs = new Date(tick.ts).getTime();
    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return null;
    const fastSample = sampleAgo(current.samples, params.fastLookbackSec, tickTimeMs);
    const slowSample = sampleAgo(current.samples, params.slowLookbackSec, tickTimeMs);
    if (!fastSample || !slowSample || currentMarketUp == null) return null;

    const btcPrice = toFiniteNumber(tick.btc_price);
    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    if (btcPrice == null || priceToBeat == null) return null;

    const curvature = currentMarketUp - (2 * fastSample.marketUp) + slowSample.marketUp;
    const curveAbs = Math.abs(curvature);
    if (curveAbs > params.maxCurveAbs) return null;

    const theoreticalSide = currentMarketUp >= 0.5 ? 'UP' : 'DOWN';
    if (params.allowedPositionSide !== 'BOTH' && params.allowedPositionSide !== theoreticalSide) return null;
    const aheadSide = btcPrice > priceToBeat ? 'UP' : 'DOWN';
    if (theoreticalSide !== aheadSide) return null;

    const sideSign = theoreticalSide === 'UP' ? 1 : -1;
    const support = sideSign * (btcPrice - fastSample.btcPrice);
    if (support < params.minBtcSupport) return null;

    const distanceAbs = Math.abs(btcPrice - priceToBeat);
    if (distanceAbs < params.minDistanceAbs || distanceAbs > params.maxDistanceAbs) return null;

    const fields = sideFields(tick, theoreticalSide);
    const oppositeFields = sideFields(tick, theoreticalSide === 'UP' ? 'DOWN' : 'UP');
    if (fields.ask == null || fields.bid == null || oppositeFields.ask == null || oppositeFields.bid == null) return null;

    const spread = fields.ask - fields.bid;
    const oddsSum = toFiniteNumber(tick.up_best_ask) + toFiniteNumber(tick.down_best_ask);
    if (!Number.isFinite(oddsSum)) return null;
    if (fields.ask < params.minAsk || fields.ask > params.maxAsk) return null;
    if (spread > params.maxSpread) return null;
    if (oddsSum < params.minOddsSum || oddsSum > params.maxOddsSum) return null;

    const priceCenter = (params.minAsk + params.maxAsk) / 2;
    const pricePenalty = Math.abs(fields.ask - priceCenter) * 0.05;
    const carryStability = Math.max(0, params.maxCurveAbs - curveAbs);
    const carryBoost = Math.min(0.03, support / Math.max(1, params.maxDistanceAbs));
    const decisionMetric = carryStability + carryBoost - spread - pricePenalty;
    if (decisionMetric < params.minDecisionMetric) return null;

    return {
      side: theoreticalSide,
      fields,
      ask: fields.ask,
      bid: fields.bid,
      spread,
      oddsSum,
      timeRemainingSec,
      distanceAbs,
      signedDistance: theoreticalSide === 'UP' ? btcPrice - priceToBeat : priceToBeat - btcPrice,
      curvature,
      curveAbs,
      currentMarketUp,
      fastMarketUp: fastSample.marketUp,
      slowMarketUp: slowSample.marketUp,
      btcSupport: support,
      decisionMetric,
    };
  };

  const maybeEnter = (tick, currentMarketUp) => {
    const candidate = scoreSignal(tick, currentMarketUp);
    current.lastDiagnostics = candidate
      ? {
          side: candidate.side,
          ask: candidate.ask,
          spread: candidate.spread,
          oddsSum: candidate.oddsSum,
          curveAbs: candidate.curveAbs,
          btcSupport: candidate.btcSupport,
          timeRemainingSec: candidate.timeRemainingSec,
          decisionMetric: candidate.decisionMetric,
        }
      : current.lastDiagnostics;
    if (!candidate) return;

    const maxFillPrice = Math.min(0.999, candidate.ask + params.entrySlippageMax);
    const targetValue = Math.min(params.maxOrderValue, equityNow());
    const requestedQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (requestedQty < params.minShares) return;

    const fallbackKey = `${tick.ts}:stable-carry:entry:${candidate.side}`;
    const availableQty = availableAskQty(
      candidate.fields.rawAsks,
      maxFillPrice,
      candidate.fields.ask,
      params.fallbackBookSize,
      fallbackKey,
    );
    if (availableQty < requestedQty * params.minLiquidityRatio) return;

    const consumedClone = new Map(current.consumedAsksBySide[candidate.side]);
    const fills = consumeAskValue(
      candidate.fields.rawAsks,
      maxFillPrice,
      targetValue,
      consumedClone,
      candidate.fields.ask,
      params.fallbackBookSize,
      fallbackKey,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < params.minShares || totalCost <= 0 || totalCost > targetValue + 0.000001) return;
    if (filledQty < requestedQty * params.minLiquidityRatio) return;

    current.consumedAsksBySide[candidate.side] = consumedClone;
    current.position = {
      side: candidate.side,
      qty: filledQty,
      remainingQty: filledQty,
      cost: totalCost,
      openCost: totalCost,
      avgEntryPrice: totalCost / filledQty,
      fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
      exits: [],
      realizedPnl: 0,
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
      oddsSum: candidate.oddsSum,
      timeRemainingSec: candidate.timeRemainingSec,
      distanceAbs: candidate.distanceAbs,
      signedDistance: candidate.signedDistance,
      curvature: candidate.curvature,
      curveAbs: candidate.curveAbs,
      currentMarketUp: candidate.currentMarketUp,
      fastMarketUp: candidate.fastMarketUp,
      slowMarketUp: candidate.slowMarketUp,
      btcSupport: candidate.btcSupport,
      decisionMetric: candidate.decisionMetric,
    };

    addLog(
      tick.ts,
      `ENTRADA SCC | ${candidate.side} ${filledQty.toFixed(2)} @ $${(totalCost / filledQty).toFixed(4)} | curva ${candidate.curveAbs.toFixed(4)} | suporte $${candidate.btcSupport.toFixed(2)} | ${Math.round(candidate.timeRemainingSec)}s`,
      'entry',
    );
  };

  const processTick = (tick) => {
    ticksProcessed++;
    if (!periodStart) periodStart = tick.ts;
    periodEnd = tick.ts;

    const key = eventKey(tick);
    if (!current && completedEvents.has(key)) return;

    if (!current || key !== eventKey(current)) {
      if (current) finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
      if (completedEvents.has(key)) return;
      current = createEventState(tick);
      totalEvents++;
      addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | Stable Carry Compression V1`, 'info');
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);
    const tickTimeMs = new Date(tick.ts).getTime();
    if (tickTimeMs < new Date(current.eventStart).getTime()) return;

    const currentMarketUp = marketProbUp(tick);
    if (tickTimeMs >= current.eventEndMs) {
      addSample(current, tick, currentMarketUp);
      finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
      return;
    }

    if (maybeExitPosition(tick)) return;
    maybeEnter(tick, currentMarketUp);
    addSample(current, tick, currentMarketUp);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
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
      strategy: 'STABLE_CARRY_COMPRESSION_V1',
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

function runStableCarryCompressionBacktest(rawParams, ticks) {
  const runner = createStableCarryCompressionBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runStableCarryCompressionBacktestInBatches(rawParams, tickBatches) {
  const runner = createStableCarryCompressionBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
