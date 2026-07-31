/**
 * Two-sided maker engine for Polymarket binary pairs (UP/DOWN, sum = $1).
 *
 * MEASURED STRUCTURE OF THIS BOOK (99 days, 25,269 events):
 *   ask_UP + ask_DOWN = 1.010  (95% of ticks)   per-leg spread = 0.010
 *   bid_UP + bid_DOWN = 0.990  (95% of ticks)   tick size      = 0.001
 *   P(win) ~= ask + taker_fee  -> the book is calibrated to leave the TAKER at
 *   zero EV. Every taker entry therefore loses the fee plus the half spread.
 *
 * FEES: takers pay shares*0.07*p*(1-p) on crypto markets; makers pay ZERO and
 * additionally earn a 20% rebate of collected taker fees. So passive fills are
 * the only structurally non-negative way into this book.
 *
 * A complete set (1 UP + 1 DOWN) is worth exactly $1.00 at resolution no matter
 * who wins. Acquiring one passively at bid_UP + bid_DOWN = 0.990 yields +1c per
 * share with zero directional risk. The whole problem is inventory: when only
 * one leg fills the position is naked and directional.
 *
 * FILL MODEL (deliberately pessimistic; we have book snapshots, not trade
 * prints, so we never infer a fill from a mere touch):
 *   resting BUY  at p fills once best_bid drops strictly below p - slack
 *   resting SELL at p fills once best_ask rises strictly above p + slack
 * i.e. the entire visible queue at our level must be consumed or pulled, and we
 * assume we sat at the BACK of it. Taker actions execute at the touch and pay
 * the taker fee.
 */

export const FEE_RATE = 0.07;
export const TICK = 0.001;

export function takerFee(price, shares = 1) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return FEE_RATE * p * (1 - p) * shares;
}

const OTHER = { UP: 'DOWN', DOWN: 'UP' };

function bidOf(tick, side) {
  return side === 'UP' ? tick.upBid : tick.downBid;
}
function askOf(tick, side) {
  return side === 'UP' ? tick.upAsk : tick.downAsk;
}
function round(px) {
  return Math.round(px / TICK) * TICK;
}

/**
 * @param {Array} ticks   ascending-time tick series for one event
 * @param {object} p      policy
 * @param {'UP'|'DOWN'} winner
 */
export function runEvent(ticks, p, winner) {
  const inv = { UP: 0, DOWN: 0 };
  let cash = 0; // dollars spent (negative = received)
  let takerFees = 0;
  let makerFills = 0;
  let takerFills = 0;
  const live = { UP: null, DOWN: null }; // resting orders, one per side
  const fills = [];
  let setsFormed = 0;
  let cutCount = 0;
  let aborted = false;

  // entry / exit windows
  let started = false;

  const tradeThrough = (order, side, tick, slack) => {
    if (
      p.makerFillModel !== 'trade_through' ||
      !Array.isArray(p.tradeTape) ||
      !Number.isFinite(order.postedAtMs) ||
      !Number.isFinite(tick.tsMs)
    ) {
      return null;
    }
    // Public historical trades have one-second timestamps. Excluding the whole
    // posting second prevents a trade that happened before our hypothetical
    // order from proving a fill.
    const postedSecond = Math.floor(order.postedAtMs / 1000);
    const currentSecond = Math.floor(tick.tsMs / 1000);
    return (
      p.tradeTape.find((trade) => {
        const tradeSecond = Number(trade.timestamp);
        if (
          !Number.isFinite(tradeSecond) ||
          tradeSecond <= postedSecond ||
          tradeSecond > currentSecond ||
          trade.outcome !== side
        ) {
          return false;
        }
        if (order.kind === 'buy') {
          return (
            trade.side === 'SELL' &&
            Number(trade.price) < order.px - slack - 1e-12
          );
        }
        return (
          trade.side === 'BUY' &&
          Number(trade.price) > order.px + slack + 1e-12
        );
      }) ?? null
    );
  };

  for (let i = 0; i < ticks.length; i += 1) {
    const t = ticks[i];
    if (!Number.isFinite(t.upBid) || !Number.isFinite(t.downBid)) continue;
    if (!started && t.tau <= p.entryTau) started = true;
    if (!started) continue;

    const slack = p.slackTicks * TICK;

    // ---------- 1. resolve resting fills ----------
    for (const side of ['UP', 'DOWN']) {
      const order = live[side];
      if (!order) continue;
      // p.makerFeeRate lets us price the pessimistic world in which Polymarket
      // charges passive fills the taker fee anyway. Real fills recorded in this
      // repo matched the taker formula in 99.96% of cases, so this is NOT a
      // hypothetical: it is the honest floor and must be reported beside the
      // documented maker exemption.
      const mFee = (px, size) =>
        p.makerFeeRate > 0 ? p.makerFeeRate * Math.min(0.99, Math.max(0.01, px)) * (1 - Math.min(0.99, Math.max(0.01, px))) * size : 0;
      const tradeProof = tradeThrough(order, side, t, slack);
      // CORRECT FILL REFERENCE: the lake book does not contain our own order, so
      // comparing the observed bid against OUR price is a phantom fill — posting
      // above the touch would "fill" on the very next tick. The only honest
      // reference is the book level that existed WHEN WE POSTED (order.refBid):
      // once that level is consumed, the selling flow that consumed it had to
      // pass through our price first (if we improved) or through the whole queue
      // ahead of us (if we joined, hence the slack).
      // Reference = min(our price, touch at post time):
      //   px > touch  (improving)  -> touch must be consumed; we stood in front
      //   px = touch  (joining)    -> touch must be consumed; we sat behind it
      //   px < touch  (deep)       -> sell flow must walk all the way DOWN to us
      // Using the touch for a deep order would be a phantom fill: a 1-tick
      // decline would "fill" an order resting 5c below the market.
      if (order.kind === 'buy') {
        const ref = Math.min(order.px, order.refBid);
        const bookFill =
          p.makerFillModel !== 'trade_through' &&
          bidOf(t, side) < ref - slack - 1e-12;
        if (tradeProof || bookFill) {
          const f = mFee(order.px, order.size);
          inv[side] += order.size;
          cash += order.px * order.size + f;
          takerFees += f;
          makerFills += 1;
          fills.push({
            side,
            kind: 'buy',
            px: order.px,
            tau: t.tau,
            maker: true,
            proof: tradeProof
              ? {
                  model: 'trade_through',
                  timestamp: tradeProof.timestamp,
                  price: Number(tradeProof.price),
                  transactionHash: tradeProof.transactionHash ?? null,
                }
              : { model: 'book_depletion' },
          });
          live[side] = null;
        }
      } else if (
        tradeProof ||
        (
          p.makerFillModel !== 'trade_through' &&
          askOf(t, side) >
            Math.max(order.px, order.refAsk) + slack + 1e-12
        )
      ) {
        const f = mFee(order.px, order.size);
        inv[side] -= order.size;
        cash -= order.px * order.size - f;
        takerFees += f;
        makerFills += 1;
        fills.push({
          side,
          kind: 'sell',
          px: order.px,
          tau: t.tau,
          maker: true,
          proof: tradeProof
            ? {
                model: 'trade_through',
                timestamp: tradeProof.timestamp,
                price: Number(tradeProof.price),
                transactionHash: tradeProof.transactionHash ?? null,
              }
            : { model: 'book_depletion' },
        });
        live[side] = null;
      }
    }

    const imbalance = inv.UP - inv.DOWN;
    const longSide = imbalance > 1e-9 ? 'UP' : imbalance < -1e-9 ? 'DOWN' : null;
    const absImb = Math.abs(imbalance);

    // ---------- 2. naked-leg protection ----------
    // The naked leg is the whole risk. Two exits are available:
    //   a) taker-complete the pair on the opposite leg  (cost = pairSum + fee)
    //   b) taker-sell the naked leg back                (cost = drift + fee)
    // They are economically identical because ask_other = 1.01 - ask_this, so we
    // take whichever is cheaper at the touch.
    if (longSide && p.cut && !aborted && cutCount < (p.maxCuts ?? Infinity)) {
      const entryPx = fills
        .filter((f) => f.side === longSide && f.kind === 'buy')
        .slice(-1)[0]?.px;
      if (entryPx != null) {
        const drift = entryPx - bidOf(t, longSide);
        const tauLow = p.cut.tauMax != null && t.tau <= p.cut.tauMax;
        if (drift >= p.cut.driftTrigger - 1e-12 || tauLow) {
          // option (a): buy the opposite leg as taker -> locks a complete set
          const oppAsk = askOf(t, OTHER[longSide]);
          const costA = Number.isFinite(oppAsk)
            ? entryPx + oppAsk + takerFee(oppAsk) - 1
            : Infinity;
          // option (b): sell this leg as taker
          const myBid = bidOf(t, longSide);
          const costB = Number.isFinite(myBid)
            ? entryPx - myBid + takerFee(myBid)
            : Infinity;
          const best = Math.min(costA, costB);
          if (best <= p.cut.maxLossPerShare + 1e-12) {
            if (costA <= costB) {
              inv[OTHER[longSide]] += absImb;
              cash += (oppAsk + takerFee(oppAsk)) * absImb;
              takerFees += takerFee(oppAsk) * absImb;
            } else {
              inv[longSide] -= absImb;
              cash -= (myBid - takerFee(myBid)) * absImb;
              takerFees += takerFee(myBid) * absImb;
            }
            takerFills += 1;
            cutCount += 1;
            live.UP = null;
            live.DOWN = null;
            if (p.cut.stopAfterCut) aborted = true;
            continue;
          }
        }
      }
    }

    if (aborted) continue;
    if (t.tau <= p.stopQuoteTau) {
      live.UP = null;
      live.DOWN = null;
      continue;
    }

    // ---------- 3. requote ----------
    const balancedSets = Math.min(inv.UP, inv.DOWN);
    for (const side of ['UP', 'DOWN']) {
      // inventory skew: only bid the leg we are short of, so the book itself
      // pushes us back to balance instead of letting exposure compound
      if (longSide === side && p.skew) {
        live[side] = null;
        continue;
      }
      if (absImb >= p.maxImbalance && longSide !== OTHER[side]) {
        live[side] = null;
        continue;
      }
      if (balancedSets >= p.maxSets) {
        live[side] = null;
        continue;
      }
      // STATIC QUOTING is the actual pair-lock mechanism. With both bids resting
      // at the touch, bid_UP + bid_DOWN = 0.990 identically, so the UP order
      // fills on the first downtick of the UP price and the DOWN order fills on
      // the first uptick — any oscillation completes the pair at exactly 0.990.
      // Re-anchoring to the new touch after the first fill destroys this: the
      // remaining leg gets chased upward and the pair sum drifts above 1.
      // So once an order is resting we leave it alone.
      if (p.staticQuotes && live[side] && live[side].kind === 'buy') continue;

      const bid = bidOf(t, side);
      const ask = askOf(t, side);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;

      // ZONE GATE applies to the EVENT via the favourite's price, not to each
      // leg. Gating per leg was a design error: with a zone of 0.88-0.98 only the
      // favourite leg ever qualified (the dog bids at 0.01-0.11), so the engine
      // quoted one side and was naked by construction.
      const favBid = Math.max(t.upBid, t.downBid);
      if (favBid < p.zoneLo - 1e-12 || favBid > p.zoneHi + 1e-12) {
        live[side] = null;
        continue;
      }
      // Naked-exposure ceiling: never rest a bid whose unhedged loss would blow
      // the pair budget. At the extremes this deliberately leaves us quoting
      // only the cheap leg, which is honest — an expensive naked leg costs ~95c
      // against a pair profit of 1c.
      if (p.maxNakedPx != null && bid > p.maxNakedPx + 1e-12) {
        live[side] = null;
        continue;
      }

      let px;
      if (p.quoteMode === 'join') px = bid;
      else if (p.quoteMode === 'improve') px = bid + p.improveTicks * TICK;
      else px = bid - p.backoffTicks * TICK; // 'backoff': queue deeper, cheaper
      px = round(px);
      if (px >= ask - 1e-12) px = round(ask - TICK); // never cross
      if (px <= 0 || px >= 1) {
        live[side] = null;
        continue;
      }

      // pair-sum discipline: if we are completing a set, refuse a price that
      // would push the finished pair above the profitability ceiling
      if (longSide === OTHER[side]) {
        const entryPx = fills
          .filter((f) => f.side === OTHER[side] && f.kind === 'buy')
          .slice(-1)[0]?.px;
        if (entryPx != null && entryPx + px > p.maxPairSum + 1e-12) {
          if (!p.chase) {
            live[side] = null;
            continue;
          }
          px = round(p.maxPairSum - entryPx);
          if (px <= 0 || px >= ask) {
            live[side] = null;
            continue;
          }
        }
      } else if (p.openPairSumMax != null) {
        // opening quote: require the two-sided pair to be worth quoting
        const otherBid = bidOf(t, OTHER[side]);
        if (Number.isFinite(otherBid) && px + otherBid > p.openPairSumMax + 1e-12) {
          live[side] = null;
          continue;
        }
      }

      const existing = live[side];
      if (
        !existing ||
        existing.kind !== 'buy' ||
        (p.chase && Math.abs(existing.px - px) > 1e-12)
      ) {
        // refBid is the observable level whose consumption proves our fill.
        // Joining the touch means queueing behind it; improving means standing
        // in front of it, but either way the evidence is the same level falling.
        live[side] = {
          kind: 'buy',
          px,
          size: p.size,
          refBid: bid,
          refAsk: ask,
          postedAtMs: Number.isFinite(t.tsMs) ? t.tsMs : null,
        };
      }
    }
  }

  // ---------- settlement ----------
  const payout = inv[winner];
  const pnl = payout - cash;
  setsFormed = Math.min(inv.UP, inv.DOWN);
  const residual = Math.abs(inv.UP - inv.DOWN);

  return {
    pnl,
    cash,
    invUP: inv.UP,
    invDOWN: inv.DOWN,
    setsFormed,
    residual,
    residualSide: inv.UP > inv.DOWN ? 'UP' : inv.DOWN > inv.UP ? 'DOWN' : null,
    residualWon: residual > 0 && inv[winner] > Math.min(inv.UP, inv.DOWN),
    takerFees,
    makerFills,
    takerFills,
    cutCount,
    engaged: makerFills > 0 || takerFills > 0,
    nFills: fills.length,
  };
}

export function defaultPolicy(overrides = {}) {
  return {
    id: 'default',
    size: 5,
    entryTau: 280,
    stopQuoteTau: 15,
    slackTicks: 0,
    quoteMode: 'join', // join | improve | backoff
    improveTicks: 1,
    backoffTicks: 1,
    skew: true, // only bid the leg we are short of
    chase: false, // requote the completing leg as the market moves
    staticQuotes: true, // leave resting orders in place instead of re-anchoring
    maxImbalance: 1,
    maxSets: 1,
    maxPairSum: 0.999,
    openPairSumMax: null,
    zoneLo: 0,
    zoneHi: 1,
    maxNakedPx: null, // refuse to rest a bid above this price
    makerFeeRate: 0, // 0 = documented maker exemption; FEE_RATE = pessimistic floor
    makerFillModel: 'book_depletion', // book_depletion | trade_through
    tradeTape: null,
    cut: null, // { driftTrigger, maxLossPerShare, tauMax, stopAfterCut }
    maxCuts: Infinity, // cap taker churn: every cut pays a taker fee
    ...overrides,
  };
}

export function summarize(rows) {
  const done = rows.filter(Boolean);
  if (!done.length) return { events: 0 };
  const engaged = done.filter((r) => r.engaged);
  const pnls = done.map((r) => r.pnl);
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((x) => x > 1e-9);
  const losses = pnls.filter((x) => x < -1e-9);
  const gp = wins.reduce((a, b) => a + b, 0);
  const gl = losses.reduce((a, b) => a + Math.abs(b), 0);
  const sorted = [...pnls].sort((a, b) => a - b);
  const qq = (f) => sorted[Math.floor((sorted.length - 1) * f)];
  const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
  const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  const invested = done.reduce((a, r) => a + Math.max(0, r.cash), 0);
  return {
    events: done.length,
    engaged: engaged.length,
    engagedPct: r2((engaged.length / done.length) * 100),
    setsTotal: done.reduce((a, r) => a + r.setsFormed, 0),
    residualEvents: done.filter((r) => r.residual > 0).length,
    residualPct: r2(
      (done.filter((r) => r.residual > 0).length / done.length) * 100,
    ),
    cuts: done.reduce((a, r) => a + r.cutCount, 0),
    totalPnl: r4(total),
    pnlPerEvent: r4(total / done.length),
    pnlPerEngaged: engaged.length ? r4(total / engaged.length) : null,
    profitFactor: gl > 0 ? r4(gp / gl) : gp > 0 ? 'Infinity' : 0,
    winRatePct: r2((wins.length / done.length) * 100),
    takerFees: r4(done.reduce((a, r) => a + r.takerFees, 0)),
    makerFills: done.reduce((a, r) => a + r.makerFills, 0),
    takerFills: done.reduce((a, r) => a + r.takerFills, 0),
    invested: r4(invested),
    roiPct: invested > 0 ? r2((total / invested) * 100) : null,
    worst: r4(sorted[0]),
    p01: r4(qq(0.01)),
    p05: r4(qq(0.05)),
    p50: r4(qq(0.5)),
    p95: r4(qq(0.95)),
  };
}
