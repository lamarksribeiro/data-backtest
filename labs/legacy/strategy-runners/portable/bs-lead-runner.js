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
  entryWindowStart: 105,
  entryWindowEnd: 20, // Evita colapso do book nos segundos finais conforme estudo
  minAsk: 0.08,
  maxAsk: 0.58,
  minEdge: 0.10, // Prêmio robusto em relação ao Black-Scholes teório
  maxSpread: 0.06,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.75,
  volLookbackSec: 45,
  // Gatilho direcional rápido Binance (Lead-Lag)
  binanceConfirmSec: 2,
  binanceConfirmMinMove: 1.0, // Impulso mínimo em USD da Binance spot
  // Gerenciamento de Posição & Stops
  stopBid: 0.18,
  stopFairProb: 0.35, // Stop rápido por desvalorização teórica (Fair Value Stop)
  takeProfitBid: 0.90,
  takeProfitPct: 0.35,
  trailAfterBid: 0.78,
  trailDrop: 0.10,
  lateExitSec: 16,
  lateExitMinBid: 0.64,
  finalExitSec: 0,
  finalExitMinBid: 0.05,
  sizePriceAware: true,
  sizePriceThreshold: 0.52,
  sizePriceFactor: 0.5,
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

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0.0001;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function normalizePrice(value, fallback) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return fallback;
  return clamp(numberValue, 0.001, 0.99);
}

function mergeBSLeadParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'maxOrderValue', 'minShares', 'entryWindowStart', 'entryWindowEnd',
    'minAsk', 'maxAsk', 'minEdge', 'maxSpread', 'entrySlippageMax', 'minLiquidityRatio',
    'volLookbackSec', 'binanceConfirmSec', 'binanceConfirmMinMove',
    'stopBid', 'stopFairProb', 'takeProfitBid', 'takeProfitPct', 'trailAfterBid', 'trailDrop',
    'lateExitSec', 'lateExitMinBid', 'finalExitSec', 'finalExitMinBid',
    'sizePriceThreshold', 'sizePriceFactor',
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
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.minEdge = clamp(params.minEdge, -0.5, 0.5);
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.volLookbackSec = clamp(params.volLookbackSec, 5, 150);
  params.binanceConfirmSec = clamp(params.binanceConfirmSec, 1, 30);
  params.binanceConfirmMinMove = Math.max(0, params.binanceConfirmMinMove);
  params.stopBid = normalizePrice(params.stopBid, DEFAULT_PARAMS.stopBid);
  params.stopFairProb = clamp(params.stopFairProb, 0.01, 0.99);
  params.sizePriceAware = toBool(raw.sizePriceAware, DEFAULT_PARAMS.sizePriceAware);
  params.sizePriceThreshold = normalizePrice(params.sizePriceThreshold, DEFAULT_PARAMS.sizePriceThreshold);
  params.sizePriceFactor = clamp(params.sizePriceFactor, 0.05, 1);
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

function availableAskQty(rawAsks, maxPrice, fallbackBestAsk) {
  const levels = parseBookLevels(rawAsks);
  return levels.reduce((sum, level) => sum + (level.price <= maxPrice ? level.size : 0), 0);
}

function consumeAsksFromTick(rawAsks, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk) {
  const levels = parseBookLevels(rawAsks);
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

function eventElapsedSec(state, tick) {
  return Math.max(0, (new Date(tick.ts) - new Date(state.eventStart)) / 1000);
}

function recentVolPct(samples, lookbackSec) {
  if (samples.length < 3) return 0.0001; // floor
  const latest = samples[samples.length - 1];
  const recent = samples.filter((sample) => latest.timeMs - sample.timeMs <= lookbackSec * 1000 && sample.bin != null);
  if (recent.length < 3) return 0.0001;

  const returns = [];
  for (let index = 1; index < recent.length; index++) {
    const prev = recent[index - 1].bin;
    if (prev > 0) {
      returns.push((recent[index].bin - prev) / prev);
    }
  }
  return Math.max(0.00001, std(returns));
}

function binanceMomentum(samples, seconds) {
  if (!samples.length) return null;
  let latest = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].bin != null) { latest = samples[i]; break; }
  }
  if (!latest) return null;
  const targetMs = latest.timeMs - (seconds * 1000);
  let past = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].bin != null && samples[i].timeMs <= targetMs) { past = samples[i]; break; }
  }
  if (!past) return null;
  return latest.bin - past.bin;
}

function computeBSModel(state, tick, params) {
  const timeRemainingSec = secondsRemaining(state, tick);
  const S = toFiniteNumber(tick.btc_price); // Spot slow Chainlink
  const K = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat); // Strike Price

  if (S == null || K == null || S <= 0 || K <= 0 || timeRemainingSec <= 0) {
    return { pFair: 0.5, sigmaPct: 0.0001, d2: 0, timeRemainingSec };
  }

  const sigmaPct = recentVolPct(state.samples, params.volLookbackSec);

  // Black-Scholes d2 formula para Cash-or-Nothing Option
  const numerator = Math.log(S / K) - (0.5 * (sigmaPct ** 2) * timeRemainingSec);
  const denominator = sigmaPct * Math.sqrt(timeRemainingSec);
  const d2 = numerator / Math.max(0.000001, denominator);
  const pFair = clamp(normalCdf(d2), 0.001, 0.999);

  return { pFair, sigmaPct, d2, timeRemainingSec };
}

function scoreCandidates(state, tick, params) {
  const model = computeBSModel(state, tick, params);
  const pUp = model.pFair;

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
    .filter((candidate) => candidate.ask != null
      && candidate.ask >= params.minAsk
      && candidate.ask <= params.maxAsk
      && candidate.edge >= params.minEdge
      && candidate.spread <= params.maxSpread)
    .sort((left, right) => right.edge - left.edge);
}

function createPosition(side, fills) {
  const totalQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
  const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
  return {
    side,
    totalQty,
    remainingQty: totalQty,
    totalCost,
    openCost: totalCost,
    avgEntryPrice: totalQty > 0 ? totalCost / totalQty : 0,
    fills,
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
  const params = mergeBSLeadParams(rawParams);
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

  const currentOpenAveragePrice = () => {
    if (!current?.position || current.position.remainingQty <= 0) return 0;
    return current.position.openCost / Math.max(0.000001, current.position.remainingQty);
  };

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
    addLog(tick.ts, `${reason.toUpperCase()} | ${current.position.side} ${formatQty(sellQty)} @ ${formatPrice(price)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, type);
    return sellQty;
  };

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
      diagnostics: { lastCandidate: current.lastCandidate },
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
      addLog(ts, `EXPIRACAO | ${current.position.side} vs ${winnerSide} | PnL ${expiryPnl >= 0 ? '+' : ''}$${expiryPnl.toFixed(2)}`, expiryPnl >= 0 ? 'profit' : 'loss');
    }

    const finalPnl = current.realizedPnl;
    totalPnl += finalPnl;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: current.position.side,
      entryTime: current.entryTime,
      entryDistanceToPtb: current.entryDistanceToPtb,
      entryTimeRemaining: current.entryTimeRemaining,
      quantity: current.position.totalQty,
      cost: current.position.totalCost,
      avgEntryPrice: current.position.avgEntryPrice,
      fills: current.position.fills.map((fill) => ({ ...fill })),
      profitOrders: current.partials.map((partial) => ({ ...partial })),
      exits: current.exits.map((exit) => ({ ...exit })),
      reversals: current.reversals.map((reversal) => ({ ...reversal, entryFills: reversal.entryFills.map((fill) => ({ ...fill })) })),
      expirationResult,
      winnerSide,
      expiryPnl,
      finalPnl,
      reason,
      closedAt: ts,
      orders: current.orders.map((order) => ({ ...order, fills: order.fills.map((fill) => ({ ...fill })) })),
      diagnostics: current.entryDiagnostics,
    });

    equity.push({ ts, pnl: totalPnl });
    addLog(ts, `EVENTO FIN | BS-Lead ${current.position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`, finalPnl >= 0 ? 'profit' : 'loss');
    current = null;
  };

  const startEvent = (tick) => {
    current = {
      eventId: tick.condition_id,
      eventStart: tick.event_start,
      eventEnd: new Date(new Date(tick.event_start).getTime() + 300000),
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
    totalEvents++;
    addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | BS-Lead Strategy`, 'info');
  };

  const addSample = (state, tick) => {
    const tickTime = new Date(tick.ts).getTime();
    state.samples.push({
      timeMs: tickTime,
      ts: tick.ts,
      btc: toFiniteNumber(tick.btc_price),
      bin: toFiniteNumber(tick.btc_binance),
    });

    while (state.samples.length > 1 && tickTime - state.samples[0].timeMs > 120000) {
      state.samples.shift();
    }
  };

  const maybeProcessPosition = (tick) => {
    if (!current?.position) return false;
    const fields = sideFields(tick, current.position.side);
    const bid = fields.bid;
    if (bid == null || bid <= 0) return false;

    const timeRemainingSec = secondsRemaining(current, tick);
    current.maxBid = Math.max(current.maxBid, bid);

    // Stop Reverse
    const tryStopReverse = (signal) => {
      if (bid < params.stopReverseMinBid || current.position.remainingQty < params.minShares) return false;
      const reverseFields = sideFields(tick, signal.toSide);
      if (reverseFields.ask == null || reverseFields.ask <= 0) return false;

      const exitQty = current.position.remainingQty;
      const exitProceeds = exitQty * bid;
      const budget = stopReverseBudget({
        params,
        maxOrderValue: params.maxOrderValue,
        equityNow: params.walletSize + totalPnl,
        totalCost: current.position.totalCost,
        openCost: current.position.openCost,
        proceeds: exitProceeds,
      });
      const maxFillPrice = Math.min(params.stopReverseMaxAsk, reverseFields.ask + params.stopReverseSlippageMax);
      const targetQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));
      if (targetQty < params.minShares) return false;

      const availableQty = availableAskQty(reverseFields.rawAsks, maxFillPrice, reverseFields.ask);
      if (availableQty < targetQty * params.stopReverseMinLiquidityRatio) return false;

      const consumedClone = new Map(current.consumedAsksBySide[signal.toSide]);
      const fills = consumeAsksFromTick(
        reverseFields.rawAsks,
        maxFillPrice,
        targetQty,
        consumedClone,
        reverseFields.ask,
      );
      const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
      const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
      if (filledQty < params.minShares || totalCost <= 0 || totalCost > budget + 0.000001) return false;

      const fromSide = current.position.side;
      const fromQty = current.position.remainingQty;
      const fromOpenCost = current.position.openCost;
      const soldQty = executeSell(tick, fromQty, bid, 'stop reverse exit', 'stop');
      if (soldQty < fromQty * 0.999) return false;

      const timedFills = fills.map((fill) => ({ ...fill, time: tick.ts }));
      current.consumedAsksBySide[signal.toSide] = consumedClone;
      current.position = createPosition(signal.toSide, timedFills);
      current.maxBid = reverseFields.bid ?? 0;
      current.stopReverseCount++;
      current.reversals.push({
        time: tick.ts,
        fromSide,
        toSide: signal.toSide,
        soldQty,
        exitPrice: bid,
        exitProceeds: soldQty * bid,
        fromOpenCost,
        adverseDistance: signal.adverseDistance,
        timeRemainingSec: signal.timeRemainingSec,
        budget,
        entryQty: filledQty,
        entryCost: totalCost,
        avgEntryPrice: totalCost / filledQty,
        entryFills: timedFills,
      });
      current.orders.push({
        side: signal.toSide,
        source: 'stop_reverse',
        requestedQty: targetQty,
        filledQty,
        maxPrice: maxFillPrice,
        avgPrice: totalCost / filledQty,
        cost: totalCost,
        createdAt: tick.ts,
        adverseDistance: signal.adverseDistance,
        timeRemainingSec: signal.timeRemainingSec,
        fills: timedFills.map((fill) => ({ ...fill })),
      });
      addLog(tick.ts, `STOP REVERSE | ${fromSide}->${signal.toSide} | saiu ${formatQty(soldQty)} @ ${formatPrice(bid)} | entrou ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | dist $${signal.adverseDistance.toFixed(2)} | ${Math.round(signal.timeRemainingSec)}s`, 'stop');
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

    // ── Fair Value Stop (Stop por desvalorização teórica) ──
    const model = computeBSModel(current, tick, params);
    const activeFairProb = current.position.side === 'UP' ? model.pFair : 1 - model.pFair;
    if (activeFairProb < params.stopFairProb && timeRemainingSec > params.lateExitSec) {
      executeSell(tick, current.position.remainingQty, bid, 'fair value stop', 'loss');
      finalizeCurrentEvent('fair_value_stop', tick.ts);
      return true;
    }

    // Stop clássico de Bid
    if (bid <= params.stopBid && timeRemainingSec > params.lateExitSec) {
      executeSell(tick, current.position.remainingQty, bid, 'stop bid', 'loss');
      finalizeCurrentEvent('stop', tick.ts);
      return true;
    }

    // Parcial / Take Profit
    if (!current.tookProfit && bid >= params.takeProfitBid && params.takeProfitPct > 0) {
      const partialQty = Math.floor(current.position.totalQty * params.takeProfitPct);
      if (partialQty >= params.minShares) {
        const soldQty = executeSell(tick, partialQty, params.takeProfitBid, 'parcial profit', 'profit');
        if (soldQty > 0) {
          current.tookProfit = true;
          current.partials.push({
            side: current.position.side,
            price: params.takeProfitBid,
            targetPct: params.takeProfitPct,
            qty: soldQty,
            filledQty: soldQty,
            filled: true,
            fillTime: tick.ts,
            pnl: current.exits[current.exits.length - 1]?.pnl ?? 0,
            status: 'FILLED',
          });
        }
      }
    }

    // Trailing Stop
    if (current.maxBid >= params.trailAfterBid && current.maxBid - bid >= params.trailDrop) {
      executeSell(tick, current.position.remainingQty, bid, 'trailing profit', bid >= currentOpenAveragePrice() ? 'profit' : 'stop');
      finalizeCurrentEvent('trail', tick.ts);
      return true;
    }

    // Derisk na janela late
    if (timeRemainingSec <= params.lateExitSec && bid >= params.lateExitMinBid) {
      executeSell(tick, current.position.remainingQty, bid, 'derisk late', bid >= currentOpenAveragePrice() ? 'profit' : 'stop');
      finalizeCurrentEvent('late_exit', tick.ts);
      return true;
    }

    // Salvamento emergencial final
    if (params.finalExitSec > 0 && timeRemainingSec <= params.finalExitSec && bid >= params.finalExitMinBid) {
      executeSell(tick, current.position.remainingQty, bid, 'salvage final', bid >= currentOpenAveragePrice() ? 'profit' : 'stop');
      finalizeCurrentEvent('final_exit', tick.ts);
      return true;
    }

    return false;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return;
    if (eventElapsedSec(current, tick) < Math.max(4, params.binanceConfirmSec)) return;

    const candidates = scoreCandidates(current, tick, params);
    const candidate = candidates[0] || null;

    current.lastCandidate = candidate ? {
      side: candidate.side,
      ask: candidate.ask,
      bid: candidate.bid,
      probability: candidate.probability,
      edge: candidate.edge,
      spread: candidate.spread,
      timeRemainingSec,
    } : null;

    if (!candidate) return;

    // ── Gatilho Direcional Exclusivo da Binance ──
    const mom = binanceMomentum(current.samples, params.binanceConfirmSec);
    if (mom == null) return; // Se não há dados de Binance no sample, fail-safe (vetar)

    const eps = params.binanceConfirmMinMove;
    const isUpImpulse = mom > eps;
    const isDownImpulse = mom < -eps;

    // Só compra UP se a Binance disparou pra cima, e só compra DOWN se a Binance disparou pra baixo
    const isAligned = (candidate.side === 'UP' && isUpImpulse) || (candidate.side === 'DOWN' && isDownImpulse);
    if (!isAligned) return;

    // Se passou, executamos a entrada
    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const equityNow = Math.max(0, params.walletSize + totalPnl);
    const orderValueCap = (params.sizePriceAware && candidate.ask > params.sizePriceThreshold)
      ? params.maxOrderValue * params.sizePriceFactor
      : params.maxOrderValue;
    const targetValue = Math.min(orderValueCap, equityNow);
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return;

    const availableQty = availableAskQty(candidate.fields.rawAsks, maxFillPrice, candidate.fields.ask);
    if (availableQty < targetQty * params.minLiquidityRatio) return;

    const fills = consumeAsksFromTick(
      candidate.fields.rawAsks,
      maxFillPrice,
      targetQty,
      current.consumedAsksBySide[candidate.side],
      candidate.fields.ask,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < params.minShares || totalCost > targetValue + 0.000001) return;

    totalEntries++;
    current.position = createPosition(candidate.side, fills.map((fill) => ({ ...fill, time: tick.ts })));
    current.entryTime = tick.ts;
    current.entryDistanceToPtb = Math.abs(toFiniteNumber(tick.btc_price) - toFiniteNumber(current.priceToBeat ?? tick.price_to_beat));
    current.entryTimeRemaining = timeRemainingSec;
    current.entryDiagnostics = {
      pFair: candidate.probability,
      edge: candidate.edge,
      ask: candidate.ask,
      spread: candidate.spread,
      distanceToPtb: current.entryDistanceToPtb,
      sigmaPct: candidate.model?.sigmaPct ?? null,
      binanceMom: mom,
    };
    current.maxBid = candidate.bid ?? 0;
    current.orders.push({
      side: candidate.side,
      requestedQty: targetQty,
      filledQty,
      maxPrice: maxFillPrice,
      avgPrice: totalCost / filledQty,
      createdAt: tick.ts,
      probability: candidate.probability,
      edge: candidate.edge,
      fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
    });

    addLog(
      tick.ts,
      `ENTRADA BS-LEAD | ${candidate.side} ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | pFair ${(candidate.probability * 100).toFixed(1)}% | edge ${(candidate.edge * 100).toFixed(1)}pp | binMom ${mom >= 0 ? '+' : ''}${mom.toFixed(1)} | ${Math.round(timeRemainingSec)}s`,
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
      strategy: 'BS_LEAD_V1',
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

function runBSLeadBacktest(rawParams, ticks) {
  const runner = createBSLeadBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runBSLeadBacktestInBatches(rawParams, tickBatches) {
  const runner = createBSLeadBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
