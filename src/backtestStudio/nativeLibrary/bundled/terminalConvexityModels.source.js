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