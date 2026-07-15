/**
 * Hopper 4 V1 — stop-and-reverse one-sided (port of polymarket-fm/Hopper4.py).
 * Live logic only: entry @ trigger, flip = sell all + buy opposite with mult ladder, FOK, PTB filter.
 * No equalization / early-close / take-profit / final protection (dead in Python).
 */

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
  triggerCents: 60,
  distMinPtb: 5,
  distFinalPtb: 2,
  distFinalSec: 30,
  cooldownBuySec: 3,
  cooldownFlipSec: 25,
  cooldownHaltEndSec: 60,
  fallbackBookSize: 0,
  multVirada: [2, 4, 8, 20, 32],
  maxViradas: 5,
  fokEnabled: true,
  fokPriceCap: 0.75,
  fokAteVirada: 1,
  somaMinValida: 85,
  somaMaxValida: 115,
};

function parseMultVirada(raw) {
  if (Array.isArray(raw)) {
    const nums = raw.map((v) => toFiniteNumber(v)).filter((v) => v != null && v > 0);
    return nums.length ? nums : [...DEFAULT_PARAMS.multVirada];
  }
  if (typeof raw === 'string') {
    try {
      return parseMultVirada(JSON.parse(raw));
    } catch {
      const parts = raw.split(/[,|]/).map((s) => toFiniteNumber(s.trim())).filter((v) => v != null && v > 0);
      return parts.length ? parts : [...DEFAULT_PARAMS.multVirada];
    }
  }
  return [...DEFAULT_PARAMS.multVirada];
}

function mergeHopper4Params(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize',
    'pctWallet',
    'minShares',
    'walletMinLimit',
    'walletMaxCap',
    'monitoringWindowSec',
    'minTimeForNewCycleSec',
    'triggerCents',
    'distMinPtb',
    'distFinalPtb',
    'distFinalSec',
    'cooldownBuySec',
    'cooldownFlipSec',
    'cooldownHaltEndSec',
    'fallbackBookSize',
    'maxViradas',
    'fokPriceCap',
    'fokAteVirada',
    'somaMinValida',
    'somaMaxValida',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  // Compat: hopper-3 naming
  if (raw.triggerExpensiveCents != null && raw.triggerCents == null) {
    const v = toFiniteNumber(raw.triggerExpensiveCents);
    if (v != null) params.triggerCents = v;
  }

  if (raw.multVirada != null) {
    params.multVirada = parseMultVirada(raw.multVirada);
  }

  params.fokEnabled = toBool(raw.fokEnabled ?? raw.fok, params.fokEnabled);
  params.maxViradas = Math.max(0, Math.floor(params.maxViradas));
  params.fokAteVirada = Math.max(0, Math.floor(params.fokAteVirada));

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
    return { avgPrice: bestAsk, subiu: false, liquidezTotal: null, cabe: true };
  }

  let restante = sharesDesejadas;
  let custo = 0.0;
  let execSh = 0.0;
  let ultimoPreco = levels[0].price;
  let levelsUsed = 0;
  let liquidezTotal = 0;

  for (const level of levels) {
    liquidezTotal += level.size;
    if (restante <= 1e-9) continue;
    ultimoPreco = level.price;
    const se = Math.min(restante, level.size);
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
  return {
    avgPrice,
    subiu: levelsUsed > 1,
    liquidezTotal,
    cabe: liquidezTotal + 1e-9 >= sharesDesejadas,
  };
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
    const se = Math.min(restante, level.size);
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

function analisarLiquidezFok(rawAsks, sharesDesejadas, bestAsk, fokPriceCap) {
  const levels = parseBookLevels(rawAsks, 'ask');
  if (!levels.length) {
    const ok = bestAsk != null && bestAsk <= fokPriceCap;
    return {
      executavel: ok,
      precoMedio: bestAsk,
      liquidezTotal: null,
      motivo: ok ? 'sem book, bestAsk ok' : `sem book, bestAsk > teto ${fokPriceCap}`,
    };
  }

  let restante = sharesDesejadas;
  let custo = 0;
  let execSh = 0;
  let liquidezTotal = 0;

  for (const level of levels) {
    liquidezTotal += level.size;
    if (restante <= 1e-9) continue;
    const se = Math.min(restante, level.size);
    if (se <= 0) continue;
    execSh += se;
    custo += se * level.price;
    restante -= se;
  }

  const cabe = restante <= 1e-9;
  if (!cabe) {
    return {
      executavel: false,
      precoMedio: null,
      liquidezTotal,
      motivo: `liquidez insuficiente (${liquidezTotal.toFixed(0)}sh < ${sharesDesejadas})`,
    };
  }

  const precoMedio = execSh > 0 ? custo / execSh : bestAsk;
  const executavel = precoMedio != null && precoMedio <= fokPriceCap;
  return {
    executavel,
    precoMedio,
    liquidezTotal,
    motivo: executavel
      ? `FOK ok media ${(precoMedio * 100).toFixed(1)}c`
      : `media ${(precoMedio * 100).toFixed(1)}c > teto ${(fokPriceCap * 100).toFixed(0)}c`,
  };
}

function calcEntrada(saldoEfetivo, params) {
  if (saldoEfetivo < params.walletMinLimit) {
    return params.minShares;
  }
  const cappedSaldo = Math.min(saldoEfetivo, params.walletMaxCap);
  const valor = cappedSaldo * params.pctWallet;
  const shares = valor / (params.triggerCents / 100);
  return Math.max(params.minShares, Math.round(shares));
}

function ladoOposto(lado) {
  return lado === 'UP' ? 'DOWN' : 'UP';
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
    shares: { UP: 0, DOWN: 0 },
    cost: { UP: 0, DOWN: 0 },
    realizedPnl: 0,
    fills: { UP: [], DOWN: [] },
    exits: { UP: [], DOWN: [] },
    lastBuyTimeMs: 0,
    lastFlipTimeMs: 0,
    state: {
      entradaFeita: false,
      ladoAtual: null,
      shEntrada: 0,
      nViradas: 0,
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
  const params = mergeHopper4Params(rawParams);
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
        nViradas: current.state.nViradas,
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
      positionType: current.state.ladoAtual || 'ONE_SIDE',
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
      reason,
      closedAt,
      diagnostics: { ...current.state },
      nViradas: current.state.nViradas,
    });
    equity.push({ ts: closedAt, pnl: totalPnl });
    addLog(
      closedAt,
      `EVENTO FIN | Hopper 4 | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | viradas ${current.state?.nViradas ?? 0} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
    current = null;
  };

  const buyShares = (lado, qty, askPrice, type, ts) => {
    const fields = sideFields(current.lastTick, lado);
    const { avgPrice } = walkBook(fields.rawAsks, qty, askPrice, params.fallbackBookSize);
    const finalPrice = avgPrice;
    const cost = qty * finalPrice;
    current.shares[lado] += qty;
    current.cost[lado] += cost;

    const fill = {
      price: finalPrice,
      qty,
      time: ts,
      type,
      liquidity: 'taker',
    };
    current.fills[lado].push(fill);
    current.lastBuyTimeMs = new Date(ts).getTime();
    addLog(
      ts,
      `COMPRA Hopper 4 | ${lado} ${qty.toFixed(0)}sh @ $${finalPrice.toFixed(4)} | Tipo: ${type}`,
      'entry',
    );
    return qty;
  };

  const sellShares = (lado, qty, bidPrice, type, ts) => {
    const fields = sideFields(current.lastTick, lado);
    const execPrice = bidPrice ?? fields.bid ?? fields.price;
    const { avgPrice } = walkBookBids(fields.rawBids, qty, execPrice);
    const finalPrice = avgPrice;
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
      liquidity: 'taker',
    };
    current.exits[lado].push(exit);

    addLog(
      ts,
      `VENDA Hopper 4 | ${lado} ${qty.toFixed(0)}sh @ $${finalPrice.toFixed(4)} | PnL $${tradePnl.toFixed(2)} | Tipo: ${type}`,
      'exit',
    );
    return revenue;
  };

  const tryBuyFok = (lado, qty, askPrice, type, ts, numVirada) => {
    const usarFok = params.fokEnabled && numVirada <= params.fokAteVirada;
    const fields = sideFields(current.lastTick, lado);

    if (usarFok) {
      const an = analisarLiquidezFok(fields.rawAsks, qty, askPrice, params.fokPriceCap);
      if (!an.executavel) {
        addLog(
          ts,
          `FOK CANCELOU ${type} | ${lado} ${qty}sh | ${an.motivo}`,
          'info',
        );
        return false;
      }
    }

    buyShares(lado, qty, askPrice, type, ts);
    return true;
  };

  const distOkLado = (lado, btcPrice, ptb, timeRemainingSec) => {
    if (ptb == null || btcPrice == null) return true;
    const distMin = timeRemainingSec <= params.distFinalSec ? params.distFinalPtb : params.distMinPtb;
    if (lado === 'UP') return btcPrice >= ptb + distMin;
    return btcPrice <= ptb - distMin;
  };

  const maybeEvaluateHopper = (tick) => {
    const tickTimeMs = new Date(tick.ts).getTime();
    const timeRemainingSec = secondsRemaining(current, tick);

    if (timeRemainingSec > params.monitoringWindowSec) return;

    const fieldsUp = sideFields(tick, 'UP');
    const fieldsDown = sideFields(tick, 'DOWN');

    if (fieldsUp.ask == null || fieldsDown.ask == null) return;

    const askUpC = fieldsUp.ask * 100;
    const askDownC = fieldsDown.ask * 100;
    const somaOdds = askUpC + askDownC;
    if (somaOdds >= params.somaMaxValida || somaOdds <= params.somaMinValida) return;

    const btcPrice = toFiniteNumber(tick.btc_price);
    const ptb = current.priceToBeat;

    const agora = tickTimeMs;
    const podeComprar = (agora - current.lastBuyTimeMs) >= params.cooldownBuySec * 1000;
    const cooldownAtivo = timeRemainingSec > params.cooldownHaltEndSec;
    const viradaLiberada = !cooldownAtivo || (agora - current.lastFlipTimeMs) >= params.cooldownFlipSec * 1000;

    if (!current.state.entradaFeita) {
      const caroNow = askUpC >= askDownC ? 'UP' : 'DOWN';
      const fieldsCaro = caroNow === 'UP' ? fieldsUp : fieldsDown;
      const askCaro = fieldsCaro.ask;
      const askCaroC = askCaro * 100;

      if (
        podeComprar
        && timeRemainingSec > params.minTimeForNewCycleSec
        && askCaroC >= params.triggerCents
        && distOkLado(caroNow, btcPrice, ptb, timeRemainingSec)
      ) {
        const shEntrada = calcEntrada(equityNow(), params);
        const ok = tryBuyFok(caroNow, shEntrada, askCaro, 'INICIO', tick.ts, 0);
        if (ok) {
          current.state.entradaFeita = true;
          current.state.ladoAtual = caroNow;
          current.state.shEntrada = shEntrada;
          current.state.nViradas = 0;
          current.lastFlipTimeMs = agora;
        }
      }
      return;
    }

    // Posição aberta: stop-and-reverse
    const ladoAtual = current.state.ladoAtual;
    if (!ladoAtual) return;

    const novo = ladoOposto(ladoAtual);
    const fieldsNovo = novo === 'UP' ? fieldsUp : fieldsDown;
    const fieldsAtual = ladoAtual === 'UP' ? fieldsUp : fieldsDown;
    const askNovoC = fieldsNovo.ask * 100;

    if (
      current.state.nViradas < params.maxViradas
      && podeComprar
      && viradaLiberada
      && askNovoC >= params.triggerCents
      && distOkLado(novo, btcPrice, ptb, timeRemainingSec)
    ) {
      const numVirada = current.state.nViradas + 1;
      const multIdx = Math.min(current.state.nViradas, params.multVirada.length - 1);
      const mult = params.multVirada[multIdx];
      const shComprar = Math.max(params.minShares, Math.round(current.state.shEntrada * mult));

      const usarFok = params.fokEnabled && numVirada <= params.fokAteVirada;
      if (usarFok) {
        const an = analisarLiquidezFok(fieldsNovo.rawAsks, shComprar, fieldsNovo.ask, params.fokPriceCap);
        if (!an.executavel) {
          addLog(
            tick.ts,
            `FOK CANCELOU VIRADA ${numVirada} -> [${novo}] ${shComprar}sh | ${an.motivo} | mantem [${ladoAtual}]`,
            'info',
          );
          return;
        }
      }

      const shVender = current.shares[ladoAtual];
      if (shVender > 0) {
        const bidAtual = fieldsAtual.bid ?? fieldsAtual.price ?? fieldsAtual.ask;
        sellShares(ladoAtual, shVender, bidAtual, 'VIRA-VENDE', tick.ts);
      }

      buyShares(novo, shComprar, fieldsNovo.ask, `VIRA${numVirada}-COMPRA`, tick.ts);
      current.state.ladoAtual = novo;
      current.state.nViradas = numVirada;
      current.lastFlipTimeMs = agora;
      addLog(
        tick.ts,
        `VIRADA ${numVirada} -> [${novo}] | mult ${mult}x | ${shComprar}sh`,
        'info',
      );
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
      addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | Hopper 4 V1`, 'info');
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);
    const tickTimeMs = new Date(tick.ts).getTime();
    if (tickTimeMs < new Date(current.eventStart).getTime()) return;

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
    return {
      params,
      strategy: 'HOPPER_4_V1',
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

function runHopper4Backtest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runHopper4BacktestInBatches(rawParams, tickBatches) {
  const runner = createBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}

var __hopper4Exports = {
  createBacktestRunner,
  mergeHopper4Params,
  parseMultVirada,
  analisarLiquidezFok,
  calcEntrada,
  runHopper4Backtest,
  runHopper4BacktestInBatches,
};
