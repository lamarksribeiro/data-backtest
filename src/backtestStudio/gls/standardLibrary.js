import { resolveNativeModels } from '../nativeLibrary/registry.js';

export function createStandardLibrary({ nativeLibraries = [] } = {}) {
  let activeSamples = [];
  const lib = {
    setActiveSamples(samples) {
      activeSamples = samples || [];
    },
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
        const ask = lib.book.ask(side, tick);
        const bid = lib.book.bid(side, tick);
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
      liquidityRatio(side, tick, budget, maxPrice = null) {
        const ask = lib.book.ask(side, tick);
        const limitPrice = maxPrice != null && Number.isFinite(Number(maxPrice)) ? Number(maxPrice) : ask;
        const qty = lib.book.availableQty(side, limitPrice, tick);
        const needed = budget / Math.max(limitPrice, 0.001);
        return needed > 0 ? qty / needed : 0;
      },
    },
    signals: {
      momentum(arg1, arg2) {
        return sampleDelta(arg1, arg2, sampleUnderlyingValue, activeSamples);
      },
      slowMomentum(arg1, arg2) {
        return sampleDelta(arg1, arg2, sampleUnderlyingValue, activeSamples);
      },
      volatility(arg1, arg2) {
        const values = recentValues(arg1, arg2, sampleUnderlyingValue, activeSamples);
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
      stopReverseMinDistance(params = {}, secondsLeft) {
        const fallback = Math.max(0, Number(params.stopReverseMinDistanceAbs ?? 0));
        let schedule = params.stopReverseDistanceSchedule;
        if (typeof schedule === 'string') {
          try {
            schedule = JSON.parse(schedule);
          } catch {
            schedule = null;
          }
        }
        if (!Array.isArray(schedule) || !schedule.length) return fallback;
        const normalized = schedule
          .map((item) => ({
            minSecondsRemaining: Number(item?.minSecondsRemaining ?? item?.minSec ?? item?.secondsRemaining ?? item?.seconds),
            minDistanceAbs: Number(item?.minDistanceAbs ?? item?.distanceAbs ?? item?.distance ?? item?.dist),
          }))
          .filter((item) => Number.isFinite(item.minSecondsRemaining) && Number.isFinite(item.minDistanceAbs))
          .sort((left, right) => right.minSecondsRemaining - left.minSecondsRemaining);
        const bucket = normalized.find((item) => Number(secondsLeft) >= Math.min(300, Math.max(0, item.minSecondsRemaining)));
        return bucket ? Math.max(0, bucket.minDistanceAbs) : fallback;
      },
      underlyingAgo(arg1, arg2) {
        const sample = sampleAgo(arg1, arg2, activeSamples);
        return sample ? sampleUnderlyingValue(sample) : null;
      },
      upAskAgo(arg1, arg2) {
        const sample = sampleAgo(arg1, arg2, activeSamples);
        return sample ? Number(sample?.up_best_ask ?? sample?.upBestAsk ?? sample?.up_price ?? sample?.upPrice) : null;
      },
      downAskAgo(arg1, arg2) {
        const sample = sampleAgo(arg1, arg2, activeSamples);
        return sample ? Number(sample?.down_best_ask ?? sample?.downBestAsk ?? sample?.down_price ?? sample?.downPrice) : null;
      },
      ptbFlipCount(arg1, arg2) {
        const { samples, seconds: windowSeconds } = resolveSamplesAndSeconds(arg1, arg2, activeSamples);
        if (!samples?.length) return 0;
        const latest = samples[samples.length - 1];
        const latestTs = latest._tsMs ?? timestampMs(latest.ts);
        const cutoff = latestTs - Number(windowSeconds) * 1000;
        let flips = 0;
        let prev = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const row = samples[index];
          const rowTs = row._tsMs ?? timestampMs(row.ts);
          if (rowTs < cutoff) continue;
          const btc = sampleUnderlyingValue(row);
          const ptb = Number(row?.priceToBeat ?? row?.price_to_beat);
          if (!Number.isFinite(btc) || !Number.isFinite(ptb)) continue;
          const sign = Math.sign(btc - ptb);
          if (sign && prev && sign !== prev) flips += 1;
          if (sign) prev = sign;
        }
        return flips;
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
      erf(value) {
        const sign = value < 0 ? -1 : 1;
        const absValue = Math.abs(value);
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;
        const factor = 1 / (1 + (p * absValue));
        const result = 1 - (((((a5 * factor + a4) * factor) + a3) * factor + a2) * factor + a1) * factor * Math.exp(-absValue * absValue);
        return sign * result;
      },
      normalCdf(value) {
        return 0.5 * (1 + lib.math.erf(value / Math.SQRT2));
      },
    },
    model: {
      orderBookImbalance(side, tick, levels = 5) {
        const prefix = side === 'DOWN' ? 'down' : 'up';
        let bidQtySum = 0;
        let askQtySum = 0;
        for (let i = 1; i <= levels; i += 1) {
          const askSz = Number(tick?.[`${prefix}_ask_sz_${i}`]);
          const bidSz = Number(tick?.[`${prefix}_bid_sz_${i}`]);
          if (Number.isFinite(askSz)) askQtySum += askSz;
          if (Number.isFinite(bidSz)) bidQtySum += bidSz;
        }
        const sum = bidQtySum + askQtySum;
        return sum > 0 ? (bidQtySum - askQtySum) / sum : 0;
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
        return Math.max(0, (timestampMs(end) - timestampMs(ts)) / 1000);
      },
      secondsSince(start, ts) {
        return Math.max(0, (timestampMs(ts) - timestampMs(start)) / 1000);
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

  const injected = new Set();
  for (const dep of nativeLibraries) {
    const key = `${dep.slug}:${dep.version ?? 1}`;
    if (injected.has(key)) continue;
    injected.add(key);
    const nativeModels = resolveNativeModels(lib, dep.slug, dep.version ?? 1);
    if (!nativeModels) continue;
    if (nativeModels.directionProbability) lib.model.directionProbability = nativeModels.directionProbability;
    if (nativeModels.scoreSides) lib.model.scoreSides = nativeModels.scoreSides;
    if (nativeModels.scoreTerminalSides) lib.model.scoreTerminalSides = nativeModels.scoreTerminalSides;
    if (nativeModels.scoreImpulseElasticitySides) lib.model.scoreImpulseElasticitySides = nativeModels.scoreImpulseElasticitySides;
  }

  return lib;
}

function resolveSamplesAndSeconds(arg1, arg2, defaultSamples = []) {
  if (Array.isArray(arg1)) {
    return { samples: arg1, seconds: Number(arg2 ?? 0) };
  }
  if (Array.isArray(arg2)) {
    return { samples: arg2, seconds: Number(arg1 ?? 0) };
  }
  if (typeof arg1 === 'number' || typeof arg1 === 'string') {
    return { samples: defaultSamples, seconds: Number(arg1) };
  }
  return { samples: defaultSamples, seconds: Number(arg2 ?? 0) };
}

function sampleAgo(arg1, arg2, defaultSamples = []) {
  const { samples, seconds } = resolveSamplesAndSeconds(arg1, arg2, defaultSamples);
  if (!samples?.length) return null;
  const latest = samples[samples.length - 1];
  const latestTs = latest._tsMs ?? timestampMs(latest.ts);
  const targetMs = latestTs - Number(seconds) * 1000;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sampleTs = samples[index]._tsMs ?? timestampMs(samples[index].ts);
    if (sampleTs <= targetMs) return samples[index];
  }
  return samples[0];
}

function sampleUnderlyingValue(sample) {
  return Number(sample?.underlyingPrice ?? sample?.btc_price ?? sample?.underlying_price);
}

function recentValues(arg1, arg2, pick, defaultSamples = []) {
  const { samples, seconds } = resolveSamplesAndSeconds(arg1, arg2, defaultSamples);
  if (!samples?.length) return [];
  const latest = samples[samples.length - 1];
  const latestTs = latest._tsMs ?? timestampMs(latest.ts);
  const cutoff = latestTs - Number(seconds) * 1000;
  return samples.filter((row) => (row._tsMs ?? timestampMs(row.ts)) >= cutoff).map(pick).filter(Number.isFinite);
}

function timestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

function sampleDelta(arg1, arg2, pick, defaultSamples = []) {
  const values = recentValues(arg1, arg2, pick, defaultSamples);
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
    _tsMs: tick._tsMs ?? timestampMs(tick.ts),
    _eventStartMs: tick._eventStartMs ?? timestampMs(tick.event_start),
    _eventEndMs: tick._eventEndMs ?? timestampMs(tick.event_end),
    underlyingPrice: Number(tick.btc_price ?? tick.underlyingPrice ?? tick.underlying_price),
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
