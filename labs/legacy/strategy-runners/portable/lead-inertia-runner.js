const DEFAULT_PARAMS = {
  preset: 'lim-deep',
  walletSize: 200,
  maxOrderValue: 14,
  minShares: 5,
  entryWindowStart: 290,
  entryWindowEnd: 120,
  minLead: 120,
  maxLead: 600,
  minAsk: 0.55,
  maxAsk: 0.95,
  maxSpread: 0.18,
  minOddsSum: 0.92,
  maxOddsSum: 1.08,
  minFairProb: 0.85,
  minEdge: 0.05,
  velocityWindowSec: 30,
  volWindowSec: 90,
  sigmaFloor: 5,
  driftLeadScale: 200,
  driftWeight: 1,
  driftClampSigma: 0.5,
  velocityFloor: 0,
  consistencyTicks: 0,
  consistencySec: 0,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.60,
  fallbackBookSize: 0,
  stopIfCrossed: false,
  stopCrossLeadRatio: 0.60,
  stopMinBid: 0.05,
  exitSlippageMax: 0.02,
  exitLiquidityRatio: 0.40,
  allowedPositionSide: 'BOTH',
};

const PRESETS = {
  'lim-deep': {},
  'lim-tau-early': {
    preset: 'lim-tau-early',
    entryWindowStart: 290,
    entryWindowEnd: 220,
    minLead: 60,
    minAsk: 0.40,
    maxAsk: 0.92,
    maxSpread: 0.06,
    minOddsSum: 0.95,
    maxOddsSum: 1.10,
    minFairProb: 0.70,
    minEdge: 0.06,
    volWindowSec: 60,
    driftClampSigma: 1,
    minLiquidityRatio: 0.60,
  },
  'lim-stop': {
    stopIfCrossed: true,
    stopCrossLeadRatio: 0.60,
    stopMinBid: 0.05,
  },
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

function clamp01(value) {
  return clamp(value, 0, 1);
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

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const absValue = Math.abs(value);
  const coeff1 = 0.254829592;
  const coeff2 = -0.284496736;
  const coeff3 = 1.421413741;
  const coeff4 = -1.453152027;
  const coeff5 = 1.061405429;
  const approximation = 0.3275911;
  const factor = 1 / (1 + (approximation * absValue));
  const result = 1 - (((((coeff5 * factor + coeff4) * factor) + coeff3) * factor + coeff2) * factor + coeff1) * factor * Math.exp(-absValue * absValue);
  return sign * result;
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function normalizePrice(value, fallback) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return fallback;
  return clamp(numberValue, 0.001, 0.999);
}

function normalizePreset(value) {
  const preset = String(value || DEFAULT_PARAMS.preset).toLowerCase();
  return PRESETS[preset] ? preset : DEFAULT_PARAMS.preset;
}

function normalizeAllowedPositionSide(value) {
  const side = String(value || 'BOTH').toUpperCase();
  return ['BOTH', 'UP', 'DOWN'].includes(side) ? side : 'BOTH';
}

function mergeLeadInertiaParams(raw = {}) {
  const preset = normalizePreset(raw.preset ?? raw.variant ?? DEFAULT_PARAMS.preset);
  const params = { ...DEFAULT_PARAMS, ...PRESETS[preset], preset };
  const numericKeys = [
    'walletSize',
    'maxOrderValue',
    'minShares',
    'entryWindowStart',
    'entryWindowEnd',
    'minLead',
    'maxLead',
    'minAsk',
    'maxAsk',
    'maxSpread',
    'minOddsSum',
    'maxOddsSum',
    'minFairProb',
    'minEdge',
    'velocityWindowSec',
    'volWindowSec',
    'sigmaFloor',
    'driftLeadScale',
    'driftWeight',
    'driftClampSigma',
    'velocityFloor',
    'consistencyTicks',
    'consistencySec',
    'entrySlippageMax',
    'minLiquidityRatio',
    'fallbackBookSize',
    'stopCrossLeadRatio',
    'stopMinBid',
    'exitSlippageMax',
    'exitLiquidityRatio',
  ];

  if (raw.tauMax != null && raw.entryWindowStart == null) raw.entryWindowStart = raw.tauMax;
  if (raw.tauMin != null && raw.entryWindowEnd == null) raw.entryWindowEnd = raw.tauMin;

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
  params.minLead = Math.max(0, params.minLead);
  params.maxLead = Math.max(params.minLead, params.maxLead);
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.999);
  params.minOddsSum = clamp(params.minOddsSum, 0.01, 1.99);
  params.maxOddsSum = clamp(params.maxOddsSum, 0.01, 1.99);
  if (params.maxOddsSum < params.minOddsSum) {
    [params.maxOddsSum, params.minOddsSum] = [params.minOddsSum, params.maxOddsSum];
  }
  params.minFairProb = clamp(params.minFairProb, 0.001, 0.999);
  params.minEdge = clamp(params.minEdge, -0.99, 0.99);
  params.velocityWindowSec = clamp(params.velocityWindowSec, 1, 180);
  params.volWindowSec = clamp(params.volWindowSec, 3, 240);
  params.sigmaFloor = Math.max(0.01, params.sigmaFloor);
  params.driftLeadScale = Math.max(1, params.driftLeadScale);
  params.driftWeight = clamp(params.driftWeight, 0, 3);
  params.driftClampSigma = clamp(params.driftClampSigma, 0, 5);
  params.velocityFloor = clamp(params.velocityFloor, -100, 100);
  params.consistencyTicks = Math.max(0, Math.floor(params.consistencyTicks));
  params.consistencySec = Math.max(0, params.consistencySec);
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.fallbackBookSize = Math.max(0, params.fallbackBookSize);
  params.stopIfCrossed = toBool(raw.stopIfCrossed, params.stopIfCrossed);
  params.stopCrossLeadRatio = clamp(params.stopCrossLeadRatio, 0, 10);
  params.stopMinBid = normalizePrice(params.stopMinBid, DEFAULT_PARAMS.stopMinBid);
  params.exitSlippageMax = clamp(params.exitSlippageMax, 0, 0.99);
  params.exitLiquidityRatio = clamp(params.exitLiquidityRatio, 0.01, 1);
  params.allowedPositionSide = normalizeAllowedPositionSide(raw.allowedPositionSide ?? params.allowedPositionSide);
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

function eventKey(tickOrState) {
  return `${tickOrState.event_start ?? tickOrState.eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEnd - new Date(tick.ts)) / 1000);
}

function addSample(state, tick, params) {
  const timeMs = new Date(tick.ts).getTime();
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  const delta = btcPrice != null && priceToBeat != null ? btcPrice - priceToBeat : null;
  const sideSign = delta == null ? 0 : (delta > 0 ? 1 : delta < 0 ? -1 : 0);
  state.samples.push({ timeMs, ts: tick.ts, btcPrice, priceToBeat, delta, sideSign });

  const lookbackSec = Math.max(params.volWindowSec, params.velocityWindowSec, params.consistencySec, 1) + 5;
  while (state.samples.length > 2 && timeMs - state.samples[0].timeMs > lookbackSec * 1000) {
    state.samples.shift();
  }
}

function realizedVolPerSqrtSec(samples, lookbackSec) {
  if (samples.length < 4) return 0;
  const latest = samples[samples.length - 1];
  const cutoffMs = latest.timeMs - lookbackSec * 1000;
  const recent = samples.filter((sample) => sample.timeMs >= cutoffMs && sample.btcPrice != null);
  if (recent.length < 4) return 0;

  const normalizedChanges = [];
  for (let index = 1; index < recent.length; index++) {
    const seconds = (recent[index].timeMs - recent[index - 1].timeMs) / 1000;
    if (seconds <= 0) continue;
    normalizedChanges.push((recent[index].btcPrice - recent[index - 1].btcPrice) / Math.sqrt(seconds));
  }
  return std(normalizedChanges);
}

function velocityPerSec(samples, lookbackSec) {
  if (samples.length < 2) return 0;
  const latest = samples[samples.length - 1];
  const targetMs = latest.timeMs - lookbackSec * 1000;
  let earliest = samples[0];
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index].timeMs <= targetMs) {
      earliest = samples[index];
      break;
    }
  }

  const seconds = (latest.timeMs - earliest.timeMs) / 1000;
  if (seconds <= 0 || latest.btcPrice == null || earliest.btcPrice == null) return 0;
  return (latest.btcPrice - earliest.btcPrice) / seconds;
}

function consistentSeconds(samples, currentSideSign) {
  if (currentSideSign === 0 || !samples.length) return 0;
  const latest = samples[samples.length - 1];
  let earliestTimeMs = latest.timeMs;
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index].sideSign !== currentSideSign) break;
    earliestTimeMs = samples[index].timeMs;
  }
  return (latest.timeMs - earliestTimeMs) / 1000;
}

function consistentTicks(samples, currentSideSign) {
  if (currentSideSign === 0) return 0;
  let count = 0;
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index].sideSign !== currentSideSign) break;
    count++;
  }
  return count;
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
    exits: [],
  };
}

function leadInertiaModelForLeader(state, tick, params) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null) return null;

  const delta = btcPrice - priceToBeat;
  if (delta === 0) return null;

  const sideSign = delta > 0 ? 1 : -1;
  const side = sideSign > 0 ? 'UP' : 'DOWN';
  const timeRemainingSec = Math.max(1, secondsRemaining(state, tick));
  const leadAbs = Math.abs(delta);
  const sigmaReal = realizedVolPerSqrtSec(state.samples, params.volWindowSec);
  const sigmaTau = Math.max(params.sigmaFloor, sigmaReal * Math.sqrt(timeRemainingSec));
  const rawVelocity = velocityPerSec(state.samples, params.velocityWindowSec);
  const signedVelocity = rawVelocity * sideSign;
  const driftWeight = clamp(leadAbs / params.driftLeadScale, 0, 1) * params.driftWeight;
  const driftRaw = signedVelocity * timeRemainingSec * driftWeight;
  const driftCap = sigmaTau * params.driftClampSigma;
  const drift = clamp(driftRaw, -driftCap, driftCap);
  const projectedLead = leadAbs + drift;
  const zScore = projectedLead / Math.max(sigmaTau, 0.000001);
  const fairProb = clamp(normalCdf(zScore), 0.001, 0.999);

  return {
    side,
    sideSign,
    delta,
    leadAbs,
    timeRemainingSec,
    sigmaReal,
    sigmaTau,
    rawVelocity,
    signedVelocity,
    driftWeight,
    drift,
    projectedLead,
    zScore,
    fairProb,
  };
}

function evaluateEntry(state, tick, params) {
  const model = leadInertiaModelForLeader(state, tick, params);
  if (!model) return null;
  if (params.allowedPositionSide !== 'BOTH' && params.allowedPositionSide !== model.side) return null;
  if (model.timeRemainingSec > params.entryWindowStart || model.timeRemainingSec < params.entryWindowEnd) return null;
  if (model.leadAbs < params.minLead || model.leadAbs > params.maxLead) return null;
  if (model.fairProb < params.minFairProb) return null;
  if (model.signedVelocity < params.velocityFloor) return null;

  const fields = sideFields(tick, model.side);
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  if (fields.ask == null || fields.bid == null || upFields.ask == null || downFields.ask == null) return null;

  const oddsSum = upFields.ask + downFields.ask;
  if (oddsSum < params.minOddsSum || oddsSum > params.maxOddsSum) return null;

  const spread = Math.max(0, fields.ask - fields.bid);
  if (spread > params.maxSpread) return null;
  if (fields.ask < params.minAsk || fields.ask > params.maxAsk) return null;

  const edge = model.fairProb - fields.ask;
  if (edge < params.minEdge) return null;

  const sideConsistencyTicks = consistentTicks(state.samples, model.sideSign);
  const sideConsistencySec = consistentSeconds(state.samples, model.sideSign);
  if (sideConsistencyTicks < params.consistencyTicks) return null;
  if (sideConsistencySec < params.consistencySec) return null;

  return {
    side: model.side,
    fields,
    ask: fields.ask,
    bid: fields.bid,
    spread,
    oddsSum,
    edge,
    model,
    sideConsistencyTicks,
    sideConsistencySec,
    score: edge * model.fairProb / Math.max(0.01, spread),
  };
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
  const params = mergeLeadInertiaParams(rawParams);
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

    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    const winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
    let expiryPnl = 0;
    let finalPnl = 0;

    if (current.position.closed) {
      finalPnl = current.position.realizedPnl;
    } else {
      expiryPnl = current.position.side === winnerSide
        ? current.position.qty - current.position.cost
        : -current.position.cost;
      finalPnl = expiryPnl;
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
      entryDistanceToPtb: current.entry?.leadAbs ?? null,
      entryTimeRemaining: current.entry?.timeRemainingSec ?? null,
      quantity: current.position.qty,
      cost: current.position.cost,
      avgEntryPrice: current.position.avgEntryPrice,
      fills: current.position.fills.map((fill) => ({ ...fill })),
      profitOrders: [],
      exits: current.exits.map((exit) => ({ ...exit })),
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
      `EVENTO FIN | LIM ${current.position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
    current = null;
  };

  const maybeStopPosition = (tick) => {
    if (!current?.position || current.position.closed || !params.stopIfCrossed) return false;

    const btcPrice = toFiniteNumber(tick.btc_price);
    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    if (btcPrice == null || priceToBeat == null) return false;

    const signedDistance = current.position.side === 'UP' ? btcPrice - priceToBeat : priceToBeat - btcPrice;
    const entryLeadAbs = Math.abs(current.entry?.leadAbs || 0);
    const stopDistance = -entryLeadAbs * params.stopCrossLeadRatio;
    if (signedDistance > stopDistance) return false;

    const fields = sideFields(tick, current.position.side);
    if (fields.bid == null || fields.bid < params.stopMinBid) return false;

    const minExitPrice = Math.max(params.stopMinBid, fields.bid - params.exitSlippageMax);
    const fallbackKey = `${tick.ts}:lead-inertia:exit:${current.position.side}`;
    const availableQty = availableBidQty(fields.rawBids, minExitPrice, fields.bid, params.fallbackBookSize, fallbackKey);
    if (availableQty < current.position.qty * params.exitLiquidityRatio) return false;

    const consumedClone = new Map(current.consumedBidsBySide[current.position.side]);
    const fills = consumeBidsFromTick(
      fields.rawBids,
      minExitPrice,
      current.position.qty,
      consumedClone,
      fields.bid,
      params.fallbackBookSize,
      fallbackKey,
    );
    const soldQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const proceeds = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (soldQty < current.position.qty * params.exitLiquidityRatio || proceeds <= 0) return false;

    current.consumedBidsBySide[current.position.side] = consumedClone;
    const avgExitPrice = proceeds / soldQty;
    const pnl = proceeds - current.position.cost;
    current.position.closed = true;
    current.position.realizedPnl = pnl;
    current.exits.push({
      time: tick.ts,
      qty: soldQty,
      price: avgExitPrice,
      pnl,
      reason: 'cross_stop',
      fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
    });
    addLog(tick.ts, `CROSS STOP LIM | ${current.position.side} ${formatQty(soldQty)} @ ${formatPrice(avgExitPrice)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? 'profit' : 'stop');
    finalizeCurrentEvent('cross_stop', tick.ts);
    return true;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    const candidate = evaluateEntry(current, tick, params);
    if (!candidate) return;

    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const targetValue = Math.min(params.maxOrderValue, equityNow());
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return;

    const fallbackKey = `${tick.ts}:lead-inertia:${candidate.side}`;
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
    const avgEntryPrice = totalCost / filledQty;
    current.position = {
      side: candidate.side,
      qty: filledQty,
      cost: totalCost,
      avgEntryPrice,
      fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
      closed: false,
    };
    current.entry = {
      time: tick.ts,
      side: candidate.side,
      qty: filledQty,
      cost: totalCost,
      avgEntryPrice,
      ask: candidate.ask,
      bid: candidate.bid,
      spread: candidate.spread,
      oddsSum: candidate.oddsSum,
      timeRemainingSec: candidate.model.timeRemainingSec,
      signedDistance: candidate.model.delta,
      leadAbs: candidate.model.leadAbs,
      fairProb: candidate.model.fairProb,
      edge: candidate.edge,
      sigmaReal: candidate.model.sigmaReal,
      sigmaTau: candidate.model.sigmaTau,
      rawVelocity: candidate.model.rawVelocity,
      signedVelocity: candidate.model.signedVelocity,
      driftWeight: candidate.model.driftWeight,
      drift: candidate.model.drift,
      projectedLead: candidate.model.projectedLead,
      zScore: candidate.model.zScore,
      consistencyTicks: candidate.sideConsistencyTicks,
      consistencySec: candidate.sideConsistencySec,
      score: candidate.score,
    };

    addLog(
      tick.ts,
      `ENTRADA LIM | ${candidate.side} ${formatQty(filledQty)} @ ${formatPrice(avgEntryPrice)} | fair ${(candidate.model.fairProb * 100).toFixed(1)}% | edge ${(candidate.edge * 100).toFixed(1)}pp | lead $${candidate.model.leadAbs.toFixed(2)} | ${Math.round(candidate.model.timeRemainingSec)}s`,
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

    addSample(current, tick, params);

    if (tickTime >= current.eventEnd) {
      finalizeCurrentEvent('expired', current.eventEnd.toISOString());
      return;
    }

    if (maybeStopPosition(tick)) return;
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
      strategy: 'LEAD_INERTIA_MISPRICING_V1',
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

function runLeadInertiaBacktest(rawParams, ticks) {
  const runner = createLeadInertiaBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runLeadInertiaBacktestInBatches(rawParams, tickBatches) {
  const runner = createLeadInertiaBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
