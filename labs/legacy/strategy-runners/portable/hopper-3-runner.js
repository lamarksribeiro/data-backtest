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

const DEFAULT_PARAMS = {
  walletSize: 100,
  pctWallet: 0.06,
  minShares: 10,
  walletMinLimit: 100,
  walletMaxCap: 1000,
  monitoringWindowSec: 290,
  minTimeForNewCycleSec: 35,
  triggerExpensiveCents: 59,
  triggerCheapBaseCents: 20,
  flipIncrementCents: 3,
  distMinPtb: 7,
  cooldownBuySec: 3,
  cooldownFlipSec: 30,
  cooldownHaltEndSec: 60,
  earlyCloseEnabled: true,
  earlyCloseMarginInitial: 0.05,
  earlyCloseMarginLate: 0.01,
  finalProtectionEnabled: true,
  finalProtectionSec: 10,
  fallbackBookSize: 0,
  multReversao: 3,
  multRevCaro: 9,
  multRevBarato: 0.1,
  multRev2Barato: 36,
  multRev2Caro: 0.1,
  multRev3Caro: 20,
  multRev4Barato: 30,
  entrySlippageMax: 0.02,
  exitSlippageMax: 0.02,
  minLiquidityRatio: 0.55,
  maxFlipsAllowed: 5,
  maxSpreadCents: 5,
  minEntryAskCents: 55,
  maxEntryAskCents: 85,
  stopLossCentsFromAvg: 0,
  dynamicSizingEnabled: true,
  simulateMaker: true,
  // optimistic_maker | resting_maker | taker — se omitido, deriva de simulateMaker
  executionMode: null,
  makerFillEpsilon: 0.01,
  makerTimeoutSec: 15,
};

function resolveExecutionMode(raw = {}, simulateMaker = true) {
  const mode = String(raw.executionMode ?? '').trim().toLowerCase();
  if (mode === 'optimistic_maker' || mode === 'optimistic') return 'optimistic_maker';
  if (mode === 'resting_maker' || mode === 'resting') return 'resting_maker';
  if (mode === 'taker') return 'taker';
  return simulateMaker ? 'optimistic_maker' : 'taker';
}

/** Fill maker quando o ask atravessa o limite (mesma regra do orderSimulator GLS). */
function shouldFillRestingBuy(prevAsk, currAsk, limitPrice, epsilon = 0.01) {
  if (prevAsk == null || currAsk == null || limitPrice == null) return false;
  if (!Number.isFinite(prevAsk) || !Number.isFinite(currAsk) || !Number.isFinite(limitPrice)) return false;
  return prevAsk >= limitPrice && currAsk <= limitPrice - epsilon;
}

function mergeHopperParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize',
    'pctWallet',
    'minShares',
    'walletMinLimit',
    'walletMaxCap',
    'monitoringWindowSec',
    'minTimeForNewCycleSec',
    'triggerExpensiveCents',
    'triggerCheapBaseCents',
    'flipIncrementCents',
    'distMinPtb',
    'cooldownBuySec',
    'cooldownFlipSec',
    'cooldownHaltEndSec',
    'earlyCloseMarginInitial',
    'earlyCloseMarginLate',
    'finalProtectionSec',
    'fallbackBookSize',
    'multReversao',
    'multRevCaro',
    'multRevBarato',
    'multRev2Barato',
    'multRev2Caro',
    'multRev3Caro',
    'multRev4Barato',
    'entrySlippageMax',
    'exitSlippageMax',
    'minLiquidityRatio',
    'maxFlipsAllowed',
    'maxSpreadCents',
    'minEntryAskCents',
    'maxEntryAskCents',
    'stopLossCentsFromAvg',
    'makerFillEpsilon',
    'makerTimeoutSec',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.earlyCloseEnabled = toBool(raw.earlyCloseEnabled ?? raw.earlyClose, params.earlyCloseEnabled);
  params.finalProtectionEnabled = toBool(raw.finalProtectionEnabled ?? raw.finalProtection, params.finalProtectionEnabled);
  params.dynamicSizingEnabled = toBool(raw.dynamicSizingEnabled ?? raw.dynamicSizing, params.dynamicSizingEnabled);
  params.simulateMaker = toBool(raw.simulateMaker ?? raw.simulateMaker, params.simulateMaker);
  params.executionMode = resolveExecutionMode(raw, params.simulateMaker);
  // Compat: simulateMaker espelha se o modo é maker (otimista ou resting)
  params.simulateMaker = params.executionMode !== 'taker';

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

function walkBook(rawAsks, sharesDesejadas, bestAsk, fallbackBookSize) {
  const levels = parseBookLevels(rawAsks, 'ask');
  if (!levels.length) {
    return { avgPrice: bestAsk, subiu: false };
  }

  let restante = sharesDesejadas;
  let custo = 0.0;
  let execSh = 0.0;
  let ultimoPreco = levels[0].price;
  let levelsUsed = 0;

  for (const level of levels) {
    if (restante <= 1e-9) break;
    ultimoPreco = level.price;
    const disp = level.size;
    const se = Math.min(restante, disp);
    if (se <= 0) continue;
    execSh += se;
    custo += se * level.price;
    restante -= se;
    levelsUsed++;
  }

  if (restante > 1e-9) {
    custo += restante * ultimoPreco;
    execSh += restante;
  }

  const avgPrice = execSh > 0 ? custo / execSh : bestAsk;
  return { avgPrice, subiu: levelsUsed > 1 };
}

function walkBookBids(rawBids, sharesDesejadas, bestBid) {
  const levels = parseBookLevels(rawBids, 'bid');
  if (!levels.length) {
    return { avgPrice: bestBid, subiu: false };
  }

  let restante = sharesDesejadas;
  let receita = 0.0;
  let execSh = 0.0;
  let ultimoPreco = levels[0].price;
  let levelsUsed = 0;

  for (const level of levels) {
    if (restante <= 1e-9) break;
    ultimoPreco = level.price;
    const disp = level.size;
    const se = Math.min(restante, disp);
    if (se <= 0) continue;
    execSh += se;
    receita += se * level.price;
    restante -= se;
    levelsUsed++;
  }

  if (restante > 1e-9) {
    receita += restante * ultimoPreco;
    execSh += restante;
  }

  const avgPrice = execSh > 0 ? receita / execSh : bestBid;
  return { avgPrice, subiu: levelsUsed > 1 };
}

function calcEntrada(saldoEfetivo, params) {
  if (saldoEfetivo < params.walletMinLimit) {
    return params.minShares;
  }
  const cappedSaldo = Math.min(saldoEfetivo, params.walletMaxCap);
  const valor = cappedSaldo * params.pctWallet;
  const shares = valor / (params.triggerExpensiveCents / 100);
  return Math.max(params.minShares, Math.round(shares));
}

function sharesCascata(entradaCaro, params) {
  return {
    REVERSAO: Math.round(entradaCaro * params.multReversao),
    REV_CARO: Math.round(entradaCaro * params.multRevCaro),
    REV_BARATO: Math.round(entradaCaro * params.multRevBarato),
    REV2_BARATO: Math.round(entradaCaro * params.multRev2Barato),
    REV2_CARO: Math.round(entradaCaro * params.multRev2Caro),
    REV3_CARO: Math.round(entradaCaro * params.multRev3Caro),
    REV4_BARATO: Math.round(entradaCaro * params.multRev4Barato),
  };
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

function eventKey(tickOrState) {
  const rawEventStart = tickOrState.event_start ?? tickOrState.eventStart;
  const eventStart = rawEventStart instanceof Date ? rawEventStart.toISOString() : new Date(rawEventStart).toISOString();
  return `${eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEndMs - new Date(tick.ts).getTime()) / 1000);
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
    shares: { UP: 0, DOWN: 0 },
    cost: { UP: 0, DOWN: 0 },
    realizedPnl: 0,
    fills: { UP: [], DOWN: [] },
    exits: { UP: [], DOWN: [] },
    lastBuyTimeMs: 0,
    lastFlipTimeMs: 0,
    restingBuy: null,
    restingStats: {
      placed: 0,
      filled: 0,
      cancelled: 0,
      rejected: 0,
    },
    state: {
      entradaFeita: false,
      ladoCaro: null,
      ladoBarato: null,
      shEntradaCaro: 0,
      reversaoFeita: false,
      revCaroPend: false,
      revBaratoPend: false,
      revCaroFeito: false,
      revBaratoFeito: false,
      rev2BaratoPend: false,
      rev2CaroPend: false,
      rev2BaratoFeito: false,
      rev2CaroFeito: false,
      rev3CaroPend: false,
      rev3CaroFeito: false,
      rev4BaratoPend: false,
      rev4BaratoFeito: false,
      equalizado: false,
      fechadoAntecipado: false,
      protegidoFinal: false,
      nivelEq: 0,
    },
    lastDiagnostics: null,
  };
}

function closeReasonFromPnl(pnl) {
  if (pnl > 0) return 'WIN';
  if (pnl < 0) return 'LOSS';
  return 'FLAT';
}

function std(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length);
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
  const params = mergeHopperParams(rawParams);
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

  const calcDynamicFlipShares = (precoAsk, params) => {
    if (!params.dynamicSizingEnabled) {
      return null;
    }
    const takerFeeRate = 0.0007; // Taxa taker da Polymarket (0.07%)
    const totalInvestido = current.cost.UP + current.cost.DOWN; // Prejuízo acumulado anterior
    
    // Lucro alvo esperado se a entrada inicial tivesse dado certo
    const precoEntradaEstimado = params.triggerExpensiveCents / 100;
    const lucroAlvoInicial = current.state.shEntradaCaro * (1 - precoEntradaEstimado - takerFeeRate * (1 + precoEntradaEstimado));
    const lucroAlvo = Math.max(2, lucroAlvoInicial); // Pelo menos $2 de lucro
    
    // N = (Cost_prev + Lucro_alvo) / (1 - P - T * (1 + P))
    const denominador = 1 - precoAsk - takerFeeRate * (1 + precoAsk);
    
    if (denominador <= 0.01) {
      return Math.round(current.state.shEntradaCaro * 3);
    }
    
    const sharesNecessarias = (totalInvestido + lucroAlvo) / denominador;
    const maxSharesLimit = (equityNow() * params.pctWallet * 20) / precoAsk; // Limite de risk management (máximo de 20x a entrada)
    
    const finalShares = Math.min(maxSharesLimit, Math.max(params.minShares, sharesNecessarias));
    return Math.round(finalShares);
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    cancelRestingBuy('event_end');
    completedEvents.add(eventKey(current));
    const tick = current.lastTick;
    const closedAt = closeTs || new Date(current.eventEndMs).toISOString();
    const restingPlaced = current.restingStats.placed;
    const restingFilled = current.restingStats.filled;
    const restingCancelled = current.restingStats.cancelled;
    const restingRejected = current.restingStats.rejected;
    const makerFillRate = restingPlaced > 0 ? restingFilled / restingPlaced : null;

    const totalFillsCount = current.fills.UP.length + current.fills.DOWN.length;
    if (totalFillsCount === 0) {
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
        restingPlaced,
        restingFilled,
        restingCancelled,
        restingRejected,
        makerFillRate,
        executionMode: params.executionMode,
      });
      equity.push({ ts: closedAt, pnl: totalPnl });
      current = null;
      return;
    }

    let finalPnl = current.realizedPnl;
    let expiryPnl = 0;
    let winnerSide = null;

    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    winnerSide = btcPrice != null && priceToBeat != null && btcPrice >= priceToBeat ? 'UP' : 'DOWN';

    if (current.shares.UP > 0) {
      const settlementValue = winnerSide === 'UP' ? current.shares.UP * 1.0 : 0;
      expiryPnl += settlementValue - current.cost.UP;
      current.shares.UP = 0;
      current.cost.UP = 0;
    }
    if (current.shares.DOWN > 0) {
      const settlementValue = winnerSide === 'DOWN' ? current.shares.DOWN * 1.0 : 0;
      expiryPnl += settlementValue - current.cost.DOWN;
      current.shares.DOWN = 0;
      current.cost.DOWN = 0;
    }

    finalPnl += expiryPnl;
    totalPnl += finalPnl;
    totalEntries++;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    const firstFill = current.fills.UP[0] || current.fills.DOWN[0];

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: new Date(current.eventEndMs).toISOString(),
      positionType: current.state.ladoCaro || 'BOTH',
      entryTime: firstFill ? firstFill.time : null,
      entryDistanceToPtb: firstFill && btcPrice != null && priceToBeat != null ? Math.abs(btcPrice - priceToBeat) : null,
      entryTimeRemaining: firstFill ? secondsRemaining(current, { ts: firstFill.time }) : null,
      quantity: firstFill ? firstFill.qty : 0,
      cost: firstFill ? firstFill.qty * firstFill.price : 0,
      avgEntryPrice: firstFill ? firstFill.price : 0,
      fills: [
        ...current.fills.UP.map((f) => ({ ...f, side: 'UP' })),
        ...current.fills.DOWN.map((f) => ({ ...f, side: 'DOWN' })),
      ],
      exits: [
        ...current.exits.UP.map((e) => ({ ...e, side: 'UP' })),
        ...current.exits.DOWN.map((e) => ({ ...e, side: 'DOWN' })),
      ],
      expirationResult: closeReasonFromPnl(finalPnl),
      winnerSide,
      expiryPnl,
      finalPnl,
      reason: current.state.fechadoAntecipado ? 'profit_exit' : (current.state.protegidoFinal ? 'stop_bid' : reason),
      closedAt,
      diagnostics: { ...current.state },
      restingPlaced,
      restingFilled,
      restingCancelled,
      restingRejected,
      makerFillRate,
      executionMode: params.executionMode,
    });
    equity.push({ ts: closedAt, pnl: totalPnl });
    addLog(
      closedAt,
      `EVENTO FIN | Hopper 3 | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
    current = null;
  };

  const cancelRestingBuy = (reason = 'cancelled') => {
    if (!current?.restingBuy || current.restingBuy.status !== 'open') return false;
    current.restingBuy.status = 'cancelled';
    current.restingBuy.cancelReason = reason;
    current.restingStats.cancelled += 1;
    addLog(
      current.lastTick?.ts || new Date().toISOString(),
      `RESTING CANCEL | ${current.restingBuy.side} ${current.restingBuy.qty}sh @ ${current.restingBuy.price} | ${reason}`,
      'info',
    );
    current.restingBuy = null;
    return true;
  };

  const applyImmediateBuy = (lado, qty, askPrice, type, ts, onFill) => {
    const fields = sideFields(current.lastTick, lado);
    const optimistic = params.executionMode === 'optimistic_maker';
    const execPrice = optimistic ? (fields.bid || fields.price || askPrice) : askPrice;
    const { avgPrice } = walkBook(fields.rawAsks, qty, execPrice, params.fallbackBookSize);
    const finalPrice = optimistic ? execPrice : avgPrice;
    const cost = qty * finalPrice;
    current.shares[lado] += qty;
    current.cost[lado] += cost;

    const fill = {
      price: finalPrice,
      qty,
      time: ts,
      type,
      liquidity: optimistic ? 'maker' : 'taker',
    };
    current.fills[lado].push(fill);
    current.lastBuyTimeMs = new Date(ts).getTime();
    addLog(
      ts,
      `COMPRA Hopper 3 | ${lado} ${qty.toFixed(0)}sh @ $${finalPrice.toFixed(4)} | Tipo: ${type} | Liq: ${fill.liquidity}`,
      'entry',
    );
    if (typeof onFill === 'function') onFill();
    return qty;
  };

  const placeRestingBuy = (lado, qty, askPrice, type, ts, onFill) => {
    const fields = sideFields(current.lastTick, lado);
    const bid = fields.bid || fields.price;
    const ask = fields.ask || askPrice;

    if (current.restingBuy?.status === 'open'
      && current.restingBuy.side === lado
      && current.restingBuy.type === type) {
      return 0;
    }

    if (current.restingBuy?.status === 'open') {
      cancelRestingBuy('replaced');
    }

    if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || bid >= 1) {
      current.restingStats.rejected += 1;
      addLog(ts, `RESTING REJECT | ${lado} bid inválido`, 'info');
      return 0;
    }
    // Marketable: preço >= ask executaria como taker — não repousa
    if (bid >= ask) {
      current.restingStats.rejected += 1;
      addLog(ts, `RESTING REJECT | ${lado} bid=${bid} >= ask=${ask} (marketable)`, 'info');
      return 0;
    }

    current.restingBuy = {
      side: lado,
      price: bid,
      qty,
      type,
      placedTs: ts,
      placedMs: new Date(ts).getTime(),
      placedRefAsk: ask,
      lastAsk: ask,
      onFill: typeof onFill === 'function' ? onFill : null,
      status: 'open',
    };
    current.restingStats.placed += 1;
    current.lastBuyTimeMs = new Date(ts).getTime();
    addLog(
      ts,
      `RESTING PLACE | ${lado} ${qty.toFixed(0)}sh @ $${bid.toFixed(4)} | Tipo: ${type} | refAsk=${ask.toFixed(4)}`,
      'info',
    );
    return 0;
  };

  const checkRestingBuys = (tick) => {
    const resting = current?.restingBuy;
    if (!resting || resting.status !== 'open') return 0;

    const tickMs = new Date(tick.ts).getTime();
    const timeoutMs = (params.makerTimeoutSec || 15) * 1000;
    if (tickMs - resting.placedMs >= timeoutMs) {
      cancelRestingBuy('timeout');
      return 0;
    }

    const fields = sideFields(tick, resting.side);
    const currAsk = fields.ask;
    if (currAsk == null) return 0;

    const prevAsk = resting.lastAsk ?? resting.placedRefAsk;
    const epsilon = params.makerFillEpsilon ?? 0.01;
    const crossed = shouldFillRestingBuy(prevAsk, currAsk, resting.price, epsilon);
    resting.lastAsk = currAsk;
    if (!crossed) return 0;

    const qty = resting.qty;
    const lado = resting.side;
    const type = resting.type;
    const onFill = resting.onFill;
    const fillPrice = resting.price;

    current.shares[lado] += qty;
    current.cost[lado] += qty * fillPrice;
    current.fills[lado].push({
      price: fillPrice,
      qty,
      time: tick.ts,
      type,
      liquidity: 'maker',
    });
    current.restingStats.filled += 1;
    resting.status = 'filled';
    current.restingBuy = null;
    current.lastBuyTimeMs = tickMs;

    addLog(
      tick.ts,
      `RESTING FILL | ${lado} ${qty.toFixed(0)}sh @ $${fillPrice.toFixed(4)} | Tipo: ${type} | Liq: maker`,
      'entry',
    );
    if (typeof onFill === 'function') onFill();
    return qty;
  };

  const buyShares = (lado, qty, askPrice, type, ts, onFill = null) => {
    if (params.executionMode === 'resting_maker') {
      return placeRestingBuy(lado, qty, askPrice, type, ts, onFill);
    }
    return applyImmediateBuy(lado, qty, askPrice, type, ts, onFill);
  };

  const sellShares = (lado, qty, bidPrice, type, ts) => {
    const fields = sideFields(current.lastTick, lado);
    // resting_maker: saídas sempre taker; optimistic_maker: ask; taker: bid walk
    const optimistic = params.executionMode === 'optimistic_maker';
    const execPrice = optimistic ? (fields.ask || fields.price || bidPrice) : bidPrice;
    const { avgPrice } = walkBookBids(fields.rawBids, qty, execPrice);
    const finalPrice = optimistic ? execPrice : avgPrice;
    const revenue = qty * finalPrice;
    const avgCostPrice = current.shares[lado] > 0 ? current.cost[lado] / current.shares[lado] : 0;
    const consumedCost = avgCostPrice * qty;

    const tradePnl = revenue - consumedCost;
    current.realizedPnl += tradePnl;

    current.shares[lado] -= qty;
    current.cost[lado] = Math.max(0, current.cost[lado] - consumedCost);

    const exit = {
      price: finalPrice,
      qty,
      time: ts,
      type,
      pnl: tradePnl,
      liquidity: optimistic ? 'maker' : 'taker',
    };
    current.exits[lado].push(exit);

    addLog(
      ts,
      `VENDA Hopper 3 | ${lado} ${qty.toFixed(0)}sh @ $${finalPrice.toFixed(4)} | PnL $${tradePnl.toFixed(2)} | Tipo: ${type} | Liq: ${exit.liquidity}`,
      'exit',
    );
    return revenue;
  };

  const maybeEvaluateHopper = (tick) => {
    checkRestingBuys(tick);

    const tickTimeMs = new Date(tick.ts).getTime();
    const timeRemainingSec = secondsRemaining(current, tick);

    const fieldsUp = sideFields(tick, 'UP');
    const fieldsDown = sideFields(tick, 'DOWN');

    if (fieldsUp.ask == null || fieldsDown.ask == null) return;

    const askUpC = fieldsUp.ask * 100;
    const askDownC = fieldsDown.ask * 100;

    const btcPrice = toFiniteNumber(tick.btc_price);
    const ptb = current.priceToBeat;

    const agora = tickTimeMs;
    const podeComprar = (agora - current.lastBuyTimeMs) >= params.cooldownBuySec * 1000;
    const cooldownAtivo = timeRemainingSec > params.cooldownHaltEndSec;
    const viradaLiberada = !cooldownAtivo || (agora - current.lastFlipTimeMs) >= params.cooldownFlipSec * 1000;

    const distOkLado = (lado) => {
      if (ptb == null || btcPrice == null) return true;
      if (lado === 'UP') return btcPrice >= ptb + params.distMinPtb;
      return btcPrice <= ptb - params.distMinPtb;
    };

    // 1. Fechamento antecipado
    if (params.earlyCloseEnabled && current.state.entradaFeita && !current.state.equalizado && !current.state.fechadoAntecipado) {
      if (current.shares.UP > 0 && current.shares.DOWN > 0) {
        let nivelFech = 0;
        if (current.state.rev4BaratoFeito) nivelFech = 5;
        else if (current.state.rev3CaroFeito) nivelFech = 4;
        else if (current.state.rev2BaratoFeito) nivelFech = 3;
        else if (current.state.revCaroFeito) nivelFech = 2;
        else if (current.state.reversaoFeita) nivelFech = 1;

        const margemFech = nivelFech <= 2 ? params.earlyCloseMarginInitial : params.earlyCloseMarginLate;

        const bidUp = fieldsUp.bid || fieldsUp.price;
        const bidDown = fieldsDown.bid || fieldsDown.price;

        const recebeUp = current.shares.UP * bidUp;
        const recebeDown = current.shares.DOWN * bidDown;
        const recebeTot = recebeUp + recebeDown;

        const totalInvestido = current.cost.UP + current.cost.DOWN;
        const lucroFechar = recebeTot - totalInvestido;
        const lucroAlvo = totalInvestido * margemFech;

        if (lucroFechar >= lucroAlvo) {
          sellShares('UP', current.shares.UP, bidUp, 'FECHA-UP', tick.ts);
          sellShares('DOWN', current.shares.DOWN, bidDown, 'FECHA-DOWN', tick.ts);
          current.state.fechadoAntecipado = true;
          finalizeCurrentEvent('early_close', tick.ts);
          return;
        }
      }
    }

    // 2. Equalização
    if (!current.state.equalizado && !current.state.fechadoAntecipado && podeComprar) {
      let nivelEq = 0;
      if (current.state.rev4BaratoFeito) nivelEq = 5;
      else if (current.state.rev3CaroFeito) nivelEq = 4;
      else if (current.state.rev2BaratoFeito) nivelEq = 3;
      else if (current.state.revCaroFeito) nivelEq = 2;
      else if (current.state.reversaoFeita) nivelEq = 1;

      const eqPreco = 0.05;

      for (const ladoB of ['UP', 'DOWN']) {
        const askB = ladoB === 'UP' ? fieldsUp.ask : fieldsDown.ask;
        if (askB <= eqPreco) {
          const ladoO = ladoB === 'UP' ? 'DOWN' : 'UP';
          const shB = ladoB === 'UP' ? current.shares.UP : current.shares.DOWN;
          const shO = ladoO === 'UP' ? current.shares.UP : current.shares.DOWN;
          const falta = shO - shB;
          if (falta > 0) {
            buyShares(ladoB, falta, askB, 'EQUALIZA', tick.ts, () => {
              current.state.equalizado = true;
              current.state.nivelEq = nivelEq;
            });
            return;
          }
        }
      }
    }

    // 3. Proteção Final
    if (params.finalProtectionEnabled && current.state.entradaFeita && !current.state.equalizado && !current.state.fechadoAntecipado && !current.state.protegidoFinal) {
      if (timeRemainingSec <= params.finalProtectionSec && btcPrice != null && ptb != null) {
        let ladoDominante = null;
        if (current.shares.UP > current.shares.DOWN) ladoDominante = 'UP';
        else if (current.shares.DOWN > current.shares.UP) ladoDominante = 'DOWN';

        const ladoFavorecido = btcPrice >= ptb ? 'UP' : 'DOWN';
        if (ladoDominante != null && ladoDominante === ladoFavorecido) {
          const bidUp = fieldsUp.bid || fieldsUp.price;
          const bidDown = fieldsDown.bid || fieldsDown.price;

          if (current.shares.UP > 0) sellShares('UP', current.shares.UP, bidUp, 'PROTECAO-FINAL', tick.ts);
          if (current.shares.DOWN > 0) sellShares('DOWN', current.shares.DOWN, bidDown, 'PROTECAO-FINAL', tick.ts);
          current.state.protegidoFinal = true;
          finalizeCurrentEvent('final_protection', tick.ts);
          return;
        }
      }
    }

    // 3.1. Stop Loss Dinâmico
    if (params.stopLossCentsFromAvg > 0 && current && current.state.entradaFeita && !current.state.equalizado && !current.state.fechadoAntecipado && !current.state.protegidoFinal) {
      const ladoDominante = current.state.ladoCaro;
      const shDom = current.shares[ladoDominante];
      if (shDom > 0) {
        const avgPrice = current.cost[ladoDominante] / shDom;
        const fieldsDom = ladoDominante === 'UP' ? fieldsUp : fieldsDown;
        const bidDom = fieldsDom.bid || fieldsDom.price;
        if (bidDom != null && bidDom <= (avgPrice - params.stopLossCentsFromAvg / 100)) {
          const bidUp = fieldsUp.bid || fieldsUp.price;
          const bidDown = fieldsDown.bid || fieldsDown.price;

          if (current.shares.UP > 0) sellShares('UP', current.shares.UP, bidUp, 'STOP-LOSS', tick.ts);
          if (current.shares.DOWN > 0) sellShares('DOWN', current.shares.DOWN, bidDown, 'STOP-LOSS', tick.ts);

          finalizeCurrentEvent('stop_loss', tick.ts);
          return;
        }
      }
    }

    // 4. Entrada Inicial
    if (!current.state.entradaFeita) {
      const caroNow = askUpC >= askDownC ? 'UP' : 'DOWN';
      const askCaro = caroNow === 'UP' ? fieldsUp.ask : fieldsDown.ask;
      const askCaroC = askCaro * 100;
      const fieldsCaro = caroNow === 'UP' ? fieldsUp : fieldsDown;
      const bidCaro = fieldsCaro.bid || fieldsCaro.price || askCaro;
      const spreadCaroCents = Math.abs(askCaro - bidCaro) * 100;

      if (podeComprar 
          && timeRemainingSec > params.minTimeForNewCycleSec 
          && askCaroC >= params.triggerExpensiveCents 
          && askCaroC <= params.maxEntryAskCents
          && askCaroC >= params.minEntryAskCents
          && spreadCaroCents <= params.maxSpreadCents
          && distOkLado(caroNow)) {
        current.state.ladoCaro = caroNow;
        current.state.ladoBarato = caroNow === 'UP' ? 'DOWN' : 'UP';

        const shEntradaCaro = calcEntrada(equityNow(), params);
        current.state.shEntradaCaro = shEntradaCaro;

        buyShares(current.state.ladoCaro, shEntradaCaro, askCaro, 'INICIO', tick.ts, () => {
          current.state.entradaFeita = true;
          current.lastFlipTimeMs = agora;
        });
      }
    } else if (!current.state.equalizado && !current.state.fechadoAntecipado) {
      // 5. Cascata de Viradas
      const shEvento = sharesCascata(current.state.shEntradaCaro, params);
      const ladoCaro = current.state.ladoCaro;
      const ladoBarato = current.state.ladoBarato;

      const askCaro = ladoCaro === 'UP' ? fieldsUp.ask : fieldsDown.ask;
      const askBarato = ladoBarato === 'UP' ? fieldsUp.ask : fieldsDown.ask;

      const askCaroC = askCaro * 100;
      const askBaratoC = askBarato * 100;

      const pReversao = params.triggerExpensiveCents - params.flipIncrementCents;
      const pRevCaro = params.triggerExpensiveCents - params.flipIncrementCents;
      const pRevBarato = params.triggerCheapBaseCents;
      const pRev2Barato = params.triggerExpensiveCents - params.flipIncrementCents;
      const pRev2Caro = params.triggerCheapBaseCents;
      const pRev3Caro = params.triggerExpensiveCents - params.flipIncrementCents;
      const pRev4Barato = params.triggerExpensiveCents - params.flipIncrementCents;

      // (a) 1a VIRADA
      if (params.maxFlipsAllowed >= 1 && !current.state.reversaoFeita && podeComprar && askBaratoC >= pReversao && distOkLado(ladoBarato) && viradaLiberada) {
        const qty = calcDynamicFlipShares(askBarato, params) ?? shEvento.REVERSAO;
        buyShares(ladoBarato, qty, askBarato, '1a VIRADA', tick.ts, () => {
          current.state.reversaoFeita = true;
          current.lastFlipTimeMs = agora;
          current.state.revCaroPend = true;
          current.state.revBaratoPend = true;
        });
      }
      // (b) 2a VIRADA
      else if (params.maxFlipsAllowed >= 2 && current.state.revCaroPend && !current.state.revCaroFeito && podeComprar && askCaroC >= pRevCaro && distOkLado(ladoCaro) && viradaLiberada) {
        const qty = calcDynamicFlipShares(askCaro, params) ?? shEvento.REV_CARO;
        buyShares(ladoCaro, qty, askCaro, '2a VIRADA', tick.ts, () => {
          current.state.revCaroFeito = true;
          current.lastFlipTimeMs = agora;
          current.state.rev2BaratoPend = true;
          current.state.rev2CaroPend = true;
        });
      }
      // (c) REV-BARATO
      else if (current.state.revBaratoPend && !current.state.revBaratoFeito && podeComprar && askBaratoC <= pRevBarato) {
        buyShares(ladoBarato, shEvento.REV_BARATO, askBarato, 'REV-BARATO', tick.ts, () => {
          current.state.revBaratoFeito = true;
        });
      }
      // (d) 3a VIRADA
      else if (params.maxFlipsAllowed >= 3 && current.state.rev2BaratoPend && !current.state.rev2BaratoFeito && podeComprar && askBaratoC >= pRev2Barato && distOkLado(ladoBarato) && viradaLiberada) {
        const qty = calcDynamicFlipShares(askBarato, params) ?? shEvento.REV2_BARATO;
        buyShares(ladoBarato, qty, askBarato, '3a VIRADA', tick.ts, () => {
          current.state.rev2BaratoFeito = true;
          current.lastFlipTimeMs = agora;
          current.state.rev3CaroPend = true;
        });
      }
      // (e) REV2-CARO
      else if (current.state.rev2CaroPend && !current.state.rev2CaroFeito && podeComprar && askCaroC <= pRev2Caro) {
        buyShares(ladoCaro, shEvento.REV2_CARO, askCaro, 'REV2-CARO', tick.ts, () => {
          current.state.rev2CaroFeito = true;
        });
      }
      // (f) 4a VIRADA
      else if (params.maxFlipsAllowed >= 4 && current.state.rev3CaroPend && !current.state.rev3CaroFeito && podeComprar && askCaroC >= pRev3Caro && distOkLado(ladoCaro) && viradaLiberada) {
        const qty = calcDynamicFlipShares(askCaro, params) ?? shEvento.REV3_CARO;
        buyShares(ladoCaro, qty, askCaro, '4a VIRADA', tick.ts, () => {
          current.state.rev3CaroFeito = true;
          current.lastFlipTimeMs = agora;
          current.state.rev4BaratoPend = true;
        });
      }
      // (g) 5a VIRADA
      else if (params.maxFlipsAllowed >= 5 && current.state.rev4BaratoPend && !current.state.rev4BaratoFeito && podeComprar && askBaratoC >= pRev4Barato && distOkLado(ladoBarato) && viradaLiberada) {
        const qty = calcDynamicFlipShares(askBarato, params) ?? shEvento.REV4_BARATO;
        buyShares(ladoBarato, qty, askBarato, '5a VIRADA', tick.ts, () => {
          current.state.rev4BaratoFeito = true;
          current.lastFlipTimeMs = agora;
        });
      }
    }
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
      addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | Hopper 3 V1`, 'info');
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);
    const tickTimeMs = new Date(tick.ts).getTime();
    if (tickTimeMs < new Date(current.eventStart).getTime()) return;

    const currentMarketUp = marketProbUp(tick);
    if (tickTimeMs >= current.eventEndMs) {
      finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
      return;
    }

    maybeEvaluateHopper(tick);
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
    const restingPlaced = events.reduce((s, e) => s + (e.restingPlaced || 0), 0);
    const restingFilled = events.reduce((s, e) => s + (e.restingFilled || 0), 0);
    const restingCancelled = events.reduce((s, e) => s + (e.restingCancelled || 0), 0);
    return {
      params,
      strategy: 'HOPPER_3_V1',
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
        executionMode: params.executionMode,
        restingPlaced,
        restingFilled,
        restingCancelled,
        makerFillRate: restingPlaced > 0 ? restingFilled / restingPlaced : null,
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

function runHopper3Backtest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runHopper3BacktestInBatches(rawParams, tickBatches) {
  const runner = createBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}

// Surface for unit tests (library loader only calls createBacktestRunner)
var __hopperExports = {
  createBacktestRunner,
  mergeHopperParams,
  resolveExecutionMode,
  shouldFillRestingBuy,
  runHopper3Backtest,
  runHopper3BacktestInBatches,
};
