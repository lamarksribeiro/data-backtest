import { applyStopReverseParams, stopReverseBudget, stopReverseTrigger } from './stopReverse.js';

const DEFAULT_PARAMS = {
  walletSize: 100,
  maxOrderValue: 15,
  minShares: 5,
  entryWindowStart: 105,
  entryWindowEnd: 4,
  minAsk: 0.08,
  maxAsk: 0.58,
  minEdge: 0.07,
  minDirectionalProb: 0.56,
  minDistanceAbs: 50,
  minDistanceNearExpiry: 50,
  nearExpiryThresholdSec: 30,
  minSigma: 10,
  sigmaMultiplier: 1,
  distanceWeight: 2.0,
  momentumWeight: 0.65,
  momentumSec: 6,
  slowMomentumSec: 18,
  slowMomentumWeight: 0.35,
  lagWeight: 0.45,
  volLookbackSec: 45,
  maxSpread: 0.08,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.75,
  stopBid: 0.18,
  sizePriceAware: true,
  sizePriceThreshold: 0.52,
  sizePriceFactor: 0.5,
  dynamicStopEnabled: false,
  dynamicStopFactor: 0.45,
  dynamicStopMinBid: 0.16,
  takeProfitBid: 0.92,
  takeProfitPct: 0.35,
  trailAfterBid: 0.78,
  trailDrop: 0.10,
  lateExitSec: 16,
  lateExitMinBid: 0.64,
  finalExitSec: 0,
  finalExitMinBid: 0.05,
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

function logistic(value) {
  return 1 / (1 + Math.exp(-clamp(value, -18, 18)));
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

export function mergeEdgeSniperParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'maxOrderValue', 'minShares', 'entryWindowStart', 'entryWindowEnd',
    'minAsk', 'maxAsk', 'minEdge', 'minDirectionalProb', 'minDistanceAbs',
    'minDistanceNearExpiry', 'nearExpiryThresholdSec', 'minSigma',
    'sigmaMultiplier', 'distanceWeight', 'momentumWeight', 'momentumSec',
    'slowMomentumSec', 'slowMomentumWeight', 'lagWeight', 'volLookbackSec',
    'maxSpread', 'entrySlippageMax', 'minLiquidityRatio', 'stopBid',
    'sizePriceThreshold', 'sizePriceFactor', 'dynamicStopFactor', 'dynamicStopMinBid',
    'takeProfitBid', 'takeProfitPct', 'trailAfterBid', 'trailDrop', 'lateExitSec',
    'lateExitMinBid', 'finalExitSec', 'finalExitMinBid',
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
  if (params.entryWindowStart < params.entryWindowEnd) [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.minEdge = clamp(params.minEdge, -0.5, 0.5);
  params.minDirectionalProb = clamp(params.minDirectionalProb, 0.01, 0.99);
  params.minDistanceAbs = Math.max(0, params.minDistanceAbs);
  params.minDistanceNearExpiry = Math.max(params.minDistanceAbs, params.minDistanceNearExpiry);
  params.nearExpiryThresholdSec = clamp(params.nearExpiryThresholdSec, 0, 150);
  params.minSigma = Math.max(0.01, params.minSigma);
  params.sigmaMultiplier = clamp(params.sigmaMultiplier, 0.1, 5);
  params.momentumSec = clamp(params.momentumSec, 1, 90);
  params.slowMomentumSec = clamp(params.slowMomentumSec, params.momentumSec, 150);
  params.volLookbackSec = clamp(params.volLookbackSec, 5, 150);
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.stopBid = normalizePrice(params.stopBid, DEFAULT_PARAMS.stopBid);
  params.sizePriceAware = toBool(raw.sizePriceAware, DEFAULT_PARAMS.sizePriceAware);
  params.sizePriceThreshold = normalizePrice(params.sizePriceThreshold, DEFAULT_PARAMS.sizePriceThreshold);
  params.sizePriceFactor = clamp(params.sizePriceFactor, 0.05, 1);
  params.dynamicStopEnabled = toBool(raw.dynamicStopEnabled, DEFAULT_PARAMS.dynamicStopEnabled);
  params.dynamicStopMinBid = normalizePrice(params.dynamicStopMinBid, DEFAULT_PARAMS.dynamicStopMinBid);
  params.takeProfitBid = normalizePrice(params.takeProfitBid, DEFAULT_PARAMS.takeProfitBid);
  params.takeProfitPct = clamp(params.takeProfitPct, 0, 1);
  params.trailAfterBid = normalizePrice(params.trailAfterBid, DEFAULT_PARAMS.trailAfterBid);
  params.trailDrop = clamp(params.trailDrop, 0.001, 0.99);
  params.lateExitSec = clamp(params.lateExitSec, 0, 90);
  params.lateExitMinBid = normalizePrice(params.lateExitMinBid, DEFAULT_PARAMS.lateExitMinBid);
  params.finalExitSec = clamp(params.finalExitSec, 0, params.lateExitSec);
  params.finalExitMinBid = normalizePrice(params.finalExitMinBid, DEFAULT_PARAMS.finalExitMinBid);
  applyStopReverseParams(params, raw, {
    stopReverseEnabled: true,
    stopReverseMinDistanceAbs: 10,
    stopReverseMaxSecondsRemaining: 60,
    stopReverseMinLiquidityRatio: 0.75,
    stopReverseBudgetFactor: 1.25,
  });
  return params;
}

function parseBookLevels(rawLevels) {
  if (rawLevels && rawLevels._isParsed) return rawLevels;
  let levels = rawLevels;
  if (typeof rawLevels === 'string') {
    try {
      levels = JSON.parse(rawLevels);
    } catch {
      levels = [];
    }
  }
  if (!Array.isArray(levels)) return [];
  if (levels._isParsed) return levels;

  const result = levels
    .map((level) => ({ price: toFiniteNumber(level?.price), size: toFiniteNumber(level?.size) }))
    .filter((level) => level.price != null && level.size != null && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }))
    .sort((left, right) => left.price - right.price);

  Object.defineProperty(result, '_isParsed', { value: true, enumerable: false });
  return result;
}

function withFallbackAsk(levels, fallbackBestAsk) {
  if (levels.length) return levels;
  const price = toFiniteNumber(fallbackBestAsk);
  return price == null ? [] : [{ price, size: Number.POSITIVE_INFINITY, key: String(price) }];
}

function availableAskQty(rawAsks, maxPrice, fallbackBestAsk) {
  return withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk)
    .reduce((sum, level) => sum + (level.price <= maxPrice ? level.size : 0), 0);
}

function consumeAsksFromTick(rawAsks, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk);
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
      rawAsks: tick._parsed_up_book_asks || tick.up_book_asks,
      price: fallbackPrice
    };
  }
  const fallbackPrice = toFiniteNumber(tick.down_price);
  return {
    ask: toFiniteNumber(tick.down_best_ask) ?? fallbackPrice,
    bid: toFiniteNumber(tick.down_best_bid) ?? fallbackPrice,
    rawAsks: tick._parsed_down_book_asks || tick.down_book_asks,
    price: fallbackPrice
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
  const tsMs = tick._tsMs ?? new Date(tick.ts).getTime();
  const endMs = state._eventEndMs ?? state.eventEnd.getTime();
  return Math.max(0, (endMs - tsMs) / 1000);
}

function eventElapsedSec(state, tick) {
  const tsMs = tick._tsMs ?? new Date(tick.ts).getTime();
  const startMs = state._eventStartMs ?? new Date(state.eventStart).getTime();
  return Math.max(0, (tsMs - startMs) / 1000);
}

function sampleAgo(samples, seconds) {
  if (!samples.length) return null;
  const targetMs = samples[samples.length - 1].timeMs - (seconds * 1000);
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].timeMs <= targetMs) return samples[index];
  }
  return samples[0];
}

function recentVol(samples, lookbackSec) {
  if (samples.length < 3) return 0;
  const latest = samples[samples.length - 1];
  const recent = samples.filter((sample) => latest.timeMs - sample.timeMs <= lookbackSec * 1000 && sample.btc != null);
  const changes = [];
  for (let index = 1; index < recent.length; index += 1) changes.push(recent[index].btc - recent[index - 1].btc);
  return std(changes);
}

function createEventState(tick) {
  const eventStart = tick.event_start;
  const startMs = tick._eventStartMs ?? new Date(eventStart).getTime();
  const endMs = startMs + 300000;
  return {
    eventId: tick.condition_id,
    eventStart,
    eventEnd: new Date(endMs),
    _eventStartMs: startMs,
    _eventEndMs: endMs,
    priceToBeat: toFiniteNumber(tick.price_to_beat),
    lastTick: tick,
    samples: [],
    position: null,
    entryTime: null,
    entryDistanceToPtb: null,
    entryTimeRemaining: null,
    entryDiagnostics: null,
    consumedAsksBySide: { UP: new Map(), DOWN: new Map() },
    realizedPnl: 0,
    exits: [],
    partials: [],
    orders: [],
    maxBid: 0,
    tookProfit: false,
    stopReverseCount: 0,
    reversals: [],
    lastCandidate: null,
  };
}

function addSample(state, tick) {
  const tickTime = tick._tsMs ?? new Date(tick.ts).getTime();
  state.samples.push({ timeMs: tickTime, ts: tick.ts, btc: toFiniteNumber(tick.btc_price) });
  while (state.samples.length > 1 && tickTime - state.samples[0].timeMs > 120000) state.samples.shift();
}

function computeModel(state, tick, params) {
  const samples = state.samples;
  const latest = samples[samples.length - 1];
  const fastSample = sampleAgo(samples, params.momentumSec) || latest;
  const slowSample = sampleAgo(samples, params.slowMomentumSec) || fastSample;
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null || !latest) return { probability: 0.5, sigma: null, distance: null, distanceZ: 0, momentumZ: 0, marketLag: 0, recentVolPerSec: 0, timeRemainingSec: secondsRemaining(state, tick) };
  const timeRemainingSec = secondsRemaining(state, tick);
  const distance = btcPrice - priceToBeat;
  const fastMove = btcPrice - (fastSample?.btc ?? btcPrice);
  const slowMove = btcPrice - (slowSample?.btc ?? btcPrice);
  const recentVolPerSec = recentVol(samples, params.volLookbackSec);
  const sigma = Math.max(params.minSigma, recentVolPerSec * Math.sqrt(Math.max(1, timeRemainingSec)) * params.sigmaMultiplier);
  const distanceZ = distance / sigma;
  const momentumZ = (fastMove + (params.slowMomentumWeight * slowMove)) / sigma;
  const marketProbability = marketProbUp(tick);
  const marketLag = clamp((distance > 0 ? 1 - marketProbability : marketProbability) - 0.5, -0.5, 0.5);
  const probability = clamp(logistic((params.distanceWeight * distanceZ) + (params.momentumWeight * momentumZ) + (params.lagWeight * marketLag)), 0.001, 0.999);
  return { probability, sigma, distance, distanceZ, momentumZ, marketLag, recentVolPerSec, timeRemainingSec };
}

function effectiveMinDistance(params, timeRemainingSec) {
  if (params.minDistanceNearExpiry <= params.minDistanceAbs || params.nearExpiryThresholdSec <= 0) return params.minDistanceAbs;
  if (timeRemainingSec >= params.nearExpiryThresholdSec) return params.minDistanceAbs;
  return params.minDistanceAbs + ((params.minDistanceNearExpiry - params.minDistanceAbs) * clamp01(1 - (timeRemainingSec / params.nearExpiryThresholdSec)));
}

function scoreCandidates(state, tick, params) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null) return [];
  if (Math.abs(btcPrice - priceToBeat) < effectiveMinDistance(params, secondsRemaining(state, tick))) return [];
  const model = computeModel(state, tick, params);
  const pUp = model.probability;
  return ['UP', 'DOWN']
    .map((side) => {
      const fields = sideFields(tick, side);
      const ask = fields.ask;
      const bid = fields.bid;
      const probability = side === 'UP' ? pUp : 1 - pUp;
      const spread = ask != null && bid != null ? Math.max(0, ask - bid) : Number.POSITIVE_INFINITY;
      const edge = ask != null ? probability - ask : Number.NEGATIVE_INFINITY;
      return { side, fields, ask, bid, probability, edge, spread, model };
    })
    .filter((candidate) => candidate.ask != null && candidate.ask >= params.minAsk && candidate.ask <= params.maxAsk && candidate.probability >= params.minDirectionalProb && candidate.edge >= params.minEdge && candidate.spread <= params.maxSpread)
    .sort((left, right) => right.edge - left.edge);
}

function createPosition(side, fills) {
  const totalQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
  const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
  return { side, totalQty, remainingQty: totalQty, totalCost, openCost: totalCost, avgEntryPrice: totalQty > 0 ? totalCost / totalQty : 0, fills };
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
  return { grossProfit, grossLoss, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0), payoff, expectancy: avgPnl, sharpe: pnlStd > 0 ? avgPnl / pnlStd : 0, sortino: downsideStd > 0 ? avgPnl / downsideStd : 0, riskOfRuin: edgePerTrade > 0 ? clamp(Math.pow(clamp(ruinBase, 0, 1), riskUnits), 0, 1) : 1 };
}

export function createEdgeSniperBacktestRunner(rawParams = {}) {
  const params = mergeEdgeSniperParams(rawParams);
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

  const addLog = (ts, msg, type = 'info') => log.push({ ts, msg, type });
  const currentOpenAveragePrice = () => (!current?.position || current.position.remainingQty <= 0 ? 0 : current.position.openCost / Math.max(0.000001, current.position.remainingQty));

  const executeSell = (tick, qty, price, reason, type = 'profit') => {
    if (!current?.position || current.position.remainingQty <= 0 || qty <= 0 || price == null || price <= 0) return 0;
    const sellQty = Math.min(qty, current.position.remainingQty);
    const avgOpenCost = currentOpenAveragePrice();
    const consumedCost = avgOpenCost * sellQty;
    const pnl = (price - avgOpenCost) * sellQty;
    current.position.remainingQty -= sellQty;
    current.position.openCost = Math.max(0, current.position.openCost - consumedCost);
    current.realizedPnl += pnl;
    current.exits.push({ time: tick.ts, qty: sellQty, price, pnl, reason });
    addLog(tick.ts, `${reason} | ${current.position.side} ${sellQty} @ ${price} | PnL ${pnl}`, type);
    return sellQty;
  };

  const pushNoEntryEvent = (closeTs) => {
    totalNoEntry += 1;
    events.push({ eventId: current.eventId, eventStart: current.eventStart, eventEnd: current.eventEnd.toISOString(), positionType: null, entryTime: null, entryDistanceToPtb: null, entryTimeRemaining: null, quantity: 0, cost: 0, profitOrders: [], expirationResult: null, finalPnl: 0, reason: 'no_entry', closedAt: closeTs, diagnostics: { lastCandidate: current.lastCandidate } });
    equity.push({ ts: closeTs, pnl: totalPnl });
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    completedEvents.add(eventKey(current));
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();
    if (!current.position) {
      pushNoEntryEvent(ts);
      current = null;
      return;
    }
    let expiryPnl = 0;
    let winnerSide = null;
    let expirationResult = current.realizedPnl >= 0 ? 'WIN' : 'LOSS';
    if (current.position.remainingQty > 0) {
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      const btcPrice = toFiniteNumber(tick.btc_price);
      winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
      const payout = current.position.side === winnerSide ? current.position.remainingQty : 0;
      expiryPnl = payout - current.position.openCost;
      current.position.remainingQty = 0;
      current.position.openCost = 0;
      current.realizedPnl += expiryPnl;
      expirationResult = current.position.side === winnerSide ? 'WIN' : 'LOSS';
    }
    const finalPnl = current.realizedPnl;
    totalPnl += finalPnl;
    if (finalPnl > 0) totalWins += 1;
    else if (finalPnl < 0) totalLosses += 1;
    events.push({ eventId: current.eventId, eventStart: current.eventStart, eventEnd: current.eventEnd.toISOString(), positionType: current.position.side, entryTime: current.entryTime, entryDistanceToPtb: current.entryDistanceToPtb, entryTimeRemaining: current.entryTimeRemaining, quantity: current.position.totalQty, cost: current.position.totalCost, avgEntryPrice: current.position.avgEntryPrice, fills: current.position.fills.map((fill) => ({ ...fill })), profitOrders: current.partials.map((partial) => ({ ...partial })), exits: current.exits.map((exit) => ({ ...exit })), reversals: current.reversals.map((reversal) => ({ ...reversal, entryFills: reversal.entryFills.map((fill) => ({ ...fill })) })), expirationResult, winnerSide, expiryPnl, finalPnl, reason, closedAt: ts, orders: current.orders.map((order) => ({ ...order, fills: order.fills.map((fill) => ({ ...fill })) })), diagnostics: current.entryDiagnostics });
    equity.push({ ts, pnl: totalPnl });
    current = null;
  };

  const startEvent = (tick) => {
    current = createEventState(tick);
    totalEvents += 1;
    addLog(tick.ts, `Evento ${new Date(tick.event_start).toISOString()} | Edge Sniper V2`);
  };

  const maybeProcessPosition = (tick) => {
    if (!current?.position) return false;
    const fields = sideFields(tick, current.position.side);
    const bid = fields.bid;
    if (bid == null || bid <= 0) return false;
    const timeRemainingSec = secondsRemaining(current, tick);
    current.maxBid = Math.max(current.maxBid, bid);
    const reverseSignal = stopReverseTrigger({ tick, priceToBeat: current.priceToBeat, positionSide: current.position.side, timeRemainingSec, attempts: current.stopReverseCount, params });
    if (reverseSignal) {
      const reverseFields = sideFields(tick, reverseSignal.toSide);
      const budget = stopReverseBudget({ params, maxOrderValue: params.maxOrderValue, equityNow: params.walletSize + totalPnl, totalCost: current.position.totalCost, openCost: current.position.openCost, proceeds: current.position.remainingQty * bid });
      const maxFillPrice = Math.min(params.stopReverseMaxAsk, (reverseFields.ask ?? 0) + params.stopReverseSlippageMax);
      const targetQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));
      if (targetQty >= params.minShares && availableAskQty(reverseFields.rawAsks, maxFillPrice, reverseFields.ask) >= targetQty * params.stopReverseMinLiquidityRatio) {
        const fills = consumeAsksFromTick(reverseFields.rawAsks, maxFillPrice, targetQty, new Map(current.consumedAsksBySide[reverseSignal.toSide]), reverseFields.ask).map((fill) => ({ ...fill, time: tick.ts }));
        const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
        const totalCost = fills.reduce((sum, fill) => sum + fill.qty * fill.price, 0);
        if (filledQty >= params.minShares && totalCost <= budget + 0.000001) {
          const soldQty = executeSell(tick, current.position.remainingQty, bid, 'stop reverse exit', 'stop');
          current.position = createPosition(reverseSignal.toSide, fills);
          current.maxBid = reverseFields.bid ?? 0;
          current.stopReverseCount += 1;
          current.reversals.push({ time: tick.ts, fromSide: reverseSignal.fromSide, toSide: reverseSignal.toSide, soldQty, exitPrice: bid, exitProceeds: soldQty * bid, fromOpenCost: 0, adverseDistance: reverseSignal.adverseDistance, timeRemainingSec: reverseSignal.timeRemainingSec, budget, entryQty: filledQty, entryCost: totalCost, avgEntryPrice: totalCost / filledQty, entryFills: fills });
          current.orders.push({ side: reverseSignal.toSide, source: 'stop_reverse', requestedQty: targetQty, filledQty, maxPrice: maxFillPrice, avgPrice: totalCost / filledQty, cost: totalCost, createdAt: tick.ts, adverseDistance: reverseSignal.adverseDistance, timeRemainingSec: reverseSignal.timeRemainingSec, fills });
          return true;
        }
      }
    }
    const effectiveStop = params.dynamicStopEnabled ? Math.max(params.dynamicStopMinBid, currentOpenAveragePrice() * params.dynamicStopFactor) : params.stopBid;
    if (bid <= effectiveStop && timeRemainingSec > params.lateExitSec) {
      executeSell(tick, current.position.remainingQty, bid, 'stop bid', 'loss');
      finalizeCurrentEvent('stop', tick.ts);
      return true;
    }
    if (!current.tookProfit && bid >= params.takeProfitBid && params.takeProfitPct > 0) {
      const partialQty = Math.floor(current.position.totalQty * params.takeProfitPct);
      if (partialQty >= params.minShares) {
        const soldQty = executeSell(tick, partialQty, params.takeProfitBid, 'partial edge', 'profit');
        if (soldQty > 0) current.tookProfit = true;
      }
    }
    if (current.maxBid >= params.trailAfterBid && current.maxBid - bid >= params.trailDrop) {
      executeSell(tick, current.position.remainingQty, bid, 'trailing edge', bid >= currentOpenAveragePrice() ? 'profit' : 'stop');
      finalizeCurrentEvent('trail', tick.ts);
      return true;
    }
    if (timeRemainingSec <= params.lateExitSec && bid >= params.lateExitMinBid) {
      executeSell(tick, current.position.remainingQty, bid, 'derisk final', bid >= currentOpenAveragePrice() ? 'profit' : 'stop');
      finalizeCurrentEvent('late_exit', tick.ts);
      return true;
    }
    return false;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return;
    if (eventElapsedSec(current, tick) < Math.max(4, params.momentumSec)) return;
    const candidate = scoreCandidates(current, tick, params)[0] || null;
    current.lastCandidate = candidate ? { side: candidate.side, ask: candidate.ask, bid: candidate.bid, probability: candidate.probability, edge: candidate.edge, spread: candidate.spread, timeRemainingSec } : null;
    if (!candidate) return;
    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const equityNow = Math.max(0, params.walletSize + totalPnl);
    const orderValueCap = params.sizePriceAware && candidate.ask > params.sizePriceThreshold ? params.maxOrderValue * params.sizePriceFactor : params.maxOrderValue;
    const targetValue = Math.min(orderValueCap, equityNow);
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return;
    if (availableAskQty(candidate.fields.rawAsks, maxFillPrice, candidate.fields.ask) < targetQty * params.minLiquidityRatio) return;
    const fills = consumeAsksFromTick(candidate.fields.rawAsks, maxFillPrice, targetQty, current.consumedAsksBySide[candidate.side], candidate.fields.ask).map((fill) => ({ ...fill, time: tick.ts }));
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + fill.qty * fill.price, 0);
    if (filledQty < params.minShares || totalCost > targetValue + 0.000001) return;
    totalEntries += 1;
    current.position = createPosition(candidate.side, fills);
    current.entryTime = tick.ts;
    current.entryDistanceToPtb = Math.abs(toFiniteNumber(tick.btc_price) - toFiniteNumber(current.priceToBeat ?? tick.price_to_beat));
    current.entryTimeRemaining = timeRemainingSec;
    current.entryDiagnostics = { probability: candidate.probability, edge: candidate.edge, ask: candidate.ask, spread: candidate.spread, distanceToPtb: current.entryDistanceToPtb, sigma: candidate.model?.sigma ?? null, distanceZ: candidate.model?.distanceZ ?? null, crossingMargin: candidate.model?.sigma ? Math.abs(current.entryDistanceToPtb / candidate.model.sigma) : null, momentumZ: candidate.model?.momentumZ ?? null, recentVolPerSec: candidate.model?.recentVolPerSec ?? null };
    current.maxBid = candidate.bid ?? 0;
    current.orders.push({ side: candidate.side, requestedQty: targetQty, filledQty, maxPrice: maxFillPrice, avgPrice: totalCost / filledQty, createdAt: tick.ts, probability: candidate.probability, edge: candidate.edge, fills });
  };

  const processTick = (tick) => {
    ticksProcessed += 1;
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
      maxDrawdown = Math.max(maxDrawdown, peak - point.pnl);
    }
    return { params, strategy: 'EDGE_SNIPER_V2', summary: { totalEvents, totalEntries, totalNoEntry, totalWins, totalLosses, winRate: parseFloat(winRate.toFixed(1)), totalPnl, avgPnl, maxWin, maxLoss, maxDrawdown, finalWallet: params.walletSize + totalPnl, ...computeAdvancedMetrics(events, params, totalPnl, totalEntries, totalWins, totalLosses) }, equity, events, log, ticksProcessed, periodStart, periodEnd };
  };

  return { processTick, finish };
}

export async function runEdgeSniperBacktestInBatches(rawParams, tickBatches) {
  const runner = createEdgeSniperBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
