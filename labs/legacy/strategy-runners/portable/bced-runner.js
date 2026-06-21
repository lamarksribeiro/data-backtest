

const DEFAULT_PARAMS = {
  walletSize: 200,
  maxOrderValue: 15,
  minShares: 5,
  entryWindowStart: 120,
  entryWindowEnd: 45,
  minAheadDist: 25,
  maxAheadDist: 100,
  minHbook: 0.03,
  maxHbook: 0.20,
  minAsk: 0.04,
  maxAsk: 0.40,
  maxSpread: 0.04,
  minOddsSum: 0.94,
  maxOddsSum: 1.08,
  minModelEdge: 0.12,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.60,
  fallbackBookSize: 0,
  volLookbackSec: 60,
  minSigma: 8,
  sigmaMultiplier: 1.0,
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

function mergeBcedParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'maxOrderValue', 'minShares', 'entryWindowStart', 'entryWindowEnd',
    'minAheadDist', 'maxAheadDist', 'minHbook', 'maxHbook', 'minAsk', 'maxAsk',
    'maxSpread', 'minOddsSum', 'maxOddsSum', 'minModelEdge', 'entrySlippageMax',
    'minLiquidityRatio', 'fallbackBookSize', 'volLookbackSec', 'minSigma',
    'sigmaMultiplier',
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
  params.minHbook = Math.max(0, params.minHbook);
  params.maxHbook = Math.max(0, params.maxHbook);
  if (params.maxHbook < params.minHbook) {
    [params.maxHbook, params.minHbook] = [params.minHbook, params.maxHbook];
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
  params.volLookbackSec = clamp(params.volLookbackSec, 3, 180);
  params.minSigma = Math.max(0.01, params.minSigma);
  params.sigmaMultiplier = clamp(params.sigmaMultiplier, 0.1, 5);
  params.allowedPositionSide = normalizeAllowedPositionSide(raw.allowedPositionSide ?? params.allowedPositionSide);
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

function eventKey(tickOrState) {
  return `${tickOrState.event_start ?? tickOrState.eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEnd - new Date(tick.ts)) / 1000);
}

function tailVol(samples, lookbackSec) {
  if (samples.length < 3) return 0;
  const latest = samples[samples.length - 1];
  const recent = samples.filter((sample) => latest.timeMs - sample.timeMs <= lookbackSec * 1000 && sample.btc != null);
  if (recent.length < 3) return 0;

  const normalizedChanges = [];
  for (let index = 1; index < recent.length; index++) {
    const dtSec = Math.max(0.25, (recent[index].timeMs - recent[index - 1].timeMs) / 1000);
    normalizedChanges.push((recent[index].btc - recent[index - 1].btc) / Math.sqrt(dtSec));
  }
  const globalStd = std(normalizedChanges);
  if (globalStd <= 0) return 0;

  const tailChanges = normalizedChanges.filter((change) => Math.abs(change) > 1.5 * globalStd);
  if (tailChanges.length < 2) return globalStd;
  return std(tailChanges);
}

function addSample(state, tick) {
  const timeMs = new Date(tick.ts).getTime();
  state.samples.push({ timeMs, ts: tick.ts, btc: toFiniteNumber(tick.btc_price) });
  while (state.samples.length > 1 && timeMs - state.samples[0].timeMs > 120000) {
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
  };
}

function bcedModelForSide(state, tick, side, params) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  const latest = state.samples[state.samples.length - 1];
  if (btcPrice == null || priceToBeat == null || !latest) {
    return { probability: 0.5, sigmaTail: params.minSigma, signedDistance: 0 };
  }

  const signedSide = side === 'UP' ? 1 : -1;
  const signedDistance = signedSide * (btcPrice - priceToBeat);
  const timeRemainingSec = Math.max(1, secondsRemaining(state, tick));

  const vol = tailVol(state.samples, params.volLookbackSec);
  const sigmaTail = Math.max(params.minSigma, vol * params.sigmaMultiplier);
  const z = signedDistance / Math.max(0.000001, sigmaTail * Math.sqrt(timeRemainingSec));
  const probability = clamp(normalCdf(z), 0.001, 0.999);

  return { probability, sigmaTail, signedDistance };
}

function scoreCandidates(state, tick, params) {
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  if (upFields.ask == null || downFields.ask == null || upFields.bid == null || downFields.bid == null) return [];

  const askSum = upFields.ask + downFields.ask;
  if (askSum < params.minOddsSum || askSum > params.maxOddsSum) return [];
  const hBook = Math.abs(askSum - 1.0);
  if (hBook < params.minHbook || hBook > params.maxHbook) return [];

  const timeRemainingSec = secondsRemaining(state, tick);
  if (timeRemainingSec > params.entryWindowStart || timeRemainingSec < params.entryWindowEnd) return [];

  return ['UP', 'DOWN']
    .filter((side) => params.allowedPositionSide === 'BOTH' || params.allowedPositionSide === side)
    .map((side) => {
      const fields = side === 'UP' ? upFields : downFields;
      const ask = fields.ask;
      const bid = fields.bid;
      const model = bcedModelForSide(state, tick, side, params);
      const spread = ask - bid;
      const modelEdge = model.probability - ask;

      return {
        side,
        fields,
        ask,
        bid,
        askSum,
        hBook,
        spread,
        timeRemainingSec,
        modelProbability: model.probability,
        modelEdge,
        sigmaTail: model.sigmaTail,
        signedDistance: model.signedDistance,
      };
    })
    .filter((candidate) => {
      if (candidate.signedDistance < params.minAheadDist || candidate.signedDistance > params.maxAheadDist) return false;
      if (candidate.ask < params.minAsk || candidate.ask > params.maxAsk) return false;
      if (candidate.spread > params.maxSpread) return false;
      if (candidate.modelEdge < params.minModelEdge) return false;
      return true;
    })
    .sort((left, right) => right.modelEdge - left.modelEdge);
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
  const params = mergeBcedParams(rawParams);
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
    let finalPnl = 0;

    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
    expiryPnl = current.position.side === winnerSide
      ? current.position.qty - current.position.cost
      : -current.position.cost;
    finalPnl += expiryPnl;

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
      exits: [],
      reversals: [],
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
      `EVENTO FIN | BCED ${current.position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
    current = null;
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

    const fallbackKey = `${tick.ts}:bced:${candidate.side}`;
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
      hBook: candidate.hBook,
      timeRemainingSec: candidate.timeRemainingSec,
      signedDistance: candidate.signedDistance,
      modelProbability: candidate.modelProbability,
      modelEdge: candidate.modelEdge,
      sigmaTail: candidate.sigmaTail,
    };

    addLog(
      tick.ts,
      `ENTRADA BCED | ${candidate.side} ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | prob ${(candidate.modelProbability * 100).toFixed(1)}% | edge ${(candidate.modelEdge * 100).toFixed(1)}pp | Hbook ${candidate.hBook.toFixed(4)} | dist $${candidate.signedDistance.toFixed(2)} | ${Math.round(candidate.timeRemainingSec)}s`,
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
    const result = {
      params,
      strategy: 'BOUNDARY_COHERENCE_ENTROPY_DEVIATION_V1',
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

        return result;
  };

  return { processTick, finish };
}

function runBoundaryCoherenceEntropyDeviationBacktest(rawParams, ticks) {
  const runner = createBoundaryCoherenceEntropyDeviationBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runBoundaryCoherenceEntropyDeviationBacktestInBatches(rawParams, tickBatches) {
  const runner = createBoundaryCoherenceEntropyDeviationBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
