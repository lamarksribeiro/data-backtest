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
  entryWindowStart: 45,
  entryWindowEnd: 15,
  minAheadDist: 5,
  maxAheadDist: 20,
  minAsk: 0.55,
  maxAsk: 0.82,
  maxSpread: 0.04,
  minOddsSum: 0.98,
  maxOddsSum: 1.06,
  requireStabilityTicks: 10,
  profitExitBid: 0,
  stopIfCrossed: true,
  stopCrossDist: -2,
  stopMinBid: 0.04,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.55,
  fallbackBookSize: 0,

  // Stop Reverse
  stopReverseEnabled: false,
  stopReverseMaxAttempts: 1,
  stopReverseMaxSecondsRemaining: 40,
  stopReverseMinSecondsRemaining: 5,
  stopReverseMinDistanceAbs: 5,
  stopReverseMaxAsk: 0.85,
  stopReverseSlippageMax: 0.02,
  stopReverseMinLiquidityRatio: 0.50,
  stopReverseMinBid: 0.02,
  stopReverseBudgetMode: 'same-cost',
  stopReverseBudgetFactor: 1.0,
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
  return clamp(numberValue, 0.001, 0.99);
}

function mergeConvergenceUndershootParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'maxOrderValue', 'minShares', 'entryWindowStart', 'entryWindowEnd',
    'minAheadDist', 'maxAheadDist', 'minAsk', 'maxAsk', 'maxSpread', 'minOddsSum',
    'maxOddsSum', 'requireStabilityTicks', 'profitExitBid', 'stopCrossDist', 'stopMinBid',
    'entrySlippageMax', 'minLiquidityRatio', 'fallbackBookSize',
  ];
  for (const key of numericKeys) {
    if (raw[key] != null) {
      const parsed = toFiniteNumber(raw[key]);
      if (parsed != null) params[key] = parsed;
    }
  }
  
  params.walletSize = Math.max(1, params.walletSize);
  params.maxOrderValue = Math.max(0.01, params.maxOrderValue);
  params.minShares = Math.max(0.000001, params.minShares);
  params.entryWindowStart = clamp(params.entryWindowStart, 0, 300);
  params.entryWindowEnd = clamp(params.entryWindowEnd, 0, 300);
  if (params.entryWindowStart < params.entryWindowEnd) {
    [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  }
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.minOddsSum = clamp(params.minOddsSum, 0.01, 2.0);
  params.maxOddsSum = clamp(params.maxOddsSum, 0.01, 2.0);
  if (params.maxOddsSum < params.minOddsSum) [params.maxOddsSum, params.minOddsSum] = [params.minOddsSum, params.maxOddsSum];
  
  params.stopIfCrossed = toBool(raw.stopIfCrossed, params.stopIfCrossed);
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
    .map((level) => ({
      price: toFiniteNumber(level?.price),
      size: toFiniteNumber(level?.size),
    }))
    .filter((level) => level.price != null && level.size != null && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }))
    .sort((left, right) => left.price - right.price);
}

function withFallbackAsk(levels, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  if (levels.length) return levels;
  const fallback = toFiniteNumber(fallbackBestAsk);
  if (fallback == null || fallback <= 0 || fallbackBookSize <= 0) return [];
  return [{ price: fallback, size: fallbackBookSize, key: `fallback:${fallback}:${fallbackKeySuffix}` }];
}

function availableAskQty(rawAsks, maxPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
  return levels.reduce((sum, level) => sum + (level.price <= maxPrice ? level.size : 0), 0);
}

function consumeAsksFromTick(rawAsks, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
  if (!levels.length || requestedQty <= 0) return [];

  const visiblePriceKeys = new Set(levels.map((level) => level.key));
  for (const key of Array.from(consumedByPrice.keys())) {
    if (!visiblePriceKeys.has(key)) consumedByPrice.delete(key);
  }

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

function eventKey(tickOrState) {
  return `${tickOrState.event_start ?? tickOrState.eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEnd - new Date(tick.ts)) / 1000);
}

function addSample(state, tick) {
  const timeMs = new Date(tick.ts).getTime();
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  
  let side = 'NEUTRAL';
  if (btcPrice != null && priceToBeat != null) {
    side = btcPrice > priceToBeat ? 'UP' : (btcPrice < priceToBeat ? 'DOWN' : 'NEUTRAL');
  }

  state.samples.push({ timeMs, ts: tick.ts, btc: btcPrice, side });
  while (state.samples.length > 1 && timeMs - state.samples[0].timeMs > 90000) {
    state.samples.shift();
  }
}

function getStabilityRegime(state, requiredTicks) {
  if (requiredTicks <= 0) return true;
  if (state.samples.length < requiredTicks) return false;
  
  const lastN = state.samples.slice(-requiredTicks);
  const firstSide = lastN[0].side;
  if (firstSide === 'NEUTRAL') return false;
  
  return lastN.every((sample) => sample.side === firstSide);
}

function scoreCandidates(state, tick, params) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null) return [];

  const timeRemainingSec = secondsRemaining(state, tick);
  if (timeRemainingSec > params.entryWindowStart || timeRemainingSec < params.entryWindowEnd) return [];

  const aheadSide = btcPrice > priceToBeat ? 'UP' : 'DOWN';
  const signedDistance = btcPrice - priceToBeat;
  const dist = Math.abs(signedDistance);
  if (dist < params.minAheadDist || dist > params.maxAheadDist) return [];

  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  
  const upAsk = upFields.ask;
  const downAsk = downFields.ask;
  if (upAsk == null || downAsk == null) return [];

  const oddsSum = upAsk + downAsk;
  if (oddsSum < params.minOddsSum || oddsSum > params.maxOddsSum) return [];

  const fields = aheadSide === 'UP' ? upFields : downFields;
  const ask = fields.ask;
  const bid = fields.bid;
  if (ask == null || bid == null) return [];

  const spread = ask - bid;
  if (spread > params.maxSpread) return [];

  if (ask < params.minAsk || ask > params.maxAsk) return [];

  const isStable = getStabilityRegime(state, params.requireStabilityTicks);
  if (!isStable) return [];

  const impliedConfidence = ask / oddsSum;
  const gapScore = (1 - impliedConfidence) * dist;

  return [{
    side: aheadSide,
    fields,
    ask,
    bid,
    spread,
    oddsSum,
    timeRemainingSec,
    signedDistance,
    dist,
    score: gapScore,
  }];
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
    stopReverseCount: 0,
    reversals: [],
    exits: [],
    orders: [],
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
    riskOfRuin: edgePerTrade > 0 ? clamp(Math.pow(clamp(ruinBase, 0, 1), riskUnits), 0, 1) : 1,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeConvergenceUndershootParams(rawParams);
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
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;
  let current = null;

  const addLog = (ts, msg, type = 'info') => {
    log.push({ ts, msg, type });
  };

  const equityNow = () => Math.max(0, params.walletSize + totalPnl);

  const pushNoEntryEvent = (closeTs) => {
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
      expirationResult: null,
      finalPnl: 0,
      reason: 'no_entry',
      closedAt: closeTs,
    });
    equity.push({ ts: closeTs, pnl: totalPnl });
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    const key = eventKey(current);
    completedEvents.add(key);
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();

    if (!current.position) {
      pushNoEntryEvent(ts);
      current = null;
      return;
    }

    let expiryPnl = 0;
    let winnerSide = null;
    let expirationResult = 'LOSS';

    if (!current.position.closed) {
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      const btcPrice = toFiniteNumber(tick.btc_price);
      winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
      
      const accumulatedPnl = current.position.realizedPnl || 0;
      expiryPnl = current.position.side === winnerSide
        ? current.position.qty - current.position.cost
        : -current.position.cost;
      
      current.position.closed = true;
      current.position.realizedPnl = accumulatedPnl + expiryPnl;
      expirationResult = current.position.side === winnerSide ? 'WIN' : 'LOSS';
      addLog(ts, `EXPIRACAO | ${current.position.side} vs ${winnerSide} | PnL ${expiryPnl >= 0 ? '+' : ''}$${expiryPnl.toFixed(2)}`, expiryPnl >= 0 ? 'profit' : 'loss');
    }

    const finalPnl = current.position.realizedPnl;
    totalPnl += finalPnl;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: current.position.side,
      entryTime: current.entry?.time || current.eventStart,
      entryDistanceToPtb: current.entry?.dist || 0,
      entryTimeRemaining: current.entry?.timeRemainingSec || 0,
      quantity: current.position.qty,
      cost: current.position.cost,
      avgEntryPrice: current.position.avgEntryPrice,
      fills: current.position.fills.map((fill) => ({ ...fill })),
      profitOrders: [],
      exits: current.exits.map((exit) => ({ ...exit })),
      reversals: current.reversals.map((reversal) => ({ ...reversal })),
      expirationResult,
      winnerSide,
      expiryPnl,
      finalPnl,
      reason,
      closedAt: ts,
      orders: current.orders.map((order) => ({ ...order, fills: order.fills.map((fill) => ({ ...fill })) })),
    });

    equity.push({ ts, pnl: totalPnl });
    addLog(ts, `EVENTO FIN | Conv Undershoot ${current.position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`, finalPnl >= 0 ? 'profit' : 'loss');
    current = null;
  };

  const startEvent = (tick) => {
    current = createEventState(tick);
    totalEvents++;
    addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | Conv Undershoot V1`, 'info');
  };

  const maybeProcessPosition = (tick) => {
    if (!current?.position || current.position.closed) return false;
    const fields = sideFields(tick, current.position.side);
    const bid = fields.bid;
    if (bid == null || bid <= 0) return false;

    // 1. Profit Target Exit
    if (params.profitExitBid > 0 && bid >= params.profitExitBid) {
      const accumulatedPnl = current.position.realizedPnl || 0;
      const pnl = accumulatedPnl + ((params.profitExitBid * current.position.qty) - current.position.cost);
      current.position.closed = true;
      current.position.realizedPnl = pnl;
      current.exits.push({ time: tick.ts, qty: current.position.qty, price: params.profitExitBid, pnl, reason: 'profit_exit' });
      addLog(tick.ts, `PROFIT EXIT | ${current.position.side} ${formatQty(current.position.qty)} @ ${formatPrice(params.profitExitBid)} | PnL +$${(pnl - accumulatedPnl).toFixed(2)}`, 'profit');
      finalizeCurrentEvent('profit_exit', tick.ts);
      return true;
    }

    // 2. Stop com Reversão (Stop Reverse)
    const timeRemainingSec = secondsRemaining(current, tick);
    const reverseSignal = stopReverseTrigger({
      tick,
      priceToBeat: current.priceToBeat,
      positionSide: current.position.side,
      timeRemainingSec,
      attempts: current.stopReverseCount,
      params,
    });

    if (reverseSignal && bid >= params.stopReverseMinBid && current.position.qty >= params.minShares) {
      const reverseFields = sideFields(tick, reverseSignal.toSide);
      if (reverseFields.ask != null && reverseFields.ask > 0) {
        const exitQty = current.position.qty;
        const exitProceeds = exitQty * bid;
        
        // Patrimônio hipotético se vendêssemos agora para calcular orçamento
        const virtualEquity = equityNow() - current.position.cost + exitProceeds;
        const budget = stopReverseBudget({
          params,
          maxOrderValue: params.maxOrderValue,
          equityNow: virtualEquity,
          totalCost: current.position.cost,
          openCost: current.position.cost,
          proceeds: exitProceeds,
        });

        const maxFillPrice = Math.min(params.stopReverseMaxAsk, reverseFields.ask + params.stopReverseSlippageMax);
        const targetQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));

        if (targetQty >= params.minShares) {
          const fallbackKey = `${tick.ts}:conv-under:${reverseSignal.toSide}:reverse`;
          const availableQty = availableAskQty(reverseFields.rawAsks, maxFillPrice, reverseFields.ask, params.fallbackBookSize, fallbackKey);

          if (availableQty >= targetQty * params.stopReverseMinLiquidityRatio) {
            const consumedClone = new Map(current.consumedAsksBySide[reverseSignal.toSide]);
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

            if (filledQty >= params.minShares && totalCost > 0 && totalCost <= budget + 0.000001) {
              // Executa a venda simulada e registra realizedPnl
              const previousRealized = current.position.realizedPnl || 0;
              const exitPnl = exitProceeds - current.position.cost;
              const totalRealized = previousRealized + exitPnl;

              const fromSide = current.position.side;
              current.consumedAsksBySide[reverseSignal.toSide] = consumedClone;
              
              current.exits.push({ time: tick.ts, qty: exitQty, price: bid, pnl: exitPnl, reason: 'stop_reverse_exit' });
              
              const timedFills = fills.map((fill) => ({ ...fill, time: tick.ts }));
              current.position = {
                side: reverseSignal.toSide,
                qty: filledQty,
                cost: totalCost,
                avgEntryPrice: totalCost / filledQty,
                fills: timedFills,
                closed: false,
                realizedPnl: totalRealized,
              };

              current.stopReverseCount++;
              current.reversals.push({
                time: tick.ts,
                fromSide,
                toSide: reverseSignal.toSide,
                exitPrice: bid,
                exitQty,
                exitPnl,
                entryPrice: totalCost / filledQty,
                entryQty: filledQty,
                entryCost: totalCost,
              });

              current.orders.push({
                side: reverseSignal.toSide,
                source: 'stop_reverse',
                requestedQty: targetQty,
                filledQty,
                maxPrice: maxFillPrice,
                avgPrice: totalCost / filledQty,
                cost: totalCost,
                createdAt: tick.ts,
                adverseDistance: reverseSignal.adverseDistance,
                timeRemainingSec: reverseSignal.timeRemainingSec,
                fills: timedFills.map((fill) => ({ ...fill })),
              });

              addLog(tick.ts, `STOP REVERSE | ${fromSide}->${reverseSignal.toSide} | saiu ${formatQty(exitQty)} @ ${formatPrice(bid)} | entrou ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | dist $${reverseSignal.adverseDistance.toFixed(2)} | ${Math.round(reverseSignal.timeRemainingSec)}s`, 'stop');
              return true; // Reverteu! Continua no tick
            }
          }
        }
      }
    }

    // 3. Stop de Cruzamento Dinâmico (Crossed Stop)
    if (params.stopIfCrossed) {
      const btcPrice = toFiniteNumber(tick.btc_price);
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      if (btcPrice != null && priceToBeat != null) {
        const signedSide = current.position.side === 'UP' ? 1 : -1;
        const signedDistance = signedSide * (btcPrice - priceToBeat);
        if (signedDistance <= params.stopCrossDist && bid >= params.stopMinBid) {
          const accumulatedPnl = current.position.realizedPnl || 0;
          const exitPnl = (bid * current.position.qty) - current.position.cost;
          const pnl = accumulatedPnl + exitPnl;
          current.position.closed = true;
          current.position.realizedPnl = pnl;
          current.exits.push({ time: tick.ts, qty: current.position.qty, price: bid, pnl: exitPnl, reason: 'cross_stop' });
          addLog(tick.ts, `CROSSED STOP | ${current.position.side} ${formatQty(current.position.qty)} @ ${formatPrice(bid)} | PnL ${exitPnl >= 0 ? '+' : ''}$${exitPnl.toFixed(2)}`, 'loss');
          finalizeCurrentEvent('cross_stop', tick.ts);
          return true;
        }
      }
    }

    return false;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return;

    const candidates = scoreCandidates(current, tick, params);
    const candidate = candidates[0];
    if (!candidate) return;

    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const targetValue = Math.min(params.maxOrderValue, equityNow());
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return;

    const fallbackKey = `${tick.ts}:conv-under:${candidate.side}`;
    const availableQty = availableAskQty(candidate.fields.rawAsks, maxFillPrice, candidate.ask, params.fallbackBookSize, fallbackKey);
    if (availableQty < targetQty * params.minLiquidityRatio) return;

    const consumedClone = new Map(current.consumedAsksBySide[candidate.side]);
    const fills = consumeAsksFromTick(
      candidate.fields.rawAsks,
      maxFillPrice,
      targetQty,
      consumedClone,
      candidate.ask,
      params.fallbackBookSize,
      fallbackKey,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < params.minShares || totalCost <= 0 || totalCost > targetValue + 0.000001) return;

    totalEntries++;
    current.consumedAsksBySide[candidate.side] = consumedClone;
    const timedFills = fills.map((fill) => ({ ...fill, time: tick.ts }));
    current.position = {
      side: candidate.side,
      qty: filledQty,
      cost: totalCost,
      avgEntryPrice: totalCost / filledQty,
      fills: timedFills,
      closed: false,
      realizedPnl: 0,
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
      signedDistance: candidate.signedDistance,
      dist: candidate.dist,
      score: candidate.score,
    };

    current.orders.push({
      side: candidate.side,
      requestedQty: targetQty,
      filledQty,
      maxPrice: maxFillPrice,
      avgPrice: totalCost / filledQty,
      cost: totalCost,
      createdAt: tick.ts,
      fills: timedFills.map((fill) => ({ ...fill })),
    });

    addLog(
      tick.ts,
      `ENTRADA CONV | ${candidate.side} ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | oddsSum ${candidate.oddsSum.toFixed(3)} | dist $${candidate.dist.toFixed(2)} | ${Math.round(timeRemainingSec)}s`,
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

    if (maybeProcessPosition(tick)) return;
    maybeEnter(tick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd.toISOString());
    const enteredEvents = events.filter((item) => item.reason !== 'no_entry');
    const winRate = totalEntries > 0 ? totalWins / totalEntries * 100 : 0;
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
      strategy: 'CONVERGENCE_UNDERSHOOT_V1',
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

function runConvergenceUndershootBacktest(rawParams, ticks) {
  const runner = createConvergenceUndershootBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runConvergenceUndershootBacktestInBatches(rawParams, tickBatches) {
  const runner = createConvergenceUndershootBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
