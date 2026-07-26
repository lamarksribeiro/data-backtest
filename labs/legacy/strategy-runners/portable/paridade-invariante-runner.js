/**
 * Paridade Invariante V1 — complete-set arbitrage runner.
 *
 * The strategy never chooses UP or DOWN. It only buys equal quantities of
 * both outcomes when the executable payout invariant remains positive after:
 * - walking both ask books;
 * - crypto taker fees on every fill;
 * - a configurable operational reserve;
 * - temporal confirmation and simulated execution latency.
 *
 * Important: the historical runner treats the two FOK legs as a paired
 * snapshot. Polymarket does not provide a cross-outcome atomic order, so a
 * live executor still needs explicit leg-risk reconciliation.
 *
 * Test surface: __paridadeInvarianteExports
 */

const DEFAULT_PARAMS = {
  walletSize: 100,
  sizingMode: 'maximize', // maximize | fixed
  targetPairShares: 20,
  minPairShares: 5,
  maxPairShares: 80,
  maxEventNotional: 80,
  maxPairsPerEvent: 1,

  payoutPerPair: 1,
  takerFeeRate: 0.07,
  minNetEdgePerShare: 0.005,
  minNetProfitUsd: 0.10,
  operationalBufferPerShare: 0.002,

  confirmationTicks: 2,
  executionLatencyTicks: 1,
  maxSignalGapMs: 750,
  minSecondsLeft: 15,
  maxSecondsLeft: 285,

  maxSpread: 0.03,
  requireBookCoherence: true,
  maxBookTopDrift: 0.0015,
  requireQuality: true,
  minCoverage: 0.99,

  applyPolymarketFees: true,
  polymarketFeeCategory: 'crypto',
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

function normalizeSizingMode(value) {
  return String(value || '').trim().toLowerCase() === 'fixed' ? 'fixed' : 'maximize';
}

function mergeParidadeInvarianteParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS, ...raw };
  params.walletSize = Math.max(1, toFiniteNumber(raw.walletSize, DEFAULT_PARAMS.walletSize));
  params.sizingMode = normalizeSizingMode(raw.sizingMode ?? DEFAULT_PARAMS.sizingMode);
  params.targetPairShares = Math.max(1, Math.floor(toFiniteNumber(raw.targetPairShares, DEFAULT_PARAMS.targetPairShares)));
  params.minPairShares = Math.max(1, Math.floor(toFiniteNumber(raw.minPairShares, DEFAULT_PARAMS.minPairShares)));
  params.maxPairShares = Math.max(params.minPairShares, Math.floor(toFiniteNumber(raw.maxPairShares, DEFAULT_PARAMS.maxPairShares)));
  params.targetPairShares = clamp(params.targetPairShares, params.minPairShares, params.maxPairShares);
  params.maxEventNotional = Math.max(0.01, toFiniteNumber(raw.maxEventNotional, DEFAULT_PARAMS.maxEventNotional));
  params.maxPairsPerEvent = Math.max(1, Math.floor(toFiniteNumber(raw.maxPairsPerEvent, DEFAULT_PARAMS.maxPairsPerEvent)));

  params.payoutPerPair = clamp(toFiniteNumber(raw.payoutPerPair, DEFAULT_PARAMS.payoutPerPair), 0.01, 2);
  params.takerFeeRate = Math.max(0, toFiniteNumber(raw.takerFeeRate, DEFAULT_PARAMS.takerFeeRate));
  params.minNetEdgePerShare = Math.max(0, toFiniteNumber(raw.minNetEdgePerShare, DEFAULT_PARAMS.minNetEdgePerShare));
  params.minNetProfitUsd = Math.max(0, toFiniteNumber(raw.minNetProfitUsd, DEFAULT_PARAMS.minNetProfitUsd));
  params.operationalBufferPerShare = Math.max(
    0,
    toFiniteNumber(raw.operationalBufferPerShare, DEFAULT_PARAMS.operationalBufferPerShare),
  );

  params.confirmationTicks = Math.max(1, Math.floor(toFiniteNumber(raw.confirmationTicks, DEFAULT_PARAMS.confirmationTicks)));
  params.executionLatencyTicks = Math.max(
    0,
    Math.floor(toFiniteNumber(raw.executionLatencyTicks, DEFAULT_PARAMS.executionLatencyTicks)),
  );
  params.maxSignalGapMs = Math.max(1, toFiniteNumber(raw.maxSignalGapMs, DEFAULT_PARAMS.maxSignalGapMs));
  params.minSecondsLeft = clamp(toFiniteNumber(raw.minSecondsLeft, DEFAULT_PARAMS.minSecondsLeft), 0, 300);
  params.maxSecondsLeft = clamp(toFiniteNumber(raw.maxSecondsLeft, DEFAULT_PARAMS.maxSecondsLeft), 0, 300);
  if (params.maxSecondsLeft < params.minSecondsLeft) {
    [params.maxSecondsLeft, params.minSecondsLeft] = [params.minSecondsLeft, params.maxSecondsLeft];
  }

  params.maxSpread = clamp(toFiniteNumber(raw.maxSpread, DEFAULT_PARAMS.maxSpread), 0, 0.99);
  params.requireBookCoherence = toBool(raw.requireBookCoherence, DEFAULT_PARAMS.requireBookCoherence);
  params.maxBookTopDrift = Math.max(0, toFiniteNumber(raw.maxBookTopDrift, DEFAULT_PARAMS.maxBookTopDrift));
  params.requireQuality = toBool(raw.requireQuality, DEFAULT_PARAMS.requireQuality);
  params.minCoverage = clamp(toFiniteNumber(raw.minCoverage, DEFAULT_PARAMS.minCoverage), 0, 1);
  params.applyPolymarketFees = toBool(raw.applyPolymarketFees, DEFAULT_PARAMS.applyPolymarketFees);
  params.polymarketFeeCategory = String(raw.polymarketFeeCategory || DEFAULT_PARAMS.polymarketFeeCategory);
  return params;
}

function roundFee(value) {
  if (!(value > 0)) return 0;
  return Math.round((value + Number.EPSILON) * 100000) / 100000;
}

function calculateFillFee(qty, price, feeRate) {
  if (!(qty > 0) || !(price > 0) || !(price < 1) || !(feeRate > 0)) return 0;
  return roundFee(qty * feeRate * price * (1 - price));
}

function parseBookLevels(rawLevels, direction = 'ask') {
  let levels = rawLevels;
  if (typeof levels === 'string') {
    try {
      levels = JSON.parse(levels);
    } catch {
      levels = [];
    }
  }
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => ({
      price: toFiniteNumber(level?.price ?? level?.px),
      size: toFiniteNumber(level?.size ?? level?.sz),
    }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.price < 1 && level.size > 0)
    .sort((left, right) => (direction === 'bid' ? right.price - left.price : left.price - right.price));
}

function visibleBookLevels(tick, side, direction = 'ask') {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const parsedKey = `_parsed_${prefix}_book_${direction}s`;
  const rawKey = `${prefix}_book_${direction}s`;
  const direct = tick?.[parsedKey] ?? tick?.[rawKey];
  const parsed = parseBookLevels(direct, direction);
  if (parsed.length) return parsed;

  const levels = [];
  for (let index = 1; index <= 25; index += 1) {
    const price = toFiniteNumber(tick?.[`${prefix}_${direction}_px_${index}`]);
    const size = toFiniteNumber(tick?.[`${prefix}_${direction}_sz_${index}`]);
    if (price != null && size != null && price > 0 && price < 1 && size > 0) {
      levels.push({ price, size });
    }
  }
  return levels.sort((left, right) => (direction === 'bid' ? right.price - left.price : left.price - right.price));
}

function sideFields(tick, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const fallback = toFiniteNumber(tick?.[`${prefix}_price`]);
  return {
    ask: toFiniteNumber(tick?.[`${prefix}_best_ask`], fallback),
    bid: toFiniteNumber(tick?.[`${prefix}_best_bid`], fallback),
    asks: visibleBookLevels(tick, side, 'ask'),
  };
}

function walkAskBook(levels, requestedQty) {
  const qty = Math.max(0, toFiniteNumber(requestedQty, 0));
  if (!(qty > 0) || !levels.length) return null;

  let remaining = qty;
  let totalCost = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 0.0000001) break;
    const take = Math.min(remaining, level.size);
    if (!(take > 0)) continue;
    fills.push({ price: level.price, qty: take, liquidity: 'taker' });
    totalCost += take * level.price;
    remaining -= take;
  }
  if (remaining > 0.0000001) return null;
  return {
    qty,
    cost: totalCost,
    avgPrice: totalCost / qty,
    worstPrice: fills[fills.length - 1]?.price ?? null,
    fills,
  };
}

function feesForFills(fills, feeRate) {
  return fills.reduce((sum, fill) => sum + calculateFillFee(fill.qty, fill.price, feeRate), 0);
}

function milliseconds(value, fallback = null) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tickTimeMs(tick) {
  return milliseconds(tick?._tsMs, milliseconds(tick?.ts));
}

function eventEndMs(tick) {
  const explicit = milliseconds(tick?._eventEndMs, milliseconds(tick?.event_end));
  if (explicit != null) return explicit;
  const start = milliseconds(tick?._eventStartMs, milliseconds(tick?.event_start));
  return start == null ? null : start + 300000;
}

function secondsRemaining(tick) {
  const now = tickTimeMs(tick);
  const end = eventEndMs(tick);
  if (now == null || end == null) return null;
  return Math.max(0, (end - now) / 1000);
}

function eventKey(tick) {
  const condition = String(tick?.condition_id ?? tick?.conditionId ?? '');
  const start = milliseconds(tick?._eventStartMs, milliseconds(tick?.event_start));
  return `${condition}|${start ?? String(tick?.event_start ?? '')}`;
}

function qualityFailure(tick, params) {
  if (!params.requireQuality) return null;
  if (tick?.degraded === true || tick?.degraded === 1 || tick?.degraded === 'true') return 'degraded';
  const coverage = toFiniteNumber(tick?.coverage);
  if (coverage == null) return 'coverage_missing';
  if (coverage < params.minCoverage) return 'coverage';
  return null;
}

function quoteCoherent(fields, params) {
  if (fields.ask == null || fields.bid == null || !fields.asks.length) return false;
  if (!(fields.bid > 0) || !(fields.ask > 0) || fields.bid > fields.ask) return false;
  if (fields.ask - fields.bid > params.maxSpread + 0.0000001) return false;
  if (!params.requireBookCoherence) return true;
  return Math.abs(fields.ask - fields.asks[0].price) <= params.maxBookTopDrift + 0.0000001;
}

function topNetEdgePerShare(upAsk, downAsk, params) {
  const fees = calculateFillFee(1, upAsk, params.takerFeeRate)
    + calculateFillFee(1, downAsk, params.takerFeeRate);
  return params.payoutPerPair - upAsk - downAsk - fees;
}

function candidateQuantities(upLevels, downLevels, params) {
  if (params.sizingMode === 'fixed') return [params.targetPairShares];
  const visibleUp = upLevels.reduce((sum, level) => sum + level.size, 0);
  const visibleDown = downLevels.reduce((sum, level) => sum + level.size, 0);
  const maxVisible = Math.floor(Math.min(params.maxPairShares, visibleUp, visibleDown));
  const quantities = [];
  for (let qty = maxVisible; qty >= params.minPairShares; qty -= 1) quantities.push(qty);
  return quantities;
}

function evaluatePairOpportunity(tick, rawParams = DEFAULT_PARAMS) {
  const params = rawParams === DEFAULT_PARAMS || rawParams?.__merged
    ? rawParams
    : mergeParidadeInvarianteParams(rawParams);
  const qualityReason = qualityFailure(tick, params);
  if (qualityReason) return { ok: false, reason: qualityReason };

  const secsLeft = secondsRemaining(tick);
  if (secsLeft == null || secsLeft < params.minSecondsLeft || secsLeft > params.maxSecondsLeft) {
    return { ok: false, reason: 'time_window', secsLeft };
  }

  const up = sideFields(tick, 'UP');
  const down = sideFields(tick, 'DOWN');
  if (!quoteCoherent(up, params) || !quoteCoherent(down, params)) {
    return { ok: false, reason: 'book_incoherent', secsLeft };
  }

  const topNetEdge = topNetEdgePerShare(up.ask, down.ask, params);
  const topGuardedEdge = topNetEdge - params.operationalBufferPerShare;
  if (topGuardedEdge + 0.0000001 < params.minNetEdgePerShare) {
    return {
      ok: false,
      reason: 'edge',
      secsLeft,
      topNetEdge,
      topGuardedEdge,
      upAsk: up.ask,
      downAsk: down.ask,
    };
  }

  const quantities = candidateQuantities(up.asks, down.asks, params);
  for (const qty of quantities) {
    if (qty < params.minPairShares || qty > params.maxPairShares) continue;
    const upWalk = walkAskBook(up.asks, qty);
    const downWalk = walkAskBook(down.asks, qty);
    if (!upWalk || !downWalk) continue;

    const totalCost = upWalk.cost + downWalk.cost;
    if (totalCost > params.maxEventNotional + 0.0000001) continue;
    const estimatedFees = feesForFills(upWalk.fills, params.takerFeeRate)
      + feesForFills(downWalk.fills, params.takerFeeRate);
    const grossLockedPnl = (qty * params.payoutPerPair) - totalCost;
    const netLockedPnl = grossLockedPnl - estimatedFees;
    const operationalReserve = qty * params.operationalBufferPerShare;
    const guardedNetPnl = netLockedPnl - operationalReserve;
    const guardedEdgePerShare = guardedNetPnl / qty;
    if (guardedEdgePerShare + 0.0000001 < params.minNetEdgePerShare) continue;
    if (guardedNetPnl + 0.0000001 < params.minNetProfitUsd) continue;

    return {
      ok: true,
      reason: 'complete_set_edge',
      ts: tick?.ts,
      secsLeft,
      qty,
      payout: qty * params.payoutPerPair,
      totalCost,
      grossLockedPnl,
      estimatedFees,
      netLockedPnl,
      operationalReserve,
      guardedNetPnl,
      guardedEdgePerShare,
      topNetEdge,
      topGuardedEdge,
      up: {
        ask: up.ask,
        bid: up.bid,
        avgPrice: upWalk.avgPrice,
        worstPrice: upWalk.worstPrice,
        cost: upWalk.cost,
        fills: upWalk.fills,
      },
      down: {
        ask: down.ask,
        bid: down.bid,
        avgPrice: downWalk.avgPrice,
        worstPrice: downWalk.worstPrice,
        cost: downWalk.cost,
        fills: downWalk.fills,
      },
    };
  }

  return {
    ok: false,
    reason: 'depth_or_profit',
    secsLeft,
    topNetEdge,
    topGuardedEdge,
    upAsk: up.ask,
    downAsk: down.ask,
  };
}

function createEventState(tick) {
  return {
    key: eventKey(tick),
    conditionId: tick?.condition_id ?? null,
    eventStart: tick?.event_start ?? null,
    eventEnd: tick?.event_end ?? null,
    priceToBeat: toFiniteNumber(tick?.price_to_beat),
    lastTick: tick,
    qualifyStreak: 0,
    lastQualifiedAtMs: null,
    pending: null,
    executed: [],
    opportunitiesObserved: 0,
    confirmedSignals: 0,
    latencyMisses: 0,
    rejectionCounts: {},
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = { ...mergeParidadeInvarianteParams(rawParams), __merged: true };
  let current = null;
  const completedEvents = new Set();
  const events = [];
  const equity = [];
  const log = [];
  let ticksProcessed = 0;
  let totalEvents = 0;
  let totalEntries = 0;
  let totalNoEntry = 0;
  let totalPnl = 0;
  let totalGrossLockedPnl = 0;
  let totalEstimatedFees = 0;
  let totalEstimatedNetLockedPnl = 0;
  let totalOperationalReserve = 0;
  let opportunitiesObserved = 0;
  let confirmedSignals = 0;
  let latencyMisses = 0;
  let periodStart = null;
  let periodEnd = null;

  const addRejection = (reason) => {
    if (!current || !reason) return;
    current.rejectionCounts[reason] = (current.rejectionCounts[reason] || 0) + 1;
  };

  const executePair = (tick, opportunity, signal) => {
    if (!current || current.executed.length >= params.maxPairsPerEvent) return false;
    const createdAt = tick?.ts;
    const upFills = opportunity.up.fills.map((fill) => ({
      ...fill,
      side: 'UP',
      time: createdAt,
      source: 'complete_set_buy',
    }));
    const downFills = opportunity.down.fills.map((fill) => ({
      ...fill,
      side: 'DOWN',
      time: createdAt,
      source: 'complete_set_buy',
    }));
    const cycle = {
      time: createdAt,
      signalTime: signal?.signalTime ?? createdAt,
      confirmationTicks: params.confirmationTicks,
      executionLatencyTicks: params.executionLatencyTicks,
      qty: opportunity.qty,
      totalCost: opportunity.totalCost,
      payout: opportunity.payout,
      grossLockedPnl: opportunity.grossLockedPnl,
      estimatedFees: opportunity.estimatedFees,
      netLockedPnl: opportunity.netLockedPnl,
      operationalReserve: opportunity.operationalReserve,
      guardedNetPnl: opportunity.guardedNetPnl,
      guardedEdgePerShare: opportunity.guardedEdgePerShare,
      secsLeft: opportunity.secsLeft,
      up: {
        avgPrice: opportunity.up.avgPrice,
        worstPrice: opportunity.up.worstPrice,
        cost: opportunity.up.cost,
        fills: upFills,
      },
      down: {
        avgPrice: opportunity.down.avgPrice,
        worstPrice: opportunity.down.worstPrice,
        cost: opportunity.down.cost,
        fills: downFills,
      },
    };
    current.executed.push(cycle);
    totalEntries += 1;
    totalGrossLockedPnl += cycle.grossLockedPnl;
    totalEstimatedFees += cycle.estimatedFees;
    totalEstimatedNetLockedPnl += cycle.netLockedPnl;
    totalOperationalReserve += cycle.operationalReserve;
    log.push({
      ts: createdAt,
      type: 'profit',
      msg: `PAR COMPLETO | ${cycle.qty} UP+DOWN | custo $${cycle.totalCost.toFixed(2)} | net estimado $${cycle.netLockedPnl.toFixed(4)}`,
    });
    return true;
  };

  const handlePending = (tick) => {
    if (!current?.pending) return false;
    current.pending.remainingTicks -= 1;
    if (current.pending.remainingTicks > 0) return true;

    const pending = current.pending;
    current.pending = null;
    const opportunity = evaluatePairOpportunity(tick, params);
    if (opportunity.ok) {
      executePair(tick, opportunity, pending);
    } else {
      current.latencyMisses += 1;
      latencyMisses += 1;
      addRejection(`latency_${opportunity.reason}`);
    }
    current.qualifyStreak = 0;
    current.lastQualifiedAtMs = null;
    return true;
  };

  const evaluateTick = (tick) => {
    if (!current || current.executed.length >= params.maxPairsPerEvent) return;
    if (handlePending(tick)) return;

    const opportunity = evaluatePairOpportunity(tick, params);
    if (!opportunity.ok) {
      addRejection(opportunity.reason);
      current.qualifyStreak = 0;
      current.lastQualifiedAtMs = null;
      return;
    }

    opportunitiesObserved += 1;
    current.opportunitiesObserved += 1;
    const nowMs = tickTimeMs(tick);
    const gap = current.lastQualifiedAtMs == null ? null : nowMs - current.lastQualifiedAtMs;
    current.qualifyStreak = gap != null && gap <= params.maxSignalGapMs
      ? current.qualifyStreak + 1
      : 1;
    current.lastQualifiedAtMs = nowMs;
    if (current.qualifyStreak < params.confirmationTicks) return;

    confirmedSignals += 1;
    current.confirmedSignals += 1;
    if (params.executionLatencyTicks === 0) {
      executePair(tick, opportunity, { signalTime: tick?.ts });
    } else {
      current.pending = {
        signalTime: tick?.ts,
        remainingTicks: params.executionLatencyTicks,
        signaledOpportunity: opportunity,
      };
    }
    current.qualifyStreak = 0;
    current.lastQualifiedAtMs = null;
  };

  const finalizeCurrentEvent = (reason = 'expired', closedAt = null) => {
    if (!current) return;
    completedEvents.add(current.key);
    const cycles = current.executed;
    const entered = cycles.length > 0;
    const totalQty = cycles.reduce((sum, cycle) => sum + cycle.qty, 0);
    const totalCost = cycles.reduce((sum, cycle) => sum + cycle.totalCost, 0);
    const payout = cycles.reduce((sum, cycle) => sum + cycle.payout, 0);
    const grossPnl = payout - totalCost;
    const estimatedFees = cycles.reduce((sum, cycle) => sum + cycle.estimatedFees, 0);
    const estimatedNetPnl = grossPnl - estimatedFees;
    const operationalReserve = cycles.reduce((sum, cycle) => sum + cycle.operationalReserve, 0);
    const last = current.lastTick;
    const btcPrice = toFiniteNumber(last?.btc_price);
    const ptb = toFiniteNumber(current.priceToBeat, toFiniteNumber(last?.price_to_beat));
    const winnerSide = btcPrice != null && ptb != null && btcPrice > ptb ? 'UP' : 'DOWN';
    const finalReason = entered ? reason : 'no_entry';
    if (entered) totalPnl += grossPnl;
    else totalNoEntry += 1;

    const orders = [];
    for (const cycle of cycles) {
      orders.push(
        {
          type: 'entry',
          orderRole: 'complete_set_leg',
          side: 'UP',
          source: 'complete_set_buy',
          createdAt: cycle.time,
          shares: cycle.qty,
          filledQty: cycle.qty,
          avgPrice: cycle.up.avgPrice,
          price: cycle.up.avgPrice,
          cost: cycle.up.cost,
          notional: cycle.up.cost,
          liquidity: 'taker',
          fills: cycle.up.fills.map((fill) => ({ ...fill })),
        },
        {
          type: 'entry',
          orderRole: 'complete_set_leg',
          side: 'DOWN',
          source: 'complete_set_buy',
          createdAt: cycle.time,
          shares: cycle.qty,
          filledQty: cycle.qty,
          avgPrice: cycle.down.avgPrice,
          price: cycle.down.avgPrice,
          cost: cycle.down.cost,
          notional: cycle.down.cost,
          liquidity: 'taker',
          fills: cycle.down.fills.map((fill) => ({ ...fill })),
        },
      );
    }

    const finalTs = closedAt || current.eventEnd || last?.ts || current.eventStart;
    events.push({
      eventId: current.conditionId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd,
      entryTime: cycles[0]?.time ?? null,
      exitTime: finalTs,
      reason: finalReason,
      positionType: entered ? 'BOTH' : null,
      winnerSide,
      pairInvariant: true,
      pairQty: totalQty,
      quantity: entered ? totalQty * 2 : 0,
      cost: totalCost,
      payout,
      finalPnl: grossPnl,
      finalPnlBeforeFees: grossPnl,
      estimatedFees,
      estimatedNetPnl,
      operationalReserve,
      cycles: cycles.map((cycle) => ({ ...cycle })),
      orders,
      opportunitiesObserved: current.opportunitiesObserved,
      confirmedSignals: current.confirmedSignals,
      latencyMisses: current.latencyMisses,
      rejectionCounts: { ...current.rejectionCounts },
    });
    equity.push({ ts: finalTs, pnl: totalPnl });
    current = null;
  };

  const processTick = (tick) => {
    ticksProcessed += 1;
    if (!periodStart) periodStart = tick?.ts;
    periodEnd = tick?.ts;
    const key = eventKey(tick);
    if (!current && completedEvents.has(key)) return;

    if (!current || current.key !== key) {
      if (current) finalizeCurrentEvent('expired', current.eventEnd || current.lastTick?.ts);
      if (completedEvents.has(key)) return;
      current = createEventState(tick);
      totalEvents += 1;
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick?.price_to_beat);
    const nowMs = tickTimeMs(tick);
    const endMs = eventEndMs(tick);
    if (nowMs != null && endMs != null && nowMs >= endMs) {
      finalizeCurrentEvent('expired', tick?.event_end || tick?.ts);
      return;
    }
    evaluateTick(tick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd || current.lastTick?.ts);
    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equity) {
      if (point.pnl > peak) peak = point.pnl;
      maxDrawdown = Math.max(maxDrawdown, peak - point.pnl);
    }
    return {
      params,
      strategy: 'PARIDADE_INVARIANTE_V1',
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins: totalEntries,
        totalLosses: 0,
        winRate: totalEntries > 0 ? 100 : 0,
        totalPnl,
        avgPnl: totalEntries > 0 ? totalPnl / totalEntries : 0,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
        grossLockedPnl: totalGrossLockedPnl,
        estimatedFees: totalEstimatedFees,
        estimatedNetLockedPnl: totalEstimatedNetLockedPnl,
        operationalReserve: totalOperationalReserve,
        opportunitiesObserved,
        confirmedSignals,
        latencyMisses,
        executionModel: 'paired_fok_snapshot_non_atomic',
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

function runParidadeInvarianteBacktest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

var __paridadeInvarianteExports = {
  DEFAULT_PARAMS,
  mergeParidadeInvarianteParams,
  calculateFillFee,
  parseBookLevels,
  walkAskBook,
  feesForFills,
  topNetEdgePerShare,
  evaluatePairOpportunity,
  createBacktestRunner,
  runParidadeInvarianteBacktest,
};
