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

function sampleUnderlyingValue(sample) {
  return Number(sample?.underlyingPrice ?? sample?.btc_price ?? sample?.underlying_price);
}

function timestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length);
}

function recentVolNormalized(samples, lookbackSec) {
  if (!samples?.length || samples.length < 3) return 0;
  const latest = samples[samples.length - 1];
  const latestTs = latest._tsMs ?? timestampMs(latest.ts);
  const cutoff = latestTs - Number(lookbackSec) * 1000;
  const recent = samples.filter((sample) => {
    const ts = sample._tsMs ?? timestampMs(sample.ts);
    const btc = sampleUnderlyingValue(sample);
    return ts >= cutoff && Number.isFinite(btc);
  });
  const normalizedChanges = [];
  for (let index = 1; index < recent.length; index += 1) {
    const t1 = recent[index]._tsMs ?? timestampMs(recent[index].ts);
    const t0 = recent[index - 1]._tsMs ?? timestampMs(recent[index - 1].ts);
    const dtSec = Math.max(0.25, (t1 - t0) / 1000);
    normalizedChanges.push((sampleUnderlyingValue(recent[index], 0) - sampleUnderlyingValue(recent[index - 1], 0)) / Math.sqrt(dtSec));
  }
  return stdDev(normalizedChanges);
}

function marketProbUpFromBook(tick) {
  const upMid = sideMid(tick, 'UP');
  const downMid = sideMid(tick, 'DOWN');
  if (upMid == null || downMid == null || upMid + downMid <= 0) return 0.5;
  return libClamp(upMid / (upMid + downMid), 0.001, 0.999);
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

function libClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalPdf(value) {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function secondsRemaining(event, tick) {
  const endMs = timestampMs(event?.end ?? event?.eventEnd ?? tick?.event_end);
  const tickMs = timestampMs(tick?.ts);
  return Math.max(0, (endMs - tickMs) / 1000);
}

function bidVelocityForSide(samples, side, bid) {
  if (bid == null || !samples?.length) return 0;
  const latest = samples[samples.length - 1];
  const latestTs = latest._tsMs ?? timestampMs(latest.ts);
  let previous = null;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sampleTs = samples[index]._tsMs ?? timestampMs(samples[index].ts);
    if (latestTs - sampleTs >= 2000) {
      previous = samples[index];
      break;
    }
  }
  if (!previous) return 0;
  const prevBid = side === 'UP'
    ? finiteNumber(previous.up_best_bid ?? previous.upBestBid)
    : finiteNumber(previous.down_best_bid ?? previous.downBestBid);
  if (prevBid == null) return 0;
  const dtSec = Math.max(1, (latestTs - (previous._tsMs ?? timestampMs(previous.ts))) / 1000);
  return (bid - prevBid) / dtSec;
}

function createLibrary(lib) {
  function terminalModelForSide(samples, tick, event, side, params = {}) {
    const btcPrice = Number(tick?.underlyingPrice ?? tick?.underlying_price);
    const priceToBeat = Number(event?.priceToBeat ?? tick?.priceToBeat ?? tick?.price_to_beat);
    const latest = samples?.length ? samples[samples.length - 1] : null;
    if (!Number.isFinite(btcPrice) || !Number.isFinite(priceToBeat) || !latest) {
      return { probability: 0.5, theta: 0, sigma: Number(params.minSigma ?? 8), signedDistance: 0, drift: 0 };
    }

    const signedSide = side === 'UP' ? 1 : -1;
    const signedDistance = signedSide * (btcPrice - priceToBeat);
    const timeRemainingSec = Math.max(1, secondsRemaining(event, tick));
    const fastSample = sampleAgo(samples, params.fastMomentumSec ?? 3) || latest;
    const slowSample = sampleAgo(samples, params.slowMomentumSec ?? 10) || fastSample;
    const latestTs = latest._tsMs ?? timestampMs(latest.ts);
    const fastSec = Math.max(1, (latestTs - (fastSample._tsMs ?? timestampMs(fastSample.ts))) / 1000);
    const slowSec = Math.max(fastSec, (latestTs - (slowSample._tsMs ?? timestampMs(slowSample.ts))) / 1000);
    const fastDrift = signedSide * (btcPrice - sampleUnderlyingValue(fastSample)) / fastSec;
    const slowDrift = signedSide * (btcPrice - sampleUnderlyingValue(slowSample)) / slowSec;
    const drift = fastDrift + (Number(params.slowDriftWeight ?? 0.2) * slowDrift);
    const vol = recentVolNormalized(samples, params.volLookbackSec ?? 25);
    const sigma = Math.max(Number(params.minSigma ?? 8), vol * Math.sqrt(timeRemainingSec) * Number(params.sigmaMultiplier ?? 1.1));
    const driftContribution = libClamp(
      drift * timeRemainingSec * Number(params.driftWeight ?? 0.35),
      -sigma * Number(params.driftClampSigma ?? 0.65),
      sigma * Number(params.driftClampSigma ?? 0.65),
    );
    const projectedDistance = signedDistance + driftContribution;
    const z = projectedDistance / Math.max(sigma, 0.000001);
    const probability = libClamp(lib.math.normalCdf(z), 0.001, 0.999);
    const theta = normalPdf(z) * Math.abs(projectedDistance) / (2 * Math.max(sigma, 0.000001) * timeRemainingSec);
    return { probability, theta, sigma, signedDistance, drift, projectedDistance, z };
  }

  function scoreTerminalSides(samples, tick, event, params = {}) {
    const upAsk = lib.book.ask('UP', tick);
    const downAsk = lib.book.ask('DOWN', tick);
    const askSum = (upAsk ?? 0.5) + (downAsk ?? 0.5);
    if (askSum < Number(params.minOddsSum ?? 0.82) || askSum > Number(params.maxOddsSum ?? 1.2)) {
      return { best: null, probUp: marketProbUpFromBook(tick) };
    }

    const marketUp = marketProbUpFromBook(tick);
    const allowed = String(params.allowedPositionSide ?? 'BOTH').toUpperCase();
    const timeRemainingSec = secondsRemaining(event, tick);

    const candidates = ['UP', 'DOWN']
      .filter((side) => allowed === 'BOTH' || allowed === side)
      .map((side) => {
        const ask = lib.book.ask(side, tick);
        const bid = lib.book.bid(side, tick);
        const spread = lib.book.spread(side, tick);
        const model = terminalModelForSide(samples, tick, event, side, params);
        const marketProbability = side === 'UP' ? marketUp : 1 - marketUp;
        const modelEdge = Number.isFinite(ask) ? model.probability - ask : Number.NEGATIVE_INFINITY;
        const marketLag = model.probability - marketProbability;
        const bidVelocity = bidVelocityForSide(samples, side, bid);
        const convexityScore = modelEdge * Math.max(0.0001, model.theta) * (1 + Math.max(0, marketLag)) / Math.max(0.01, spread ?? 0.01);
        return {
          side,
          ask,
          bid,
          spread,
          askSum,
          timeRemainingSec,
          modelProbability: model.probability,
          probability: model.probability,
          modelEdge,
          edge: modelEdge,
          marketProbability,
          marketLag,
          theta: model.theta,
          sigma: model.sigma,
          signedDistance: model.signedDistance,
          drift: model.drift,
          bidVelocity,
          convexityScore,
        };
      })
      .filter((candidate) => {
        if (!Number.isFinite(candidate.ask) || !Number.isFinite(candidate.bid)) return false;
        if (candidate.timeRemainingSec > Number(params.entryWindowStart ?? 15)) return false;
        if (candidate.timeRemainingSec < Number(params.entryWindowEnd ?? 8)) return false;
        if (candidate.signedDistance < Number(params.minAheadDist ?? 25)) return false;
        if (candidate.signedDistance > Number(params.maxAheadDist ?? 55)) return false;
        if (candidate.ask < Number(params.minAsk ?? 0.04)) return false;
        if (candidate.ask > Number(params.maxAsk ?? 0.45)) return false;
        if (Number.isFinite(candidate.spread) && candidate.spread > Number(params.maxSpread ?? 0.14)) return false;
        if (candidate.modelProbability < Number(params.minModelProb ?? 0.32)) return false;
        if (candidate.modelEdge < Number(params.minModelEdge ?? 0.08)) return false;
        if (candidate.marketLag < Number(params.minMarketLag ?? -0.02)) return false;
        if (candidate.theta < Number(params.minTheta ?? 0)) return false;
        const requireBidMomentum = params.requireBidMomentum === true || params.requireBidMomentum === 'true' || params.requireBidMomentum === 1;
        if (requireBidMomentum && candidate.bidVelocity < Number(params.minBidVelocity ?? -0.08)) return false;
        return true;
      })
      .sort((left, right) => right.convexityScore - left.convexityScore || right.modelEdge - left.modelEdge);

    return { best: candidates[0] ?? null, probUp: marketUp };
  }

  return { scoreTerminalSides };
}

export default strategy({
  name: "Terminal Convexity V1",

  params: {
    walletSize: 100,
    maxOrderValue: 15,
    minShares: 5,
    entryWindowStart: 15,
    entryWindowEnd: 8,
    minAheadDist: 25,
    maxAheadDist: 55,
    minAsk: 0.04,
    maxAsk: 0.45,
    maxSpread: 0.14,
    minOddsSum: 0.82,
    maxOddsSum: 1.2,
    minModelProb: 0.32,
    minModelEdge: 0.08,
    minMarketLag: -0.02,
    minTheta: 0,
    entrySlippageMax: 0.02,
    minLiquidityRatio: 0.55,
    volLookbackSec: 25,
    fastMomentumSec: 3,
    slowMomentumSec: 10,
    minSigma: 8,
    sigmaMultiplier: 1.1,
    driftWeight: 0.35,
    slowDriftWeight: 0.2,
    driftClampSigma: 0.65,
    profitExitBid: 0,
    stopIfCrossed: true,
    stopCrossDist: -2,
    stopMinBid: 0.04,
    requireBidMomentum: false,
    minBidVelocity: -0.08,
    allowedPositionSide: "BOTH",
    stopReverseEnabled: false,
    stopReverseMaxAttempts: 1,
    stopReverseMaxSecondsRemaining: 60,
    stopReverseMinSecondsRemaining: 2,
    stopReverseMinDistanceAbs: 10,
    stopReverseMaxAsk: 0.98,
    stopReverseSlippageMax: 0.02,
    stopReverseMinLiquidityRatio: 0.5,
    stopReverseMinBid: 0.001,
    stopReverseBudgetMode: "same-cost",
    stopReverseBudgetFactor: 1.25,
    entryWindowExcludeStart: 13,
    entryWindowExcludeEnd: 10,
    minAheadDistDOWN: 30,
    minModelProbDOWN: 0.38,
    minModelEdgeDOWN: 0.11,
    sizePriceAware: false,
    sizePriceThreshold: 0.30,
    sizePriceFactor: 0.5,
    trailAfterBid: 0,
    trailDrop: 0.15,
  },

  onEventStart({ state }) {
    state.entered = false;
    state.closed = false;
    state.stopReverseCount = 0;
    state.maxBid = 0;
    state.lastNoEntryReason = "outside_entry_window";
  },

  onTick(ctx) {
    const { tick, event, state, params, position, runState } = ctx;
    const secsLeft = time.secondsUntil(event.end, tick.ts);
    if (position.open) {
      const side = position.side;
      const bid = book.bid(side, tick);
      if ((bid > state.maxBid)) {
        state.maxBid = bid;
      }
      state.reversedThisTick = false;
      if ((((params.stopReverseEnabled && (state.stopReverseCount < params.stopReverseMaxAttempts)) && (secsLeft <= params.stopReverseMaxSecondsRemaining)) && (secsLeft >= params.stopReverseMinSecondsRemaining))) {
        state.adverseDistance = (tick.underlyingPrice - event.priceToBeat);
        if ((side == "UP")) {
          state.adverseDistance = (event.priceToBeat - tick.underlyingPrice);
        }
        state.stopReverseMinDistance = signals.stopReverseMinDistance(params, secsLeft);
        if ((state.adverseDistance >= state.stopReverseMinDistance)) {
          const reverseSide = prices.oppositeSide(side);
          const reverseAsk = book.ask(reverseSide, tick);
          const reverseMaxPrice = math.min(params.stopReverseMaxAsk, (reverseAsk + params.stopReverseSlippageMax));
          state.reverseBudgetBase = position.totalCost;
          if ((params.stopReverseBudgetMode == "open-cost")) {
            state.reverseBudgetBase = position.openCost;
          }
          if ((params.stopReverseBudgetMode == "sale-proceeds")) {
            state.reverseBudgetBase = (position.shares * bid);
          }
          if ((params.stopReverseBudgetMode == "max-order")) {
            state.reverseBudgetBase = params.maxOrderValue;
          }
          const reverseBudget = math.min(params.maxOrderValue, (params.walletSize + runState.totalPnl), (state.reverseBudgetBase * params.stopReverseBudgetFactor));
          const reverseLiq = book.liquidityRatio(reverseSide, tick, reverseBudget, reverseMaxPrice);
          if (((reverseAsk <= params.stopReverseMaxAsk) && (reverseLiq >= params.stopReverseMinLiquidityRatio))) {
            const reversed = orders.reverse(reverseSide, { "exitPrice": bid, "price": reverseAsk, "maxPrice": reverseMaxPrice, "budget": reverseBudget, "minShares": params.minShares, "minLiquidityRatio": params.stopReverseMinLiquidityRatio, "tick": tick, "ignoreConsumed": true, "reason": "stop_reverse", "exitReason": "stop_reverse_exit" });
            if (reversed) {
              state.stopReverseCount = (state.stopReverseCount + 1);
              state.maxBid = book.bid(reverseSide, tick);
              state.reversedThisTick = true;
              trace.mark("reverse", { "from": side, "to": reverseSide, "price": reverseAsk });
            }
          }
        }
      }
      if (!state.reversedThisTick) {
        if (((params.profitExitBid > 0) && (bid >= params.profitExitBid))) {
          const profited = orders.exit({ "price": params.profitExitBid, "reason": "profit_exit" });
          if (profited) {
            state.closed = profited.closed;
            trace.mark("exit", { "reason": "profit_exit", "price": params.profitExitBid });
          }
        } else if (Number(params.trailAfterBid ?? 0) > 0 && state.maxBid >= Number(params.trailAfterBid) && state.maxBid - bid >= Number(params.trailDrop ?? 0.15)) {
          const trailed = orders.exit({ "price": bid, "reason": "trail" });
          if (trailed) {
            state.closed = trailed.closed;
            trace.mark("exit", { "reason": "trail", "price": bid });
          }
        } else {
          state.signedDistance = tick.underlyingPrice - event.priceToBeat;
          if (side == "DOWN") {
            state.signedDistance = event.priceToBeat - tick.underlyingPrice;
          }
          state.lateFlipExitOn = params.lateFlipExitEnabled == true || params.lateFlipExitEnabled == 1;
          if (state.lateFlipExitOn && secsLeft <= params.lateFlipExitSec && state.signedDistance <= params.lateFlipExitCrossDist && bid >= params.stopMinBid) {
            const lateFlipped = orders.exit({ "price": bid, "reason": "late_flip_exit" });
            if (lateFlipped) {
              state.closed = lateFlipped.closed;
              trace.mark("exit", { "reason": "late_flip_exit", "price": bid });
            }
          } else {
            if (params.stopIfCrossed) {
              if (((state.signedDistance <= params.stopCrossDist) && (bid >= params.stopMinBid))) {
                const stopped = orders.exit({ "price": bid, "reason": "cross_stop" });
                if (stopped) {
                  state.closed = stopped.closed;
                  trace.mark("exit", { "reason": "cross_stop", "price": bid });
                }
              }
            }
          }
        }
      }
    } else {
      state.lastNoEntryReason = "outside_entry_window";
      if (state.closed) {
        state.lastNoEntryReason = "event_closed_after_exit";
      }
      if ((!state.closed && time.inWindow(secsLeft, params.entryWindowStart, params.entryWindowEnd))) {
        state.lastNoEntryReason = "no_candidate";
        const scored = model.scoreTerminalSides(samples, tick, event, params);
        const best = scored.best;
        if (best) {
          state.lastCandidateSide = best.side;
          state.lastCandidateAsk = best.ask;
          state.lastCandidateEdge = best.edge;
          state.lastCandidateProbability = best.probability;
          state.orderValueCap = params.maxOrderValue;
          if (params.sizePriceAware && best.ask > params.sizePriceThreshold) {
            state.orderValueCap = params.maxOrderValue * params.sizePriceFactor;
          }
          const maxFillPrice = math.min(params.maxAsk, (best.ask + params.entrySlippageMax));
          const liq = book.liquidityRatio(best.side, tick, state.orderValueCap, maxFillPrice);
          state.lastLiquidityRatio = liq;
          state.lastNoEntryReason = "liquidity_below_min";
          if ((liq >= params.minLiquidityRatio)) {
            const budget = math.min(risk.capOrderValue(state.orderValueCap, params.maxOrderValue), (params.walletSize + runState.totalPnl));
            state.lastNoEntryReason = "entry_rejected";
            const bought = orders.enter(best.side, { "price": best.ask, "maxPrice": maxFillPrice, "budget": budget, "minShares": params.minShares, "minLiquidityRatio": params.minLiquidityRatio, "tick": tick, "reason": "entry" });
            if (bought) {
              state.lastNoEntryReason = "entered";
              state.entered = true;
              trace.mark("entry", { "side": best.side, "ask": best.ask, "edge": best.edge });
              trace.metric("edge", best.edge);
            }
          }
        }
      }
    }
  },

  onEventEnd() {
  },

});