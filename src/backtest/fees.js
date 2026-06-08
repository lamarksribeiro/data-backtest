export const POLYMARKET_FEE_RATES = Object.freeze({
  crypto: 0.07,
  sports: 0.03,
  finance: 0.04,
  politics: 0.04,
  economics: 0.05,
  culture: 0.05,
  weather: 0.05,
  other: 0.05,
  general: 0.05,
  mentions: 0.04,
  tech: 0.04,
  geopolitics: 0,
});

export const DEFAULT_POLYMARKET_FEE_CATEGORY = 'crypto';

const FEE_SCALE = 100000;

export function calculatePolymarketTakerFee({ shares, price, feeRate = POLYMARKET_FEE_RATES.crypto } = {}) {
  const qty = positiveNumber(shares);
  const normalizedPrice = clampPrice(price);
  const normalizedRate = toFiniteNumber(feeRate);
  if (qty == null || normalizedPrice == null || normalizedRate == null || normalizedRate <= 0) return 0;
  return roundFee(qty * normalizedRate * normalizedPrice * (1 - normalizedPrice));
}

export function applyPolymarketFeesToBacktestResult(result, options = {}) {
  if (!result || typeof result !== 'object') return result;

  const params = result.params && typeof result.params === 'object' ? result.params : {};
  if (params.applyPolymarketFees === false || options.enabled === false) return result;

  const category = normalizeCategory(options.category ?? params.polymarketFeeCategory);
  const feeRate = resolveFeeRate({ ...options, category, feeRate: options.feeRate ?? params.polymarketFeeRate });
  const events = Array.isArray(result.events) ? result.events : [];
  const feeTotals = {
    applied: true,
    model: 'polymarket_taker',
    category,
    currency: 'USDC',
    feeRate,
    totalFee: 0,
    entryFee: 0,
    exitFee: 0,
    entryNotional: 0,
    exitNotional: 0,
    volume: 0,
    tradesCharged: 0,
    entryTradesCharged: 0,
    exitTradesCharged: 0,
  };

  for (const event of events) {
    if (!isEnteredEvent(event)) continue;
    const beforeFees = toFiniteNumber(event.finalPnlBeforeFees) ?? toFiniteNumber(event.finalPnl) ?? 0;
    const entrySummary = summarizeTrades(collectEntryTrades(event), feeRate);
    const exitSummary = summarizeTrades(collectExitTrades(event), feeRate);
    const totalFee = roundFee(entrySummary.fee + exitSummary.fee);

    event.finalPnlBeforeFees = beforeFees;
    event.finalPnl = beforeFees - totalFee;
    event.fees = {
      applied: true,
      model: 'polymarket_taker',
      category,
      currency: 'USDC',
      feeRate,
      totalFee,
      entryFee: entrySummary.fee,
      exitFee: exitSummary.fee,
      tradesCharged: entrySummary.trades + exitSummary.trades,
      entryTradesCharged: entrySummary.trades,
      exitTradesCharged: exitSummary.trades,
      entryNotional: entrySummary.notional,
      exitNotional: exitSummary.notional,
      entryShares: entrySummary.shares,
      exitShares: exitSummary.shares,
      entries: entrySummary.details,
      exits: exitSummary.details,
    };

    feeTotals.totalFee = roundFee(feeTotals.totalFee + totalFee);
    feeTotals.entryFee = roundFee(feeTotals.entryFee + entrySummary.fee);
    feeTotals.exitFee = roundFee(feeTotals.exitFee + exitSummary.fee);
    feeTotals.entryNotional += entrySummary.notional;
    feeTotals.exitNotional += exitSummary.notional;
    feeTotals.volume = feeTotals.entryNotional + feeTotals.exitNotional;
    feeTotals.tradesCharged += entrySummary.trades + exitSummary.trades;
    feeTotals.entryTradesCharged += entrySummary.trades;
    feeTotals.exitTradesCharged += exitSummary.trades;
  }

  result.params = {
    ...params,
    applyPolymarketFees: true,
    polymarketFeeCategory: category,
    polymarketFeeRate: feeRate,
  };
  result.feeModel = {
    applied: true,
    model: 'polymarket_taker',
    category,
    currency: 'USDC',
    feeRate,
    formula: 'shares * feeRate * price * (1 - price)',
    roundingDecimals: 5,
  };

  recomputeSummary(result, feeTotals);
  if (Array.isArray(result.log)) {
    result.log.push({
      ts: new Date().toISOString(),
      type: 'info',
      msg: `Taxas Polymarket aplicadas | categoria ${category} | taxa ${feeRate} | total $${feeTotals.totalFee.toFixed(5)}`,
    });
  }

  return result;
}

function collectEntryTrades(event) {
  const trades = [];
  if (!event || event.reason === 'no_entry') return trades;

  const orders = Array.isArray(event.orders) ? event.orders : [];
  const entryOrders = orders.filter((order) => order?.type ? order.type === 'entry' : true);
  if (entryOrders.length) {
    for (const order of entryOrders) addOrderTrade(trades, order, { source: order.source ?? order.reason ?? 'entry' });
    return trades;
  }

  addTradesFromFills(trades, event.fills, {
    side: event.positionType,
    source: 'entry',
    time: event.entryTime,
  });
  if (Array.isArray(event.reversals)) {
    for (const reversal of event.reversals) {
      addTradesFromFills(trades, reversal.entryFills, {
        side: reversal.toSide,
        source: 'stop_reverse',
        time: reversal.time,
      });
    }
  }
  return trades;
}

function collectExitTrades(event) {
  const trades = [];
  if (!event || event.reason === 'no_entry') return trades;

  if (Array.isArray(event.exits) && event.exits.length) {
    for (const exit of event.exits) addExitTrade(trades, exit);
    return trades;
  }

  const orders = Array.isArray(event.orders) ? event.orders : [];
  for (const order of orders.filter((item) => item?.type === 'exit')) addOrderTrade(trades, order, { source: order.reason ?? 'exit' });

  if (Array.isArray(event.profitOrders)) {
    for (const order of event.profitOrders) {
      const filledQty = positiveNumber(order?.filledQty ?? (order?.filled ? order?.qty : null));
      if (filledQty == null) continue;
      addTrade(trades, {
        qty: filledQty,
        price: order.price,
        side: event.positionType,
        source: 'profit_order',
        time: order.fillTime,
      });
    }
  }

  if (Array.isArray(event.reversals)) {
    for (const reversal of event.reversals) {
      addTrade(trades, {
        qty: reversal.soldQty,
        price: reversal.exitPrice,
        proceeds: reversal.exitProceeds,
        side: reversal.fromSide,
        source: 'stop_reverse_exit',
        time: reversal.time,
      });
    }
  }
  return trades;
}

function addExitTrade(trades, exit) {
  if (Array.isArray(exit?.fills) && exit.fills.length) {
    addTradesFromFills(trades, exit.fills, {
      side: exit.side,
      source: exit.reason ?? 'exit',
      time: exit.time ?? exit.ts,
    });
    return;
  }
  addTrade(trades, {
    qty: exit?.qty ?? exit?.shares ?? exit?.soldQty ?? exit?.exitQty,
    price: exit?.avgPrice ?? exit?.price ?? exit?.exitPrice,
    proceeds: exit?.proceeds ?? exit?.notional ?? exit?.exitProceeds,
    side: exit?.side,
    source: exit?.reason ?? 'exit',
    time: exit?.time ?? exit?.ts,
  });
}

function addOrderTrade(trades, order, defaults = {}) {
  if (Array.isArray(order?.fills) && order.fills.length) {
    addTradesFromFills(trades, order.fills, {
      side: order.side,
      source: defaults.source,
      time: order.createdAt ?? order.ts,
    });
    return;
  }
  addTrade(trades, {
    qty: order?.shares ?? order?.filledQty ?? order?.qty,
    price: order?.avgPrice ?? order?.price,
    cost: order?.cost ?? order?.notional,
    proceeds: order?.notional,
    side: order?.side,
    source: defaults.source,
    time: order?.createdAt ?? order?.ts,
  });
}

function addTradesFromFills(trades, fills, defaults = {}) {
  if (!Array.isArray(fills)) return;
  for (const fill of fills) addTrade(trades, fill, defaults);
}

function addTrade(trades, rawTrade, defaults = {}) {
  const qty = positiveNumber(rawTrade?.qty ?? rawTrade?.shares ?? rawTrade?.filledQty ?? rawTrade?.size);
  if (qty == null) return;

  const cost = toFiniteNumber(rawTrade?.cost ?? rawTrade?.notional);
  const proceeds = toFiniteNumber(rawTrade?.proceeds);
  const price = clampPrice(rawTrade?.price ?? rawTrade?.avgPrice ?? rawTrade?.avgEntryPrice ?? (cost != null ? cost / qty : null) ?? (proceeds != null ? proceeds / qty : null) ?? defaults.price);
  if (price == null || price <= 0 || price >= 1) return;

  trades.push({
    qty,
    price,
    side: rawTrade?.side ?? defaults.side ?? null,
    source: rawTrade?.source ?? defaults.source ?? null,
    reason: rawTrade?.reason ?? defaults.reason ?? null,
    time: rawTrade?.time ?? rawTrade?.createdAt ?? rawTrade?.ts ?? defaults.time ?? null,
  });
}

function summarizeTrades(trades, feeRate) {
  const details = [];
  let fee = 0;
  let notional = 0;
  let shares = 0;
  for (const trade of trades) {
    const tradeFee = calculatePolymarketTakerFee({ shares: trade.qty, price: trade.price, feeRate });
    if (tradeFee <= 0) continue;
    fee += tradeFee;
    notional += trade.qty * trade.price;
    shares += trade.qty;
    details.push({ ...trade, fee: tradeFee });
  }
  return { fee: roundFee(fee), notional, shares, trades: details.length, details };
}

function recomputeSummary(result, fees) {
  if (!result.summary) result.summary = {};
  const summary = result.summary;
  const events = Array.isArray(result.events) ? result.events : [];
  const enteredEvents = events.filter(isEnteredEvent);
  const pnls = enteredEvents.map((event) => toFiniteNumber(event.finalPnl) ?? 0);
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const totalPnl = pnls.reduce((sum, value) => sum + value, 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + Math.abs(value), 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const totalEntries = toFiniteNumber(summary.totalEntries ?? summary.entries) ?? enteredEvents.length;
  const totalWins = wins.length;
  const totalLosses = losses.length;
  const avgPnl = totalEntries > 0 ? totalPnl / totalEntries : 0;
  const pnlStd = std(pnls);
  const downsideStd = std(losses);

  summary.totalWins = totalWins;
  summary.totalLosses = totalLosses;
  summary.wins = totalWins;
  summary.losses = totalLosses;
  summary.winRate = totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0;
  summary.totalPnl = totalPnl;
  summary.pnl = totalPnl;
  summary.avgPnl = avgPnl;
  summary.avgWin = avgWin;
  summary.avgLoss = avgLoss;
  summary.maxWin = pnls.length ? Math.max(...pnls) : 0;
  summary.maxLoss = pnls.length ? Math.min(...pnls) : 0;
  summary.grossProfit = grossProfit;
  summary.grossLoss = grossLoss;
  summary.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0);
  summary.sharpe = pnlStd > 0 ? avgPnl / pnlStd : 0;
  summary.sharpeRatio = summary.sharpe;
  summary.sortino = downsideStd > 0 ? avgPnl / downsideStd : 0;
  summary.sortinoRatio = summary.sortino;
  summary.finalWallet = (toFiniteNumber(result.params?.walletSize) ?? toFiniteNumber(summary.finalWallet) ?? 0) + totalPnl;
  summary.maxDrawdown = rebuildEquity(result, events);
  summary.volume = fees.volume;
  summary.fees = fees;
  summary.totalFees = fees.totalFee;
  summary.feesPaid = fees.totalFee;
  summary.feeDrag = Math.abs(totalPnl) + fees.totalFee > 0 ? fees.totalFee / (Math.abs(totalPnl) + fees.totalFee) : 0;
}

function std(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function rebuildEquity(result, events) {
  let cumulative = 0;
  result.equity = events.map((event) => {
    cumulative += toFiniteNumber(event?.finalPnl) ?? 0;
    return { ts: event?.closedAt || event?.eventEnd || event?.entryTime || null, pnl: cumulative };
  }).filter((point) => point.ts != null);
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of result.equity) {
    peak = Math.max(peak, Number(point.pnl || 0));
    maxDrawdown = Math.max(maxDrawdown, peak - Number(point.pnl || 0));
  }
  return maxDrawdown;
}

function isEnteredEvent(event) {
  if (!event || event.reason === 'no_entry') return false;
  return positiveNumber(event.cost) != null
    || positiveNumber(event.quantity) != null
    || (Array.isArray(event.orders) && event.orders.length > 0)
    || positiveNumber(event.finalPnl) != null;
}

function resolveFeeRate(options = {}) {
  const explicitRate = toFiniteNumber(options.feeRate);
  if (explicitRate != null && explicitRate >= 0) return explicitRate;
  return POLYMARKET_FEE_RATES[normalizeCategory(options.category)];
}

function normalizeCategory(category) {
  const key = String(category || DEFAULT_POLYMARKET_FEE_CATEGORY).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(POLYMARKET_FEE_RATES, key) ? key : DEFAULT_POLYMARKET_FEE_CATEGORY;
}

function positiveNumber(value) {
  const numberValue = toFiniteNumber(value);
  return numberValue != null && numberValue > 0 ? numberValue : null;
}

function clampPrice(value) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return null;
  return Math.min(1, Math.max(0, numberValue));
}

function roundFee(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round((value + Number.EPSILON) * FEE_SCALE) / FEE_SCALE;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}
