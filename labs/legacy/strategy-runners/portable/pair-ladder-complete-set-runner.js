/**
 * Pair Ladder Complete-Set V1 — library runner (research).
 *
 * Builds a UP+DOWN complete set along the event path (not snapshot arb):
 * seed → clip ladder → late vacuum → lock when avgSum/balance gates hit → redeem.
 *
 * Mode A (default): clip_ladder (Doggy-style 50→100)
 * Mode B (ablation): micro_spray (smaller clips, higher fill count)
 *
 * Test surface: __pairLadderCompleteSetExports
 */

const DEFAULT_PARAMS = {
  walletSize: 100,
  mode: 'clip_ladder', // clip_ladder | micro_spray

  openShares: 50,
  hedgeShares: 100, // RE: 2º fill tipicamente 100 no oposto
  clipShares: 100, // Doggy dominante: 50 → 100 → 100…
  openMinAsk: 0.45,
  openMaxAsk: 0.58, // RE: firstPx p90 ~0.58
  openMaxAvgSum: 1.03,
  seedHedgeSameTick: false, // RE Doggy: ~8% same-sec; hedge oposto med ~18s depois
  hedgeMaxAsk: 0.70,
  hedgeTargetAvgSum: 0.99, // pair open+hedge med ~1.00; edge vem depois no path
  hedgePreferAsk: 0.50, // 59% dos hedges ≤50¢
  minSecToHedge: 5, // evita hedge no tick seguinte; p10 gap=2s, med=18s
  maxSecToOpen: 30, // RE: ~91% abrem nos primeiros 30s (med ~4s)
  minSecondsLeftToEnter: 15,
  // janela extra para completar o hedge assíncrono após o open
  maxSecToHedge: 120,

  stopAvgSum: 0.95,
  stopMinBalance: 0.95,
  blockAvgSum: 1.08,
  refuseAvgSum: 1.0,
  maxResidualShares: 100, // RE Doggy residual med ~38; 1º chase pós-seed precisa de folga
  scaleOnlyTowardLock: true, // só escala se melhora caminho para lock (bal/avgSum/residual)

  pairSnapMax: 0.99,
  rebalanceSlackCents: 3,
  rebalanceMaxAsk: 0.70,
  rebalanceCushionAsk: 0.90,
  rebalanceMinResidual: 1,
  chaseMaxAsk: 0.40,
  chaseOverweightMaxAsk: 0.01, // RE: pós-dual quase só underweight (3150 vs 122)
  forbidOverweight: true, // Doggy raramente compra o lado overweight
  buildOnlyImprove: false,
  buildMaxAvgSum: 1.05,
  // Etapa 9: min_avg_sum (default lab) | chase_momo (RE Doggy: clip no ask que sobe)
  legChoice: 'min_avg_sum', // min_avg_sum | chase_momo
  momoLookbackSec: 15,
  momoMinRise: 0.02,
  momoMinAsk: 0.20,
  momoMaxAsk: 0.70,
  // Etapa 12b: em chase_momo, bloqueia rebalance FADE mid (ask > chaseMaxAsk sem MOMO)
  momoBlockFade: false,

  // soft lock: avgSum/bal ok não mata vacuum (Doggy continua após ≤0.95)
  softLockAllowVacuum: true,
  softLockAllowBuild: true, // Doggy continua chase under após avg≤0.95 (Etapa 2)

  lateStartSec: 180,
  lateMaxAsk: 0.15,
  lateUltraAsk: 0.05,
  lateClipShares: 50,
  lateUltraClipShares: 50,
  lateOnlyImprove: true,
  lateRequireResidual: true,
  lateOrphanAllowed: false,

  maxEventNotional: 350, // RE Etapa 7: Doggy buyUsdc med ~304 / lab 600 sangrava 2×
  maxSharesPerSide: 500,
  maxFillsPerEvent: 12, // RE: Doggy fills med 8 / p90 ~15

  // micro_spray overrides when mode=micro_spray
  sprayOpenShares: 20,
  sprayClipShares: 10,
  sprayMaxFillsPerEvent: 200,

  // Execução: taker (honesto) | mid | optimistic_maker | resting_maker
  fillMode: 'taker',
  makerFillEpsilon: 0.01,
  makerTimeoutSec: 20,

  takerFeeRate: 0.07,
  // Doggy fill med ~1¢ melhor que ask do lake; bump de spread deixa o lab pior que o RE
  spreadCents: 0,
  slippageCents: 0,
  requireQuality: true,
  minCoverage: 0.99,
  applyPolymarketFees: true,
  polymarketFeeCategory: 'crypto',
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

function mergeParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS, ...raw };
  params.mode = String(raw.mode ?? DEFAULT_PARAMS.mode).trim().toLowerCase() === 'micro_spray'
    ? 'micro_spray'
    : 'clip_ladder';

  params.walletSize = Math.max(1, toFiniteNumber(raw.walletSize, DEFAULT_PARAMS.walletSize));
  params.openShares = Math.max(1, Math.floor(toFiniteNumber(raw.openShares, DEFAULT_PARAMS.openShares)));
  params.clipShares = Math.max(1, Math.floor(toFiniteNumber(raw.clipShares, DEFAULT_PARAMS.clipShares)));
  params.hedgeShares = Math.max(1, Math.floor(toFiniteNumber(raw.hedgeShares, DEFAULT_PARAMS.hedgeShares)));
  params.openMinAsk = clamp(toFiniteNumber(raw.openMinAsk, DEFAULT_PARAMS.openMinAsk), 0.01, 0.99);
  params.openMaxAsk = clamp(toFiniteNumber(raw.openMaxAsk, DEFAULT_PARAMS.openMaxAsk), 0.01, 0.99);
  if (params.openMaxAsk < params.openMinAsk) {
    [params.openMaxAsk, params.openMinAsk] = [params.openMinAsk, params.openMaxAsk];
  }
  params.openMaxAvgSum = clamp(toFiniteNumber(raw.openMaxAvgSum, DEFAULT_PARAMS.openMaxAvgSum), 0.5, 1.2);
  params.seedHedgeSameTick = toBool(raw.seedHedgeSameTick, DEFAULT_PARAMS.seedHedgeSameTick);
  params.hedgeMaxAsk = clamp(toFiniteNumber(raw.hedgeMaxAsk, DEFAULT_PARAMS.hedgeMaxAsk), 0.05, 0.99);
  params.hedgeTargetAvgSum = clamp(toFiniteNumber(raw.hedgeTargetAvgSum, DEFAULT_PARAMS.hedgeTargetAvgSum), 0.5, 1.2);
  params.hedgePreferAsk = clamp(toFiniteNumber(raw.hedgePreferAsk, DEFAULT_PARAMS.hedgePreferAsk), 0.05, 0.99);
  params.minSecToHedge = Math.max(0, toFiniteNumber(raw.minSecToHedge, DEFAULT_PARAMS.minSecToHedge));
  params.maxSecToOpen = Math.max(1, toFiniteNumber(raw.maxSecToOpen, DEFAULT_PARAMS.maxSecToOpen));
  params.minSecondsLeftToEnter = Math.max(0, toFiniteNumber(raw.minSecondsLeftToEnter, DEFAULT_PARAMS.minSecondsLeftToEnter));
  params.maxSecToHedge = Math.max(params.maxSecToOpen, toFiniteNumber(raw.maxSecToHedge, DEFAULT_PARAMS.maxSecToHedge));

  params.stopAvgSum = clamp(toFiniteNumber(raw.stopAvgSum, DEFAULT_PARAMS.stopAvgSum), 0.5, 1.2);
  params.stopMinBalance = clamp(toFiniteNumber(raw.stopMinBalance, DEFAULT_PARAMS.stopMinBalance), 0, 1);
  params.blockAvgSum = clamp(toFiniteNumber(raw.blockAvgSum, DEFAULT_PARAMS.blockAvgSum), 0.5, 1.5);
  params.refuseAvgSum = clamp(toFiniteNumber(raw.refuseAvgSum, DEFAULT_PARAMS.refuseAvgSum), 0.5, 1.5);
  params.maxResidualShares = Math.max(0, toFiniteNumber(raw.maxResidualShares, DEFAULT_PARAMS.maxResidualShares));
  params.scaleOnlyTowardLock = toBool(raw.scaleOnlyTowardLock, DEFAULT_PARAMS.scaleOnlyTowardLock);

  params.pairSnapMax = clamp(toFiniteNumber(raw.pairSnapMax, DEFAULT_PARAMS.pairSnapMax), 0.5, 1.2);
  params.rebalanceSlackCents = Math.max(0, toFiniteNumber(raw.rebalanceSlackCents, DEFAULT_PARAMS.rebalanceSlackCents));
  params.rebalanceMaxAsk = clamp(toFiniteNumber(raw.rebalanceMaxAsk, DEFAULT_PARAMS.rebalanceMaxAsk), 0.05, 0.99);
  params.rebalanceCushionAsk = clamp(toFiniteNumber(raw.rebalanceCushionAsk, DEFAULT_PARAMS.rebalanceCushionAsk), params.rebalanceMaxAsk, 0.99);
  params.rebalanceMinResidual = Math.max(0, toFiniteNumber(raw.rebalanceMinResidual, DEFAULT_PARAMS.rebalanceMinResidual));
  params.chaseMaxAsk = clamp(toFiniteNumber(raw.chaseMaxAsk, DEFAULT_PARAMS.chaseMaxAsk), 0.01, 0.99);
  params.chaseOverweightMaxAsk = clamp(toFiniteNumber(raw.chaseOverweightMaxAsk, DEFAULT_PARAMS.chaseOverweightMaxAsk), 0.01, params.chaseMaxAsk);
  params.forbidOverweight = toBool(raw.forbidOverweight, DEFAULT_PARAMS.forbidOverweight);
  params.buildOnlyImprove = toBool(raw.buildOnlyImprove, DEFAULT_PARAMS.buildOnlyImprove);
  params.buildMaxAvgSum = clamp(toFiniteNumber(raw.buildMaxAvgSum, DEFAULT_PARAMS.buildMaxAvgSum), 0.5, 1.5);
  const legChoice = String(raw.legChoice ?? DEFAULT_PARAMS.legChoice).trim().toLowerCase();
  params.legChoice = legChoice === 'chase_momo' || legChoice === 'chasemomo' ? 'chase_momo' : 'min_avg_sum';
  params.momoLookbackSec = Math.max(1, toFiniteNumber(raw.momoLookbackSec, DEFAULT_PARAMS.momoLookbackSec));
  params.momoMinRise = clamp(toFiniteNumber(raw.momoMinRise, DEFAULT_PARAMS.momoMinRise), 0.005, 0.2);
  params.momoMinAsk = clamp(toFiniteNumber(raw.momoMinAsk, DEFAULT_PARAMS.momoMinAsk), 0.01, 0.99);
  params.momoMaxAsk = clamp(toFiniteNumber(raw.momoMaxAsk, DEFAULT_PARAMS.momoMaxAsk), 0.01, 0.99);
  if (params.momoMaxAsk < params.momoMinAsk) {
    [params.momoMaxAsk, params.momoMinAsk] = [params.momoMinAsk, params.momoMaxAsk];
  }
  params.momoBlockFade = toBool(raw.momoBlockFade, DEFAULT_PARAMS.momoBlockFade);
  params.softLockAllowVacuum = toBool(raw.softLockAllowVacuum, DEFAULT_PARAMS.softLockAllowVacuum);
  params.softLockAllowBuild = toBool(raw.softLockAllowBuild, DEFAULT_PARAMS.softLockAllowBuild);

  params.lateStartSec = clamp(toFiniteNumber(raw.lateStartSec, DEFAULT_PARAMS.lateStartSec), 0, 300);
  params.lateMaxAsk = clamp(toFiniteNumber(raw.lateMaxAsk, DEFAULT_PARAMS.lateMaxAsk), 0.01, 0.5);
  params.lateUltraAsk = clamp(toFiniteNumber(raw.lateUltraAsk, DEFAULT_PARAMS.lateUltraAsk), 0.01, params.lateMaxAsk);
  params.lateClipShares = Math.max(1, Math.floor(toFiniteNumber(raw.lateClipShares, DEFAULT_PARAMS.lateClipShares)));
  params.lateUltraClipShares = Math.max(1, Math.floor(toFiniteNumber(raw.lateUltraClipShares, DEFAULT_PARAMS.lateUltraClipShares)));
  params.lateOnlyImprove = toBool(raw.lateOnlyImprove, DEFAULT_PARAMS.lateOnlyImprove);
  params.lateRequireResidual = toBool(raw.lateRequireResidual, DEFAULT_PARAMS.lateRequireResidual);
  params.lateOrphanAllowed = toBool(raw.lateOrphanAllowed, DEFAULT_PARAMS.lateOrphanAllowed);

  params.maxEventNotional = Math.max(1, toFiniteNumber(raw.maxEventNotional, DEFAULT_PARAMS.maxEventNotional));
  params.maxSharesPerSide = Math.max(1, Math.floor(toFiniteNumber(raw.maxSharesPerSide, DEFAULT_PARAMS.maxSharesPerSide)));
  params.maxFillsPerEvent = Math.max(1, Math.floor(toFiniteNumber(raw.maxFillsPerEvent, DEFAULT_PARAMS.maxFillsPerEvent)));

  params.sprayOpenShares = Math.max(1, Math.floor(toFiniteNumber(raw.sprayOpenShares, DEFAULT_PARAMS.sprayOpenShares)));
  params.sprayClipShares = Math.max(1, Math.floor(toFiniteNumber(raw.sprayClipShares, DEFAULT_PARAMS.sprayClipShares)));
  params.sprayMaxFillsPerEvent = Math.max(1, Math.floor(toFiniteNumber(raw.sprayMaxFillsPerEvent, DEFAULT_PARAMS.sprayMaxFillsPerEvent)));

  params.takerFeeRate = Math.max(0, toFiniteNumber(raw.takerFeeRate, DEFAULT_PARAMS.takerFeeRate));
  params.spreadCents = Math.max(0, toFiniteNumber(raw.spreadCents, DEFAULT_PARAMS.spreadCents));
  // negativo permitido: research overlay p/ fill Doggy ~1¢ melhor que ask do lake
  params.slippageCents = toFiniteNumber(raw.slippageCents, DEFAULT_PARAMS.slippageCents);
  const fillMode = String(raw.fillMode ?? DEFAULT_PARAMS.fillMode).trim().toLowerCase();
  params.fillMode = ['mid', 'optimistic_maker', 'resting_maker'].includes(fillMode) ? fillMode : 'taker';
  params.makerFillEpsilon = clamp(toFiniteNumber(raw.makerFillEpsilon, DEFAULT_PARAMS.makerFillEpsilon), 0, 0.1);
  params.makerTimeoutSec = Math.max(1, toFiniteNumber(raw.makerTimeoutSec, DEFAULT_PARAMS.makerTimeoutSec));
  params.requireQuality = toBool(raw.requireQuality, DEFAULT_PARAMS.requireQuality);
  params.minCoverage = clamp(toFiniteNumber(raw.minCoverage, DEFAULT_PARAMS.minCoverage), 0, 1);
  params.applyPolymarketFees = toBool(raw.applyPolymarketFees, DEFAULT_PARAMS.applyPolymarketFees);
  params.polymarketFeeCategory = String(raw.polymarketFeeCategory || DEFAULT_PARAMS.polymarketFeeCategory);

  if (params.mode === 'micro_spray') {
    params.openShares = params.sprayOpenShares;
    params.clipShares = params.sprayClipShares;
    params.maxFillsPerEvent = params.sprayMaxFillsPerEvent;
  }

  params.__merged = true;
  return params;
}

function milliseconds(value, fallback = null) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tickTimeMs(tick) {
  return milliseconds(tick?._tsMs, milliseconds(tick?.ts));
}

function eventStartMs(tick) {
  return milliseconds(tick?._eventStartMs, milliseconds(tick?.event_start));
}

function eventEndMs(tick) {
  const explicit = milliseconds(tick?._eventEndMs, milliseconds(tick?.event_end));
  if (explicit != null) return explicit;
  const start = eventStartMs(tick);
  return start == null ? null : start + 300000;
}

function secondsInto(tick) {
  const now = tickTimeMs(tick);
  const start = eventStartMs(tick);
  if (now == null || start == null) return null;
  return Math.max(0, (now - start) / 1000);
}

function secondsRemaining(tick) {
  const now = tickTimeMs(tick);
  const end = eventEndMs(tick);
  if (now == null || end == null) return null;
  return Math.max(0, (end - now) / 1000);
}

function eventKey(tick) {
  const condition = String(tick?.condition_id ?? tick?.conditionId ?? '');
  const start = eventStartMs(tick);
  return `${condition}|${start ?? String(tick?.event_start ?? '')}`;
}

function qualityOk(tick, params) {
  if (!params.requireQuality) return true;
  if (tick?.degraded === true || tick?.degraded === 1 || tick?.degraded === 'true') return false;
  const coverage = toFiniteNumber(tick?.coverage);
  if (coverage == null) return false;
  return coverage >= params.minCoverage;
}

function sideAsk(tick, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const fallback = toFiniteNumber(tick?.[`${prefix}_price`]);
  return toFiniteNumber(tick?.[`${prefix}_best_ask`], fallback);
}

function sideBid(tick, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  return toFiniteNumber(tick?.[`${prefix}_best_bid`]);
}

function liquidityForMode(params) {
  if (params.fillMode === 'optimistic_maker' || params.fillMode === 'resting_maker') return 'maker';
  return 'taker';
}

function resolveFillPrice(tick, side, params) {
  const ask = sideAsk(tick, side);
  const bid = sideBid(tick, side);
  const slip = params.slippageCents / 100;
  if (params.fillMode === 'optimistic_maker') {
    if (bid != null && bid > 0 && bid < 1) return clamp(bid + slip, 0.01, 0.99);
    if (ask == null) return null;
    return clamp(ask - 0.01 + slip, 0.01, 0.99);
  }
  if (params.fillMode === 'mid') {
    if (ask == null) return null;
    if (bid != null && bid > 0 && bid < ask) return clamp((ask + bid) / 2 + slip, 0.01, 0.99);
    return clamp(ask + slip, 0.01, 0.99);
  }
  // taker + resting_maker (resting usa bid no place; taker fallback)
  if (ask == null || !(ask > 0) || !(ask < 1)) return null;
  const bump = (params.spreadCents / 2 + params.slippageCents) / 100;
  return clamp(ask + bump, 0.01, 0.99);
}

function takerFillPrice(ask, params) {
  if (ask == null || !(ask > 0) || !(ask < 1)) return null;
  const bump = (params.spreadCents / 2 + params.slippageCents) / 100;
  return clamp(ask + bump, 0.01, 0.99);
}

function improvesTowardLock(stats, proj, params) {
  if (!params.scaleOnlyTowardLock) return true;
  if (stats.avgSum == null) return true;
  const improvesAvg = proj.avgSum != null && proj.avgSum < stats.avgSum - 1e-12;
  const improvesBal = proj.balance > stats.balance + 1e-12;
  const reducesResidual = proj.residual < stats.residual - 1e-9;
  const staysWithinResidual = proj.residual <= params.maxResidualShares + 1e-9;
  const reachesLock =
    proj.avgSum != null
    && proj.avgSum <= params.stopAvgSum + 1e-12
    && proj.balance + 1e-12 >= params.stopMinBalance
    && proj.residual <= params.maxResidualShares + 1e-9;
  if (reachesLock) return true;
  // Doggy path: chase barato melhora avgSum aceitando residual temporário (cap em maxResidualShares).
  // Exigir melhora de bal/residual aqui bloqueava o 1º chase após seed dual flat.
  if (improvesAvg && staysWithinResidual) return true;
  if (improvesBal && staysWithinResidual) return true;
  if (reducesResidual && (proj.avgSum == null || proj.avgSum <= params.refuseAvgSum + 1e-12)) return true;
  return false;
}

function estimateFee(qty, price, feeRate) {
  if (!(qty > 0) || !(price > 0) || !(price < 1) || !(feeRate > 0)) return 0;
  return qty * feeRate * price * (1 - price);
}

function inventoryStats(state) {
  const upShares = state.shares.UP;
  const downShares = state.shares.DOWN;
  const upCost = state.cost.UP;
  const downCost = state.cost.DOWN;
  const avgUp = upShares > 0 ? upCost / upShares : null;
  const avgDown = downShares > 0 ? downCost / downShares : null;
  const avgSum = avgUp != null && avgDown != null ? avgUp + avgDown : null;
  const maxSide = Math.max(upShares, downShares);
  const minSide = Math.min(upShares, downShares);
  const balance = maxSide > 0 ? minSide / maxSide : 0;
  const residual = Math.abs(upShares - downShares);
  const residualSide = upShares > downShares ? 'UP' : downShares > upShares ? 'DOWN' : 'FLAT';
  const totalCost = upCost + downCost;
  const fillCount = state.fills.UP.length + state.fills.DOWN.length;
  return {
    upShares, downShares, upCost, downCost,
    avgUp, avgDown, avgSum, balance, residual, residualSide, totalCost, fillCount,
  };
}

function projectedAfterBuy(state, side, qty, fillPrice) {
  const next = {
    shares: { UP: state.shares.UP, DOWN: state.shares.DOWN },
    cost: { UP: state.cost.UP, DOWN: state.cost.DOWN },
  };
  next.shares[side] += qty;
  next.cost[side] += qty * fillPrice;
  return inventoryStats({ ...state, shares: next.shares, cost: next.cost, fills: state.fills });
}

function recordAskHistory(state, tick) {
  if (!state.askHist) state.askHist = { UP: [], DOWN: [] };
  const sec = secondsInto(tick);
  if (sec == null) return;
  for (const side of ['UP', 'DOWN']) {
    const ask = sideAsk(tick, side);
    if (ask == null) continue;
    const hist = state.askHist[side];
    const last = hist[hist.length - 1];
    if (last && Math.abs(last.sec - sec) < 1e-9) {
      last.ask = ask;
      continue;
    }
    hist.push({ sec, ask });
    // keep ~90s window
    while (hist.length > 2 && hist[0].sec < sec - 90) hist.shift();
  }
}

/** Ask change over lookback seconds: + = rising (MOMO), − = falling (REV). */
function askDelta(state, side, lookbackSec) {
  const hist = state.askHist?.[side];
  if (!hist || hist.length < 2) return null;
  const now = hist[hist.length - 1];
  const target = now.sec - lookbackSec;
  let best = null;
  for (let i = hist.length - 2; i >= 0; i -= 1) {
    const h = hist[i];
    if (h.sec <= target + 0.6) {
      best = h;
      break;
    }
    best = h;
  }
  if (!best || now.ask == null || best.ask == null) return null;
  if (now.sec - best.sec < lookbackSec * 0.5) return null;
  return now.ask - best.ask;
}

function canAfford(state, params, qty, fillPrice) {
  const addCost = qty * fillPrice;
  if (state.cost.UP + state.cost.DOWN + addCost > params.maxEventNotional + 1e-9) return false;
  return true;
}

function createEventState(tick) {
  return {
    key: eventKey(tick),
    conditionId: tick?.condition_id ?? null,
    eventStart: tick?.event_start ?? null,
    eventEnd: tick?.event_end ?? null,
    priceToBeat: toFiniteNumber(tick?.price_to_beat),
    lastTick: tick,
    opened: false,
    locked: false,
    lockReason: null,
    openSide: null,
    oppAskAtOpen: null,
    openedSecInto: null,
    askHist: { UP: [], DOWN: [] },
    shares: { UP: 0, DOWN: 0 },
    cost: { UP: 0, DOWN: 0 },
    fills: { UP: [], DOWN: [] },
    restingBuy: null,
    stats: {
      blockedByGate: 0,
      vacuumFills: 0,
      snapPairs: 0,
      buildFills: 0,
      seedFills: 0,
      restingPlaced: 0,
      restingFilled: 0,
      restingTimedOut: 0,
      scaleBlocked: 0,
    },
  };
}

function applyBuy(state, side, qty, fillPrice, tick, source, params, liquidity = null) {
  if (!(qty > 0) || fillPrice == null) return false;
  if (state.shares[side] + qty > params.maxSharesPerSide + 1e-9) return false;
  if (!canAfford(state, params, qty, fillPrice)) return false;
  const stats = inventoryStats(state);
  if (stats.fillCount >= params.maxFillsPerEvent) return false;

  const cost = qty * fillPrice;
  state.shares[side] += qty;
  state.cost[side] += cost;
  state.fills[side].push({
    price: fillPrice,
    qty,
    time: tick?.ts,
    liquidity: liquidity || liquidityForMode(params),
    source,
    side,
  });
  if (source === 'seed' || source === 'seed_hedge') state.stats.seedFills += 1;
  else if (source === 'vacuum' || source === 'vacuum_ultra') state.stats.vacuumFills += 1;
  else if (source === 'snap') state.stats.snapPairs += 1;
  else if (source === 'resting') state.stats.restingFilled += 1;
  else state.stats.buildFills += 1;
  return true;
}

function maybeLock(state, params) {
  if (state.locked) return;
  const stats = inventoryStats(state);
  if (stats.avgSum == null) return;
  if (
    stats.avgSum <= params.stopAvgSum + 1e-12
    && stats.balance + 1e-12 >= params.stopMinBalance
    && stats.residual <= params.maxResidualShares + 1e-9
  ) {
    state.locked = true;
    state.lockReason = 'avg_sum_balance';
  }
}

function pickSeedSide(tick, params) {
  const upAsk = sideAsk(tick, 'UP');
  const downAsk = sideAsk(tick, 'DOWN');
  const upOk = upAsk != null && upAsk >= params.openMinAsk && upAsk <= params.openMaxAsk;
  const downOk = downAsk != null && downAsk >= params.openMinAsk && downAsk <= params.openMaxAsk;
  if (!upOk && !downOk) return null;
  if (upOk && !downOk) return { side: 'UP', ask: upAsk };
  if (downOk && !upOk) return { side: 'DOWN', ask: downAsk };
  const upDist = Math.abs(upAsk - 0.5);
  const downDist = Math.abs(downAsk - 0.5);
  if (upDist < downDist - 1e-12) return { side: 'UP', ask: upAsk };
  if (downDist < upDist - 1e-12) return { side: 'DOWN', ask: downAsk };
  return upAsk <= downAsk ? { side: 'UP', ask: upAsk } : { side: 'DOWN', ask: downAsk };
}

function placeOrFillBuy(state, tick, side, qty, source, params) {
  if (params.fillMode !== 'resting_maker') {
    const fillPrice = resolveFillPrice(tick, side, params);
    if (fillPrice == null) return false;
    return applyBuy(state, side, qty, fillPrice, tick, source, params);
  }

  const bid = sideBid(tick, side);
  const ask = sideAsk(tick, side);
  if (bid == null || ask == null || !(bid > 0) || !(bid < 1) || bid >= ask) {
    // marketable / invalid → taker fallback no ask
    const fillPrice = resolveFillPrice(tick, side, { ...params, fillMode: 'taker' });
    if (fillPrice == null) return false;
    return applyBuy(state, side, qty, fillPrice, tick, source, params, 'taker');
  }

  // substitui resting anterior
  if (state.restingBuy) {
    state.restingBuy = null;
  }
  state.restingBuy = {
    side,
    price: bid,
    qty,
    source,
    placedTs: tick?.ts,
    placedMs: tickTimeMs(tick),
  };
  state.stats.restingPlaced += 1;
  return false; // ainda não preencheu
}

function checkRestingBuy(state, tick, params) {
  const resting = state.restingBuy;
  if (!resting) return false;
  const nowMs = tickTimeMs(tick);
  if (nowMs != null && resting.placedMs != null) {
    if (nowMs - resting.placedMs >= params.makerTimeoutSec * 1000) {
      state.stats.restingTimedOut += 1;
      state.restingBuy = null;
      return false;
    }
  }
  const ask = sideAsk(tick, resting.side);
  if (ask == null) return false;
  // fill quando ask atravessa o limite (bid) + epsilon
  if (ask > resting.price + params.makerFillEpsilon + 1e-12) return false;
  const fillPrice = clamp(resting.price, 0.01, 0.99);
  const ok = applyBuy(state, resting.side, resting.qty, fillPrice, tick, resting.source || 'resting', params, 'maker');
  state.restingBuy = null;
  if (ok) {
    if (!state.opened && inventoryStats(state).fillCount > 0) state.opened = true;
    maybeLock(state, params);
  }
  return ok;
}

function trySeed(state, tick, params) {
  const secInto = secondsInto(tick);
  const secsLeft = secondsRemaining(tick);
  if (secInto == null || secsLeft == null) return;
  if (secInto > params.maxSecToOpen) return;
  if (secsLeft < params.minSecondsLeftToEnter) return;
  if (!qualityOk(tick, params)) return;

  const seed = pickSeedSide(tick, params);
  if (!seed) return;
  const seedPx = resolveFillPrice(tick, seed.side, params);
  if (seedPx == null) return;

  if (params.seedHedgeSameTick) {
    const opposite = seed.side === 'UP' ? 'DOWN' : 'UP';
    const oppAsk = sideAsk(tick, opposite);
    const oppPx = resolveFillPrice(tick, opposite, params);
    if (oppPx == null) return;
    // gate no ask cru (independente do fillMode)
    const projectedAvgSum = seed.ask + (oppAsk ?? 1);
    if (projectedAvgSum > params.openMaxAvgSum + 1e-12) return;
    if (params.fillMode === 'resting_maker') {
      // seed dual: fill imediato no bid (optimistic); resting só no path de build
      const seedParams = { ...params, fillMode: 'optimistic_maker' };
      const sPx = resolveFillPrice(tick, seed.side, seedParams);
      const oPx = resolveFillPrice(tick, opposite, seedParams);
      if (sPx == null || oPx == null) return;
      const ok1 = applyBuy(state, seed.side, params.openShares, sPx, tick, 'seed', seedParams, 'maker');
      if (!ok1) return;
      applyBuy(state, opposite, params.hedgeShares, oPx, tick, 'seed_hedge', seedParams, 'maker');
    } else {
      const ok1 = applyBuy(state, seed.side, params.openShares, seedPx, tick, 'seed', params);
      if (!ok1) return;
      applyBuy(state, opposite, params.hedgeShares, oppPx, tick, 'seed_hedge', params);
    }
  } else {
    const opposite = seed.side === 'UP' ? 'DOWN' : 'UP';
    const oppAsk = sideAsk(tick, opposite);
    placeOrFillBuy(state, tick, seed.side, params.openShares, 'seed', params);
    if (inventoryStats(state).fillCount > 0) {
      state.openSide = seed.side;
      state.oppAskAtOpen = oppAsk;
      state.openedSecInto = secInto;
    }
  }
  if (inventoryStats(state).fillCount > 0 || state.restingBuy) state.opened = true;
  maybeLock(state, params);
}

function tryHedgeOpposite(state, tick, params) {
  const stats = inventoryStats(state);
  if (stats.upShares > 0 && stats.downShares > 0) return false;
  if (stats.upShares <= 0 && stats.downShares <= 0) return false;
  if (!qualityOk(tick, params)) return false;
  const secsLeft = secondsRemaining(tick);
  if (secsLeft == null || secsLeft < params.minSecondsLeftToEnter) return false;
  const secInto = secondsInto(tick);
  if (secInto != null && secInto > params.maxSecToHedge) return false;

  const needSide = stats.upShares > 0 ? 'DOWN' : 'UP';
  const heldSide = needSide === 'UP' ? 'DOWN' : 'UP';
  const ask = sideAsk(tick, needSide);
  if (ask == null) return false;

  const heldAvg = heldSide === 'UP' ? stats.avgUp : stats.avgDown;
  const projectedPair = (heldAvg ?? 0.5) + ask;
  const waited = state.openedSecInto != null && secInto != null
    ? secInto - state.openedSecInto
    : (secInto ?? 0);
  const improvedVsOpen = state.oppAskAtOpen != null && ask <= state.oppAskAtOpen - 0.01 + 1e-12;
  const prefer = ask <= params.hedgePreferAsk + 1e-12;
  const goodPair = projectedPair <= params.hedgeTargetAvgSum + 1e-12;
  const urgentCheap = ask <= params.chaseMaxAsk + 1e-12;
  const timedOut = waited >= Math.max(params.minSecToHedge, params.maxSecToHedge * 0.5)
    && ask <= params.hedgeMaxAsk + 1e-12;

  if (ask > params.hedgeMaxAsk + 1e-12 && !urgentCheap) return false;
  if (waited < params.minSecToHedge && !urgentCheap) return false;
  // Doggy waits ~18s med: hedge when prefer/good pair/improved, or timeout half-window
  if (!(prefer || goodPair || improvedVsOpen || urgentCheap || timedOut)) return false;
  if (projectedPair > params.blockAvgSum + 1e-12) return false;

  const fillPrice = resolveFillPrice(tick, needSide, params);
  if (fillPrice == null) return false;
  const qty = params.hedgeShares;
  const proj = projectedAfterBuy(state, needSide, qty, fillPrice);
  if (proj.avgSum != null && proj.avgSum > params.blockAvgSum + 1e-12) return false;

  const ok = placeOrFillBuy(state, tick, needSide, qty, 'seed_hedge', params);
  if (ok) maybeLock(state, params);
  return ok;
}

function trySnapBoth(state, tick, params) {
  if (params.fillMode === 'resting_maker') return false; // snap é taker/mid same-tick
  const upAsk = sideAsk(tick, 'UP');
  const downAsk = sideAsk(tick, 'DOWN');
  if (upAsk == null || downAsk == null) return false;
  if (upAsk + downAsk > params.pairSnapMax + 1e-12) return false;

  const upPx = resolveFillPrice(tick, 'UP', params);
  const downPx = resolveFillPrice(tick, 'DOWN', params);
  if (upPx == null || downPx == null) return false;

  const qty = params.clipShares;
  const tmp = {
    shares: { UP: state.shares.UP + qty, DOWN: state.shares.DOWN + qty },
    cost: {
      UP: state.cost.UP + qty * upPx,
      DOWN: state.cost.DOWN + qty * downPx,
    },
    fills: state.fills,
  };
  const proj = inventoryStats(tmp);
  const stats = inventoryStats(state);
  if (proj.avgSum != null && proj.avgSum > params.blockAvgSum + 1e-12) {
    state.stats.blockedByGate += 1;
    return false;
  }
  if (stats.avgSum != null && proj.avgSum != null && proj.avgSum >= stats.avgSum - 1e-12) {
    return false;
  }
  if (stats.fillCount > 0 && !improvesTowardLock(stats, proj, params)) {
    state.stats.scaleBlocked += 1;
    return false;
  }
  if (state.shares.UP + qty > params.maxSharesPerSide) return false;
  if (state.shares.DOWN + qty > params.maxSharesPerSide) return false;
  if (state.cost.UP + state.cost.DOWN + qty * upPx + qty * downPx > params.maxEventNotional) return false;

  const a = applyBuy(state, 'UP', qty, upPx, tick, 'snap', params);
  const b = applyBuy(state, 'DOWN', qty, downPx, tick, 'snap', params);
  if (a || b) maybeLock(state, params);
  return a || b;
}

function pickBuildLeg(state, tick, params) {
  const stats = inventoryStats(state);
  const underweight = stats.upShares <= stats.downShares ? 'UP' : 'DOWN';
  const overweight = underweight === 'UP' ? 'DOWN' : 'UP';
  const underwater = stats.avgSum != null && stats.avgSum > params.refuseAvgSum + 1e-12;
  const chaseMomo = params.legChoice === 'chase_momo';
  const candidates = [];

  for (const side of ['UP', 'DOWN']) {
    const ask = sideAsk(tick, side);
    const fillPrice = resolveFillPrice(tick, side, params);
    if (fillPrice == null || ask == null) continue;
    const qty = params.clipShares;
    if (state.shares[side] + qty > params.maxSharesPerSide) continue;
    if (!canAfford(state, params, qty, fillPrice)) continue;
    const proj = projectedAfterBuy(state, side, qty, fillPrice);
    if (proj.avgSum != null && proj.avgSum > params.blockAvgSum + 1e-12) continue;

    const isUnder = side === underweight && stats.residual >= params.rebalanceMinResidual - 1e-9;
    const isOver = side === overweight && stats.residual >= params.rebalanceMinResidual - 1e-9;
    const isFlat = stats.residual <= params.rebalanceMinResidual + 1e-9;
    const isChase = ask <= params.chaseMaxAsk + 1e-12;
    const isUltraChase = ask <= params.chaseOverweightMaxAsk + 1e-12;
    const improvesAvg = stats.avgSum == null || (proj.avgSum != null && proj.avgSum < stats.avgSum - 1e-12);
    const hasCushion = stats.avgSum != null && stats.avgSum <= params.stopAvgSum + 1e-12;
    const dAsk = askDelta(state, side, params.momoLookbackSec);
    const inMomoBand = ask >= params.momoMinAsk - 1e-12 && ask <= params.momoMaxAsk + 1e-12;
    const isMomo = dAsk != null && dAsk >= params.momoMinRise - 1e-12 && inMomoBand;
    const isRev = dAsk != null && dAsk <= -params.momoMinRise + 1e-12;

    if (params.forbidOverweight && isOver && !isFlat) {
      // RE Doggy: pós-dual quase nunca compra overweight
      if (!(isUltraChase && improvesAvg)) continue;
    }

    if (!chaseMomo && underwater && !improvesAvg) continue;

    if (isChase && !isUnder && !isFlat) {
      if (!isUltraChase) continue;
      if (proj.residual > params.maxResidualShares + 1e-9) continue;
    }

    let allowed = false;
    if (chaseMomo) {
      // Motor: clip no lado que sobe (MOMO), preferindo underweight / flat→tilt limitado
      if (isMomo && (isUnder || isFlat) && proj.residual <= params.maxResidualShares + 1e-9) {
        if (proj.avgSum == null || proj.avgSum <= params.blockAvgSum + 1e-12) allowed = true;
      }
      // Container: rebalance underweight — com momoBlockFade só cheap chase (≤chaseMaxAsk),
      // senão mid-band FADE/REV ainda entra via ask≤rebalanceMaxAsk (0.70).
      if (!allowed && isUnder && !isMomo) {
        const containerAskOk = params.momoBlockFade
          ? ask <= params.chaseMaxAsk + 1e-12
          : ask <= params.rebalanceMaxAsk + 1e-12;
        if (containerAskOk && (improvesAvg || (hasCushion && proj.avgSum != null && proj.avgSum <= params.refuseAvgSum + 1e-12))) {
          allowed = true;
        }
      }
      // Late cheap chase still ok
      if (!allowed && isChase && improvesAvg && (isUnder || isFlat || isUltraChase)) allowed = true;
    } else {
      if (isChase && improvesAvg && (isUnder || isFlat || isUltraChase)) allowed = true;
      if (!underwater && isUnder && ask <= params.rebalanceMaxAsk + 1e-12) {
        if (proj.avgSum == null || proj.avgSum <= params.buildMaxAvgSum + 1e-12) allowed = true;
      }
      const nearLock = stats.avgSum != null && stats.avgSum <= params.refuseAvgSum + 1e-12;
      if ((hasCushion || nearLock) && isUnder && ask <= params.rebalanceCushionAsk + 1e-12) {
        if (proj.avgSum == null || proj.avgSum <= params.refuseAvgSum + 1e-12) allowed = true;
      }
      if (!underwater && improvesAvg && isUnder && proj.avgSum != null && proj.avgSum <= params.buildMaxAvgSum + 1e-12) {
        allowed = true;
      }
    }
    if (params.buildOnlyImprove && !improvesAvg && !(hasCushion && isUnder) && !(chaseMomo && isMomo)) {
      allowed = false;
    }
    if (!allowed) continue;

    const towardLock = improvesTowardLock(stats, proj, params);
    const momoTiltOk = chaseMomo && isMomo && (isUnder || isFlat)
      && proj.residual <= params.maxResidualShares + 1e-9;
    if (!towardLock && !momoTiltOk) {
      state.stats.scaleBlocked += 1;
      continue;
    }

    let score = 0;
    if (chaseMomo) {
      if (isMomo && dAsk != null) score += dAsk * 250 + 40;
      if (isRev) score -= 20;
      if (isUnder) score += 20;
      if (improvesAvg && stats.avgSum != null && proj.avgSum != null) {
        score += (stats.avgSum - proj.avgSum) * 30; // secundário
      }
      if (isChase) score += 10;
    } else {
      if (improvesAvg && stats.avgSum != null && proj.avgSum != null) {
        score += (stats.avgSum - proj.avgSum) * 120;
      }
      if (isChase) score += 25 + (params.chaseMaxAsk - ask) * 50;
      if (isUnder) score += hasCushion ? 45 : 25;
      if (proj.balance > stats.balance) score += (proj.balance - stats.balance) * 30;
      if (!isUnder && stats.residual > 20) score -= 12;
    }
    candidates.push({
      side,
      fillPrice,
      qty,
      score,
      proj,
      source: (chaseMomo && isMomo) ? 'momo' : (isChase ? 'chase' : (isUnder ? 'rebalance' : 'build')),
      dAsk,
      isMomo,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function tryBuild(state, tick, params) {
  const secsLeft = secondsRemaining(tick);
  if (secsLeft == null || secsLeft < params.minSecondsLeftToEnter) return;
  if (!qualityOk(tick, params)) return;
  // Etapa 7: rebalance/build NÃO pode completar o hedge — senão bypassa minSecToHedge
  // (Doggy: seed → espera → hedge; lab antigo fazia seed+rebalance no mesmo tick).
  const opened = inventoryStats(state);
  if (opened.upShares <= 0 || opened.downShares <= 0) return;
  if (trySnapBoth(state, tick, params)) return;

  const leg = pickBuildLeg(state, tick, params);
  if (!leg) {
    state.stats.blockedByGate += 1;
    return;
  }
  placeOrFillBuy(state, tick, leg.side, leg.qty, leg.source || 'build', params);
  maybeLock(state, params);
}

function tryVacuum(state, tick, params) {
  const secsLeft = secondsRemaining(tick);
  if (secsLeft == null || secsLeft < params.minSecondsLeftToEnter) return;
  if (!qualityOk(tick, params)) return;

  const stats = inventoryStats(state);
  if (stats.residualSide === 'FLAT' || stats.residual <= 1e-9) {
    maybeLock(state, params);
    return;
  }
  if (params.lateRequireResidual && stats.residual <= 1e-9) {
    maybeLock(state, params);
    return;
  }

  const side = stats.upShares <= stats.downShares ? 'UP' : 'DOWN';
  const ask = sideAsk(tick, side);
  if (ask == null) return;

  let qty = null;
  let source = 'vacuum';
  if (ask <= params.lateUltraAsk + 1e-12) {
    qty = params.lateUltraClipShares;
    source = 'vacuum_ultra';
  } else if (ask <= params.lateMaxAsk + 1e-12) {
    qty = params.lateClipShares;
  } else {
    return;
  }

  qty = Math.min(qty, Math.max(1, Math.ceil(stats.residual)));

  const fillPrice = resolveFillPrice(tick, side, params);
  if (fillPrice == null) return;
  const proj = projectedAfterBuy(state, side, qty, fillPrice);
  if (params.lateOnlyImprove) {
    const improvesAvg = stats.avgSum == null || (proj.avgSum != null && proj.avgSum < stats.avgSum - 1e-12);
    const reducesResidual = proj.residual < stats.residual - 1e-9;
    const hasCushion = stats.avgSum != null && stats.avgSum <= params.stopAvgSum + 1e-12;
    if (!reducesResidual) return;
    if (!improvesAvg && !(hasCushion && proj.avgSum != null && proj.avgSum <= params.refuseAvgSum + 1e-12)) {
      if (proj.avgSum != null && proj.avgSum > stats.avgSum + 1e-12) return;
    }
  }
  if (proj.avgSum != null && proj.avgSum > params.blockAvgSum + 1e-12) {
    state.stats.blockedByGate += 1;
    return;
  }

  placeOrFillBuy(state, tick, side, qty, source, params);
  maybeLock(state, params);
}

function evaluateTick(state, tick, params) {
  recordAskHistory(state, tick);
  checkRestingBuy(state, tick, params);
  if (state.locked) {
    // Doggy Etapa 2: após soft-lock (avg≤0.95) continua chase under + vacuum — sem hard exit.
    const secInto = secondsInto(tick);
    if (params.softLockAllowBuild) {
      tryHedgeOpposite(state, tick, params);
      tryBuild(state, tick, params);
    }
    if (params.softLockAllowVacuum && secInto != null && secInto >= params.lateStartSec) {
      tryVacuum(state, tick, params);
    }
    return;
  }
  const stats = inventoryStats(state);
  if (stats.fillCount >= params.maxFillsPerEvent) return;

  const secInto = secondsInto(tick);

  if (!state.opened) {
    if (secInto != null && secInto <= params.maxSecToOpen) {
      trySeed(state, tick, params);
    }
    if (!state.opened && trySnapBoth(state, tick, params)) {
      state.opened = true;
      maybeLock(state, params);
      return;
    }
    if (!state.opened && secInto != null && secInto >= params.lateStartSec) {
      if (params.lateOrphanAllowed) {
        tryVacuum(state, tick, params);
        if (inventoryStats(state).fillCount > 0) state.opened = true;
      }
    }
    return;
  }

  if (secInto != null && secInto >= params.lateStartSec) {
    tryHedgeOpposite(state, tick, params);
    tryVacuum(state, tick, params);
    tryBuild(state, tick, params);
    return;
  }
  if (!tryHedgeOpposite(state, tick, params)) {
    tryBuild(state, tick, params);
  }
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeParams(rawParams);
  let current = null;
  const completedEvents = new Set();
  const events = [];
  const equity = [];
  const log = [];
  let ticksProcessed = 0;
  let totalEvents = 0;
  let totalEntries = 0;
  let totalNoEntry = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnl = 0;
  let lockedEvents = 0;
  let vacuumEvents = 0;
  let periodStart = null;
  let periodEnd = null;

  const finalizeCurrentEvent = (reason = 'expired', closedAt = null) => {
    if (!current) return;
    completedEvents.add(current.key);
    const stats = inventoryStats(current);
    const entered = stats.fillCount > 0;
    const last = current.lastTick;
    const btcPrice = toFiniteNumber(last?.btc_price);
    const ptb = toFiniteNumber(current.priceToBeat, toFiniteNumber(last?.price_to_beat));
    const winnerSide = btcPrice != null && ptb != null && btcPrice >= ptb ? 'UP' : 'DOWN';

    let grossPnl = 0;
    if (entered) {
      const winnerShares = winnerSide === 'UP' ? current.shares.UP : current.shares.DOWN;
      grossPnl = winnerShares - stats.totalCost;
      totalPnl += grossPnl;
      totalEntries += 1;
      if (grossPnl > 0) totalWins += 1;
      else if (grossPnl < 0) totalLosses += 1;
      if (current.locked) lockedEvents += 1;
      if (current.stats.vacuumFills > 0) vacuumEvents += 1;
    } else {
      totalNoEntry += 1;
    }

    const allFills = [
      ...current.fills.UP.map((f) => ({ ...f, side: 'UP' })),
      ...current.fills.DOWN.map((f) => ({ ...f, side: 'DOWN' })),
    ].sort((a, b) => String(a.time).localeCompare(String(b.time)));

    const orders = allFills.map((f) => ({
      type: 'entry',
      side: f.side,
      source: f.source,
      createdAt: f.time,
      shares: f.qty,
      filledQty: f.qty,
      avgPrice: f.price,
      price: f.price,
      cost: f.qty * f.price,
      notional: f.qty * f.price,
      liquidity: f.liquidity || 'taker',
      fills: [{ price: f.price, qty: f.qty, liquidity: f.liquidity || 'taker', side: f.side, time: f.time }],
    }));

    const finalTs = closedAt || current.eventEnd || last?.ts || current.eventStart;
    events.push({
      eventId: current.conditionId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd,
      entryTime: allFills[0]?.time ?? null,
      exitTime: finalTs,
      reason: entered ? reason : 'no_entry',
      positionType: entered ? 'BOTH' : null,
      winnerSide,
      quantity: current.shares.UP + current.shares.DOWN,
      upShares: current.shares.UP,
      downShares: current.shares.DOWN,
      cost: stats.totalCost,
      avgUp: stats.avgUp,
      avgDown: stats.avgDown,
      avgSum: stats.avgSum,
      balance: stats.balance,
      residual: stats.residual,
      locked: current.locked,
      lockReason: current.lockReason,
      vacuumFills: current.stats.vacuumFills,
      blockedByGate: current.stats.blockedByGate,
      scaleBlocked: current.stats.scaleBlocked,
      restingFilled: current.stats.restingFilled,
      fillCount: stats.fillCount,
      finalPnl: grossPnl,
      finalPnlBeforeFees: grossPnl,
      orders,
      fills: allFills,
    });
    equity.push({ ts: finalTs, pnl: totalPnl });
    if (entered) {
      log.push({
        ts: finalTs,
        type: grossPnl >= 0 ? 'profit' : 'loss',
        msg: `PAIR_LADDER | avgSum=${stats.avgSum?.toFixed?.(4) ?? 'n/a'} bal=${stats.balance.toFixed(3)} locked=${current.locked} pnl=${grossPnl.toFixed(2)}`,
      });
    }
    current = null;
  };

  const processTick = (tick) => {
    ticksProcessed += 1;
    if (!periodStart) periodStart = tick?.ts;
    periodEnd = tick?.ts;
    const key = eventKey(tick);
    if (!current && completedEvents.has(key)) return;

    if (!current || current.key !== key) {
      if (current) finalizeCurrentEvent('expired', current.eventEnd || current.lastTick?.ts);
      if (completedEvents.has(key)) return;
      current = createEventState(tick);
      totalEvents += 1;
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick?.price_to_beat);
    const nowMs = tickTimeMs(tick);
    const endMs = eventEndMs(tick);
    if (nowMs != null && endMs != null && nowMs >= endMs) {
      finalizeCurrentEvent('expired', tick?.event_end || tick?.ts);
      return;
    }
    evaluateTick(current, tick, params);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd || current.lastTick?.ts);
    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equity) {
      if (point.pnl > peak) peak = point.pnl;
      maxDrawdown = Math.max(maxDrawdown, peak - point.pnl);
    }
    return {
      params,
      strategy: 'PAIR_LADDER_COMPLETE_SET_V1',
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins,
        totalLosses,
        winRate: totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0,
        totalPnl,
        avgPnl: totalEntries > 0 ? totalPnl / totalEntries : 0,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
        lockedEvents,
        vacuumEvents,
        mode: params.mode,
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

function runPairLadderCompleteSetBacktest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

var __pairLadderCompleteSetExports = {
  DEFAULT_PARAMS,
  mergeParams,
  inventoryStats,
  projectedAfterBuy,
  pickSeedSide,
  takerFillPrice,
  resolveFillPrice,
  improvesTowardLock,
  askDelta,
  createBacktestRunner,
  runPairLadderCompleteSetBacktest,
};
