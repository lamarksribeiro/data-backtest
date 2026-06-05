export function createStandardLibrary() {
  return {
    market: {
      distanceFromPtb(price, ptb) {
        const p = Number(price);
        const b = Number(ptb);
        if (!Number.isFinite(p) || !Number.isFinite(b)) return 0;
        return Math.abs(p - b);
      },
      directionFromPtb(price, ptb) {
        const p = Number(price);
        const b = Number(ptb);
        if (!Number.isFinite(p) || !Number.isFinite(b)) return 'below';
        return p >= b ? 'above' : 'below';
      },
      sideFromPrice(price, ptb) {
        const p = Number(price);
        const b = Number(ptb);
        if (!Number.isFinite(p) || !Number.isFinite(b)) return 'UP';
        return p >= b ? 'UP' : 'DOWN';
      },
      isAbovePtb(price, ptb) {
        return Number(price) >= Number(ptb);
      },
      isBelowPtb(price, ptb) {
        return Number(price) < Number(ptb);
      },
    },
    prices: {
      mid(bid, ask) {
        const b = Number(bid);
        const a = Number(ask);
        if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
        return (b + a) / 2;
      },
      marketProbUp(tick) {
        const up = Number(tick?.up_price ?? tick?.upPrice);
        const down = Number(tick?.down_price ?? tick?.downPrice);
        if (!Number.isFinite(up)) return 0.5;
        if (!Number.isFinite(down)) return up;
        const sum = up + down;
        return sum > 0 ? up / sum : 0.5;
      },
      priceForSide(side, tick) {
        return side === 'DOWN' ? Number(tick?.down_price ?? tick?.downPrice) : Number(tick?.up_price ?? tick?.upPrice);
      },
      oppositeSide(side) {
        return side === 'DOWN' ? 'UP' : 'DOWN';
      },
    },
    book: {
      ask(side, tick) {
        return side === 'DOWN' ? Number(tick?.down_best_ask ?? tick?.downBestAsk) : Number(tick?.up_best_ask ?? tick?.upBestAsk);
      },
      bid(side, tick) {
        return side === 'DOWN' ? Number(tick?.down_best_bid ?? tick?.downBestBid) : Number(tick?.up_best_bid ?? tick?.upBestBid);
      },
      spread(side, tick) {
        const ask = createStandardLibrary().book.ask(side, tick);
        const bid = createStandardLibrary().book.bid(side, tick);
        if (!Number.isFinite(ask) || !Number.isFinite(bid)) return null;
        return ask - bid;
      },
      availableQty(side, maxPrice, tick) {
        const prefix = side === 'DOWN' ? 'down_ask' : 'up_ask';
        let total = 0;
        for (let i = 1; i <= 10; i += 1) {
          const px = Number(tick?.[`${prefix}_px_${i}`]);
          const sz = Number(tick?.[`${prefix}_sz_${i}`]);
          if (!Number.isFinite(px) || !Number.isFinite(sz) || px > maxPrice) continue;
          total += sz;
        }
        return total;
      },
      liquidityRatio(side, tick, budget) {
        const ask = createStandardLibrary().book.ask(side, tick);
        const qty = createStandardLibrary().book.availableQty(side, ask, tick);
        const needed = budget / Math.max(ask, 0.001);
        return needed > 0 ? qty / needed : 0;
      },
    },
    signals: {
      momentum(samples, seconds) {
        return sampleDelta(samples, seconds, (row) => Number(row?.underlyingPrice ?? row?.btc_price));
      },
      slowMomentum(samples, seconds) {
        return sampleDelta(samples, seconds, (row) => Number(row?.underlyingPrice ?? row?.btc_price));
      },
      volatility(samples, seconds) {
        const values = recentValues(samples, seconds, (row) => Number(row?.underlyingPrice ?? row?.btc_price));
        if (values.length < 2) return stdDev(values);
        return stdDev(values);
      },
      directionalEdge(side, probUp, ask) {
        const p = Number(probUp);
        const a = Number(ask);
        if (!Number.isFinite(p) || !Number.isFinite(a)) return 0;
        const sideProb = side === 'DOWN' ? 1 - p : p;
        return sideProb - a;
      },
      zScore(value, mean, std) {
        const s = Number(std);
        if (!Number.isFinite(s) || s === 0) return 0;
        return (Number(value) - Number(mean)) / s;
      },
      effectiveMinDistance(secondsLeft, minDistanceAbs, minDistanceNearExpiry, nearExpiryThresholdSec) {
        const base = Number(minDistanceAbs);
        const near = Number(minDistanceNearExpiry);
        const threshold = Number(nearExpiryThresholdSec);
        if (near <= base || threshold <= 0) return base;
        const secs = Number(secondsLeft);
        if (secs >= threshold) return base;
        const ratio = clamp01(1 - (secs / threshold));
        return base + ((near - base) * ratio);
      },
    },
    math: {
      abs: Math.abs,
      min: Math.min,
      max: Math.max,
      clamp(value, min, max) {
        return Math.min(Number(max), Math.max(Number(min), Number(value)));
      },
      sqrt: Math.sqrt,
      logistic(value) {
        const v = Math.min(18, Math.max(-18, Number(value)));
        return 1 / (1 + Math.exp(-v));
      },
    },
    model: {
      directionProbability(samples, tick, event, params = {}) {
        const btc = Number(tick?.underlyingPrice ?? tick?.btc_price);
        const ptb = Number(event?.priceToBeat ?? tick?.priceToBeat ?? tick?.price_to_beat);
        if (!Number.isFinite(btc) || !Number.isFinite(ptb)) return 0.5;
        const secsLeft = Math.max(0, (new Date(event.end || tick.event_end).getTime() - new Date(tick.ts).getTime()) / 1000);
        const distance = btc - ptb;
        const fastMove = createStandardLibrary().signals.momentum(samples, params.momentumSec ?? 6);
        const slowMove = createStandardLibrary().signals.slowMomentum(samples, params.slowMomentumSec ?? 18);
        const recentVol = createStandardLibrary().signals.volatility(samples, params.volLookbackSec ?? 45);
        const minSigma = Number(params.minSigma ?? 10);
        const sigmaMultiplier = Number(params.sigmaMultiplier ?? 1);
        const sigma = Math.max(minSigma, recentVol * Math.sqrt(Math.max(1, secsLeft)) * sigmaMultiplier);
        const distanceZ = distance / sigma;
        const momentumZ = (fastMove + (Number(params.slowMomentumWeight ?? 0.35) * slowMove)) / sigma;
        const marketProbability = createStandardLibrary().prices.marketProbUp(tick);
        const marketLag = Math.min(0.5, Math.max(-0.5, (distance > 0 ? 1 - marketProbability : marketProbability) - 0.5));
        const distanceWeight = Number(params.distanceWeight ?? 2);
        const momentumWeight = Number(params.momentumWeight ?? 0.65);
        const lagWeight = Number(params.lagWeight ?? 0.45);
        const score = (distanceWeight * distanceZ) + (momentumWeight * momentumZ) + (lagWeight * marketLag);
        return Math.min(0.999, Math.max(0.001, createStandardLibrary().math.logistic(score)));
      },
      scoreSides(samples, tick, event, params = {}) {
        const lib = createStandardLibrary();
        const probUp = lib.model.directionProbability(samples, tick, event, params);
        const candidates = ['UP', 'DOWN'].map((side) => {
          const ask = lib.book.ask(side, tick);
          const bid = lib.book.bid(side, tick);
          const spread = lib.book.spread(side, tick);
          const probability = side === 'UP' ? probUp : 1 - probUp;
          const edge = Number.isFinite(ask) ? probability - ask : Number.NEGATIVE_INFINITY;
          return { side, ask, bid, probability, edge, spread };
        }).filter((candidate) => {
          if (!Number.isFinite(candidate.ask)) return false;
          if (candidate.ask < Number(params.minAsk ?? 0.08)) return false;
          if (candidate.ask > Number(params.maxAsk ?? 0.58)) return false;
          if (candidate.probability < Number(params.minDirectionalProb ?? 0.56)) return false;
          if (candidate.edge < Number(params.minEdge ?? 0.07)) return false;
          if (Number.isFinite(candidate.spread) && candidate.spread > Number(params.maxSpread ?? 0.08)) return false;
          return true;
        }).sort((left, right) => right.edge - left.edge);
        return { best: candidates[0] ?? null, probUp };
      },
    },
    risk: {
      sizeByBudget(price, budget) {
        const p = Math.max(Number(price), 0.001);
        return Math.floor(Number(budget) / p);
      },
      capOrderValue(value, max) {
        return Math.min(Number(value), Number(max));
      },
      stopBid(position, bid, threshold) {
        return Boolean(position?.open) && Number(bid) <= Number(threshold);
      },
      takeProfit(position, bid, threshold) {
        return Boolean(position?.open) && Number(bid) >= Number(threshold);
      },
      trailingStop(position, bid, config = {}) {
        if (!position?.open) return false;
        const drop = Number(config.drop ?? config.trailDrop ?? 0);
        const peak = Number(position.peakBid ?? bid);
        return peak - Number(bid) >= drop;
      },
    },
    time: {
      secondsUntil(end, ts) {
        return Math.max(0, (new Date(end).getTime() - new Date(ts).getTime()) / 1000);
      },
      secondsSince(start, ts) {
        return Math.max(0, (new Date(ts).getTime() - new Date(start).getTime()) / 1000);
      },
      inWindow(secondsLeft, start, end) {
        return Number(secondsLeft) <= Number(start) && Number(secondsLeft) > Number(end);
      },
      isNearExpiry(secondsLeft, threshold) {
        return Number(secondsLeft) <= Number(threshold);
      },
    },
    debug: {
      log() {},
      mark() {},
      metric() {},
    },
  };
}

function recentValues(samples, seconds, pick) {
  if (!samples?.length) return [];
  const latestTs = new Date(samples[samples.length - 1].ts).getTime();
  const cutoff = latestTs - Number(seconds) * 1000;
  return samples.filter((row) => new Date(row.ts).getTime() >= cutoff).map(pick).filter(Number.isFinite);
}

function sampleDelta(samples, seconds, pick) {
  const values = recentValues(samples, seconds, pick);
  if (values.length < 2) return 0;
  return values[values.length - 1] - values[0];
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value)));
}

export function normalizeTick(tick) {
  return {
    ts: tick.ts,
    underlyingPrice: Number(tick.btc_price ?? tick.underlyingPrice),
    priceToBeat: Number(tick.price_to_beat ?? tick.priceToBeat),
    up_price: Number(tick.up_price ?? tick.upPrice),
    down_price: Number(tick.down_price ?? tick.downPrice),
    up_best_ask: Number(tick.up_best_ask ?? tick.upBestAsk),
    up_best_bid: Number(tick.up_best_bid ?? tick.upBestBid),
    down_best_ask: Number(tick.down_best_ask ?? tick.downBestAsk),
    down_best_bid: Number(tick.down_best_bid ?? tick.downBestBid),
    condition_id: tick.condition_id,
    event_start: tick.event_start,
    event_end: tick.event_end,
    ...tick,
  };
}

export function buildEventFromTick(tick) {
  return {
    eventId: tick.condition_id,
    start: tick.event_start,
    end: tick.event_end,
    eventStart: tick.event_start,
    eventEnd: tick.event_end,
    priceToBeat: Number(tick.price_to_beat ?? tick.priceToBeat),
  };
}
