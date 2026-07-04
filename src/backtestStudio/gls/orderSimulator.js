import { createStandardLibrary } from './standardLibrary.js';

export function createOrderSimulator({ limits = {} } = {}) {
  const lib = createStandardLibrary();
  const maxOrders = limits.maxOrdersPerEvent ?? 20;
  const maxRestingOrders = limits.maxRestingOrders ?? 4;
  const makerFillEpsilon = limits.makerFillEpsilon ?? 0.01;
  const makerFillPolicy = limits.makerFillPolicy ?? 'full';

  let position = null;
  let orders = [];
  let exits = [];
  let realizedPnl = 0;
  let restingOrders = [];
  let lots = { UP: null, DOWN: null };
  let limitSeq = 0;
  let lastTick = null;
  const consumedAsksBySide = { UP: new Map(), DOWN: new Map() };
  const consumedBidsBySide = { UP: new Map(), DOWN: new Map() };

  const restingViewList = [];
  const positionView = {
    open: false,
    side: null,
    shares: 0,
    totalShares: 0,
    totalCost: 0,
    openCost: 0,
    avgPrice: null,
    avgEntryPrice: null,
    peakBid: null,
    hedge: null,
  };

  function syncRestingView() {
    restingViewList.length = 0;
    for (const order of restingOrders) {
      restingViewList.push({
        id: order.id,
        side: order.side,
        price: order.price,
        shares: order.shares,
        status: order.status,
      });
    }
  }

  function syncPositionView() {
    positionView.open = Boolean(position);
    positionView.side = position?.side ?? null;
    positionView.shares = position?.remainingShares ?? 0;
    positionView.totalShares = position?.totalShares ?? 0;
    positionView.totalCost = position?.totalCost ?? 0;
    positionView.openCost = position?.openCost ?? 0;
    positionView.avgPrice = position ? currentOpenAveragePrice(position) : null;
    positionView.avgEntryPrice = position?.avgEntryPrice ?? null;
    positionView.peakBid = position?.peakBid ?? null;

    if (position) {
      const hedgeSide = position.side === 'DOWN' ? 'UP' : 'DOWN';
      const hedgeLot = lots[hedgeSide];
      positionView.hedge = hedgeLot && hedgeLot.shares > 0
        ? { side: hedgeSide, shares: hedgeLot.shares, cost: hedgeLot.cost }
        : null;
    } else {
      positionView.hedge = null;
    }
  }

  function creditLot(side, shares, cost) {
    if (shares <= 0 || cost < 0) return;
    if (!lots[side]) lots[side] = { shares: 0, cost: 0 };
    lots[side].shares += shares;
    lots[side].cost += cost;
  }

  function debitLot(side, shares, cost) {
    const lot = lots[side];
    if (!lot || shares <= 0) return;
    lot.shares = Math.max(0, lot.shares - shares);
    lot.cost = Math.max(0, lot.cost - cost);
    if (lot.shares <= 0) lots[side] = null;
  }

  function syncPrimaryLotFromPosition() {
    if (!position) return;
    lots[position.side] = {
      shares: position.remainingShares,
      cost: position.openCost,
    };
  }

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
        liquidity: 'taker',
      },
    };
  }

  const api = {
    get positionView() {
      return positionView;
    },
    get restingView() {
      return restingViewList;
    },
    enter(side, options = {}) {
      if (position || orders.filter((o) => o.type === 'entry').length >= maxOrders) return false;
      const planned = planEntry(side, options, true);
      if (!planned) return false;
      position = planned.position;
      syncPrimaryLotFromPosition();
      syncPositionView();
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
      debitLot(position.side, shares, consumedCost);
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
        liquidity: 'taker',
      };
      exits.push(order);
      orders.push(order);
      if (position.remainingShares <= 0) position = null;
      syncPositionView();
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
      syncPrimaryLotFromPosition();
      syncPositionView();
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
    placeLimitBuy(side, options = {}) {
      if (side !== 'UP' && side !== 'DOWN') return false;
      const price = Number(options.price);
      const budget = Number(options.budget ?? options.maxOrderValue ?? 10);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) return false;
      if (!Number.isFinite(budget) || budget <= 0) return false;

      // Semântica CLOB honesta: uma LIMIT de compra com preço >= best ask é
      // marketable (executaria imediatamente como taker) — não repousa no book.
      // Rejeitar força a estratégia a só pré-posicionar ordens genuinamente passivas.
      const bestAsk = bestAskPrice(side, options.tick);
      if (bestAsk == null || price >= bestAsk) return false;

      const openCount = restingOrders.filter((o) => o.status === 'open').length;
      if (openCount >= maxRestingOrders) return false;

      const requestedShares = Number(options.shares ?? options.qty);
      const shares = Number.isFinite(requestedShares) && requestedShares > 0
        ? Math.floor(requestedShares)
        : Math.floor(budget / price);
      if (shares <= 0) return false;

      limitSeq += 1;
      const resting = {
        id: `lim-${limitSeq}`,
        kind: 'limit_buy',
        side,
        price,
        budget,
        shares,
        placedTs: options.ts ?? null,
        placedRefAsk: bestAsk,
        status: 'open',
        fill: null,
        reason: options.reason ?? 'limit_buy',
      };
      restingOrders.push(resting);
      syncRestingView();
      return { id: resting.id, side, price, shares, budget, status: resting.status };
    },
    placeBuyStop(side, options = {}) {
      if (side !== 'UP' && side !== 'DOWN') return false;
      const stopPrice = Number(options.stopPrice ?? options.price);
      const budget = Number(options.budget ?? options.maxOrderValue ?? 10);
      if (!Number.isFinite(stopPrice) || stopPrice <= 0 || stopPrice >= 1) return false;
      if (!Number.isFinite(budget) || budget <= 0) return false;

      const bestAsk = bestAskPrice(side, options.tick);
      // Stop-buy repousa acima do mercado: dispara quando o ask sobe através do gatilho (flip/repricing).
      if (bestAsk == null || stopPrice <= bestAsk) return false;

      const openCount = restingOrders.filter((o) => o.status === 'open').length;
      if (openCount >= maxRestingOrders) return false;

      const requestedShares = Number(options.shares ?? options.qty);
      const shares = Number.isFinite(requestedShares) && requestedShares > 0
        ? Math.floor(requestedShares)
        : Math.floor(budget / stopPrice);
      if (shares <= 0) return false;

      limitSeq += 1;
      const resting = {
        id: `stp-${limitSeq}`,
        kind: 'stop_buy',
        side,
        price: stopPrice,
        budget,
        shares,
        placedTs: options.ts ?? null,
        placedRefAsk: bestAsk,
        status: 'open',
        fill: null,
        reason: options.reason ?? 'stop_buy',
      };
      restingOrders.push(resting);
      syncRestingView();
      return { id: resting.id, side, price: stopPrice, shares, budget, status: resting.status };
    },
    cancelLimit(idOrNull = null) {
      let cancelled = 0;
      for (const order of restingOrders) {
        if (order.status !== 'open') continue;
        if (idOrNull != null && order.id !== idOrNull) continue;
        order.status = 'cancelled';
        cancelled += 1;
        if (idOrNull != null) break;
      }
      syncRestingView();
      return cancelled;
    },
    checkRestingOrders(tick) {
      if (!tick || restingOrders.length === 0) {
        lastTick = tick ?? lastTick;
        return 0;
      }
      let filled = 0;
      for (const resting of restingOrders) {
        if (resting.status !== 'open') continue;
        const currAsk = bestAskPrice(resting.side, tick);
        if (currAsk == null) continue;

        const prevAsk = lastTick
          ? bestAskPrice(resting.side, lastTick)
          : resting.placedRefAsk;

        let shouldFill = false;
        if (resting.kind === 'stop_buy') {
          // Repricing do flip: ask sobe através do stop (ex.: 0.38 → 0.55 → 0.80).
          shouldFill = prevAsk != null
            && prevAsk < resting.price
            && currAsk >= resting.price - makerFillEpsilon;
        } else {
          // Limit passivo: ask cai através do bid (compra mais barata).
          shouldFill = prevAsk != null
            && prevAsk >= resting.price
            && currAsk <= resting.price - makerFillEpsilon;
        }
        if (!shouldFill) continue;

        let fillShares = resting.shares;
        if (makerFillPolicy === 'level-capped') {
          const visible = visibleSizeAtOrAbove(resting.side, lastTick ?? tick, resting.price);
          fillShares = Math.min(fillShares, Math.floor(visible));
        }
        if (fillShares <= 0) continue;

        const notional = fillShares * resting.price;
        resting.status = 'filled';
        resting.fill = {
          ts: tick.ts ?? tick._tsMs ?? null,
          price: resting.price,
          qty: fillShares,
          notional,
          liquidity: resting.kind === 'stop_buy' ? 'taker' : 'maker',
        };
        creditLot(resting.side, fillShares, notional);
        orders.push({
          type: 'entry',
          side: resting.side,
          ts: resting.fill.ts,
          price: resting.price,
          shares: fillShares,
          notional,
          avgPrice: resting.price,
          fills: [{ price: resting.price, qty: fillShares }],
          reason: resting.reason,
          liquidity: resting.kind === 'stop_buy' ? 'taker' : 'maker',
          restingOrderId: resting.id,
        });
        filled += 1;
      }
      if (filled > 0) syncPositionView();
      syncRestingView();
      lastTick = tick;
      return filled;
    },
    expireRestingOrders() {
      for (const order of restingOrders) {
        if (order.status === 'open') order.status = 'expired';
      }
      syncRestingView();
    },
    hasOpenRestingOrders() {
      return restingOrders.some((o) => o.status === 'open');
    },
    reset() {
      position = null;
      orders = [];
      exits = [];
      realizedPnl = 0;
      restingOrders = [];
      lots = { UP: null, DOWN: null };
      limitSeq = 0;
      lastTick = null;
      syncRestingView();
      syncPositionView();
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
        restingOrders: restingOrders.map((o) => ({ ...o })),
        lots: {
          UP: lots.UP ? { ...lots.UP } : null,
          DOWN: lots.DOWN ? { ...lots.DOWN } : null,
        },
        realizedPnl,
      };
    },
    updatePeakBid(tick, libRef) {
      if (!position) return;
      const bid = libRef.book.bid(position.side, tick);
      if (Number.isFinite(bid)) {
        position.peakBid = Math.max(position.peakBid ?? bid, bid);
        positionView.peakBid = position.peakBid;
      }
    },
  };

  return api;
}

export function settleEventPnl(simulator, tick, event) {
  const snap = simulator.snapshot();
  const hasTakerEntry = snap.orders.some((o) => o.type === 'entry');
  const lotData = snap.lots ?? { UP: null, DOWN: null };
  const hasLotShares = (lotData.UP?.shares ?? 0) > 0 || (lotData.DOWN?.shares ?? 0) > 0;

  if (!hasTakerEntry && !hasLotShares) {
    return { finalPnl: snap.realizedPnl, reason: snap.orders.length ? 'closed' : 'no_entry', expirationResult: null };
  }

  const underlying = Number(tick?.btc_price ?? tick?.underlyingPrice);
  const ptb = Number(event?.priceToBeat ?? tick?.price_to_beat);
  const winnerSide = underlying > ptb ? 'UP' : 'DOWN';

  const effectiveLots = { UP: null, DOWN: null };
  for (const side of ['UP', 'DOWN']) {
    if (lotData[side]?.shares > 0) {
      effectiveLots[side] = { shares: lotData[side].shares, cost: lotData[side].cost };
    }
  }
  if (snap.position?.remainingShares > 0 && !effectiveLots[snap.position.side]) {
    effectiveLots[snap.position.side] = {
      shares: snap.position.remainingShares,
      cost: snap.position.openCost,
    };
  }

  let expiryPnl = 0;
  const lotPnls = {};
  for (const side of ['UP', 'DOWN']) {
    const lot = effectiveLots[side];
    if (!lot || lot.shares <= 0) continue;
    const won = winnerSide === side;
    const pnl = won ? lot.shares - lot.cost : -lot.cost;
    lotPnls[side] = pnl;
    expiryPnl += pnl;
  }

  const finalPnl = snap.realizedPnl + expiryPnl;
  const primaryEntry = snap.orders.find((o) => o.type === 'entry' && o.liquidity !== 'maker');
  const hedgeFill = snap.orders.find((o) => o.type === 'entry' && o.liquidity === 'maker') ?? null;
  const primarySide = snap.position?.side ?? primaryEntry?.side ?? null;
  const hedgeSide = primarySide === 'UP' ? 'DOWN' : (primarySide === 'DOWN' ? 'UP' : null);
  const hedgePnl = hedgeSide && lotPnls[hedgeSide] != null ? lotPnls[hedgeSide] : null;
  const primaryLotPnl = primarySide && lotPnls[primarySide] != null ? lotPnls[primarySide] : null;

  const openSides = ['UP', 'DOWN'].filter((side) => effectiveLots[side]?.shares > 0);
  const anyWon = openSides.some((side) => side === winnerSide);
  const allLost = openSides.length > 0 && !anyWon;

  return {
    finalPnl,
    reason: anyWon ? 'expiry_win' : (allLost ? 'expiry_loss' : (snap.realizedPnl !== 0 ? 'closed' : 'expiry_loss')),
    expirationResult: openSides.length === 0 ? null : (anyWon ? 'win' : 'loss'),
    winnerSide,
    expiryPnl,
    lotPnls,
    hedgeFill,
    hedgePnl,
    primaryLotPnl,
  };
}

function currentOpenAveragePrice(currentPosition) {
  if (!currentPosition || currentPosition.remainingShares <= 0) return 0;
  return currentPosition.openCost / Math.max(0.000001, currentPosition.remainingShares);
}

function bestAskPrice(side, tick) {
  const scalar = finiteNumber(side === 'DOWN' ? (tick?.down_best_ask ?? tick?.downBestAsk) : (tick?.up_best_ask ?? tick?.upBestAsk));
  const levels = askLevels(side, tick, scalar);
  return levels.length ? levels[0].price : null;
}

function visibleSizeAtOrAbove(side, tick, minPrice) {
  if (!tick) return 0;
  const scalar = finiteNumber(side === 'DOWN' ? (tick?.down_best_ask ?? tick?.downBestAsk) : (tick?.up_best_ask ?? tick?.upBestAsk));
  const levels = askLevels(side, tick, scalar);
  return levels
    .filter((level) => level.price >= minPrice)
    .reduce((sum, level) => sum + level.size, 0);
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
  const canCache = canCacheBookLevels(tick);
  if (canCache && tick[cacheKey]) return tick[cacheKey];

  const rawLevels = side === 'DOWN'
    ? (tick?._parsed_down_book_asks || tick?.down_book_asks)
    : (tick?._parsed_up_book_asks || tick?.up_book_asks);
  const parsed = parseBookLevels(rawLevels);
  if (parsed.length) {
    if (canCache) tick[cacheKey] = parsed;
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
    if (canCache) tick[cacheKey] = result;
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
  const canCache = canCacheBookLevels(tick);
  if (canCache && tick[cacheKey]) return tick[cacheKey];

  const rawLevels = side === 'DOWN'
    ? (tick?._parsed_down_book_bids || tick?.down_book_bids)
    : (tick?._parsed_up_book_bids || tick?.up_book_bids);
  const parsed = parseBookLevels(rawLevels, 'bid');
  if (parsed.length) {
    if (canCache) tick[cacheKey] = parsed;
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
    if (canCache) tick[cacheKey] = result;
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

function canCacheBookLevels(tick) {
  return Boolean(tick) && typeof tick.setIndex !== 'function';
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
