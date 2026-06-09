import { createStandardLibrary } from './standardLibrary.js';

export function createOrderSimulator({ limits = {} } = {}) {
  const lib = createStandardLibrary();
  const maxOrders = limits.maxOrdersPerEvent ?? 20;
  let position = null;
  let orders = [];
  let exits = [];
  let realizedPnl = 0;
  const consumedAsksBySide = { UP: new Map(), DOWN: new Map() };
  const consumedBidsBySide = { UP: new Map(), DOWN: new Map() };

  function planEntry(side, options = {}, consume = true) {
    if (orders.filter((o) => o.type === 'entry').length >= maxOrders) return null;
    const price = Number(options.price);
    const budget = Number(options.budget ?? options.maxOrderValue ?? 10);
    const maxPrice = Number.isFinite(Number(options.maxPrice)) ? Number(options.maxPrice) : price;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(maxPrice) || maxPrice <= 0) return null;
    const minShares = Math.max(0, Number(options.minShares ?? 0));
    const requestedShares = Number(options.qty ?? options.shares);
    const targetShares = Number.isFinite(requestedShares) && requestedShares > 0
      ? Math.floor(requestedShares)
      : lib.risk.sizeByBudget(maxPrice, budget);
    if (targetShares <= 0 || targetShares < minShares) return null;

    const consumedByPrice = options.ignoreConsumed ? new Map() : consumedAsksBySide[side];
    const fills = fillAsks(side, options.tick, maxPrice, targetShares, consumedByPrice, price, consume && !options.ignoreConsumed);
    const availableShares = fills.reduce((sum, fill) => sum + fill.qty, 0);
    if (availableShares < targetShares * Number(options.minLiquidityRatio ?? 0)) return null;
    if (availableShares < minShares) return null;

    const shares = Math.min(targetShares, availableShares);
    trimFills(fills, shares);
    const notional = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (shares <= 0 || notional > budget + 0.000001) return null;
    const avgEntryPrice = notional / shares;
    return {
      position: { side, totalShares: shares, remainingShares: shares, totalCost: notional, openCost: notional, avgEntryPrice, peakBid: price },
      order: {
        type: 'entry',
        side,
        ts: options.ts,
        price,
        shares,
        notional,
        avgPrice: avgEntryPrice,
        maxPrice,
        fills: fills.map((fill) => ({ ...fill })),
        reason: options.reason ?? 'entry',
      },
    };
  }

  const api = {
    get positionView() {
      return {
        open: Boolean(position),
        side: position?.side ?? null,
        shares: position?.remainingShares ?? 0,
        totalShares: position?.totalShares ?? 0,
        totalCost: position?.totalCost ?? 0,
        openCost: position?.openCost ?? 0,
        avgPrice: position ? currentOpenAveragePrice(position) : null,
        avgEntryPrice: position?.avgEntryPrice ?? null,
        peakBid: position?.peakBid ?? null,
      };
    },
    enter(side, options = {}) {
      if (position || orders.filter((o) => o.type === 'entry').length >= maxOrders) return false;
      const planned = planEntry(side, options, true);
      if (!planned) return false;
      position = planned.position;
      const order = planned.order;
      orders.push(order);
      return order;
    },
    exit(options = {}) {
      if (!position) return false;
      const price = Number(options.price);
      if (!Number.isFinite(price)) return false;
      const minShares = Math.max(0, Number(options.minShares ?? 0));
      const requestedShares = Number(options.qty ?? options.shares);
      const pct = Number(options.pct);
      let shares = position.remainingShares;
      if (Number.isFinite(requestedShares) && requestedShares > 0) shares = requestedShares;
      else if (Number.isFinite(pct) && pct > 0) shares = Math.floor(position.totalShares * Math.min(1, pct));
      shares = Math.min(position.remainingShares, Math.floor(shares));
      if (shares <= 0 || shares < minShares) return false;

      const fills = fillBids(position.side, options.tick, price, shares, consumedBidsBySide[position.side]);
      const filledShares = fills.reduce((sum, fill) => sum + fill.qty, 0);
      if (filledShares <= 0 || filledShares < minShares) return false;
      shares = filledShares;

      const avgOpenCost = currentOpenAveragePrice(position);
      const consumedCost = avgOpenCost * shares;
      const proceeds = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
      const pnl = proceeds - consumedCost;
      realizedPnl += pnl;
      position.remainingShares -= shares;
      position.openCost = Math.max(0, position.openCost - consumedCost);
      const remainingShares = position.remainingShares;
      const order = {
        type: 'exit',
        side: position.side,
        ts: options.ts,
        price,
        shares,
        notional: proceeds,
        avgPrice: proceeds / shares,
        fills: fills.map((fill) => ({ ...fill })),
        pnl,
        remainingShares,
        closed: remainingShares <= 0,
        reason: options.reason ?? 'exit',
      };
      exits.push(order);
      orders.push(order);
      if (position.remainingShares <= 0) position = null;
      return order;
    },
    reverse(side, options = {}) {
      if (!position) return api.enter(side, options);
      const planned = planEntry(side, options, false);
      if (!planned) return false;
      const exitPrice = Number(options.exitPrice ?? options.price);
      if (!Number.isFinite(exitPrice)) return false;
      const exitOrder = api.exit({ price: exitPrice, tick: options.tick, reason: options.exitReason ?? 'reverse_exit', ts: options.ts });
      if (!exitOrder) return false;
      if (!exitOrder.closed) return false;
      const committed = planEntry(side, options, true);
      if (!committed) return false;
      position = committed.position;
      orders.push(committed.order);
      return committed.order;
    },
    closeOpenPosition(options = {}) {
      if (!position) return false;
      const bid = Number(options.price);
      const side = position.side;
      const price = Number.isFinite(bid)
        ? bid
        : lib.book.bid(side, options.tick || {});
      return api.exit({ price, tick: options.tick, reason: options.reason ?? 'close', ts: options.ts });
    },
    reset() {
      position = null;
      orders = [];
      exits = [];
      realizedPnl = 0;
      consumedAsksBySide.UP.clear();
      consumedAsksBySide.DOWN.clear();
      consumedBidsBySide.UP.clear();
      consumedBidsBySide.DOWN.clear();
    },
    snapshot() {
      return {
        position: position ? { ...position, shares: position.remainingShares, cost: position.openCost, avgPrice: currentOpenAveragePrice(position) } : null,
        orders: orders.map((o) => ({ ...o })),
        exits: exits.map((o) => ({ ...o })),
        realizedPnl,
      };
    },
    updatePeakBid(tick, lib) {
      if (!position) return;
      const bid = lib.book.bid(position.side, tick);
      if (Number.isFinite(bid)) position.peakBid = Math.max(position.peakBid ?? bid, bid);
    },
  };

  return api;
}

export function settleEventPnl(simulator, tick, event) {
  const snap = simulator.snapshot();
  if (!snap.position) {
    return { finalPnl: snap.realizedPnl, reason: snap.orders.length ? 'closed' : 'no_entry', expirationResult: null };
  }
  const side = snap.position.side;
  const underlying = Number(tick?.btc_price ?? tick?.underlyingPrice);
  const ptb = Number(event?.priceToBeat ?? tick?.price_to_beat);
  const winnerSide = underlying > ptb ? 'UP' : 'DOWN';
  const won = winnerSide === side;
  const expiryPnl = won ? snap.position.remainingShares - snap.position.openCost : -snap.position.openCost;
  const finalPnl = snap.realizedPnl + expiryPnl;
  return {
    finalPnl,
    reason: won ? 'expiry_win' : 'expiry_loss',
    expirationResult: won ? 'win' : 'loss',
    winnerSide,
    expiryPnl,
  };
}

function currentOpenAveragePrice(currentPosition) {
  if (!currentPosition || currentPosition.remainingShares <= 0) return 0;
  return currentPosition.openCost / Math.max(0.000001, currentPosition.remainingShares);
}

function fillAsks(side, tick, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk, consume = true) {
  const levels = askLevels(side, tick, fallbackBestAsk);
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
    if (consume) consumedByPrice.set(level.key, reservedQty + fillQty);
    fills.push({ price: level.price, qty: fillQty });
    remainingQty -= fillQty;
  }
  return fills;
}

function askLevels(side, tick, fallbackBestAsk) {
  const prefix = side === 'DOWN' ? 'down_ask' : 'up_ask';
  const cacheKey = `_parsed_${prefix}`;
  if (tick && tick[cacheKey]) return tick[cacheKey];

  const rawLevels = side === 'DOWN'
    ? (tick?._parsed_down_book_asks || tick?.down_book_asks)
    : (tick?._parsed_up_book_asks || tick?.up_book_asks);
  const parsed = parseBookLevels(rawLevels);
  if (parsed.length) {
    if (tick) tick[cacheKey] = parsed;
    return parsed;
  }

  const flattened = [];
  const depth = tick?.book_depth ?? 25;
  for (let i = 1; i <= depth; i += 1) {
    const price = finiteNumber(tick?.[`${prefix}_px_${i}`]);
    const size = finiteNumber(tick?.[`${prefix}_sz_${i}`]);
    if (price != null && size != null && size > 0) flattened.push({ price, size, key: String(price) });
  }
  const result = flattened.length ? flattened.sort((left, right) => left.price - right.price) : [];
  if (result.length > 0) {
    Object.defineProperty(result, '_isParsed', { value: true, enumerable: false });
    if (tick) tick[cacheKey] = result;
    return result;
  }

  const fallback = finiteNumber(fallbackBestAsk);
  return fallback == null ? [] : [{ price: fallback, size: Number.POSITIVE_INFINITY, key: String(fallback) }];
}

function fillBids(side, tick, minPrice, requestedQty, consumedByPrice) {
  const levels = bidLevels(side, tick, minPrice);
  const visiblePriceKeys = new Set(levels.map((level) => level.key));
  for (const key of Array.from(consumedByPrice.keys())) {
    if (!visiblePriceKeys.has(key)) consumedByPrice.delete(key);
  }

  const fills = [];
  let remainingQty = requestedQty;
  for (const level of levels) {
    if (remainingQty <= 0) break;
    if (level.price < minPrice) continue;
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

function bidLevels(side, tick, fallbackBestBid) {
  const prefix = side === 'DOWN' ? 'down_bid' : 'up_bid';
  const cacheKey = `_parsed_${prefix}`;
  if (tick && tick[cacheKey]) return tick[cacheKey];

  const rawLevels = side === 'DOWN'
    ? (tick?._parsed_down_book_bids || tick?.down_book_bids)
    : (tick?._parsed_up_book_bids || tick?.up_book_bids);
  const parsed = parseBookLevels(rawLevels, 'bid');
  if (parsed.length) {
    if (tick) tick[cacheKey] = parsed;
    return parsed;
  }

  const flattened = [];
  const depth = tick?.book_depth ?? 25;
  for (let i = 1; i <= depth; i += 1) {
    const price = finiteNumber(tick?.[`${prefix}_px_${i}`]);
    const size = finiteNumber(tick?.[`${prefix}_sz_${i}`]);
    if (price != null && size != null && size > 0) flattened.push({ price, size, key: String(price) });
  }
  const result = flattened.length ? flattened.sort((left, right) => right.price - left.price) : [];
  if (result.length > 0) {
    Object.defineProperty(result, '_isParsed', { value: true, enumerable: false });
    if (tick) tick[cacheKey] = result;
    return result;
  }

  const fallback = finiteNumber(fallbackBestBid);
  return fallback == null ? [] : [{ price: fallback, size: Number.POSITIVE_INFINITY, key: String(fallback) }];
}

function parseBookLevels(rawLevels, side = 'ask') {
  if (rawLevels && rawLevels._isParsed) {
    return rawLevels;
  }
  let levels = rawLevels;
  if (typeof levels === 'string') {
    try {
      levels = JSON.parse(levels);
    } catch {
      levels = [];
    }
  }
  if (!Array.isArray(levels)) return [];
  if (levels._isParsed) {
    return levels;
  }
  const result = levels
    .map((level) => ({ price: finiteNumber(level?.price), size: finiteNumber(level?.size) }))
    .filter((level) => level.price != null && level.size != null && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }))
    .sort((left, right) => (side === 'bid' ? right.price - left.price : left.price - right.price));

  Object.defineProperty(result, '_isParsed', { value: true, enumerable: false });
  return result;
}

function trimFills(fills, targetShares) {
  let remaining = targetShares;
  for (let index = 0; index < fills.length; index += 1) {
    const fill = fills[index];
    if (remaining <= 0) {
      fills.splice(index);
      return;
    }
    if (fill.qty > remaining) fill.qty = remaining;
    remaining -= fill.qty;
  }
}

function finiteNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}
