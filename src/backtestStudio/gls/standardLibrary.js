export function createStandardLibrary() {
  const lib = {
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
      momentum(samples, seconds) {
        return sampleDelta(samples, seconds, sampleUnderlyingValue);
      },
      slowMomentum(samples, seconds) {
        return sampleDelta(samples, seconds, sampleUnderlyingValue);
      },
      volatility(samples, seconds) {
        const values = recentValues(samples, seconds, sampleUnderlyingValue);
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
      underlyingAgo(samples, seconds) {
        const sample = sampleAgo(samples, seconds);
        return sample ? sampleUnderlyingValue(sample) : null;
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
      directionProbability(samples, tick, event, params = {}) {
        const btc = Number(tick?.underlyingPrice ?? tick?.btc_price);
        const ptb = Number(event?.priceToBeat ?? tick?.priceToBeat ?? tick?.price_to_beat);
        if (!Number.isFinite(btc) || !Number.isFinite(ptb)) return 0.5;
        const secsLeft = Math.max(0, (new Date(event.end || tick.event_end).getTime() - new Date(tick.ts).getTime()) / 1000);
        const distance = btc - ptb;
        const fastSample = sampleAgo(samples, params.momentumSec ?? 6);
        const slowSample = sampleAgo(samples, params.slowMomentumSec ?? 18) || fastSample;
        const fastMove = btc - sampleUnderlying(fastSample, btc);
        const slowMove = btc - sampleUnderlying(slowSample, btc);
        const recentVol = recentVolatility(samples, params.volLookbackSec ?? 45);
        const minSigma = Number(params.minSigma ?? 10);
        const sigmaMultiplier = Number(params.sigmaMultiplier ?? 1);
        const sigma = Math.max(minSigma, recentVol * Math.sqrt(Math.max(1, secsLeft)) * sigmaMultiplier);
        const distanceZ = distance / sigma;
        const momentumZ = (fastMove + (Number(params.slowMomentumWeight ?? 0.35) * slowMove)) / sigma;
        const marketProbability = marketProbUpFromBook(tick);
        const marketLag = Math.min(0.5, Math.max(-0.5, (distance > 0 ? 1 - marketProbability : marketProbability) - 0.5));
        const distanceWeight = Number(params.distanceWeight ?? 2);
        const momentumWeight = Number(params.momentumWeight ?? 0.65);
        const lagWeight = Number(params.lagWeight ?? 0.45);
        const score = (distanceWeight * distanceZ) + (momentumWeight * momentumZ) + (lagWeight * marketLag);
        return Math.min(0.999, Math.max(0.001, lib.math.logistic(score)));
      },
      scoreSides(samples, tick, event, params = {}) {
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
      scoreImpulseElasticitySides(samples, tick, event, params = {}) {
        if (!samples || !samples.length) return { best: null, probUp: 0.5 };
        const latest = samples[samples.length - 1];
        const latestTs = latest._tsMs ?? timestampMs(latest.ts);
        const impulseSec = Number(params.impulseSec ?? 5);
        const targetMs = latestTs - (impulseSec * 1000);
        let impulseSample = samples[0];
        for (let index = samples.length - 1; index >= 0; index -= 1) {
          const sampleTs = samples[index]._tsMs ?? timestampMs(samples[index].ts);
          if (sampleTs <= targetMs) {
            impulseSample = samples[index];
            break;
          }
        }
        
        if (!latest || !impulseSample || latest === impulseSample) return { best: null, probUp: 0.5 };
        
        const btcPrice = Number(tick.underlyingPrice);
        const priceToBeat = Number(event.priceToBeat ?? tick.priceToBeat);
        if (!Number.isFinite(btcPrice) || !Number.isFinite(priceToBeat)) return { best: null, probUp: 0.5 };
        
        const shock = btcPrice - sampleUnderlying(impulseSample, btcPrice);
        const shockAbs = Math.abs(shock);
        const shockSide = shock >= 0 ? 'UP' : 'DOWN';
        const shockSign = shock >= 0 ? 1 : -1;
        
        const pUp = marketProbUpFromBook(tick);
        const pUpChange = pUp - marketProbUpFromBook(impulseSample);
        const shockResponse = shockSign * pUpChange;
        
        const lookbackSec = Number(params.volLookbackSec ?? 45);
        const cutoff = latestTs - (lookbackSec * 1000);
        const recent = samples.filter((sample) => (sample._tsMs ?? timestampMs(sample.ts)) >= cutoff && Number.isFinite(sampleUnderlying(sample, Number.NaN)));
        
        const normalizedChanges = [];
        for (let index = 1; index < recent.length; index += 1) {
          const t1 = recent[index]._tsMs ?? timestampMs(recent[index].ts);
          const t0 = recent[index - 1]._tsMs ?? timestampMs(recent[index - 1].ts);
          const dtSec = Math.max(0.25, (t1 - t0) / 1000);
          normalizedChanges.push((sampleUnderlying(recent[index], 0) - sampleUnderlying(recent[index - 1], 0)) / Math.sqrt(dtSec));
        }
        
        const vol = Math.max(0.000001, stdDev(normalizedChanges));
        const shockZ = shockAbs / Math.max(0.000001, vol * Math.sqrt(Math.max(1, impulseSec)));
        
        const thesis = String(params.thesis || 'inertia').toLowerCase();
        
        if (shockAbs < Number(params.minShockAbs ?? 18) || shockZ < Number(params.minShockZ ?? 1.05)) return { best: null, probUp: pUp };
        
        let side = shockSide;
        let sideShock = shockAbs;
        let sideResponse = shockResponse;
        
        if (thesis === 'fade') {
          if (shockResponse < Number(params.minOverResponse ?? 0.12)) return { best: null, probUp: pUp };
          side = shockSide === 'UP' ? 'DOWN' : 'UP';
          sideShock = shockAbs;
          sideResponse = -shockResponse;
        } else if (thesis === 'compression') {
          if (Math.abs(btcPrice - priceToBeat) > Number(params.maxCompressionDist ?? 12)) return { best: null, probUp: pUp };
          if (vol < Number(params.minCompressionVol ?? 3.5)) return { best: null, probUp: pUp };
          if (shockResponse > Number(params.maxResponse ?? 0.065)) return { best: null, probUp: pUp };
        } else if (thesis === 'random') {
          if (shockResponse < Number(params.minResponse ?? -0.04) || shockResponse > Number(params.maxResponse ?? 0.065)) return { best: null, probUp: pUp };
          side = seededSide(`${event.start || event.eventStart}:${tick.ts}:impulse-elasticity`);
          const sideSign = side === 'UP' ? 1 : -1;
          sideShock = sideSign * shock;
          sideResponse = sideSign * pUpChange;
        } else if (shockResponse < Number(params.minResponse ?? -0.04) || shockResponse > Number(params.maxResponse ?? 0.065)) {
          return { best: null, probUp: pUp };
        }
        
        if (params.allowedPositionSide && params.allowedPositionSide !== 'BOTH' && params.allowedPositionSide !== side) return { best: null, probUp: pUp };
        
        const fields = {
          ask: lib.book.ask(side, tick),
          bid: lib.book.bid(side, tick),
          rawAsks: side === 'DOWN' ? tick.down_book_asks : tick.up_book_asks,
          rawBids: side === 'DOWN' ? tick.down_book_bids : tick.up_book_bids,
        };
        const oppositeSide = side === 'UP' ? 'DOWN' : 'UP';
        const oppositeAsk = lib.book.ask(oppositeSide, tick);
        
        const ask = fields.ask;
        const bid = fields.bid;
        if (ask == null || bid == null) return { best: null, probUp: pUp };
        
        const spread = Math.max(0, ask - bid);
        const askSum = ask + (oppositeAsk ?? 0.5);
        
        const sideSign = side === 'UP' ? 1 : -1;
        const signedDistance = sideSign * (btcPrice - priceToBeat);
        
        const secsLeft = Math.max(0, (new Date(event.end || tick.event_end).getTime() - new Date(tick.ts).getTime()) / 1000);
        
        const sigmaTau = Math.max(Number(params.minSigma ?? 8), vol * Math.sqrt(Math.max(1, secsLeft)) * Number(params.sigmaMultiplier ?? 1.10));
        
        const carryVelocity = sideShock / Math.max(1, impulseSec);
        const carryWeight = thesis === 'fade' ? Number(params.fadeCarryWeight ?? 0.42) : Number(params.impulseCarryWeight ?? 0.32);
        
        const carry = lib.math.clamp(
          carryVelocity * Math.min(secsLeft, Number(params.carryHorizonSec ?? 16)) * carryWeight,
          -sigmaTau * Number(params.carryClampSigma ?? 0.80),
          sigmaTau * Number(params.carryClampSigma ?? 0.80)
        );
        
        const terminalProbability = lib.math.clamp(lib.math.normalCdf((signedDistance + carry) / Math.max(0.000001, sigmaTau)), 0.001, 0.999);
        const responsePenalty = Math.max(0, sideResponse) / Math.max(0.001, Number(params.responseScale ?? 0.08));
        
        const inertia = lib.math.clamp(shockZ - responsePenalty, 0, 4);
        const overreaction = lib.math.clamp(responsePenalty - (shockZ * 0.55), 0, 4);
        const compressionBoost = thesis === 'compression'
          ? lib.math.clamp((Number(params.maxCompressionDist ?? 12) - Math.abs(btcPrice - priceToBeat)) / Math.max(1, Number(params.maxCompressionDist ?? 12)), 0, 1)
          : 0;
          
        const anomalyBoost = thesis === 'fade' ? overreaction : Math.max(inertia, compressionBoost * shockZ);
        
        const modelProbability = lib.math.clamp(
          terminalProbability + (Number(params.inertiaProbabilityWeight ?? 0.10) * Math.min(1, anomalyBoost / 4) * (1 - terminalProbability)),
          0.001,
          0.999
        );
        
        const modelEdge = modelProbability - ask;
        const maxFillPrice = Math.min(Number(params.maxAsk ?? 0.72), ask + Number(params.entrySlippageMax ?? 0.02));
        
        const liquidityQty = lib.book.availableQty(side, maxFillPrice, tick);
        const targetQty = Math.floor(Math.min(Number(params.maxOrderValue ?? 15), Number(params.walletSize ?? 100)) / Math.max(maxFillPrice, 0.001));
        const liquidityRatio = targetQty > 0 ? Math.min(1, liquidityQty / targetQty) : 0;
        const decisionMetric = Math.max(0, modelEdge) * Math.max(0.001, anomalyBoost) * Math.max(0.2, liquidityRatio) / Math.max(0.01, spread);
        
        const marketProbability = side === 'UP' ? pUp : 1 - pUp;
        
        const candidate = {
          side,
          ask,
          bid,
          spread,
          askSum,
          signedDistance,
          modelProbability,
          modelEdge,
          liquidityRatio,
          decisionMetric,
          marketProbability
        };
        
        if (candidate.ask < Number(params.minAsk ?? 0.06) || candidate.ask > Number(params.maxAsk ?? 0.72)) return { best: null, probUp: pUp };
        if (candidate.spread > Number(params.maxSpread ?? 0.10)) return { best: null, probUp: pUp };
        if (candidate.askSum < Number(params.minOddsSum ?? 0.98) || candidate.askSum > Number(params.maxOddsSum ?? 1.07)) return { best: null, probUp: pUp };
        if (candidate.signedDistance < Number(params.minSignedDistance ?? 4) || candidate.signedDistance > Number(params.maxSignedDistance ?? 120)) return { best: null, probUp: pUp };
        if (candidate.modelProbability < Number(params.minModelProb ?? 0.42)) return { best: null, probUp: pUp };
        if (candidate.modelEdge < Number(params.minModelEdge ?? 0.025)) return { best: null, probUp: pUp };
        if (candidate.decisionMetric < Number(params.minDecisionMetric ?? 0.025)) return { best: null, probUp: pUp };
        
        return { best: candidate, probUp: pUp };
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
  return lib;
}

function sampleAgo(samples, seconds) {
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

function sampleUnderlying(sample, fallback) {
  const value = sampleUnderlyingValue(sample);
  return Number.isFinite(value) ? value : fallback;
}

function sampleUnderlyingValue(sample) {
  return Number(sample?.underlyingPrice ?? sample?.btc_price ?? sample?.underlying_price);
}

function recentVolatility(samples, lookbackSec) {
  if (!samples?.length || samples.length < 3) return 0;
  const latest = samples[samples.length - 1];
  const latestTs = latest._tsMs ?? timestampMs(latest.ts);
  const cutoff = latestTs - Number(lookbackSec) * 1000;
  const recent = samples.filter((sample) => {
    const ts = sample._tsMs ?? timestampMs(sample.ts);
    return ts >= cutoff && Number.isFinite(sampleUnderlying(sample, Number.NaN));
  });
  const changes = [];
  for (let index = 1; index < recent.length; index += 1) {
    changes.push(sampleUnderlying(recent[index], 0) - sampleUnderlying(recent[index - 1], 0));
  }
  return stdDev(changes);
}

function marketProbUpFromBook(tick) {
  const upMid = sideMid(tick, 'UP');
  const downMid = sideMid(tick, 'DOWN');
  if (upMid == null || downMid == null || upMid + downMid <= 0) return 0.5;
  return Math.min(0.999, Math.max(0.001, upMid / (upMid + downMid)));
}

function sideMid(tick, side) {
  const bid = side === 'DOWN'
    ? finiteNumber(tick?.down_best_bid ?? tick?.downBestBid)
    : finiteNumber(tick?.up_best_bid ?? tick?.upBestBid);
  const ask = side === 'DOWN'
    ? finiteNumber(tick?.down_best_ask ?? tick?.downBestAsk)
    : finiteNumber(tick?.up_best_ask ?? tick?.upBestAsk);
  const price = side === 'DOWN'
    ? finiteNumber(tick?.down_price ?? tick?.downPrice)
    : finiteNumber(tick?.up_price ?? tick?.upPrice);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return ask ?? bid ?? price ?? null;
}

function finiteNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function recentValues(samples, seconds, pick) {
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

function seededSide(key) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? 'UP' : 'DOWN';
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
