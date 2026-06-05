import { createStandardLibrary } from './standardLibrary.js';

export function createOrderSimulator({ limits = {} } = {}) {
  const lib = createStandardLibrary();
  const maxOrders = limits.maxOrdersPerEvent ?? 20;
  let position = null;
  let orders = [];
  let exits = [];
  let realizedPnl = 0;

  const api = {
    get positionView() {
      return {
        open: Boolean(position),
        side: position?.side ?? null,
        shares: position?.shares ?? 0,
        avgPrice: position?.avgPrice ?? null,
        peakBid: position?.peakBid ?? null,
      };
    },
    enter(side, options = {}) {
      if (position || orders.filter((o) => o.type === 'entry').length >= maxOrders) return false;
      const price = Number(options.price);
      const budget = Number(options.budget ?? options.maxOrderValue ?? 10);
      if (!Number.isFinite(price) || price <= 0) return false;
      const shares = lib.risk.sizeByBudget(price, budget);
      if (shares <= 0) return false;
      const notional = shares * price;
      position = { side, shares, avgPrice: price, cost: notional, peakBid: price };
      const order = {
        type: 'entry',
        side,
        ts: options.ts,
        price,
        shares,
        notional,
        reason: options.reason ?? 'entry',
      };
      orders.push(order);
      return order;
    },
    exit(options = {}) {
      if (!position) return false;
      const price = Number(options.price);
      if (!Number.isFinite(price)) return false;
      const proceeds = position.shares * price;
      const pnl = proceeds - position.cost;
      realizedPnl += pnl;
      const order = {
        type: 'exit',
        side: position.side,
        ts: options.ts,
        price,
        shares: position.shares,
        notional: proceeds,
        pnl,
        reason: options.reason ?? 'exit',
      };
      exits.push(order);
      orders.push(order);
      position = null;
      return order;
    },
    reverse(side, options = {}) {
      if (position) api.exit({ ...options, reason: options.reason ?? 'reverse_exit' });
      return api.enter(side, options);
    },
    closeOpenPosition(options = {}) {
      if (!position) return false;
      const bid = Number(options.price);
      const side = position.side;
      const libBook = createStandardLibrary().book;
      const price = Number.isFinite(bid)
        ? bid
        : libBook.bid(side, options.tick || {});
      return api.exit({ price, reason: options.reason ?? 'close', ts: options.ts });
    },
    reset() {
      position = null;
      orders = [];
      exits = [];
      realizedPnl = 0;
    },
    snapshot() {
      return {
        position: position ? { ...position } : null,
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
  const winnerSide = underlying >= ptb ? 'UP' : 'DOWN';
  const won = winnerSide === side;
  const expiryPnl = won ? snap.position.shares - snap.position.cost : -snap.position.cost;
  const finalPnl = snap.realizedPnl + expiryPnl;
  return {
    finalPnl,
    reason: won ? 'expiry_win' : 'expiry_loss',
    expirationResult: won ? 'win' : 'loss',
    winnerSide,
    expiryPnl,
  };
}
