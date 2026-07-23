const DEFAULT_PARAMS = {
  walletSize: 100,
  maxOrderValue: 15,
  minShares: 5,
  entryWindowStart: 280,
  entryWindowEnd: 15,
  impulseSec: 5,
  minSpikeAbs: 25,
  strategyMode: 'fade', // 'fade' (counter-trend) or 'impulse' (trend)
  maxTradesPerEvent: 5,
  cooldownSec: 8,
  minAsk: 0.05,
  maxAsk: 0.75,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.50,
  takeProfitPct: 0.20, // +20% gain target
  partialTakeProfitPct: 0.50, // 50% partial exit
  takeProfitBid: 0.90, // target absolute bid
  trailDrop: 0.08, // drop from highest bid
  stopLossPct: 0.18, // -18% loss stop
  stopBid: 0.12, // absolute stop bid floor
  maxHoldTimeSec: 25, // max duration in seconds for a scalp trade
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

function normalizePrice(value, fallback) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return fallback;
  return clamp(numberValue, 0.001, 0.99);
}

export function mergeAbruptSpikeScalperParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize',
    'maxOrderValue',
    'minShares',
    'entryWindowStart',
    'entryWindowEnd',
    'impulseSec',
    'minSpikeAbs',
    'maxTradesPerEvent',
    'cooldownSec',
    'minAsk',
    'maxAsk',
    'entrySlippageMax',
    'minLiquidityRatio',
    'takeProfitPct',
    'partialTakeProfitPct',
    'takeProfitBid',
    'trailDrop',
    'stopLossPct',
    'stopBid',
    'maxHoldTimeSec',
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
  params.impulseSec = clamp(params.impulseSec, 1, 60);
  params.minSpikeAbs = Math.max(1, params.minSpikeAbs);
  params.strategyMode = String(raw.strategyMode || DEFAULT_PARAMS.strategyMode).toLowerCase() === 'impulse' ? 'impulse' : 'fade';
  params.maxTradesPerEvent = Math.max(1, Math.floor(params.maxTradesPerEvent));
  params.cooldownSec = Math.max(0, params.cooldownSec);
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) {
    [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  }
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.takeProfitPct = clamp(params.takeProfitPct, 0.01, 5.0);
  params.partialTakeProfitPct = clamp(params.partialTakeProfitPct, 0, 1);
  params.takeProfitBid = normalizePrice(params.takeProfitBid, DEFAULT_PARAMS.takeProfitBid);
  params.trailDrop = clamp(params.trailDrop, 0.001, 0.99);
  params.stopLossPct = clamp(params.stopLossPct, 0.01, 0.99);
  params.stopBid = normalizePrice(params.stopBid, DEFAULT_PARAMS.stopBid);
  params.maxHoldTimeSec = clamp(params.maxHoldTimeSec, 1, 300);

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
  return withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk).reduce(
    (sum, level) => sum + (level.price <= maxPrice ? level.size : 0),
    0
  );
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

function eventKey(tick) {
  return tick.condition_id ?? tick.conditionId ?? `${tick.event_start}_${tick.event_end}`;
}

function sideFields(tick, side) {
  if (side === 'UP') {
    return {
      ask: toFiniteNumber(tick.up_best_ask ?? tick.upAsk ?? tick.up_ask),
      bid: toFiniteNumber(tick.up_best_bid ?? tick.upBid ?? tick.up_bid),
      rawAsks: tick.up_asks ?? tick.upAsks ?? [],
      rawBids: tick.up_bids ?? tick.upBids ?? [],
    };
  }
  return {
    ask: toFiniteNumber(tick.down_best_ask ?? tick.downAsk ?? tick.down_ask),
    bid: toFiniteNumber(tick.down_best_bid ?? tick.downBid ?? tick.down_bid),
    rawAsks: tick.down_asks ?? tick.downAsks ?? [],
    rawBids: tick.down_bids ?? tick.downBids ?? [],
  };
}

function secondsRemaining(event, tick) {
  const end = new Date(event.eventEnd).getTime();
  const now = new Date(tick.ts).getTime();
  return Math.max(0, (end - now) / 1000);
}

function createPosition(side, fills) {
  const totalQty = fills.reduce((sum, f) => sum + f.qty, 0);
  const openCost = fills.reduce((sum, f) => sum + f.qty * f.price, 0);
  const avgEntryPrice = totalQty > 0 ? openCost / totalQty : 0;
  return {
    side,
    totalQty,
    remainingQty: totalQty,
    openCost,
    avgEntryPrice,
    fills: fills.map((f) => ({ ...f })),
  };
}

export function createAbruptSpikeScalperRunner(rawParams = {}) {
  const params = mergeAbruptSpikeScalperParams(rawParams);

  let totalEvents = 0;
  let totalEntries = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnl = 0;
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;

  const events = [];
  const equity = [];
  const log = [];
  const completedEvents = new Set();
  let current = null;

  const addLog = (ts, msg, type = 'info') => log.push({ ts, msg, type });

  const createEventState = (tick) => ({
    eventId: eventKey(tick),
    eventStart: new Date(tick.event_start || tick.ts),
    eventEnd: new Date(tick.event_end || new Date(new Date(tick.event_start || tick.ts).getTime() + 300000)),
    priceToBeat: toFiniteNumber(tick.price_to_beat ?? tick.priceToBeat),
    samples: [],
    position: null,
    highestBid: 0,
    tookPartial: false,
    entryTime: null,
    tradesCount: 0,
    cooldownUntilMs: 0,
    realizedPnl: 0,
    consumedAsksBySide: { UP: new Map(), DOWN: new Map() },
    trades: [],
    lastTick: tick,
    orders: [],
    exits: [],
  });

  const addSample = (event, tick) => {
    const btcPrice = toFiniteNumber(tick.btc_price ?? tick.currentBtcPrice ?? tick.underlyingPrice);
    if (btcPrice == null) return;
    const tsMs = new Date(tick.ts).getTime();
    event.samples.push({ tsMs, ts: tick.ts, btcPrice });
    if (event.samples.length > 500) event.samples.shift();
  };

  const getBtcImpulse = (event, tick) => {
    const btcPrice = toFiniteNumber(tick.btc_price ?? tick.currentBtcPrice ?? tick.underlyingPrice);
    if (btcPrice == null || !event.samples.length) return 0;
    const currentMs = new Date(tick.ts).getTime();
    const targetMs = currentMs - params.impulseSec * 1000;

    let pastSample = event.samples[0];
    for (let i = event.samples.length - 1; i >= 0; i--) {
      if (event.samples[i].tsMs <= targetMs) {
        pastSample = event.samples[i];
        break;
      }
    }

    return btcPrice - pastSample.btcPrice;
  };

  const executeSell = (tick, qty, price, reason, type = 'profit') => {
    if (!current?.position || current.position.remainingQty <= 0 || qty <= 0 || price == null || price <= 0) return 0;
    const sellQty = Math.min(qty, current.position.remainingQty);
    const avgOpenCost = current.position.avgEntryPrice;
    const consumedCost = avgOpenCost * sellQty;
    const pnl = (price - avgOpenCost) * sellQty;

    current.position.remainingQty -= sellQty;
    current.position.openCost = Math.max(0, current.position.openCost - consumedCost);
    current.realizedPnl += pnl;
    current.exits.push({ time: tick.ts, qty: sellQty, price, pnl, reason });
    addLog(tick.ts, `${reason} | ${current.position.side} ${sellQty} @ ${price} | PnL ${pnl.toFixed(4)}`, type);

    if (current.position.remainingQty <= 0) {
      current.tradesCount += 1;
      current.cooldownUntilMs = new Date(tick.ts).getTime() + params.cooldownSec * 1000;
      current.position = null;
      current.tookPartial = false;
      current.highestBid = 0;
      current.entryTime = null;
    }
    return sellQty;
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    completedEvents.add(current.eventId);
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();

    if (current.position && current.position.remainingQty > 0) {
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat ?? tick.priceToBeat);
      const btcPrice = toFiniteNumber(tick.btc_price ?? tick.currentBtcPrice ?? tick.underlyingPrice);
      const winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
      const payout = current.position.side === winnerSide ? current.position.remainingQty : 0;
      const expiryPnl = payout - current.position.openCost;
      current.realizedPnl += expiryPnl;
      current.exits.push({ time: ts, qty: current.position.remainingQty, price: payout > 0 ? 1.0 : 0.0, pnl: expiryPnl, reason: 'event_expiry' });
      current.position = null;
    }

    const finalPnl = current.realizedPnl;
    totalPnl += finalPnl;
    if (finalPnl > 0) totalWins += 1;
    else if (finalPnl < 0) totalLosses += 1;

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      tradesCount: current.tradesCount,
      exits: current.exits.map((e) => ({ ...e })),
      finalPnl,
      reason,
      closedAt: ts,
      orders: current.orders.map((o) => ({ ...o, fills: o.fills.map((f) => ({ ...f })) })),
    });
    equity.push({ ts, pnl: totalPnl });
    current = null;
  };

  const startEvent = (tick) => {
    current = createEventState(tick);
    totalEvents += 1;
    addLog(tick.ts, `Evento ${new Date(tick.event_start || tick.ts).toISOString()} | AbruptSpikeScalper (${params.strategyMode.toUpperCase()})`);
  };

  const maybeProcessPosition = (tick) => {
    if (!current?.position) return false;
    const fields = sideFields(tick, current.position.side);
    const bid = fields.bid;
    if (bid == null || bid <= 0) return false;

    current.highestBid = Math.max(current.highestBid, bid);
    const holdDurationSec = (new Date(tick.ts).getTime() - new Date(current.entryTime).getTime()) / 1000;

    // 1. Partial Take Profit
    if (!current.tookPartial && params.partialTakeProfitPct > 0) {
      const targetTpPrice = current.position.avgEntryPrice * (1 + params.takeProfitPct);
      if (bid >= targetTpPrice) {
        const partialQty = Math.floor(current.position.totalQty * params.partialTakeProfitPct);
        if (partialQty >= params.minShares) {
          executeSell(tick, partialQty, bid, 'partial_take_profit', 'profit');
          current.tookPartial = true;
          if (!current.position) return true;
        }
      }
    }

    // 2. Full Take Profit / Trailing Exit
    if (bid >= params.takeProfitBid) {
      executeSell(tick, current.position.remainingQty, bid, 'take_profit_target', 'profit');
      return true;
    }

    if (current.highestBid >= current.position.avgEntryPrice * (1 + params.takeProfitPct) && current.highestBid - bid >= params.trailDrop) {
      executeSell(tick, current.position.remainingQty, bid, 'trailing_stop_exit', bid >= current.position.avgEntryPrice ? 'profit' : 'stop');
      return true;
    }

    // 3. Stop Loss
    const stopLossPrice = current.position.avgEntryPrice * (1 - params.stopLossPct);
    if (bid <= stopLossPrice || bid <= params.stopBid) {
      executeSell(tick, current.position.remainingQty, bid, 'stop_loss', 'loss');
      return true;
    }

    // 4. Max Hold Time Exit
    if (holdDurationSec >= params.maxHoldTimeSec) {
      executeSell(tick, current.position.remainingQty, bid, 'max_hold_time_exit', bid >= current.position.avgEntryPrice ? 'profit' : 'loss');
      return true;
    }

    return false;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    if (current.tradesCount >= params.maxTradesPerEvent) return;

    const tickMs = new Date(tick.ts).getTime();
    if (tickMs < current.cooldownUntilMs) return;

    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return;

    const btcImpulse = getBtcImpulse(current, tick);
    const absImpulse = Math.abs(btcImpulse);
    if (absImpulse < params.minSpikeAbs) return;

    let targetSide = null;
    if (params.strategyMode === 'fade') {
      targetSide = btcImpulse > 0 ? 'DOWN' : 'UP';
    } else {
      targetSide = btcImpulse > 0 ? 'UP' : 'DOWN';
    }

    const candidate = sideFields(tick, targetSide);
    if (candidate.ask == null || candidate.ask < params.minAsk || candidate.ask > params.maxAsk) return;

    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const equityNow = Math.max(0, params.walletSize + totalPnl);
    const targetValue = Math.min(params.maxOrderValue, equityNow);
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return;

    if (availableAskQty(candidate.rawAsks, maxFillPrice, candidate.ask) < targetQty * params.minLiquidityRatio) return;

    const fills = consumeAsksFromTick(
      candidate.rawAsks,
      maxFillPrice,
      targetQty,
      current.consumedAsksBySide[targetSide],
      candidate.ask
    ).map((fill) => ({ ...fill, time: tick.ts }));

    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + fill.qty * fill.price, 0);
    if (filledQty < params.minShares || totalCost > targetValue + 0.000001) return;

    totalEntries += 1;
    current.position = createPosition(targetSide, fills);
    current.entryTime = tick.ts;
    current.highestBid = candidate.bid ?? candidate.ask;
    current.tookPartial = false;

    current.orders.push({
      side: targetSide,
      requestedQty: targetQty,
      filledQty,
      maxPrice: maxFillPrice,
      avgPrice: totalCost / filledQty,
      createdAt: tick.ts,
      impulse: btcImpulse,
      fills,
    });
    addLog(tick.ts, `Entrada ${targetSide} | Impulso: ${btcImpulse.toFixed(2)} USD | ${filledQty} @ ${(totalCost / filledQty).toFixed(3)}`);
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
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat ?? tick.priceToBeat);

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
    const winRate = totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0;
    const avgPnl = totalEntries > 0 ? totalPnl / totalEntries : 0;

    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equity) {
      if (point.pnl > peak) peak = point.pnl;
      maxDrawdown = Math.max(maxDrawdown, peak - point.pnl);
    }

    return {
      params,
      strategy: 'ABRUPT_SPIKE_SCALPER',
      summary: {
        totalEvents,
        totalEntries,
        totalWins,
        totalLosses,
        winRate: parseFloat(winRate.toFixed(1)),
        totalPnl: parseFloat(totalPnl.toFixed(4)),
        avgPnl: parseFloat(avgPnl.toFixed(4)),
        maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
        finalWallet: parseFloat((params.walletSize + totalPnl).toFixed(4)),
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

export async function runAbruptSpikeScalperBacktestInBatches(rawParams, tickBatches) {
  const runner = createAbruptSpikeScalperRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}

export default createAbruptSpikeScalperRunner;
