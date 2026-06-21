const DEFAULT_PARAMS = {
  walletSize: 100,
  maxOrderValue: 5,
  minShares: 1,
  entryWindowStart: 297,
  entryWindowEnd: 0,
  warmupSec: 3,
  minAsk: 0.31,
  maxAsk: 0.85,
  minEdge: 0.03,
  maxSpread: 0.05,
  minDirectionalProb: 0.51,
  minProbHighAsk: 0.51,
  minDistanceAbs: 13,
  inversionDistanceAbs: 15,
  askSemEdge: 0.65,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 1,
  minSigma: 30,
  sigmaMultiplier: 1,
  distanceWeight: 1.8,
  momentumWeight: 1.2,
  lagWeight: 0.9,
  fastMomentumSec: 10,
  slowMomentumSec: 30,
  slowMomentumWeight: 0.4,
  historyWindowSec: 120,
  oddsSumTolerance: 0.20,
  fallbackExitBid: 0.01,
  inversionSharesMultiplier: 2,
  deteriorationEnabled: true,
  inversionEnabled: true,
  deteriorationOddFactor: 0.45,
  deteriorationProbFactor: 0.45,
  deteriorationRequiresCross: true,
  dynamicEdgeEnabled: true,
  edgeTier1MaxAsk: 0.35,
  edgeTier1Min: 0.06,
  edgeTier2MaxAsk: 0.50,
  edgeTier2Min: 0.03,
  edgeTier3MaxAsk: 0.65,
  edgeTier3Min: 0.01,
  edgeTier4MaxAsk: 0.75,
  edgeTier4Min: -0.03,
  edgeTier5Min: -0.08,
  positionSizingMode: 'bankroll',
  minStake: 1,
  bankrollThreshold: 100,
  bankrollPct: 0.05,
  reinforcementEnabled: true,
  reinforcementDistanceFactor: 1.36,
  reinforcementShares: 0,
  reinforcementStakeMultiplier: 1,
  postInversionStopLossEnabled: true,
  postInversionStopLossFactor: 0.50,
  postInversionReentryShares: 0,
  postInversionReentryMultiplier: 2,
  postInversionReentryStakeMultiplier: 4,
  allowedPositionSide: 'BOTH',
  entryShares: 0,
  reversalShares: 0,
  strategyName: 'MOMENTUM_EDGE_MODEL_V1',
  strategyDisplayName: 'Momentum Edge Model V1',
};

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function normalizePrice(value, fallback) {
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) return fallback;
  return clamp(numberValue, 0.001, 0.999);
}

function normalizeAllowedPositionSide(value) {
  const side = String(value || 'BOTH').toUpperCase();
  return ['BOTH', 'UP', 'DOWN'].includes(side) ? side : 'BOTH';
}

function normalizePositionSizingMode(value) {
  const mode = String(value || 'fixed').toLowerCase();
  return mode === 'bankroll' ? 'bankroll' : 'fixed';
}

function logistic(value) {
  return 1 / (1 + Math.exp(-clamp(value, -20, 20)));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function formatPrice(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatQty(value) {
  const numberValue = Number(value || 0);
  return Number.isInteger(numberValue) ? String(numberValue) : numberValue.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function mergeMomentumParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'maxOrderValue', 'minShares', 'entryWindowStart', 'entryWindowEnd',
    'warmupSec', 'minAsk', 'maxAsk', 'minEdge', 'maxSpread', 'minDirectionalProb',
    'minProbHighAsk', 'minDistanceAbs', 'inversionDistanceAbs', 'askSemEdge',
    'entrySlippageMax', 'minLiquidityRatio', 'minSigma', 'sigmaMultiplier',
    'distanceWeight', 'momentumWeight', 'lagWeight', 'fastMomentumSec',
    'slowMomentumSec', 'slowMomentumWeight', 'historyWindowSec', 'oddsSumTolerance',
    'fallbackExitBid', 'inversionSharesMultiplier', 'entryShares', 'reversalShares',
    'deteriorationOddFactor', 'deteriorationProbFactor', 'edgeTier1MaxAsk',
    'edgeTier1Min', 'edgeTier2MaxAsk', 'edgeTier2Min', 'edgeTier3MaxAsk',
    'edgeTier3Min', 'edgeTier4MaxAsk', 'edgeTier4Min', 'edgeTier5Min',
    'minStake', 'bankrollThreshold', 'bankrollPct', 'reinforcementDistanceFactor',
    'reinforcementShares', 'reinforcementStakeMultiplier', 'postInversionStopLossFactor',
    'postInversionReentryShares', 'postInversionReentryMultiplier',
    'postInversionReentryStakeMultiplier',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.walletSize = Math.max(1, params.walletSize);
  params.maxOrderValue = Math.max(0.01, params.maxOrderValue);
  params.minShares = Math.max(0.000001, params.minShares);
  params.entryWindowStart = clamp(params.entryWindowStart, 0, 300);
  params.entryWindowEnd = clamp(params.entryWindowEnd, 0, 300);
  if (params.entryWindowStart < params.entryWindowEnd) {
    [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  }
  params.warmupSec = clamp(params.warmupSec, 0, 120);
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.minEdge = clamp(params.minEdge, -0.99, 0.99);
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.minDirectionalProb = clamp(params.minDirectionalProb, 0.001, 0.999);
  params.minProbHighAsk = clamp(params.minProbHighAsk, 0.001, 0.999);
  params.minDistanceAbs = Math.max(0, params.minDistanceAbs);
  params.inversionDistanceAbs = Math.max(0, params.inversionDistanceAbs);
  params.askSemEdge = normalizePrice(params.askSemEdge, DEFAULT_PARAMS.askSemEdge);
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.99);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.minSigma = Math.max(0.01, params.minSigma);
  params.sigmaMultiplier = clamp(params.sigmaMultiplier, 0.1, 5);
  params.distanceWeight = clamp(params.distanceWeight, -10, 10);
  params.momentumWeight = clamp(params.momentumWeight, -10, 10);
  params.lagWeight = clamp(params.lagWeight, -10, 10);
  params.fastMomentumSec = clamp(params.fastMomentumSec, 1, 180);
  params.slowMomentumSec = clamp(params.slowMomentumSec, params.fastMomentumSec, 300);
  params.slowMomentumWeight = clamp(params.slowMomentumWeight, -5, 5);
  params.historyWindowSec = clamp(params.historyWindowSec, params.slowMomentumSec, 600);
  params.oddsSumTolerance = clamp(params.oddsSumTolerance, 0, 0.99);
  params.fallbackExitBid = normalizePrice(params.fallbackExitBid, DEFAULT_PARAMS.fallbackExitBid);
  params.inversionSharesMultiplier = Math.max(0, params.inversionSharesMultiplier);
  params.entryShares = Math.max(0, params.entryShares);
  params.reversalShares = Math.max(0, params.reversalShares);
  params.deteriorationOddFactor = clamp(params.deteriorationOddFactor, 0.01, 1);
  params.deteriorationProbFactor = clamp(params.deteriorationProbFactor, 0.01, 1);
  params.edgeTier1MaxAsk = normalizePrice(params.edgeTier1MaxAsk, DEFAULT_PARAMS.edgeTier1MaxAsk);
  params.edgeTier2MaxAsk = normalizePrice(params.edgeTier2MaxAsk, DEFAULT_PARAMS.edgeTier2MaxAsk);
  params.edgeTier3MaxAsk = normalizePrice(params.edgeTier3MaxAsk, DEFAULT_PARAMS.edgeTier3MaxAsk);
  params.edgeTier4MaxAsk = normalizePrice(params.edgeTier4MaxAsk, DEFAULT_PARAMS.edgeTier4MaxAsk);
  params.edgeTier1Min = clamp(params.edgeTier1Min, -0.99, 0.99);
  params.edgeTier2Min = clamp(params.edgeTier2Min, -0.99, 0.99);
  params.edgeTier3Min = clamp(params.edgeTier3Min, -0.99, 0.99);
  params.edgeTier4Min = clamp(params.edgeTier4Min, -0.99, 0.99);
  params.edgeTier5Min = clamp(params.edgeTier5Min, -0.99, 0.99);
  params.minStake = Math.max(0.01, params.minStake);
  params.bankrollThreshold = Math.max(0, params.bankrollThreshold);
  params.bankrollPct = clamp(params.bankrollPct, 0.0001, 1);
  params.reinforcementDistanceFactor = Math.max(1, params.reinforcementDistanceFactor);
  params.reinforcementShares = Math.max(0, params.reinforcementShares);
  params.reinforcementStakeMultiplier = Math.max(0, params.reinforcementStakeMultiplier);
  params.postInversionStopLossFactor = clamp(params.postInversionStopLossFactor, 0.01, 1);
  params.postInversionReentryShares = Math.max(0, params.postInversionReentryShares);
  params.postInversionReentryMultiplier = Math.max(0, params.postInversionReentryMultiplier);
  params.postInversionReentryStakeMultiplier = Math.max(0, params.postInversionReentryStakeMultiplier);
  params.deteriorationEnabled = toBool(raw.deteriorationEnabled, params.deteriorationEnabled);
  params.inversionEnabled = toBool(raw.inversionEnabled, params.inversionEnabled);
  params.deteriorationRequiresCross = toBool(raw.deteriorationRequiresCross, params.deteriorationRequiresCross);
  params.dynamicEdgeEnabled = toBool(raw.dynamicEdgeEnabled, params.dynamicEdgeEnabled);
  params.reinforcementEnabled = toBool(raw.reinforcementEnabled, params.reinforcementEnabled);
  params.postInversionStopLossEnabled = toBool(raw.postInversionStopLossEnabled, params.postInversionStopLossEnabled);
  params.allowedPositionSide = normalizeAllowedPositionSide(raw.allowedPositionSide ?? params.allowedPositionSide);
  params.positionSizingMode = normalizePositionSizingMode(raw.positionSizingMode ?? params.positionSizingMode);
  params.strategyName = String(raw.strategyName || params.strategyName || DEFAULT_PARAMS.strategyName);
  params.strategyDisplayName = String(raw.strategyDisplayName || params.strategyDisplayName || DEFAULT_PARAMS.strategyDisplayName);
  return params;
}

function parseBookLevels(rawLevels) {
  let levels = rawLevels;
  if (typeof rawLevels === 'string') {
    try {
      levels = JSON.parse(rawLevels);
    } catch {
      levels = [];
    }
  }
  if (!Array.isArray(levels)) return [];

  return levels
    .map((level) => ({ price: toFiniteNumber(level?.price), size: toFiniteNumber(level?.size) }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }))
    .sort((left, right) => left.price - right.price);
}

function withFallbackAsk(levels, fallbackBestAsk) {
  if (levels.length) return levels;
  return [];
}

function pruneConsumedByVisibleLevels(levels, consumedByPrice) {
  const visiblePriceKeys = new Set(levels.map((level) => level.key));
  for (const key of Array.from(consumedByPrice.keys())) {
    if (!visiblePriceKeys.has(key)) consumedByPrice.delete(key);
  }
}

function availableAskQty(rawAsks, maxPrice, fallbackBestAsk) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk);
  return levels.reduce((sum, level) => sum + (level.price <= maxPrice ? level.size : 0), 0);
}

function bankrollStake(params, walletBalance, multiplier = 1) {
  const balance = Math.max(0, toFiniteNumber(walletBalance) ?? params.walletSize);
  const baseStake = balance < params.bankrollThreshold ? params.minStake : balance * params.bankrollPct;
  return Math.max(params.minStake, baseStake * Math.max(0, multiplier));
}

function sharesForStake(stake, price, minStake) {
  if (price == null || price <= 0) return 0;
  let shares = Math.floor(stake / price);
  shares = Math.max(1, shares);
  while (shares * price < minStake) shares += 1;
  return shares;
}

function minEdgeForAsk(params, ask) {
  if (!params.dynamicEdgeEnabled) return params.minEdge;
  if (ask < params.edgeTier1MaxAsk) return params.edgeTier1Min;
  if (ask < params.edgeTier2MaxAsk) return params.edgeTier2Min;
  if (ask < params.edgeTier3MaxAsk) return params.edgeTier3Min;
  if (ask < params.edgeTier4MaxAsk) return params.edgeTier4Min;
  return params.edgeTier5Min;
}

function consumeAsksFromTick(rawAsks, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk);
  if (!levels.length || requestedQty <= 0) return [];
  pruneConsumedByVisibleLevels(levels, consumedByPrice);

  const fills = [];
  let remainingQty = requestedQty;
  for (const level of levels) {
    if (remainingQty <= 0) break;
    if (level.price > maxPrice) continue;

    const reservedQty = Math.min(consumedByPrice.get(level.key) || 0, level.size);
    if (reservedQty > 0) consumedByPrice.set(level.key, reservedQty);
    else consumedByPrice.delete(level.key);

    const availableQty = level.size - reservedQty;
    if (availableQty <= 0) continue;

    const fillQty = Math.min(availableQty, remainingQty);
    consumedByPrice.set(level.key, reservedQty + fillQty);
    fills.push({ price: level.price, qty: fillQty });
    remainingQty -= fillQty;
  }

  return fills;
}

function sideFields(tick, side) {
  if (side === 'UP') {
    const fallbackPrice = toFiniteNumber(tick.up_price);
    return {
      ask: toFiniteNumber(tick.up_best_ask) ?? fallbackPrice,
      bid: toFiniteNumber(tick.up_best_bid) ?? fallbackPrice,
      rawAsks: tick.up_book_asks,
      price: fallbackPrice,
    };
  }
  const fallbackPrice = toFiniteNumber(tick.down_price);
  return {
    ask: toFiniteNumber(tick.down_best_ask) ?? fallbackPrice,
    bid: toFiniteNumber(tick.down_best_bid) ?? fallbackPrice,
    rawAsks: tick.down_book_asks,
    price: fallbackPrice,
  };
}

function eventKey(tickOrState) {
  return `${tickOrState.event_start ?? tickOrState.eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEnd - new Date(tick.ts)) / 1000);
}

function eventElapsedSec(state, tick) {
  return Math.max(0, (new Date(tick.ts) - new Date(state.eventStart)) / 1000);
}

function sampleAgo(samples, seconds) {
  if (!samples.length) return null;
  const latest = samples[samples.length - 1];
  const targetMs = latest.timeMs - (seconds * 1000);
  return samples.find((sample) => sample.timeMs >= targetMs) || samples[0];
}

function recentAbsReturnVol(samples) {
  if (samples.length < 3) return 0;
  const returns = [];
  for (let index = 1; index < samples.length; index++) {
    const prev = samples[index - 1].btc;
    const curr = samples[index].btc;
    if (prev == null || curr == null) continue;
    returns.push(Math.abs(curr - prev));
  }
  return std(returns);
}

function movementPerSecond(samples, seconds) {
  if (samples.length < 2) return 0;
  const latest = samples[samples.length - 1];
  const previous = sampleAgo(samples, seconds);
  if (!previous || previous === latest || latest.btc == null || previous.btc == null) return 0;
  const dt = (latest.timeMs - previous.timeMs) / 1000;
  if (dt <= 0) return 0;
  return (latest.btc - previous.btc) / dt;
}

function createEventState(tick) {
  const eventStart = tick.event_start;
  const eventEnd = new Date(new Date(tick.event_start).getTime() + 300000);
  return {
    eventId: tick.condition_id,
    eventStart,
    eventEnd,
    priceToBeat: toFiniteNumber(tick.price_to_beat),
    lastTick: tick,
    samples: [],
    position: null,
    entryTime: null,
    entryDistanceToPtb: null,
    entryTimeRemaining: null,
    entryDiagnostics: null,
    entryAsk: null,
    entryProbability: null,
    consumedAsksBySide: { UP: new Map(), DOWN: new Map() },
    realizedPnl: 0,
    exits: [],
    reversals: [],
    orders: [],
    inverted: false,
    deteriorated: false,
    deteriorationAlert: false,
    reinforced: false,
    originalSide: null,
    inversionAsk: null,
    inversionQty: null,
    postInversionStopLoss: false,
    lastCandidate: null,
    lastModel: null,
  };
}

function addSample(state, tick, params) {
  const tickTime = new Date(tick.ts).getTime();
  state.samples.push({
    timeMs: tickTime,
    ts: tick.ts,
    btc: toFiniteNumber(tick.btc_price),
  });

  const maxAgeMs = params.historyWindowSec * 1000;
  while (state.samples.length > 1 && tickTime - state.samples[0].timeMs > maxAgeMs) {
    state.samples.shift();
  }
}

function estimateProbability(state, tick, params) {
  const samples = state.samples;
  const latest = samples[samples.length - 1];
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null || !latest) {
    return {
      pUp: 0.5,
      pDown: 0.5,
      sigma: params.minSigma,
      distanceZ: 0,
      momentumZ: 0,
      marketLag: 0,
      fastMove: 0,
      slowMove: 0,
      edgeUp: null,
      edgeDown: null,
    };
  }

  const timeRemainingSec = secondsRemaining(state, tick);
  const rawVol = recentAbsReturnVol(samples);
  const sigma = Math.max(
    params.minSigma,
    rawVol * Math.sqrt(Math.max(1, timeRemainingSec)) * params.sigmaMultiplier,
  );
  const distance = btcPrice - priceToBeat;
  const distanceZ = distance / sigma;
  const fastMove = movementPerSecond(samples, params.fastMomentumSec);
  const slowMove = movementPerSecond(samples, params.slowMomentumSec);
  const momentumZ = (fastMove + (params.slowMomentumWeight * slowMove)) / sigma;
  const zPre = (params.distanceWeight * distanceZ) + (params.momentumWeight * momentumZ);
  const pUpPre = logistic(zPre);
  const upAsk = sideFields(tick, 'UP').ask ?? 0.5;
  const downAsk = sideFields(tick, 'DOWN').ask ?? 0.5;
  const marketLag = btcPrice >= priceToBeat ? pUpPre - upAsk : (1 - pUpPre) - downAsk;
  const pUp = clamp(logistic(zPre + (params.lagWeight * marketLag)), 0.001, 0.999);
  const pDown = 1 - pUp;

  return {
    pUp,
    pDown,
    sigma,
    distanceZ,
    momentumZ,
    marketLag,
    fastMove,
    slowMove,
    edgeUp: upAsk != null ? pUp - upAsk : null,
    edgeDown: downAsk != null ? pDown - downAsk : null,
  };
}

function oddsAreValid(tick, params) {
  const upAsk = sideFields(tick, 'UP').ask;
  const downAsk = sideFields(tick, 'DOWN').ask;
  if (upAsk == null || downAsk == null) return false;
  const sum = upAsk + downAsk;
  return sum >= 1 - params.oddsSumTolerance && sum <= 1 + params.oddsSumTolerance;
}

function evaluateCandidate({ side, fields, probability, distanceAbs, params, walletBalance }) {
  const ask = fields.ask;
  const bid = fields.bid;
  if (ask == null) return { approved: false, reason: 'sem ask' };
  if (ask < params.minAsk) return { approved: false, reason: `ask ${ask.toFixed(2)} < minAsk ${params.minAsk}` };
  if (ask > params.maxAsk) return { approved: false, reason: `ask ${ask.toFixed(2)} > maxAsk ${params.maxAsk}` };

  const minProbability = params.dynamicEdgeEnabled
    ? params.minDirectionalProb
    : (ask >= params.askSemEdge ? params.minProbHighAsk : params.minDirectionalProb);
  if (probability < minProbability) {
    return { approved: false, reason: `prob ${probability.toFixed(2)} < min ${minProbability}` };
  }

  const edge = probability - ask;
  const requiredEdge = minEdgeForAsk(params, ask);
  if ((params.dynamicEdgeEnabled || ask < params.askSemEdge) && edge < requiredEdge) {
    return { approved: false, reason: `edge ${edge.toFixed(3)} < minEdge ${requiredEdge} (ask=${ask.toFixed(2)})` };
  }

  const spread = bid != null ? Math.max(0, ask - bid) : null;
  if (spread != null && spread > params.maxSpread) {
    return { approved: false, reason: `spread ${spread.toFixed(2)} > max ${params.maxSpread}` };
  }

  if (distanceAbs < params.minDistanceAbs) {
    return { approved: false, reason: `dist $${distanceAbs.toFixed(0)} < min $${params.minDistanceAbs}` };
  }

  const maxFill = Math.min(params.maxAsk, ask + params.entrySlippageMax);
  let quantity = 0;
  if (params.positionSizingMode === 'bankroll') {
    quantity = sharesForStake(bankrollStake(params, walletBalance), maxFill, params.minStake);
  } else if (params.entryShares > 0) {
    quantity = params.entryShares;
    const estimatedCost = quantity * maxFill;
    if (estimatedCost > params.maxOrderValue) {
      return { approved: false, reason: `custo estimado $${estimatedCost.toFixed(2)} > maxOrderValue $${params.maxOrderValue}` };
    }
  } else {
    quantity = Math.floor(params.maxOrderValue / Math.max(maxFill, 0.001));
  }
  if (quantity < params.minShares) return { approved: false, reason: 'quantidade calculada abaixo do mínimo' };

  return {
    approved: true,
    reason: 'ok',
    side,
    fields,
    ask,
    bid,
    probability,
    edge,
    spread,
    maxFill,
    quantity,
  };
}

function scoreCandidate(state, tick, params, walletBalance) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null) return null;
  if (!oddsAreValid(tick, params)) return null;

  const distanceAbs = Math.abs(btcPrice - priceToBeat);
  const model = estimateProbability(state, tick, params);
  state.lastModel = model;

  const alignedSide = btcPrice >= priceToBeat ? 'UP' : 'DOWN';
  if (params.allowedPositionSide !== 'BOTH' && params.allowedPositionSide !== alignedSide) return null;

  const fields = sideFields(tick, alignedSide);
  const probability = alignedSide === 'UP' ? model.pUp : model.pDown;
  const candidate = evaluateCandidate({ side: alignedSide, fields, probability, distanceAbs, params, walletBalance });
  state.lastCandidate = {
    side: alignedSide,
    ask: fields.ask,
    bid: fields.bid,
    probability,
    edge: fields.ask != null ? probability - fields.ask : null,
    spread: fields.ask != null && fields.bid != null ? fields.ask - fields.bid : null,
    distanceAbs,
    model,
    approved: candidate.approved,
    reason: candidate.reason,
  };

  return candidate.approved ? candidate : null;
}

function createPosition(side, fills) {
  const totalQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
  const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
  return {
    side,
    totalQty,
    remainingQty: totalQty,
    totalCost,
    openCost: totalCost,
    avgEntryPrice: totalQty > 0 ? totalCost / totalQty : 0,
    fills,
  };
}

function computeAdvancedMetrics(events, params, totalPnl, totalEntries, totalWins, totalLosses) {
  const enteredEvents = events.filter((item) => item.reason !== 'no_entry');
  const pnls = enteredEvents.map((item) => Number(item.finalPnl || 0));
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + Math.abs(value), 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgPnl = totalEntries > 0 ? totalPnl / totalEntries : 0;
  const pnlStd = std(pnls);
  const downsideStd = std(losses);
  const winProbability = totalEntries > 0 ? totalWins / totalEntries : 0;
  const lossProbability = totalEntries > 0 ? totalLosses / totalEntries : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Number.POSITIVE_INFINITY : 0);
  const edgePerTrade = (winProbability * avgWin) - (lossProbability * avgLoss);
  const riskUnits = avgLoss > 0 ? Math.max(1, Math.floor(params.walletSize / avgLoss)) : 99;
  const ruinBase = payoff > 0 && winProbability > 0 ? lossProbability / Math.max(0.000001, winProbability * payoff) : 1;

  return {
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    payoff,
    expectancy: avgPnl,
    sharpe: pnlStd > 0 ? avgPnl / pnlStd : 0,
    sortino: downsideStd > 0 ? avgPnl / downsideStd : 0,
    riskOfRuin: edgePerTrade > 0 ? clamp(Math.pow(clamp01(ruinBase), riskUnits), 0, 1) : 1,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeMomentumParams(rawParams);
  const log = [];
  const events = [];
  const equity = [];
  const completedEvents = new Set();

  let totalEvents = 0;
  let totalEntries = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalNoEntry = 0;
  let totalPnl = 0;
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;
  let current = null;

  const addLog = (ts, msg, type = 'info') => {
    log.push({ ts, msg, type });
  };

  const currentOpenAveragePrice = () => {
    if (!current?.position || current.position.remainingQty <= 0) return 0;
    return current.position.openCost / Math.max(0.000001, current.position.remainingQty);
  };

  const currentWalletBalance = () => params.walletSize + totalPnl + (current?.realizedPnl || 0);

  const executeSell = (tick, qty, rawPrice, reason, type = 'stop') => {
    if (!current?.position || current.position.remainingQty <= 0 || qty <= 0) return 0;
    const price = rawPrice != null && rawPrice > 0 ? rawPrice : params.fallbackExitBid;
    const sellQty = Math.min(qty, current.position.remainingQty);
    const avgOpenCost = currentOpenAveragePrice();
    const consumedCost = avgOpenCost * sellQty;
    const proceeds = sellQty * price;
    const pnl = proceeds - consumedCost;
    current.position.remainingQty -= sellQty;
    current.position.openCost = Math.max(0, current.position.openCost - consumedCost);
    current.realizedPnl += pnl;
    current.exits.push({ time: tick.ts, side: current.position.side, qty: sellQty, price, proceeds, pnl, reason });
    addLog(tick.ts, `${reason.toUpperCase()} | ${current.position.side} ${formatQty(sellQty)} @ ${formatPrice(price)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, type);
    return sellQty;
  };

  const executeBuy = (tick, side, requestedQty, maxFillPrice, source, model, distanceAbs, timeRemainingSec, consumedMap = null) => {
    const fields = sideFields(tick, side);
    if (fields.ask == null || fields.ask <= 0 || requestedQty <= 0) return null;

    const consumed = consumedMap || current.consumedAsksBySide[side];
    const availableQty = availableAskQty(fields.rawAsks, maxFillPrice, fields.ask);
    if (availableQty < requestedQty * params.minLiquidityRatio) return null;

    const fills = consumeAsksFromTick(fields.rawAsks, maxFillPrice, requestedQty, consumed, fields.ask);
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const cost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < Math.max(params.minShares, requestedQty * params.minLiquidityRatio) || cost <= 0) return null;

    const timedFills = fills.map((fill) => ({ ...fill, time: tick.ts }));
    return {
      side,
      source,
      requestedQty,
      filledQty,
      maxPrice: maxFillPrice,
      avgPrice: cost / filledQty,
      cost,
      createdAt: tick.ts,
      probability: side === 'UP' ? model.pUp : model.pDown,
      distanceAbs,
      timeRemainingSec,
      fills: timedFills,
    };
  };

  const addToPosition = (order) => {
    if (!current?.position || !order || order.filledQty <= 0) return;
    current.position.totalQty += order.filledQty;
    current.position.remainingQty += order.filledQty;
    current.position.totalCost += order.cost;
    current.position.openCost += order.cost;
    current.position.avgEntryPrice = current.position.totalCost / current.position.totalQty;
    current.position.fills.push(...order.fills.map((fill) => ({ ...fill })));
    current.orders.push({ ...order, fills: order.fills.map((fill) => ({ ...fill })) });
  };

  const pushNoEntryEvent = (closeTs) => {
    totalNoEntry++;
    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: null,
      entryTime: null,
      entryDistanceToPtb: null,
      entryTimeRemaining: null,
      quantity: 0,
      cost: 0,
      profitOrders: [],
      exits: [],
      reversals: [],
      expirationResult: null,
      winnerSide: null,
      finalPnl: 0,
      reason: 'no_entry',
      closedAt: closeTs,
      diagnostics: { lastCandidate: current.lastCandidate, lastModel: current.lastModel },
    });
    equity.push({ ts: closeTs, pnl: totalPnl });
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    const key = eventKey(current);
    completedEvents.add(key);
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();

    if (!current.position) {
      pushNoEntryEvent(ts);
      current = null;
      return;
    }

    let expiryPnl = 0;
    let winnerSide = null;
    let expirationResult = 'LOSS';

    if (current.position.remainingQty > 0) {
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      const btcPrice = toFiniteNumber(tick.btc_price);
      winnerSide = btcPrice != null && priceToBeat != null && btcPrice >= priceToBeat ? 'UP' : 'DOWN';
      const payout = current.position.side === winnerSide ? current.position.remainingQty : 0;
      expiryPnl = payout - current.position.openCost;
      current.position.remainingQty = 0;
      current.position.openCost = 0;
      current.realizedPnl += expiryPnl;
      expirationResult = current.position.side === winnerSide && !current.inverted ? 'WIN' : 'LOSS';
      addLog(ts, `EXPIRACAO | ${current.position.side} vs ${winnerSide} | PnL ${expiryPnl >= 0 ? '+' : ''}$${expiryPnl.toFixed(2)}`, expiryPnl >= 0 ? 'profit' : 'loss');
    }

    const finalPnl = current.realizedPnl;
    totalPnl += finalPnl;
    const isWin = !current.inverted && finalPnl > 0;
    if (isWin) totalWins++;
    else totalLosses++;

    const finalReason = current.deteriorated ? 'deterioration_inversion' : current.inverted ? 'cross_inversion' : reason;
    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: current.position.side,
      entryTime: current.entryTime,
      entryDistanceToPtb: current.entryDistanceToPtb,
      entryTimeRemaining: current.entryTimeRemaining,
      quantity: current.position.totalQty,
      cost: current.position.totalCost,
      avgEntryPrice: current.position.avgEntryPrice,
      fills: current.position.fills.map((fill) => ({ ...fill })),
      profitOrders: [],
      exits: current.exits.map((exit) => ({ ...exit })),
      reversals: current.reversals.map((reversal) => ({
        ...reversal,
        entryFills: reversal.entryFills.map((fill) => ({ ...fill })),
      })),
      expirationResult,
      winnerSide,
      expiryPnl,
      finalPnl,
      reason: finalReason,
      closedAt: ts,
      orders: current.orders.map((order) => ({ ...order, fills: order.fills.map((fill) => ({ ...fill })) })),
      diagnostics: {
        ...current.entryDiagnostics,
        inverted: current.inverted,
        deteriorated: current.deteriorated,
        reinforced: current.reinforced,
        postInversionStopLoss: current.postInversionStopLoss,
      },
    });

    equity.push({ ts, pnl: totalPnl });
    addLog(ts, `EVENTO FIN | Momentum ${current.position.side} | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`, finalPnl >= 0 ? 'profit' : 'loss');
    current = null;
  };

  const startEvent = (tick) => {
    current = createEventState(tick);
    totalEvents++;
    addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | ${params.strategyDisplayName}`, 'info');
  };

  const tryReversePosition = (tick, toSide, reason, model, distanceAbs, timeRemainingSec) => {
    if (!current?.position || current.position.remainingQty <= 0) return false;
    if (params.reversalShares <= 0 && params.inversionSharesMultiplier <= 0) return false;

    const reverseFields = sideFields(tick, toSide);
    if (reverseFields.ask == null || reverseFields.ask <= 0) return false;

    const fromSide = current.position.side;
    const fromQty = current.position.remainingQty;
    const fromOpenCost = current.position.openCost;
    let targetQty = 0;
    if (params.reversalShares > 0) {
      targetQty = params.reversalShares;
    } else {
      targetQty = fromQty * params.inversionSharesMultiplier;
    }

    const maxFillPrice = Math.min(0.999, reverseFields.ask + params.entrySlippageMax);
    if (params.positionSizingMode === 'bankroll') {
      targetQty = Math.max(
        targetQty,
        sharesForStake(bankrollStake(params, currentWalletBalance(), params.inversionSharesMultiplier), maxFillPrice, params.minStake),
      );
    }
    const availableQty = availableAskQty(reverseFields.rawAsks, maxFillPrice, reverseFields.ask);
    if (availableQty < targetQty * params.minLiquidityRatio) return false;

    const consumedClone = new Map(current.consumedAsksBySide[toSide]);
    const fills = consumeAsksFromTick(
      reverseFields.rawAsks,
      maxFillPrice,
      targetQty,
      consumedClone,
      reverseFields.ask,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const entryCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < Math.max(params.minShares, targetQty * params.minLiquidityRatio) || entryCost <= 0) return false;

    const exitFields = sideFields(tick, fromSide);
    const exitPrice = exitFields.bid != null && exitFields.bid > 0 ? exitFields.bid : params.fallbackExitBid;
    const soldQty = executeSell(tick, fromQty, exitPrice, reason, 'stop');
    if (soldQty <= 0) return false;

    const timedFills = fills.map((fill) => ({ ...fill, time: tick.ts }));
    current.consumedAsksBySide[toSide] = consumedClone;
    current.position = createPosition(toSide, timedFills);
    current.inverted = true;
    current.deteriorated = current.deteriorated || reason === 'deterioracao';
    current.inversionAsk = reverseFields.ask;
    current.inversionQty = filledQty;
    current.reversals.push({
      time: tick.ts,
      reason,
      fromSide,
      toSide,
      soldQty,
      exitPrice,
      exitProceeds: soldQty * exitPrice,
      fromOpenCost,
      adverseDistance: distanceAbs,
      timeRemainingSec,
      entryQty: filledQty,
      entryCost,
      avgEntryPrice: entryCost / filledQty,
      probability: toSide === 'UP' ? model.pUp : model.pDown,
      entryFills: timedFills,
    });
    current.orders.push({
      side: toSide,
      source: reason,
      requestedQty: targetQty,
      filledQty,
      maxPrice: maxFillPrice,
      avgPrice: entryCost / filledQty,
      cost: entryCost,
      createdAt: tick.ts,
      probability: toSide === 'UP' ? model.pUp : model.pDown,
      distanceAbs,
      timeRemainingSec,
      fills: timedFills.map((fill) => ({ ...fill })),
    });

    addLog(
      tick.ts,
      `${reason.toUpperCase()} | ${fromSide}->${toSide} | saiu ${formatQty(soldQty)} @ ${formatPrice(exitPrice)} | entrou ${formatQty(filledQty)} @ ${formatPrice(entryCost / filledQty)} | dist $${distanceAbs.toFixed(2)} | ${Math.round(timeRemainingSec)}s`,
      'stop',
    );
    return true;
  };

  const maybeProcessPosition = (tick) => {
    if (!current?.position) return false;
    const btcPrice = toFiniteNumber(tick.btc_price);
    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    if (btcPrice == null || priceToBeat == null || !oddsAreValid(tick, params)) return false;

    const distanceAbs = Math.abs(btcPrice - priceToBeat);
    const btcAbove = btcPrice >= priceToBeat;
    const timeRemainingSec = secondsRemaining(current, tick);
    const model = estimateProbability(current, tick, params);
    current.lastModel = model;

    const positionFields = sideFields(tick, current.position.side);
    const currentAsk = positionFields.ask;
    const currentProbability = current.position.side === 'UP' ? model.pUp : model.pDown;
    const oddDeteriorated = current.entryAsk != null && currentAsk != null && currentAsk <= current.entryAsk * params.deteriorationOddFactor;
    const probDeteriorated = current.entryProbability != null && currentProbability <= current.entryProbability * params.deteriorationProbFactor;
    const oppositeActive = (current.position.side === 'UP' && !btcAbove) || (current.position.side === 'DOWN' && btcAbove);

    if (current.inverted) {
      if (!params.postInversionStopLossEnabled || current.postInversionStopLoss || current.inversionAsk == null) return false;
      if (currentAsk == null || currentAsk > current.inversionAsk * params.postInversionStopLossFactor) return false;

      const invertedSide = current.position.side;
      const originalSide = current.originalSide || (invertedSide === 'UP' ? 'DOWN' : 'UP');
      const invertedQty = current.position.remainingQty;
      const exitFields = sideFields(tick, invertedSide);
      const exitPrice = exitFields.bid != null && exitFields.bid > 0 ? exitFields.bid : params.fallbackExitBid;
      const soldQty = executeSell(tick, invertedQty, exitPrice, 'stoploss_inversao', 'stop');
      if (soldQty <= 0) return false;

      const originalFields = sideFields(tick, originalSide);
      if (originalFields.ask == null || originalFields.ask <= 0) return false;
      const maxFillPrice = Math.min(0.999, originalFields.ask + params.entrySlippageMax);
      let targetQty = params.postInversionReentryShares > 0
        ? params.postInversionReentryShares
        : (current.inversionQty || soldQty) * params.postInversionReentryMultiplier;
      if (params.positionSizingMode === 'bankroll') {
        targetQty = Math.max(
          targetQty,
          sharesForStake(bankrollStake(params, currentWalletBalance(), params.postInversionReentryStakeMultiplier), maxFillPrice, params.minStake),
        );
      }

      const order = executeBuy(tick, originalSide, targetQty, maxFillPrice, 'reforco2', model, distanceAbs, timeRemainingSec);
      if (!order) return false;
      current.position = createPosition(originalSide, order.fills.map((fill) => ({ ...fill })));
      current.orders.push({ ...order, fills: order.fills.map((fill) => ({ ...fill })) });
      current.postInversionStopLoss = true;
      addLog(
        tick.ts,
        `STOPLOSS INVERSAO | ${invertedSide}->${originalSide} | saiu ${formatQty(soldQty)} @ ${formatPrice(exitPrice)} | entrou ${formatQty(order.filledQty)} @ ${formatPrice(order.avgPrice)} | odd ${currentAsk.toFixed(2)} <= ${(current.inversionAsk * params.postInversionStopLossFactor).toFixed(2)}`,
        'stop',
      );
      return true;
    }

    if (params.reinforcementEnabled && !current.reinforced && current.entryDistanceToPtb > 0 && distanceAbs >= current.entryDistanceToPtb * params.reinforcementDistanceFactor) {
      const maxFillPrice = Math.min(params.maxAsk, positionFields.ask + params.entrySlippageMax);
      let targetQty = params.reinforcementShares;
      if (targetQty <= 0) {
        targetQty = params.positionSizingMode === 'bankroll'
          ? sharesForStake(bankrollStake(params, currentWalletBalance(), params.reinforcementStakeMultiplier), maxFillPrice, params.minStake)
          : current.position.totalQty;
      }
      const order = executeBuy(tick, current.position.side, targetQty, maxFillPrice, 'reforco', model, distanceAbs, timeRemainingSec);
      if (order) {
        addToPosition(order);
        current.reinforced = true;
        addLog(
          tick.ts,
          `REFORCO | ${current.position.side} ${formatQty(order.filledQty)} @ ${formatPrice(order.avgPrice)} | dist $${current.entryDistanceToPtb.toFixed(2)} -> $${distanceAbs.toFixed(2)}`,
          'entry',
        );
        return true;
      }
    }

    if (params.deteriorationEnabled && oddDeteriorated && probDeteriorated) {
      const toSide = current.position.side === 'UP' ? 'DOWN' : 'UP';
      if (params.deteriorationRequiresCross) {
        current.deteriorationAlert = true;
      } else {
        current.deteriorated = true;
        if (tryReversePosition(tick, toSide, 'deterioracao', model, distanceAbs, timeRemainingSec)) return true;
        current.deteriorated = false;
      }
    }

    if (params.deteriorationRequiresCross && current.deteriorationAlert && oppositeActive) {
      const toSide = current.position.side === 'UP' ? 'DOWN' : 'UP';
      current.deteriorated = true;
      if (tryReversePosition(tick, toSide, 'deterioracao', model, distanceAbs, timeRemainingSec)) return true;
      current.deteriorated = false;
    }

    if (params.inversionEnabled && oppositeActive && distanceAbs >= params.inversionDistanceAbs) {
      const toSide = current.position.side === 'UP' ? 'DOWN' : 'UP';
      if (tryReversePosition(tick, toSide, 'inversao', model, distanceAbs, timeRemainingSec)) return true;
    }

    return false;
  };

  const maybeEnter = (tick) => {
    if (!current || current.position) return;
    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return;
    if (eventElapsedSec(current, tick) < params.warmupSec) return;

    const candidate = scoreCandidate(current, tick, params, currentWalletBalance());
    if (!candidate) return;

    const availableQty = availableAskQty(candidate.fields.rawAsks, candidate.maxFill, candidate.fields.ask);
    if (availableQty < candidate.quantity * params.minLiquidityRatio) return;

    const fills = consumeAsksFromTick(
      candidate.fields.rawAsks,
      candidate.maxFill,
      candidate.quantity,
      current.consumedAsksBySide[candidate.side],
      candidate.fields.ask,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < Math.max(params.minShares, candidate.quantity * params.minLiquidityRatio) || totalCost <= 0) return;

    const model = current.lastModel || estimateProbability(current, tick, params);
    totalEntries++;
    current.position = createPosition(candidate.side, fills.map((fill) => ({ ...fill, time: tick.ts })));
    current.entryTime = tick.ts;
    current.entryDistanceToPtb = Math.abs(toFiniteNumber(tick.btc_price) - toFiniteNumber(current.priceToBeat ?? tick.price_to_beat));
    current.entryTimeRemaining = timeRemainingSec;
    current.entryAsk = candidate.ask;
    current.entryProbability = candidate.probability;
    current.originalSide = candidate.side;
    current.entryDiagnostics = {
      probability: candidate.probability,
      edge: candidate.edge,
      ask: candidate.ask,
      bid: candidate.bid,
      spread: candidate.spread,
      distanceToPtb: current.entryDistanceToPtb,
      pUp: model.pUp,
      pDown: model.pDown,
      sigma: model.sigma,
      distanceZ: model.distanceZ,
      momentumZ: model.momentumZ,
      marketLag: model.marketLag,
      fastMove: model.fastMove,
      slowMove: model.slowMove,
    };
    current.orders.push({
      side: candidate.side,
      source: 'entrada',
      requestedQty: candidate.quantity,
      filledQty,
      maxPrice: candidate.maxFill,
      avgPrice: totalCost / filledQty,
      cost: totalCost,
      createdAt: tick.ts,
      probability: candidate.probability,
      edge: candidate.edge,
      distanceAbs: current.entryDistanceToPtb,
      timeRemainingSec,
      fills: fills.map((fill) => ({ ...fill, time: tick.ts })),
    });

    addLog(
      tick.ts,
      `ENTRADA MOMENTUM | ${candidate.side} ${formatQty(filledQty)} @ ${formatPrice(totalCost / filledQty)} | prob ${(candidate.probability * 100).toFixed(1)}% | edge ${(candidate.edge * 100).toFixed(1)}pp | dist $${current.entryDistanceToPtb.toFixed(2)} | ${Math.round(timeRemainingSec)}s`,
      'entry',
    );
  };

  const processTick = (tick) => {
    ticksProcessed++;
    if (!periodStart) periodStart = tick.ts;
    periodEnd = tick.ts;

    const key = eventKey(tick);
    if (!current && completedEvents.has(key)) return;

    if (!current || tick.condition_id !== current.eventId) {
      if (current) finalizeCurrentEvent('expired', current.eventEnd.toISOString());
      if (completedEvents.has(key)) return;
      startEvent(tick);
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);

    const tickTime = new Date(tick.ts);
    if (tickTime < new Date(current.eventStart)) return;

    addSample(current, tick, params);

    if (tickTime >= current.eventEnd) {
      finalizeCurrentEvent('expired', current.eventEnd.toISOString());
      return;
    }

    if (maybeProcessPosition(tick)) return;
    maybeEnter(tick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd.toISOString());
    const enteredEvents = events.filter((item) => item.reason !== 'no_entry');
    const winRate = totalEntries > 0 ? totalWins / totalEntries * 100 : 0;
    const avgPnl = totalEntries > 0 ? totalPnl / totalEntries : 0;
    const maxWin = enteredEvents.length ? Math.max(...enteredEvents.map((item) => item.finalPnl)) : 0;
    const maxLoss = enteredEvents.length ? Math.min(...enteredEvents.map((item) => item.finalPnl)) : 0;

    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equity) {
      if (point.pnl > peak) peak = point.pnl;
      const drawdown = peak - point.pnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const advanced = computeAdvancedMetrics(events, params, totalPnl, totalEntries, totalWins, totalLosses);
    return {
      params,
      strategy: params.strategyName,
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins,
        totalLosses,
        winRate: parseFloat(winRate.toFixed(1)),
        totalPnl,
        avgPnl,
        maxWin,
        maxLoss,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
        ...advanced,
      },
      equity,
      events,
      log,
      ticksProcessed,
      periodStart,
      periodEnd,
    };
  };

  return { processTick, finish };
}

function runMomentumBacktest(rawParams, ticks) {
  const runner = createMomentumBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runMomentumBacktestInBatches(rawParams, tickBatches) {
  const runner = createMomentumBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
