const DEFAULT_HYPERION_PARAMS = {
  walletSize: 100,
  maxOrderValue: 15,
  minShares: 5,
  entryWindowStart: 280,
  entryWindowEnd: 5,
  minAsk: 0.12,
  maxAsk: 0.82,
  minEdge: 0.08,
  minJumpIntensity: 0.25,
  jumpSigma: 45.0,
  obiLevels: 5,
  obiThreshold: 0.30,
  enableCrossEventCoupling: true,
  crossEventWindowStartSec: 20,
  crossEventWindowEndSec: 2,
  crossEventDistanceMin: 35,
  maxSpread: 0.06,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.75,
};

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalCdf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));

  return 0.5 * (1.0 + sign * y);
}

function mertonJumpDiffusionProbability(spot, ptb, sigma, secsLeft, jumpIntensity = 0.25) {
  const S = Number(spot);
  const K = Number(ptb);
  if (!Number.isFinite(S) || !Number.isFinite(K) || K <= 0) return 0.5;

  const T = Math.max(1, Number(secsLeft)) / 300.0;
  const vol = Math.max(10, Number(sigma));
  const distSigned = S - K;

  const d2 = distSigned / (vol * Math.sqrt(T));
  let baseProb = normalCdf(d2);

  if (distSigned > 0) {
    baseProb = Math.min(0.99, baseProb + (jumpIntensity * 0.05));
  } else {
    baseProb = Math.max(0.01, baseProb - (jumpIntensity * 0.05));
  }

  return baseProb;
}

export function mergeHyperionParams(raw = {}) {
  const params = { ...DEFAULT_HYPERION_PARAMS };
  for (const key of Object.keys(DEFAULT_HYPERION_PARAMS)) {
    if (raw[key] != null) {
      if (typeof DEFAULT_HYPERION_PARAMS[key] === 'boolean') {
        params[key] = toBool(raw[key], params[key]);
      } else {
        const val = toFiniteNumber(raw[key]);
        if (val != null) params[key] = val;
      }
    }
  }
  return params;
}

export function runHyperionStrategy(event, ticks, userParams = {}) {
  const params = mergeHyperionParams(userParams);
  const traces = [];
  let totalPnl = 0;
  let currentPosition = null;

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    const secsLeft = Math.max(0, (event.end - tick.ts) / 1000);

    if (currentPosition) {
      // Hold to Settlement
      continue;
    }

    if (secsLeft <= params.entryWindowStart && secsLeft >= params.entryWindowEnd) {
      const spot = tick.underlyingPrice;
      const ptb = event.priceToBeat;
      const distSigned = spot - ptb;

      const pJumpUp = mertonJumpDiffusionProbability(spot, ptb, 25.0, secsLeft, params.minJumpIntensity);

      const upAsk = Number(tick.up_best_ask ?? tick.upBestAsk ?? 0.5);
      const downAsk = Number(tick.down_best_ask ?? tick.downBestAsk ?? 0.5);
      const upSpread = Number(tick.up_best_ask) - Number(tick.up_best_bid) || 0.01;
      const downSpread = Number(tick.down_best_ask) - Number(tick.down_best_bid) || 0.01;

      let candidateSide = 'UP';
      let candidateAsk = upAsk;
      let candidateProb = pJumpUp;
      let candidateSpread = upSpread;

      if (distSigned < 0) {
        candidateSide = 'DOWN';
        candidateAsk = downAsk;
        candidateProb = 1.0 - pJumpUp;
        candidateSpread = downSpread;
      }

      const edge = candidateProb - candidateAsk;
      const gapCushion = Math.max(0.015, candidateSpread * 1.2);
      const netEdge = edge - gapCushion;

      if (
        candidateAsk >= params.minAsk &&
        candidateAsk <= params.maxAsk &&
        candidateSpread <= params.maxSpread &&
        netEdge >= params.minEdge
      ) {
        currentPosition = {
          side: candidateSide,
          entryPrice: candidateAsk,
          entryTs: tick.ts,
          netEdge,
          prob: candidateProb,
        };

        traces.push({
          type: 'ENTRY',
          ts: tick.ts,
          side: candidateSide,
          price: candidateAsk,
          netEdge,
          prob: candidateProb,
        });
      }
    }
  }

  return {
    traces,
    totalPnl,
    position: currentPosition,
  };
}
