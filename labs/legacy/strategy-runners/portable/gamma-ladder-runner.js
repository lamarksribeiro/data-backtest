const DEFAULT_STOP_REVERSE_PARAMS = {
  stopReverseEnabled: false,
  stopReverseMaxAttempts: 1,
  stopReverseMaxSecondsRemaining: 60,
  stopReverseMinSecondsRemaining: 2,
  stopReverseMinDistanceAbs: 10,
  stopReverseDistanceSchedule: null,
  stopReverseMaxAsk: 0.98,
  stopReverseSlippageMax: 0.02,
  stopReverseMinLiquidityRatio: 0.50,
  stopReverseMinBid: 0.001,
  stopReverseBudgetMode: 'same-cost',
  stopReverseBudgetFactor: 1,
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

function normalizeBudgetMode(value, fallback) {
  const mode = String(value || fallback || '').toLowerCase();
  return ['same-cost', 'open-cost', 'sale-proceeds', 'max-order'].includes(mode) ? mode : DEFAULT_STOP_REVERSE_PARAMS.stopReverseBudgetMode;
}

function normalizeDistanceSchedule(value) {
  let rawSchedule = value;
  if (typeof rawSchedule === 'string') {
    try {
      rawSchedule = JSON.parse(rawSchedule);
    } catch {
      rawSchedule = null;
    }
  }
  if (!Array.isArray(rawSchedule)) return null;

  const schedule = rawSchedule
    .map((item) => {
      const minSecondsRemaining = toFiniteNumber(
        item?.minSecondsRemaining ?? item?.minSec ?? item?.secondsRemaining ?? item?.seconds,
      );
      const minDistanceAbs = toFiniteNumber(
        item?.minDistanceAbs ?? item?.distanceAbs ?? item?.distance ?? item?.dist,
      );
      if (minSecondsRemaining == null || minDistanceAbs == null) return null;
      return {
        minSecondsRemaining: clamp(minSecondsRemaining, 0, 300),
        minDistanceAbs: Math.max(0, minDistanceAbs),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.minSecondsRemaining - left.minSecondsRemaining);

  return schedule.length ? schedule : null;
}

function resolveStopReverseMinDistance(params, timeRemainingSec) {
  if (Array.isArray(params.stopReverseDistanceSchedule) && params.stopReverseDistanceSchedule.length) {
    const bucket = params.stopReverseDistanceSchedule.find((item) => timeRemainingSec >= item.minSecondsRemaining);
    if (bucket) return bucket.minDistanceAbs;
  }
  return params.stopReverseMinDistanceAbs;
}

function mergeStopReverseParams(raw = {}, defaults = {}) {
  const params = { ...DEFAULT_STOP_REVERSE_PARAMS, ...defaults };
  const numericKeys = [
    'stopReverseMaxAttempts',
    'stopReverseMaxSecondsRemaining',
    'stopReverseMinSecondsRemaining',
    'stopReverseMinDistanceAbs',
    'stopReverseMaxAsk',
    'stopReverseSlippageMax',
    'stopReverseMinLiquidityRatio',
    'stopReverseMinBid',
    'stopReverseBudgetFactor',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.stopReverseEnabled = toBool(raw.stopReverseEnabled, params.stopReverseEnabled);
  params.stopReverseMaxAttempts = Math.max(0, Math.floor(params.stopReverseMaxAttempts));
  params.stopReverseMaxSecondsRemaining = clamp(params.stopReverseMaxSecondsRemaining, 0, 300);
  params.stopReverseMinSecondsRemaining = clamp(params.stopReverseMinSecondsRemaining, 0, params.stopReverseMaxSecondsRemaining);
  params.stopReverseMinDistanceAbs = Math.max(0, params.stopReverseMinDistanceAbs);
  params.stopReverseMaxAsk = clamp(params.stopReverseMaxAsk, 0.001, 0.999);
  params.stopReverseSlippageMax = clamp(params.stopReverseSlippageMax, 0, 0.99);
  params.stopReverseMinLiquidityRatio = clamp(params.stopReverseMinLiquidityRatio, 0.01, 1);
  params.stopReverseMinBid = clamp(params.stopReverseMinBid, 0.001, 0.999);
  params.stopReverseBudgetMode = normalizeBudgetMode(raw.stopReverseBudgetMode, params.stopReverseBudgetMode);
  params.stopReverseBudgetFactor = Math.max(0, params.stopReverseBudgetFactor);
  params.stopReverseDistanceSchedule = normalizeDistanceSchedule(
    raw.stopReverseDistanceSchedule ?? params.stopReverseDistanceSchedule,
  );
  return params;
}

function applyStopReverseParams(params, raw = {}, defaults = {}) {
  Object.assign(params, mergeStopReverseParams(raw, defaults));
  return params;
}

function stopReverseTrigger({ tick, priceToBeat, positionSide, timeRemainingSec, attempts = 0, params }) {
  if (!params.stopReverseEnabled || attempts >= params.stopReverseMaxAttempts) return null;
  if (timeRemainingSec > params.stopReverseMaxSecondsRemaining || timeRemainingSec < params.stopReverseMinSecondsRemaining) return null;

  const btcPrice = toFiniteNumber(tick?.btc_price ?? tick?.currentBtcPrice);
  const ptb = toFiniteNumber(priceToBeat ?? tick?.price_to_beat ?? tick?.priceToBeat);
  if (btcPrice == null || ptb == null) return null;

  const adverseDistance = positionSide === 'UP' ? ptb - btcPrice : btcPrice - ptb;
  const minDistanceAbs = resolveStopReverseMinDistance(params, timeRemainingSec);
  if (adverseDistance < minDistanceAbs) return null;

  return {
    fromSide: positionSide,
    toSide: positionSide === 'UP' ? 'DOWN' : 'UP',
    btcPrice,
    priceToBeat: ptb,
    adverseDistance,
    minDistanceAbs,
    timeRemainingSec,
  };
}

function stopReverseBudget({ params, maxOrderValue, equityNow, totalCost = 0, openCost = 0, proceeds = 0 }) {
  const cappedMaxOrder = Math.max(0, toFiniteNumber(maxOrderValue, 0));
  const availableEquity = Math.max(0, toFiniteNumber(equityNow, cappedMaxOrder));
  let rawBudget = 0;

  if (params.stopReverseBudgetMode === 'sale-proceeds') rawBudget = proceeds;
  else if (params.stopReverseBudgetMode === 'open-cost') rawBudget = openCost;
  else if (params.stopReverseBudgetMode === 'max-order') rawBudget = cappedMaxOrder;
  else rawBudget = totalCost || openCost;

  return Math.min(cappedMaxOrder, availableEquity, Math.max(0, rawBudget * params.stopReverseBudgetFactor));
}


const DEFAULT_PARAMS = {
  walletSize: 100,
  entryWindowStart: 105,
  entryWindowEnd: 4,
  maxEventExposure: 35,
  maxEntryValue: 7,
  minShares: 5,
  maxEntriesPerEvent: 6,
  cooldownSec: 7,
  minAsk: 0.04,
  maxAsk: 0.66,
  minEdge: 0.07,
  minDirectionalProb: 0.56,
  minDistanceAbs: 40,
  minSigma: 8,
  sigmaMultiplier: 1,
  modelWeight: 0.72,
  driftWeight: 0.38,
  driftClampSigma: 0.85,
  momentumSec: 8,
  slowMomentumSec: 28,
  slowMomentumWeight: 0.28,
  volLookbackSec: 55,
  maxSpread: 0.10,
  maxOddsSum: 1.18,
  minOddsSum: 0.82,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.70,
  fallbackBookSize: 0,
  kellyFraction: 0.18,
  maxKellyPct: 0.16,
  boxEnabled: true,
  boxMaxSumAsk: 0.985,
  boxMinProfit: 0.012,
  boxMaxPairValue: 12,
  hedgeEnabled: true,
  hedgeMinLockedProfit: 0.05,
  hedgeMaxAsk: 0.58,
  takeProfitBid: 0.88,
  takeProfitPct: 0.40,
  trailAfterBid: 0.74,
  trailDrop: 0.14,
  stopBid: 0.12,
  edgeExitBelow: -0.04,
  lateExitSec: 8,
  lateExitMinBid: 0.62,
  minTicksBeforeEntry: 8,
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

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + (p * x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function mergeGammaLadderParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS };
  const numericKeys = [
    'walletSize', 'entryWindowStart', 'entryWindowEnd', 'maxEventExposure',
    'maxEntryValue', 'minShares', 'maxEntriesPerEvent', 'cooldownSec', 'minAsk',
    'maxAsk', 'minEdge', 'minDirectionalProb', 'minDistanceAbs', 'minSigma',
    'sigmaMultiplier', 'modelWeight', 'driftWeight', 'driftClampSigma',
    'momentumSec', 'slowMomentumSec', 'slowMomentumWeight', 'volLookbackSec',
    'maxSpread', 'maxOddsSum', 'minOddsSum', 'entrySlippageMax',
    'minLiquidityRatio', 'fallbackBookSize', 'kellyFraction', 'maxKellyPct',
    'boxMaxSumAsk', 'boxMinProfit', 'boxMaxPairValue', 'hedgeMinLockedProfit',
    'hedgeMaxAsk', 'takeProfitBid', 'takeProfitPct', 'trailAfterBid',
    'trailDrop', 'stopBid', 'edgeExitBelow', 'lateExitSec', 'lateExitMinBid',
    'minTicksBeforeEntry',
  ];

  for (const key of numericKeys) {
    if (raw[key] == null) continue;
    const value = toFiniteNumber(raw[key]);
    if (value != null) params[key] = value;
  }

  params.walletSize = Math.max(1, params.walletSize);
  params.entryWindowStart = clamp(params.entryWindowStart, 0, 300);
  params.entryWindowEnd = clamp(params.entryWindowEnd, 0, 300);
  if (params.entryWindowStart < params.entryWindowEnd) {
    [params.entryWindowStart, params.entryWindowEnd] = [params.entryWindowEnd, params.entryWindowStart];
  }
  params.maxEventExposure = Math.max(0.01, params.maxEventExposure);
  params.maxEntryValue = Math.max(0.01, params.maxEntryValue);
  params.minShares = Math.max(0.000001, params.minShares);
  params.maxEntriesPerEvent = Math.max(1, Math.floor(params.maxEntriesPerEvent));
  params.cooldownSec = Math.max(0, params.cooldownSec);
  params.minAsk = normalizePrice(params.minAsk, DEFAULT_PARAMS.minAsk);
  params.maxAsk = normalizePrice(params.maxAsk, DEFAULT_PARAMS.maxAsk);
  if (params.maxAsk < params.minAsk) [params.maxAsk, params.minAsk] = [params.minAsk, params.maxAsk];
  params.minEdge = clamp(params.minEdge, -0.25, 0.50);
  params.minDirectionalProb = clamp(params.minDirectionalProb, 0.01, 0.99);
  params.minDistanceAbs = Math.max(0, params.minDistanceAbs);
  params.minSigma = Math.max(0.01, params.minSigma);
  params.sigmaMultiplier = clamp(params.sigmaMultiplier, 0.10, 5);
  params.modelWeight = clamp(params.modelWeight, 0, 1);
  params.driftWeight = clamp(params.driftWeight, -3, 3);
  params.driftClampSigma = clamp(params.driftClampSigma, 0, 4);
  params.momentumSec = clamp(params.momentumSec, 1, 90);
  params.slowMomentumSec = clamp(params.slowMomentumSec, params.momentumSec, 150);
  params.slowMomentumWeight = clamp(params.slowMomentumWeight, -3, 3);
  params.volLookbackSec = clamp(params.volLookbackSec, 5, 180);
  params.maxSpread = clamp(params.maxSpread, 0.001, 0.99);
  params.maxOddsSum = clamp(params.maxOddsSum, 0.01, 2);
  params.minOddsSum = clamp(params.minOddsSum, 0.01, 2);
  if (params.maxOddsSum < params.minOddsSum) [params.maxOddsSum, params.minOddsSum] = [params.minOddsSum, params.maxOddsSum];
  params.entrySlippageMax = clamp(params.entrySlippageMax, 0, 0.50);
  params.minLiquidityRatio = clamp(params.minLiquidityRatio, 0.01, 1);
  params.fallbackBookSize = Math.max(0, params.fallbackBookSize);
  params.kellyFraction = clamp(params.kellyFraction, 0, 1);
  params.maxKellyPct = clamp(params.maxKellyPct, 0.001, 1);
  params.boxEnabled = toBool(raw.boxEnabled, params.boxEnabled);
  params.boxMaxSumAsk = clamp(params.boxMaxSumAsk, 0.01, 1.99);
  params.boxMinProfit = Math.max(0, params.boxMinProfit);
  params.boxMaxPairValue = Math.max(0.01, params.boxMaxPairValue);
  params.hedgeEnabled = toBool(raw.hedgeEnabled, params.hedgeEnabled);
  params.hedgeMinLockedProfit = Math.max(0, params.hedgeMinLockedProfit);
  params.hedgeMaxAsk = normalizePrice(params.hedgeMaxAsk, DEFAULT_PARAMS.hedgeMaxAsk);
  params.takeProfitBid = normalizePrice(params.takeProfitBid, DEFAULT_PARAMS.takeProfitBid);
  params.takeProfitPct = clamp(params.takeProfitPct, 0, 1);
  params.trailAfterBid = normalizePrice(params.trailAfterBid, DEFAULT_PARAMS.trailAfterBid);
  params.trailDrop = clamp(params.trailDrop, 0.001, 0.99);
  params.stopBid = normalizePrice(params.stopBid, DEFAULT_PARAMS.stopBid);
  params.edgeExitBelow = clamp(params.edgeExitBelow, -0.99, 0.99);
  params.lateExitSec = clamp(params.lateExitSec, 0, 120);
  params.lateExitMinBid = normalizePrice(params.lateExitMinBid, DEFAULT_PARAMS.lateExitMinBid);
  params.minTicksBeforeEntry = Math.max(1, Math.floor(params.minTicksBeforeEntry));
  applyStopReverseParams(params, raw, { stopReverseBudgetMode: 'open-cost' });
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
    .map((level) => ({
      price: toFiniteNumber(level?.price),
      size: toFiniteNumber(level?.size),
    }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }))
    .sort((left, right) => left.price - right.price);
}

function withFallbackAsk(levels, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  if (levels.length) return levels;
  const fallback = toFiniteNumber(fallbackBestAsk);
  if (fallback == null || fallback <= 0 || fallbackBookSize <= 0) return [];
  return [{ price: fallback, size: fallbackBookSize, key: `fallback:${fallback}:${fallbackKeySuffix}` }];
}

function pruneConsumedByVisibleLevels(levels, consumedByPrice) {
  const visiblePriceKeys = new Set(levels.map((level) => level.key));
  for (const key of Array.from(consumedByPrice.keys())) {
    if (!visiblePriceKeys.has(key)) consumedByPrice.delete(key);
  }
}

function availableAskQty(rawAsks, maxPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
  return levels.reduce((sum, level) => sum + (level.price <= maxPrice ? level.size : 0), 0);
}

function consumeAsksFromTick(rawAsks, maxPrice, requestedQty, consumedByPrice, fallbackBestAsk, fallbackBookSize, fallbackKeySuffix) {
  const levels = withFallbackAsk(parseBookLevels(rawAsks), fallbackBestAsk, fallbackBookSize, fallbackKeySuffix);
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
    if (fillQty <= 0) continue;

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

function sideMid(fields) {
  if (fields.ask != null && fields.bid != null) return (fields.ask + fields.bid) / 2;
  return fields.ask ?? fields.bid ?? fields.price ?? null;
}

function oppositeSide(side) {
  return side === 'UP' ? 'DOWN' : 'UP';
}

function marketProbUp(tick) {
  const upMid = sideMid(sideFields(tick, 'UP'));
  const downMid = sideMid(sideFields(tick, 'DOWN'));
  if (upMid == null || downMid == null || upMid + downMid <= 0) return 0.5;
  return clamp(upMid / (upMid + downMid), 0.001, 0.999);
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
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index].timeMs <= targetMs) return samples[index];
  }
  return samples[0];
}

function recentVol(samples, lookbackSec) {
  if (samples.length < 3) return 0;
  const latest = samples[samples.length - 1];
  const recent = samples.filter((sample) => latest.timeMs - sample.timeMs <= lookbackSec * 1000 && sample.btc != null);
  const normalizedChanges = [];
  for (let index = 1; index < recent.length; index++) {
    const dtSec = Math.max(0.25, (recent[index].timeMs - recent[index - 1].timeMs) / 1000);
    normalizedChanges.push((recent[index].btc - recent[index - 1].btc) / Math.sqrt(dtSec));
  }
  return std(normalizedChanges);
}

function formatPrice(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatQty(value) {
  const numberValue = Number(value || 0);
  return Number.isInteger(numberValue) ? String(numberValue) : numberValue.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function createSideInventory(side) {
  return {
    side,
    totalQty: 0,
    remainingQty: 0,
    totalCost: 0,
    openCost: 0,
    fills: [],
    maxBid: 0,
    tookProfit: false,
  };
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
    inventory: {
      UP: createSideInventory('UP'),
      DOWN: createSideInventory('DOWN'),
    },
    consumedAsksBySide: { UP: new Map(), DOWN: new Map() },
    realizedPnl: 0,
    entries: [],
    exits: [],
    orders: [],
    boxes: [],
    hedges: [],
    partials: [],
    lastEntryMs: 0,
    lastBoxEntryMs: 0,
    directionalEntries: 0,
    boxEntries: 0,
    totalOpenCost: 0,
    stopReverseCount: 0,
    reversals: [],
    lastDiagnostics: null,
  };
}

function addSample(state, tick) {
  const tickTime = new Date(tick.ts).getTime();
  state.samples.push({
    timeMs: tickTime,
    ts: tick.ts,
    btc: toFiniteNumber(tick.btc_price),
  });

  while (state.samples.length > 1 && tickTime - state.samples[0].timeMs > 180000) {
    state.samples.shift();
  }
}

function modelProbUp(state, tick, params) {
  const samples = state.samples;
  const latest = samples[samples.length - 1];
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null || !latest) return 0.5;

  const timeRemainingSec = Math.max(1, secondsRemaining(state, tick));
  const fastSample = sampleAgo(samples, params.momentumSec) || latest;
  const slowSample = sampleAgo(samples, params.slowMomentumSec) || fastSample;
  const fastSec = Math.max(1, (latest.timeMs - fastSample.timeMs) / 1000);
  const slowSec = Math.max(fastSec, (latest.timeMs - slowSample.timeMs) / 1000);
  const fastMove = btcPrice - (fastSample?.btc ?? btcPrice);
  const slowMove = btcPrice - (slowSample?.btc ?? btcPrice);
  const fastDrift = fastMove / fastSec;
  const slowDrift = slowMove / slowSec;
  const drift = fastDrift + (params.slowMomentumWeight * slowDrift);
  const sigma = Math.max(params.minSigma, recentVol(samples, params.volLookbackSec) * Math.sqrt(timeRemainingSec) * params.sigmaMultiplier);
  const driftContribution = clamp(drift * timeRemainingSec * params.driftWeight, -sigma * params.driftClampSigma, sigma * params.driftClampSigma);
  const distance = btcPrice - priceToBeat;
  const pStat = normalCdf((distance + driftContribution) / sigma);
  const pMarket = marketProbUp(tick);
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  const askSum = (upFields.ask ?? 0.5) + (downFields.ask ?? 0.5);
  const oddsPenalty = askSum > params.maxOddsSum || askSum < params.minOddsSum ? 0.12 : 0;
  const blended = (params.modelWeight * pStat) + ((1 - params.modelWeight) * pMarket);
  const towardMarket = blended > pMarket ? blended - oddsPenalty : blended + oddsPenalty;
  return clamp(towardMarket, 0.001, 0.999);
}

function scoreDirectionalCandidates(state, tick, params) {
  const btcPrice = toFiniteNumber(tick.btc_price);
  const priceToBeat = toFiniteNumber(state.priceToBeat ?? tick.price_to_beat);
  if (btcPrice == null || priceToBeat == null) return [];
  if (Math.abs(btcPrice - priceToBeat) < params.minDistanceAbs) return [];

  const pUp = modelProbUp(state, tick, params);
  const upFields = sideFields(tick, 'UP');
  const downFields = sideFields(tick, 'DOWN');
  const askSum = (upFields.ask ?? 0.5) + (downFields.ask ?? 0.5);
  if (askSum > params.maxOddsSum || askSum < params.minOddsSum) return [];

  return ['UP', 'DOWN']
    .map((side) => {
      const fields = side === 'UP' ? upFields : downFields;
      const ask = fields.ask;
      const bid = fields.bid;
      const probability = side === 'UP' ? pUp : 1 - pUp;
      const spread = ask != null && bid != null ? Math.max(0, ask - bid) : Number.POSITIVE_INFINITY;
      const edge = ask != null ? probability - ask : Number.NEGATIVE_INFINITY;
      return { side, fields, ask, bid, probability, edge, spread, askSum };
    })
    .filter((candidate) => candidate.ask != null
      && candidate.ask >= params.minAsk
      && candidate.ask <= params.maxAsk
      && candidate.probability >= params.minDirectionalProb
      && candidate.edge >= params.minEdge
      && candidate.spread <= params.maxSpread)
    .sort((left, right) => right.edge - left.edge);
}

function averageOpenPrice(sideInventory) {
  if (!sideInventory || sideInventory.remainingQty <= 0) return 0;
  return sideInventory.openCost / Math.max(0.000001, sideInventory.remainingQty);
}

function addInventoryFills(sideInventory, fills) {
  for (const fill of fills) {
    const cost = fill.qty * fill.price;
    sideInventory.totalQty += fill.qty;
    sideInventory.remainingQty += fill.qty;
    sideInventory.totalCost += cost;
    sideInventory.openCost += cost;
    sideInventory.fills.push(fill);
  }
}

function computeAdvancedMetrics(events, totalPnl, totalEntries, totalWins, totalLosses) {
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

  return {
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    payoff,
    expectancy: avgPnl,
    sharpe: pnlStd > 0 ? avgPnl / pnlStd : 0,
    sortino: downsideStd > 0 ? avgPnl / downsideStd : 0,
    edgePerEntry: edgePerTrade,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeGammaLadderParams(rawParams);
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
  let totalDirectionalEntries = 0;
  let totalBoxEntries = 0;
  let totalHedges = 0;
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;
  let current = null;

  const addLog = (ts, msg, type = 'info') => {
    log.push({ ts, msg, type });
  };

  const openCost = () => {
    if (!current) return 0;
    return current.inventory.UP.openCost + current.inventory.DOWN.openCost;
  };

  const canAddExposure = (cost) => openCost() + cost <= params.maxEventExposure + 0.000001;

  const sellSide = (tick, side, qty, price, reason, type = 'profit') => {
    const sideInventory = current?.inventory?.[side];
    if (!sideInventory || sideInventory.remainingQty <= 0 || qty <= 0 || price == null || price <= 0) return 0;
    const sellQty = Math.min(qty, sideInventory.remainingQty);
    const avgOpenCost = averageOpenPrice(sideInventory);
    const consumedCost = avgOpenCost * sellQty;
    const pnl = (price - avgOpenCost) * sellQty;
    sideInventory.remainingQty -= sellQty;
    sideInventory.openCost = Math.max(0, sideInventory.openCost - consumedCost);
    current.realizedPnl += pnl;
    current.exits.push({ time: tick.ts, side, qty: sellQty, price, pnl, reason });
    addLog(tick.ts, `${reason.toUpperCase()} | ${side} ${formatQty(sellQty)} @ ${formatPrice(price)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, type);
    return sellQty;
  };

  const pushNoEntryEvent = (closeTs) => {
    totalNoEntry++;
    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: null,
      quantity: 0,
      cost: 0,
      avgEntryPrice: 0,
      entries: [],
      fills: [],
      exits: [],
      boxes: [],
      hedges: [],
      expirationResult: null,
      finalPnl: 0,
      reason: 'no_entry',
      closedAt: closeTs,
      diagnostics: current.lastDiagnostics,
    });
    equity.push({ ts: closeTs, pnl: totalPnl });
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    const key = eventKey(current);
    completedEvents.add(key);
    const tick = current.lastTick;
    const ts = closeTs || current.eventEnd.toISOString();
    const upInventory = current.inventory.UP;
    const downInventory = current.inventory.DOWN;
    const hasPosition = upInventory.remainingQty > 0 || downInventory.remainingQty > 0 || current.entries.length > 0;

    if (!hasPosition) {
      pushNoEntryEvent(ts);
      current = null;
      return;
    }

    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    const winnerSide = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat ? 'UP' : 'DOWN';
    let expiryPnl = 0;
    for (const side of ['UP', 'DOWN']) {
      const sideInventory = current.inventory[side];
      if (sideInventory.remainingQty <= 0) continue;
      const payout = side === winnerSide ? sideInventory.remainingQty : 0;
      const sidePnl = payout - sideInventory.openCost;
      expiryPnl += sidePnl;
      sideInventory.remainingQty = 0;
      sideInventory.openCost = 0;
    }
    current.realizedPnl += expiryPnl;

    const finalPnl = current.realizedPnl;
    totalPnl += finalPnl;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    const allFills = [...upInventory.fills, ...downInventory.fills].sort((left, right) => new Date(left.time) - new Date(right.time));
    const totalQty = upInventory.totalQty + downInventory.totalQty;
    const totalCost = upInventory.totalCost + downInventory.totalCost;
    const dominantSide = upInventory.totalCost >= downInventory.totalCost ? 'UP' : 'DOWN';

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd.toISOString(),
      positionType: upInventory.totalQty > 0 && downInventory.totalQty > 0 ? 'BOTH' : dominantSide,
      entryTime: current.entries[0]?.time ?? null,
      entryDistanceToPtb: current.entries[0]?.distanceToPtb ?? null,
      entryTimeRemaining: current.entries[0]?.timeRemainingSec ?? null,
      quantity: totalQty,
      cost: totalCost,
      avgEntryPrice: totalQty > 0 ? totalCost / totalQty : 0,
      fills: allFills.map((fill) => ({ ...fill })),
      entries: current.entries.map((entry) => ({ ...entry })),
      profitOrders: current.partials.map((partial) => ({ ...partial })),
      exits: current.exits.map((exit) => ({ ...exit })),
      reversals: current.reversals.map((reversal) => ({ ...reversal, entryFills: reversal.entryFills.map((fill) => ({ ...fill })) })),
      boxes: current.boxes.map((box) => ({ ...box })),
      hedges: current.hedges.map((hedge) => ({ ...hedge })),
      expirationResult: finalPnl >= 0 ? 'WIN' : 'LOSS',
      winnerSide,
      expiryPnl,
      finalPnl,
      reason,
      closedAt: ts,
      orders: current.orders.map((order) => ({ ...order, fills: order.fills.map((fill) => ({ ...fill })) })),
      diagnostics: current.lastDiagnostics,
      inventory: {
        UP: { totalQty: upInventory.totalQty, totalCost: upInventory.totalCost },
        DOWN: { totalQty: downInventory.totalQty, totalCost: downInventory.totalCost },
      },
    });

    equity.push({ ts, pnl: totalPnl });
    addLog(ts, `EVENTO FIN | Gamma Ladder | ${winnerSide} venceu | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | carteira $${(params.walletSize + totalPnl).toFixed(2)}`, finalPnl >= 0 ? 'profit' : 'loss');
    current = null;
  };

  const startEvent = (tick) => {
    current = createEventState(tick);
    totalEvents++;
    addLog(tick.ts, `Evento: ${new Date(tick.event_start).toISOString().slice(11, 19)} | Gamma Ladder V1`, 'info');
  };

  const executeBuy = (tick, side, requestedQty, maxFillPrice, source, diagnostics = {}) => {
    const fields = sideFields(tick, side);
    const fills = consumeAsksFromTick(
      fields.rawAsks,
      maxFillPrice,
      requestedQty,
      current.consumedAsksBySide[side],
      fields.ask,
      params.fallbackBookSize,
      `${tick.ts}:${source}:${side}`,
    );
    const filledQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const totalCost = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    if (filledQty < params.minShares || totalCost <= 0 || !canAddExposure(totalCost)) return null;

    const timedFills = fills.map((fill) => ({ ...fill, side, time: tick.ts, source }));
    addInventoryFills(current.inventory[side], timedFills);
    current.totalOpenCost += totalCost;
    current.orders.push({
      side,
      source,
      requestedQty,
      filledQty,
      maxPrice: maxFillPrice,
      avgPrice: totalCost / filledQty,
      cost: totalCost,
      createdAt: tick.ts,
      fills: timedFills.map((fill) => ({ ...fill })),
      ...diagnostics,
    });
    return { side, filledQty, totalCost, avgPrice: totalCost / filledQty, fills: timedFills };
  };

  const attemptBoxEntry = (tick) => {
    if (!params.boxEnabled || current.boxEntries >= params.maxEntriesPerEvent) return false;
    const timeMs = new Date(tick.ts).getTime();
    if (current.lastBoxEntryMs && timeMs - current.lastBoxEntryMs < params.cooldownSec * 1000) return false;

    const upFields = sideFields(tick, 'UP');
    const downFields = sideFields(tick, 'DOWN');
    if (upFields.ask == null || downFields.ask == null) return false;
    const pairAsk = upFields.ask + downFields.ask;
    const lockedProfitPerPair = 1 - pairAsk;
    if (pairAsk > params.boxMaxSumAsk || lockedProfitPerPair < params.boxMinProfit) return false;
    if (upFields.ask - (upFields.bid ?? upFields.ask) > params.maxSpread) return false;
    if (downFields.ask - (downFields.bid ?? downFields.ask) > params.maxSpread) return false;

    const maxPairPrice = pairAsk + (2 * params.entrySlippageMax);
    const equityNow = Math.max(0, params.walletSize + totalPnl);
    const targetValue = Math.min(params.boxMaxPairValue, params.maxEntryValue, equityNow * params.maxKellyPct, params.maxEventExposure - openCost());
    const targetQty = Math.floor(targetValue / Math.max(maxPairPrice, 0.001));
    if (targetQty < params.minShares) return false;

    const upMaxPrice = upFields.ask + params.entrySlippageMax;
    const downMaxPrice = downFields.ask + params.entrySlippageMax;
    const upAvailable = availableAskQty(upFields.rawAsks, upMaxPrice, upFields.ask, params.fallbackBookSize, `${tick.ts}:box:UP`);
    const downAvailable = availableAskQty(downFields.rawAsks, downMaxPrice, downFields.ask, params.fallbackBookSize, `${tick.ts}:box:DOWN`);
    const pairQty = Math.min(targetQty, Math.floor(upAvailable), Math.floor(downAvailable));
    if (pairQty < params.minShares || pairQty < targetQty * params.minLiquidityRatio) return false;

    const upConsumed = new Map(current.consumedAsksBySide.UP);
    const downConsumed = new Map(current.consumedAsksBySide.DOWN);
    const upFills = consumeAsksFromTick(upFields.rawAsks, upMaxPrice, pairQty, upConsumed, upFields.ask, params.fallbackBookSize, `${tick.ts}:box:UP`);
    const downFills = consumeAsksFromTick(downFields.rawAsks, downMaxPrice, pairQty, downConsumed, downFields.ask, params.fallbackBookSize, `${tick.ts}:box:DOWN`);
    const upQty = upFills.reduce((sum, fill) => sum + fill.qty, 0);
    const downQty = downFills.reduce((sum, fill) => sum + fill.qty, 0);
    if (upQty < params.minShares || downQty < params.minShares || Math.abs(upQty - downQty) > 0.000001) return false;

    const qty = Math.min(upQty, downQty);
    const upCost = upFills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    const downCost = downFills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
    const cost = upCost + downCost;
    if (!canAddExposure(cost)) return false;

    current.consumedAsksBySide.UP = upConsumed;
    current.consumedAsksBySide.DOWN = downConsumed;
    const timedUpFills = upFills.map((fill) => ({ ...fill, side: 'UP', time: tick.ts, source: 'box' }));
    const timedDownFills = downFills.map((fill) => ({ ...fill, side: 'DOWN', time: tick.ts, source: 'box' }));
    addInventoryFills(current.inventory.UP, timedUpFills);
    addInventoryFills(current.inventory.DOWN, timedDownFills);
    current.totalOpenCost += cost;
    current.orders.push(
      { side: 'UP', source: 'box', requestedQty: pairQty, filledQty: qty, maxPrice: upMaxPrice, avgPrice: upCost / qty, cost: upCost, createdAt: tick.ts, lockedProfitPerPair, pairAsk, fills: timedUpFills.map((fill) => ({ ...fill })) },
      { side: 'DOWN', source: 'box', requestedQty: pairQty, filledQty: qty, maxPrice: downMaxPrice, avgPrice: downCost / qty, cost: downCost, createdAt: tick.ts, lockedProfitPerPair, pairAsk, fills: timedDownFills.map((fill) => ({ ...fill })) },
    );

    current.boxEntries++;
    totalBoxEntries++;
    totalEntries++;
    current.lastBoxEntryMs = timeMs;
    current.entries.push({
      time: tick.ts,
      type: 'box',
      side: 'BOTH',
      qty,
      cost,
      avgEntryPrice: cost / (qty * 2),
      lockedProfit: qty - cost,
      lockedProfitPerPair,
      timeRemainingSec: secondsRemaining(current, tick),
      distanceToPtb: Math.abs(toFiniteNumber(tick.btc_price) - toFiniteNumber(current.priceToBeat ?? tick.price_to_beat)),
    });
    current.boxes.push({ time: tick.ts, qty, cost, lockedProfit: qty - cost, upAvg: upCost / qty, downAvg: downCost / qty });
    addLog(tick.ts, `BOX | UP+DOWN ${formatQty(qty)} pares | custo ${formatPrice(cost)} | lock $${(qty - cost).toFixed(2)}`, 'entry');
    return true;
  };

  const directionalSize = (candidate) => {
    const equityNow = Math.max(0, params.walletSize + totalPnl);
    const winPayoff = Math.max(0.001, (1 - candidate.ask) / candidate.ask);
    const lossProbability = 1 - candidate.probability;
    const kelly = Math.max(0, ((candidate.probability * winPayoff) - lossProbability) / winPayoff);
    const kellyValue = equityNow * Math.min(params.maxKellyPct, kelly * params.kellyFraction);
    return Math.min(params.maxEntryValue, kellyValue, params.maxEventExposure - openCost());
  };

  const attemptDirectionalEntry = (tick) => {
    if (current.directionalEntries + current.boxEntries >= params.maxEntriesPerEvent) return false;
    const timeMs = new Date(tick.ts).getTime();
    if (current.lastEntryMs && timeMs - current.lastEntryMs < params.cooldownSec * 1000) return false;

    const candidates = scoreDirectionalCandidates(current, tick, params);
    const candidate = candidates[0] || null;
    current.lastDiagnostics = candidate ? {
      side: candidate.side,
      ask: candidate.ask,
      bid: candidate.bid,
      probability: candidate.probability,
      edge: candidate.edge,
      spread: candidate.spread,
      askSum: candidate.askSum,
      timeRemainingSec: secondsRemaining(current, tick),
    } : current.lastDiagnostics;
    if (!candidate) return false;

    const maxFillPrice = Math.min(params.maxAsk, candidate.ask + params.entrySlippageMax);
    const targetValue = directionalSize(candidate);
    const targetQty = Math.floor(targetValue / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return false;

    const availableQty = availableAskQty(candidate.fields.rawAsks, maxFillPrice, candidate.fields.ask, params.fallbackBookSize, `${tick.ts}:directional:${candidate.side}`);
    if (availableQty < targetQty * params.minLiquidityRatio) return false;

    const buy = executeBuy(tick, candidate.side, targetQty, maxFillPrice, 'directional', {
      probability: candidate.probability,
      edge: candidate.edge,
      spread: candidate.spread,
    });
    if (!buy) return false;

    current.directionalEntries++;
    totalDirectionalEntries++;
    totalEntries++;
    current.lastEntryMs = timeMs;
    const distanceToPtb = Math.abs(toFiniteNumber(tick.btc_price) - toFiniteNumber(current.priceToBeat ?? tick.price_to_beat));
    current.entries.push({
      time: tick.ts,
      type: 'directional',
      side: candidate.side,
      qty: buy.filledQty,
      cost: buy.totalCost,
      avgEntryPrice: buy.avgPrice,
      probability: candidate.probability,
      edge: candidate.edge,
      spread: candidate.spread,
      timeRemainingSec: secondsRemaining(current, tick),
      distanceToPtb,
    });
    addLog(
      tick.ts,
      `ENTRADA GAMMA | ${candidate.side} ${formatQty(buy.filledQty)} @ ${formatPrice(buy.avgPrice)} | prob ${(candidate.probability * 100).toFixed(1)}% | edge ${(candidate.edge * 100).toFixed(1)}pp | dist $${distanceToPtb.toFixed(2)}`,
      'entry',
    );
    return true;
  };

  const attemptProfitLockHedge = (tick, side) => {
    if (!params.hedgeEnabled) return false;
    const sideInventory = current.inventory[side];
    if (!sideInventory || sideInventory.remainingQty < params.minShares) return false;
    const hedgeSide = oppositeSide(side);
    const hedgeFields = sideFields(tick, hedgeSide);
    if (hedgeFields.ask == null || hedgeFields.ask > params.hedgeMaxAsk) return false;
    const hedgeQty = Math.floor(sideInventory.remainingQty - current.inventory[hedgeSide].remainingQty);
    if (hedgeQty < params.minShares) return false;
    const maxFillPrice = hedgeFields.ask + params.entrySlippageMax;
    const expectedCost = hedgeQty * maxFillPrice;
    const lockedPayout = Math.min(sideInventory.remainingQty, current.inventory[hedgeSide].remainingQty + hedgeQty);
    const lockedProfit = lockedPayout - (current.inventory.UP.openCost + current.inventory.DOWN.openCost + expectedCost);
    if (lockedProfit < params.hedgeMinLockedProfit || !canAddExposure(expectedCost)) return false;

    const availableQty = availableAskQty(hedgeFields.rawAsks, maxFillPrice, hedgeFields.ask, params.fallbackBookSize, `${tick.ts}:hedge:${hedgeSide}`);
    if (availableQty < hedgeQty * params.minLiquidityRatio) return false;
    const buy = executeBuy(tick, hedgeSide, hedgeQty, maxFillPrice, 'hedge', { lockedProfit });
    if (!buy) return false;

    totalHedges++;
    current.hedges.push({ time: tick.ts, side: hedgeSide, qty: buy.filledQty, cost: buy.totalCost, avgEntryPrice: buy.avgPrice, lockedProfit });
    addLog(tick.ts, `HEDGE LOCK | ${hedgeSide} ${formatQty(buy.filledQty)} @ ${formatPrice(buy.avgPrice)} | lock $${lockedProfit.toFixed(2)}`, 'profit');
    return true;
  };

  const attemptStopReverse = (tick, side, signal, bid) => {
    if (bid < params.stopReverseMinBid) return false;
    const sideInventory = current.inventory[side];
    if (!sideInventory || sideInventory.remainingQty < params.minShares) return false;
    const reverseFields = sideFields(tick, signal.toSide);
    if (reverseFields.ask == null || reverseFields.ask <= 0) return false;

    const fromQty = sideInventory.remainingQty;
    const fromOpenCost = sideInventory.openCost;
    const budget = stopReverseBudget({
      params,
      maxOrderValue: params.maxEntryValue,
      equityNow: params.walletSize + totalPnl,
      totalCost: fromOpenCost,
      openCost: fromOpenCost,
      proceeds: fromQty * bid,
    });
    const maxFillPrice = Math.min(params.stopReverseMaxAsk, reverseFields.ask + params.stopReverseSlippageMax);
    const targetQty = Math.floor(budget / Math.max(maxFillPrice, 0.001));
    if (targetQty < params.minShares) return false;
    if (openCost() - fromOpenCost + budget > params.maxEventExposure + 0.000001) return false;

    const availableQty = availableAskQty(
      reverseFields.rawAsks,
      maxFillPrice,
      reverseFields.ask,
      params.fallbackBookSize,
      `${tick.ts}:stop-reverse:${signal.toSide}`,
    );
    if (availableQty < targetQty * params.stopReverseMinLiquidityRatio) return false;

    const soldQty = sellSide(tick, side, fromQty, bid, 'stop reverse gamma exit', 'stop');
    if (soldQty < fromQty * 0.999) return false;

    const buy = executeBuy(tick, signal.toSide, targetQty, maxFillPrice, 'stop_reverse', {
      adverseDistance: signal.adverseDistance,
      timeRemainingSec: signal.timeRemainingSec,
    });
    current.stopReverseCount++;
    if (!buy) {
      current.reversals.push({
        time: tick.ts,
        fromSide: side,
        toSide: signal.toSide,
        status: 'entry_failed',
        soldQty,
        exitPrice: bid,
        exitProceeds: soldQty * bid,
        fromOpenCost,
        adverseDistance: signal.adverseDistance,
        timeRemainingSec: signal.timeRemainingSec,
        budget,
        entryQty: 0,
        entryCost: 0,
        avgEntryPrice: 0,
        entryFills: [],
      });
      if (current.inventory.UP.remainingQty <= 0 && current.inventory.DOWN.remainingQty <= 0) finalizeCurrentEvent('stop_reverse_exit', tick.ts);
      return true;
    }

    current.directionalEntries++;
    totalDirectionalEntries++;
    totalEntries++;
    current.entries.push({
      time: tick.ts,
      type: 'stop_reverse',
      side: signal.toSide,
      fromSide: side,
      qty: buy.filledQty,
      cost: buy.totalCost,
      avgEntryPrice: buy.avgPrice,
      adverseDistance: signal.adverseDistance,
      timeRemainingSec: signal.timeRemainingSec,
      distanceToPtb: signal.adverseDistance,
    });
    current.reversals.push({
      time: tick.ts,
      fromSide: side,
      toSide: signal.toSide,
      status: 'filled',
      soldQty,
      exitPrice: bid,
      exitProceeds: soldQty * bid,
      fromOpenCost,
      adverseDistance: signal.adverseDistance,
      timeRemainingSec: signal.timeRemainingSec,
      budget,
      entryQty: buy.filledQty,
      entryCost: buy.totalCost,
      avgEntryPrice: buy.avgPrice,
      entryFills: buy.fills.map((fill) => ({ ...fill })),
    });
    addLog(tick.ts, `STOP REVERSE GAMMA | ${side}->${signal.toSide} | saiu ${formatQty(soldQty)} @ ${formatPrice(bid)} | entrou ${formatQty(buy.filledQty)} @ ${formatPrice(buy.avgPrice)} | dist $${signal.adverseDistance.toFixed(2)} | ${Math.round(signal.timeRemainingSec)}s`, 'stop');
    return true;
  };

  const maybeProcessPositions = (tick) => {
    let closedByStop = false;
    const pUp = modelProbUp(current, tick, params);
    for (const side of ['UP', 'DOWN']) {
      const sideInventory = current.inventory[side];
      if (sideInventory.remainingQty <= 0) continue;
      const fields = sideFields(tick, side);
      const bid = fields.bid;
      if (bid == null || bid <= 0) continue;
      sideInventory.maxBid = Math.max(sideInventory.maxBid, bid);
      const avgOpen = averageOpenPrice(sideInventory);
      const probability = side === 'UP' ? pUp : 1 - pUp;
      const edgeToBid = probability - bid;
      const timeRemainingSec = secondsRemaining(current, tick);

      const reverseSignal = stopReverseTrigger({
        tick,
        priceToBeat: current.priceToBeat,
        positionSide: side,
        timeRemainingSec,
        attempts: current.stopReverseCount,
        params,
      });
      if (reverseSignal && attemptStopReverse(tick, side, reverseSignal, bid)) return true;

      if (!sideInventory.tookProfit && bid >= params.takeProfitBid && params.takeProfitPct > 0) {
        const partialQty = Math.floor(sideInventory.remainingQty * params.takeProfitPct);
        if (partialQty >= params.minShares) {
          const soldQty = sellSide(tick, side, partialQty, bid, 'parcial gamma', 'profit');
          if (soldQty > 0) {
            sideInventory.tookProfit = true;
            current.partials.push({ side, price: bid, qty: soldQty, fillTime: tick.ts, status: 'FILLED' });
          }
        }
      }

      if (sideInventory.maxBid >= params.trailAfterBid && sideInventory.maxBid - bid >= params.trailDrop) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'trailing gamma', bid >= avgOpen ? 'profit' : 'stop');
        continue;
      }

      if (bid <= params.stopBid && edgeToBid < params.edgeExitBelow && timeRemainingSec > params.lateExitSec) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'stop gamma', 'loss');
        closedByStop = true;
        continue;
      }

      if (edgeToBid < params.edgeExitBelow && bid > avgOpen && timeRemainingSec > params.lateExitSec) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'edge fade', 'profit');
        continue;
      }

      if (timeRemainingSec <= params.lateExitSec && bid >= params.lateExitMinBid) {
        sellSide(tick, side, sideInventory.remainingQty, bid, 'derisk final', bid >= avgOpen ? 'profit' : 'stop');
        continue;
      }

      attemptProfitLockHedge(tick, side);
    }

    if (closedByStop && current.inventory.UP.remainingQty <= 0 && current.inventory.DOWN.remainingQty <= 0) {
      finalizeCurrentEvent('stop', tick.ts);
      return true;
    }
    return false;
  };

  const maybeEnter = (tick) => {
    const timeRemainingSec = secondsRemaining(current, tick);
    if (timeRemainingSec > params.entryWindowStart || timeRemainingSec <= params.entryWindowEnd) return;
    if (eventElapsedSec(current, tick) < 2) return;
    if (current.samples.length < params.minTicksBeforeEntry) return;
    if (openCost() >= params.maxEventExposure) return;

    if (attemptBoxEntry(tick)) return;
    attemptDirectionalEntry(tick);
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

    addSample(current, tick);

    if (tickTime >= current.eventEnd) {
      finalizeCurrentEvent('expired', current.eventEnd.toISOString());
      return;
    }

    if (maybeProcessPositions(tick)) return;
    maybeEnter(tick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd.toISOString());
    const enteredEvents = events.filter((item) => item.reason !== 'no_entry');
    const eventWinRate = enteredEvents.length > 0 ? totalWins / enteredEvents.length * 100 : 0;
    const entryAdjustedWinRate = totalEntries > 0 ? totalWins / totalEntries * 100 : 0;
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

    const advanced = computeAdvancedMetrics(events, totalPnl, totalEntries, totalWins, totalLosses);
    return {
      params,
      strategy: 'GAMMA_LADDER_V1',
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins,
        totalLosses,
        winRate: parseFloat(eventWinRate.toFixed(1)),
        eventWinRate: parseFloat(eventWinRate.toFixed(1)),
        entryAdjustedWinRate: parseFloat(entryAdjustedWinRate.toFixed(1)),
        totalPnl,
        avgPnl,
        maxWin,
        maxLoss,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
        directionalEntries: totalDirectionalEntries,
        boxEntries: totalBoxEntries,
        hedges: totalHedges,
        activeEvents: enteredEvents.length,
        entriesPerActiveEvent: enteredEvents.length ? totalEntries / enteredEvents.length : 0,
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

function runGammaLadderBacktest(rawParams, ticks) {
  const runner = createGammaLadderBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

async function runGammaLadderBacktestInBatches(rawParams, tickBatches) {
  const runner = createGammaLadderBacktestRunner(rawParams);
  for await (const batch of tickBatches) {
    for (const tick of batch) runner.processTick(tick);
  }
  return runner.finish();
}
