/**
 * Skew-Set V0 — pure event engine (no I/O).
 * Open complete-set (UP+DOWN) + hybrid A-biased inventory skew.
 * No MULT, no ladder re-arm, no mid-event underdog accumulation.
 */

export const DEFAULT_PARAMS = {
  openShares: 10,
  openPairSumMax: 1.0,
  openCapCents: 2,
  maxOpenAttempts: 3,
  tauOpenMin: 40,
  tauOpenMax: 240,
  spotBufferUsd: 15,
  oddsMinGap: 0.04,
  maxSkew: 0.3,
  skewDeadband: 0.05,
  rebalanceClipShares: 2,
  maxRebalancesPerEvent: 10,
  minSellEdge: 0.02,
  avgSumMax: 0.98,
  eqAskMax: 0.08,
  eqAvgSumMax: 0.99,
  eqMinShares: 0.5,
  tauEqMin: 12,
  tauDone: 3,
  maxEventNotional: 40,
  feeRate: 0.07,
  confirmationTicks: 1,
};

export function mergeParams(raw = {}) {
  return { ...DEFAULT_PARAMS, ...raw };
}

function clamp01(x) {
  return Math.min(0.99, Math.max(0.01, Number(x)));
}

function feeFor(price, shares, rate) {
  const p = clamp01(price);
  return rate * p * (1 - p) * shares;
}

function opposite(side) {
  return side === 'UP' ? 'DOWN' : 'UP';
}

export function createEventEngine(paramsRaw = {}, meta = {}) {
  const p = mergeParams(paramsRaw);
  const state = {
    meta,
    mode: 'idle', // idle | flat | skewing | done | blocked
    favSide: null,
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    openAttempts: 0,
    openDone: false,
    rebalanceCount: 0,
    eqAttempts: 0,
    fills: [],
    blocks: [],
    events: [],
    lastAsks: { UP: null, DOWN: null },
    lastBids: { UP: null, DOWN: null },
    qualifierCounts: {},
    qualifierSeen: new Set(),
  };

  function invested() {
    return state.inv.UP.cost + state.inv.DOWN.cost;
  }

  function totalFees() {
    return state.inv.UP.fees + state.inv.DOWN.fees;
  }

  function avg(side) {
    const x = state.inv[side];
    return x.shares > 0 ? x.cost / x.shares : null;
  }

  function avgSum() {
    const a = avg('UP');
    const b = avg('DOWN');
    if (a == null || b == null) return null;
    return a + b;
  }

  function residual() {
    const d = state.inv.UP.shares - state.inv.DOWN.shares;
    if (Math.abs(d) < 1e-9) return { side: null, shares: 0 };
    return d > 0
      ? { side: 'DOWN', shares: d }
      : { side: 'UP', shares: -d };
  }

  function baseShares() {
    const mean = (state.inv.UP.shares + state.inv.DOWN.shares) / 2;
    return mean > 1e-9 ? mean : p.openShares;
  }

  function skewFrac() {
    const base = baseShares();
    if (base <= 1e-9) return 0;
    return (state.inv.UP.shares - state.inv.DOWN.shares) / base;
  }

  function worstPnl() {
    const cost = invested() + totalFees();
    const up = state.inv.UP.shares - cost;
    const dn = state.inv.DOWN.shares - cost;
    return Math.min(up, dn);
  }

  function lockedPnlPerShare() {
    const balanced = Math.min(state.inv.UP.shares, state.inv.DOWN.shares);
    return balanced > 1e-9 ? worstPnl() / balanced : null;
  }

  function projectedAvgSum(side, px, sh) {
    if (sh <= 0) return avgSum();
    const cur = state.inv[side];
    const newSh = cur.shares + sh;
    const newAvg = (cur.cost + sh * px) / newSh;
    const o = avg(opposite(side));
    if (o == null) return null;
    return newAvg + o;
  }

  function qualify(key) {
    state.qualifierSeen.add(key);
    const next = (state.qualifierCounts[key] || 0) + 1;
    state.qualifierCounts[key] = next;
    const required = Math.max(1, Number(p.confirmationTicks) || 1);
    return next >= required;
  }

  function finishQualifierTick() {
    for (const key of Object.keys(state.qualifierCounts)) {
      if (!state.qualifierSeen.has(key)) delete state.qualifierCounts[key];
    }
    state.qualifierSeen.clear();
  }

  function block(reason, extra = {}) {
    state.blocks.push({ reason, ...extra, t: state.events.length });
  }

  function refreshModeFromInventory() {
    if (state.mode === 'done' || state.mode === 'blocked' || state.mode === 'idle') {
      return;
    }
    const base = baseShares();
    const frac = Math.abs(skewFrac());
    if (frac <= p.skewDeadband + 1e-12 || base <= 1e-9) {
      state.mode = 'flat';
    } else {
      state.mode = 'skewing';
    }
  }

  function buy(side, px, sh, kind, liquidity = 'taker') {
    if (sh <= 0) return 0;
    const notional = sh * px;
    if (invested() + notional > p.maxEventNotional + 1e-9) {
      block('TETO', { side, sh, px, kind });
      return 0;
    }
    const fee = liquidity === 'maker' ? 0 : feeFor(px, sh, p.feeRate);
    state.inv[side].shares += sh;
    state.inv[side].cost += notional;
    state.inv[side].fees += fee;
    const fill = { side, px, sh, kind, liquidity, fee, notional };
    state.fills.push(fill);
    state.events.push({ type: 'fill', ...fill });
    return sh;
  }

  function sell(side, px, sh, kind, liquidity = 'taker') {
    if (sh <= 0) return 0;
    const cur = state.inv[side];
    const shOut = Math.min(sh, cur.shares);
    if (shOut <= 1e-12) return 0;
    const avgCost = avg(side);
    if (avgCost == null) return 0;
    const fee = liquidity === 'maker' ? 0 : feeFor(px, shOut, p.feeRate);
    const proceeds = shOut * px;
    // Realize proportional cost basis; fee reduces inventory cash via fees bucket.
    cur.shares -= shOut;
    cur.cost -= avgCost * shOut;
    if (cur.shares < 1e-12) {
      cur.shares = 0;
      cur.cost = 0;
    }
    cur.fees += fee;
    const fill = {
      side,
      px,
      sh: -shOut,
      kind,
      liquidity,
      fee,
      notional: -proceeds,
      avgCost,
    };
    state.fills.push(fill);
    state.events.push({ type: 'fill', ...fill });
    return shOut;
  }

  function concordantFavorite(asks, btc, ptb) {
    if (btc == null || ptb == null || !Number.isFinite(btc) || !Number.isFinite(ptb)) {
      return null;
    }
    const up = asks.UP;
    const dn = asks.DOWN;
    if (up == null || dn == null) return null;
    const buf = p.spotBufferUsd;
    const gap = p.oddsMinGap;
    const spotUp = btc >= ptb + buf;
    const spotDn = btc <= ptb - buf;
    const oddsUp = up >= dn + gap;
    const oddsDn = dn >= up + gap;
    if (spotUp && oddsUp) return 'UP';
    if (spotDn && oddsDn) return 'DOWN';
    return null;
  }

  function tryOpen(asks, tau, ts) {
    if (state.mode !== 'idle' || state.openDone) return;
    if (tau == null || tau < p.tauOpenMin || tau > p.tauOpenMax) return;
    if (state.openAttempts >= p.maxOpenAttempts) {
      state.mode = 'blocked';
      block('OPEN_ATTEMPTS_EXHAUSTED', { tau });
      return;
    }

    const askUp = asks.UP;
    const askDn = asks.DOWN;
    if (askUp == null || askDn == null) return;

    const sum = askUp + askDn;
    if (sum > p.openPairSumMax + 1e-12) {
      block('OPEN_PAIR_SUM', { sum, max: p.openPairSumMax, tau });
      return;
    }

    // Soft band around a fair 0.50/0.50: reject only if both legs wildly off
    // when openCapCents is set — gap from ideal mid sum/2 for each leg.
    const cap = (p.openCapCents || 0) / 100;
    if (cap > 0) {
      const ideal = sum / 2;
      const gapUp = Math.abs(askUp - ideal);
      const gapDn = Math.abs(askDn - ideal);
      // Cap is optional softness; primary gate is openPairSumMax.
      // Miss only if ONE leg is > cap away from complementary fair AND sum still ok —
      // keep simple: if either ask > 0.99, miss.
      if (askUp > 0.99 + 1e-12 || askDn > 0.99 + 1e-12) {
        state.openAttempts += 1;
        block('OPEN_MISS_CAP', { askUp, askDn, tau, gapUp, gapDn });
        return;
      }
    }

    const sh = p.openShares;
    const notional = sh * askUp + sh * askDn;
    if (invested() + notional > p.maxEventNotional + 1e-9) {
      block('TETO', { kind: 'open_pair', notional, tau });
      state.mode = 'blocked';
      return;
    }

    if (!qualify('open:pair')) return;
    state.openAttempts += 1;

    const gotUp = buy('UP', askUp, sh, 'open', 'taker');
    const gotDn = buy('DOWN', askDn, sh, 'open', 'taker');
    if (gotUp <= 0 || gotDn <= 0) {
      block('OPEN_PARTIAL', { gotUp, gotDn, tau });
      state.mode = 'blocked';
      return;
    }

    state.openDone = true;
    state.mode = 'flat';
    state.events.push({
      type: 'open_pair',
      askUp,
      askDn,
      sh,
      sum,
      tau,
      ts,
    });
  }

  function tryRebalance(asks, bids, tau, ts, fav) {
    if (state.mode !== 'flat' && state.mode !== 'skewing') return;
    if (fav == null) {
      state.favSide = null;
      refreshModeFromInventory();
      return;
    }
    state.favSide = fav;
    const dog = opposite(fav);
    const base = baseShares();
    const targetFav = base * (1 + p.maxSkew);
    const targetDog = base * (1 - p.maxSkew);
    const clip = p.rebalanceClipShares;

    // Buy favorite toward target
    const needFav = targetFav - state.inv[fav].shares;
    if (needFav > p.skewDeadband * base + 1e-12) {
      if (state.rebalanceCount >= p.maxRebalancesPerEvent) {
        block('REBALANCE_CAP', { tau, count: state.rebalanceCount });
      } else {
        const ask = asks[fav];
        if (ask != null) {
          const sh = Math.min(clip, needFav);
          const proj = projectedAvgSum(fav, ask, sh);
          if (proj != null && proj > p.avgSumMax + 1e-12) {
            block('SKEW_REFUSE_AVGSUM', {
              side: fav,
              ask,
              sh,
              proj,
              max: p.avgSumMax,
              tau,
            });
          } else if (!qualify(`skew_buy:${fav}`)) {
            // wait
          } else {
            const got = buy(fav, ask, sh, 'skew_buy', 'taker');
            if (got > 0) {
              state.rebalanceCount += 1;
              state.events.push({
                type: 'skew_buy',
                side: fav,
                px: ask,
                sh: got,
                tau,
                ts,
              });
            }
          }
        }
      }
    }

    // Sell underdog toward target only with edge
    const excessDog = state.inv[dog].shares - targetDog;
    if (excessDog > p.skewDeadband * base + 1e-12) {
      const bid = bids[dog];
      const avgCost = avg(dog);
      if (bid != null && avgCost != null) {
        const sh = Math.min(clip, excessDog);
        const feeEst = feeFor(bid, sh, p.feeRate);
        const edge = bid - avgCost - feeEst / sh;
        if (edge + 1e-12 < p.minSellEdge) {
          block('SELL_NO_EDGE', {
            side: dog,
            bid,
            avgCost,
            edge,
            min: p.minSellEdge,
            tau,
          });
        } else if (qualify(`skew_sell:${dog}`)) {
          const got = sell(dog, bid, sh, 'skew_sell', 'taker');
          if (got > 0) {
            state.rebalanceCount += 1;
            state.events.push({
              type: 'skew_sell',
              side: dog,
              px: bid,
              sh: got,
              edge,
              tau,
              ts,
            });
          }
        }
      }
    }

    refreshModeFromInventory();
  }

  function tryEq(asks, tau, ts) {
    if (state.mode !== 'flat' && state.mode !== 'skewing') return;
    if (tau == null || tau > p.tauEqMin) return;
    const res = residual();
    if (res.shares <= p.eqMinShares + 1e-12 || res.side == null) return;

    const ask = asks[res.side];
    if (ask == null || ask > p.eqAskMax + 1e-12) return;

    const sh = res.shares;
    const proj = projectedAvgSum(res.side, ask, sh);
    if (proj != null && proj > p.eqAvgSumMax + 1e-12) {
      block('EQ_REFUSE_AVGSUM', {
        side: res.side,
        ask,
        sh,
        proj,
        max: p.eqAvgSumMax,
        tau,
      });
      return;
    }
    if (!qualify(`eq:${res.side}`)) return;

    state.eqAttempts += 1;
    const got = buy(res.side, ask, sh, 'eq', 'taker');
    if (got > 0) {
      state.events.push({ type: 'eq', side: res.side, px: ask, sh: got, tau, ts });
      refreshModeFromInventory();
    }
  }

  function maybeDone(tau) {
    if (state.mode === 'done' || state.mode === 'blocked' || state.mode === 'idle') {
      return;
    }
    if (tau != null && tau <= p.tauDone) {
      state.mode = 'done';
      state.events.push({ type: 'done', tau, residual: residual() });
    }
  }

  function onTick(tick = {}) {
    if (state.mode === 'done' || state.mode === 'blocked') {
      return snapshot('idle_tick');
    }

    const tau = tick.tau;
    const askUp = tick.askUp ?? tick.upAsk ?? null;
    const askDown = tick.askDown ?? tick.downAsk ?? null;
    const bidUp = tick.bidUp ?? tick.upBid ?? null;
    const bidDown = tick.bidDown ?? tick.downBid ?? null;
    const btc = tick.btc ?? null;
    const ptb = tick.ptb ?? null;
    const ts = tick.ts ?? tau ?? null;

    const asks = { UP: askUp, DOWN: askDown };
    const bids = { UP: bidUp, DOWN: bidDown };
    state.lastAsks = asks;
    state.lastBids = bids;

    tryOpen(asks, tau, ts);

    const fav = concordantFavorite(asks, btc, ptb);
    if (state.mode === 'flat' || state.mode === 'skewing') {
      tryRebalance(asks, bids, tau, ts, fav);
      tryEq(asks, tau, ts);
      maybeDone(tau);
    }

    finishQualifierTick();
    return snapshot(fav ? `fav:${fav}` : 'no_fav');
  }

  function blockCounts() {
    const counts = {};
    for (const b of state.blocks) {
      counts[b.reason] = (counts[b.reason] || 0) + 1;
    }
    return counts;
  }

  function snapshot(note) {
    return {
      mode: state.mode,
      note,
      inv: {
        UP: { ...state.inv.UP },
        DOWN: { ...state.inv.DOWN },
      },
      avgSum: avgSum(),
      residual: residual(),
      skewFrac: skewFrac(),
      favSide: state.favSide,
      rebalanceCount: state.rebalanceCount,
      worstPnl: worstPnl(),
      lockedPnlPerShare: lockedPnlPerShare(),
      invested: invested(),
      fees: totalFees(),
      fills: state.fills.slice(),
      blocks: state.blocks.slice(),
      blockCounts: blockCounts(),
      events: state.events.slice(),
    };
  }

  function finish() {
    if (state.mode !== 'done' && state.mode !== 'blocked') {
      state.mode = 'done';
      state.events.push({ type: 'finish', residual: residual() });
    }
    return snapshot('finish');
  }

  return {
    params: p,
    state,
    onTick,
    finish,
    snapshot: () => snapshot('manual'),
  };
}
