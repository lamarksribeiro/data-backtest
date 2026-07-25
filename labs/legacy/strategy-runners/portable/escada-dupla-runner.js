/**
 * Escada Dupla V1 — library runner (lab-first).
 *
 * Mecânica: grade SUB/DESC dual, re-arme em par, multiplicador SUB,
 * líder 55¢ = taker, lado oposto = maker (fee 0), equalização ≤5¢.
 *
 * Surface de testes: __escadaExports
 */
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

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clampCents(c) {
  return Math.min(99, Math.max(1, Math.round(Number(c) * 10) / 10));
}

const DEFAULT_SUB = [
  [55, 30], [60, 20], [65, 20], [70, 20], [75, 20], [80, 20], [85, 20], [90, 10],
];
const DEFAULT_DESC = [
  [45, 10], [40, 10], [35, 10], [30, 10], [25, 10], [20, 10], [15, 10], [10, 10],
];

const DEFAULT_PARAMS = {
  walletSize: 100,
  sideMultiplier: 1, // default conservador; 2+ amplifica chicote
  leaderThresholdCents: 55,
  equalizeMaxAskCents: 5,
  equalizeEnabled: true,
  liquidityMode: 'auto', // auto | taker | maker
  executionMode: 'optimistic_maker', // optimistic_maker | resting_maker | touch_maker | taker
  // touch_maker: taker com walk+slip; maker posta no limit; fill se ask já atravessou (DESC/hedge).
  makerPostMode: 'auto', // auto | limit | bid — auto: limit em touch_maker, bid em resting_maker
  throughFillOnTrigger: true, // touch_maker: se ask<=limit no disparo, fill maker imediato
  rearmOnMakerCancel: true, // reaponta nível se resting cancelar sem fill
  // formula = halfSpread+slip (realista leve); walk = book; capped = min(walk, formula+takerMaxExtraCents)
  takerPriceMode: 'auto', // auto | formula | walk | capped
  takerMaxExtraCents: 2, // só em capped: teto acima da fórmula
  ladderProfile: 'ascent_hedge',
  rearmMode: 'off', // full | once | off — em ascent_hedge força off
  maxSubLevels: 8, // 0 = todos; holdout julho campeão usa 8
  maxDescLevels: 4,
  // Freio: com os dois lados, se médiaUP+médiaDOWN (¢) > teto, para novas compras (eq ainda pode)
  maxPairAvgSumCents: 98,
  // Janela de início: só começa escada se tau ∈ [minStart, maxStart]
  minSecondsLeftToStart: 45,
  maxSecondsLeftToStart: 240,
  spreadCents: 1,
  slippageCents: 0,
  equalizeExtraSlipCents: 0,
  makerFillEpsilon: 0.01,
  makerTimeoutSec: 30,
  maxSharesPerSide: 400,
  maxEventNotional: 80,
  // Escala proporcional da escada (shares + caps). 1 = budget campeão (~$80/evento).
  sizeScale: 1,
  minSecondsLeftToEnter: 15, // legado: corta fills tardios sem posição
  fallbackBookSize: 0,
  applyPolymarketFees: true,
  polymarketFeeCategory: 'crypto',
  subLevels: null,
  descLevels: null,
};

function resolveExecutionMode(raw = {}) {
  const mode = String(raw.executionMode ?? DEFAULT_PARAMS.executionMode).trim().toLowerCase();
  if (mode === 'optimistic_maker' || mode === 'optimistic') return 'optimistic_maker';
  if (mode === 'resting_maker' || mode === 'resting') return 'resting_maker';
  if (mode === 'touch_maker' || mode === 'touch') return 'touch_maker';
  if (mode === 'taker') return 'taker';
  return 'optimistic_maker';
}

function resolveMakerPostMode(raw = {}, executionMode = 'optimistic_maker') {
  const mode = String(raw.makerPostMode ?? DEFAULT_PARAMS.makerPostMode).trim().toLowerCase();
  if (mode === 'limit' || mode === 'bid') return mode;
  if (executionMode === 'touch_maker') return 'limit';
  return 'bid';
}

function resolveTakerPriceMode(raw = {}, executionMode = 'optimistic_maker') {
  const mode = String(raw.takerPriceMode ?? DEFAULT_PARAMS.takerPriceMode).trim().toLowerCase();
  if (mode === 'formula' || mode === 'walk' || mode === 'capped') return mode;
  if (executionMode === 'optimistic_maker') return 'formula';
  if (executionMode === 'touch_maker') return 'capped';
  return 'walk'; // resting_maker / taker: book walk honesto
}

function resolveLiquidityMode(raw = {}) {
  const mode = String(raw.liquidityMode ?? 'auto').trim().toLowerCase();
  if (mode === 'taker' || mode === 'maker' || mode === 'auto') return mode;
  return 'auto';
}

function parseLevels(raw, fallback) {
  if (!Array.isArray(raw) || !raw.length) {
    return fallback.map(([price, shares], i) => ({
      tipo: fallback === DEFAULT_SUB ? 'SUB' : 'DESC',
      idx: i + 1,
      preco: price,
      shares,
    }));
  }
  return raw.map((row, i) => {
    if (Array.isArray(row)) {
      return { tipo: fallback === DEFAULT_SUB ? 'SUB' : 'DESC', idx: i + 1, preco: Number(row[0]), shares: Number(row[1]) };
    }
    return {
      tipo: row.tipo || (fallback === DEFAULT_SUB ? 'SUB' : 'DESC'),
      idx: Number(row.idx) || i + 1,
      preco: Number(row.preco ?? row.price),
      shares: Number(row.shares ?? row.size),
    };
  }).filter((n) => n.preco > 0 && n.shares > 0);
}

function resolveLadderProfile(raw = {}) {
  const p = String(raw.ladderProfile ?? DEFAULT_PARAMS.ladderProfile).trim().toLowerCase();
  if (p === 'oscillate' || p === 'full' || p === 'html') return 'oscillate';
  return 'ascent_hedge';
}

function resolveRearmMode(raw = {}, ladderProfile = 'ascent_hedge') {
  if (ladderProfile === 'ascent_hedge') return 'off';
  const m = String(raw.rearmMode ?? DEFAULT_PARAMS.rearmMode).trim().toLowerCase();
  if (m === 'full' || m === 'once' || m === 'off') return m;
  return 'off';
}

function mergeEscadaParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS, ...raw };
  const sizeScale = clamp(toFiniteNumber(raw.sizeScale, DEFAULT_PARAMS.sizeScale), 0.05, 5);
  params.sizeScale = sizeScale;
  params.sideMultiplier = Math.max(1, Math.round(toFiniteNumber(raw.sideMultiplier, DEFAULT_PARAMS.sideMultiplier)));
  params.leaderThresholdCents = toFiniteNumber(raw.leaderThresholdCents, DEFAULT_PARAMS.leaderThresholdCents);
  params.equalizeMaxAskCents = toFiniteNumber(raw.equalizeMaxAskCents, DEFAULT_PARAMS.equalizeMaxAskCents);
  params.equalizeEnabled = toBool(raw.equalizeEnabled, DEFAULT_PARAMS.equalizeEnabled);
  params.spreadCents = Math.max(0, toFiniteNumber(raw.spreadCents, DEFAULT_PARAMS.spreadCents));
  params.slippageCents = Math.max(0, toFiniteNumber(raw.slippageCents, DEFAULT_PARAMS.slippageCents));
  params.equalizeExtraSlipCents = Math.max(0, toFiniteNumber(raw.equalizeExtraSlipCents, DEFAULT_PARAMS.equalizeExtraSlipCents));
  params.makerFillEpsilon = toFiniteNumber(raw.makerFillEpsilon, DEFAULT_PARAMS.makerFillEpsilon);
  params.makerTimeoutSec = toFiniteNumber(raw.makerTimeoutSec, DEFAULT_PARAMS.makerTimeoutSec);
  params.maxSharesPerSide = toFiniteNumber(raw.maxSharesPerSide, DEFAULT_PARAMS.maxSharesPerSide);
  params.maxEventNotional = toFiniteNumber(raw.maxEventNotional, DEFAULT_PARAMS.maxEventNotional);
  params.minSecondsLeftToEnter = toFiniteNumber(raw.minSecondsLeftToEnter, DEFAULT_PARAMS.minSecondsLeftToEnter);
  params.minSecondsLeftToStart = toFiniteNumber(raw.minSecondsLeftToStart, DEFAULT_PARAMS.minSecondsLeftToStart);
  params.maxSecondsLeftToStart = toFiniteNumber(raw.maxSecondsLeftToStart, DEFAULT_PARAMS.maxSecondsLeftToStart);
  params.maxPairAvgSumCents = toFiniteNumber(raw.maxPairAvgSumCents, DEFAULT_PARAMS.maxPairAvgSumCents);
  params.maxSubLevels = Math.max(0, Math.round(toFiniteNumber(raw.maxSubLevels, DEFAULT_PARAMS.maxSubLevels)));
  params.maxDescLevels = Math.max(0, Math.round(toFiniteNumber(raw.maxDescLevels, DEFAULT_PARAMS.maxDescLevels)));
  params.walletSize = toFiniteNumber(raw.walletSize, DEFAULT_PARAMS.walletSize);
  params.executionMode = resolveExecutionMode(raw);
  params.liquidityMode = resolveLiquidityMode(raw);
  params.ladderProfile = resolveLadderProfile(raw);
  params.rearmMode = resolveRearmMode(raw, params.ladderProfile);
  params.makerPostMode = resolveMakerPostMode(raw, params.executionMode);
  params.throughFillOnTrigger = toBool(raw.throughFillOnTrigger, DEFAULT_PARAMS.throughFillOnTrigger);
  params.rearmOnMakerCancel = toBool(raw.rearmOnMakerCancel, DEFAULT_PARAMS.rearmOnMakerCancel);
  params.takerPriceMode = resolveTakerPriceMode(raw, params.executionMode);
  params.takerMaxExtraCents = Math.max(0, toFiniteNumber(raw.takerMaxExtraCents, DEFAULT_PARAMS.takerMaxExtraCents));

  if (sizeScale !== 1) {
    params.maxSharesPerSide = Math.round(params.maxSharesPerSide * sizeScale * 100) / 100;
    params.maxEventNotional = Math.round(params.maxEventNotional * sizeScale * 100) / 100;
    params.walletSize = Math.round(params.walletSize * sizeScale * 100) / 100;
  }

  let sub = parseLevels(raw.subLevels, DEFAULT_SUB).map((n) => ({ ...n, tipo: 'SUB' }));
  let desc = parseLevels(raw.descLevels, DEFAULT_DESC).map((n) => ({ ...n, tipo: 'DESC' }));
  if (params.maxSubLevels > 0) sub = sub.slice(0, params.maxSubLevels);
  if (params.maxDescLevels > 0) desc = desc.slice(0, params.maxDescLevels);
  if (sizeScale !== 1) {
    const scaleShares = (n) => ({
      ...n,
      shares: Math.max(0.01, Math.round(n.shares * sizeScale * 100) / 100),
    });
    sub = sub.map(scaleShares);
    desc = desc.map(scaleShares);
  }
  params.subLevels = sub;
  params.descLevels = desc;
  return params;
}

function pairAvgSumCents(shares, cost) {
  if (!(shares.UP > 0) || !(shares.DOWN > 0)) return null;
  const medUp = (cost.UP / shares.UP) * 100;
  const medDn = (cost.DOWN / shares.DOWN) * 100;
  return medUp + medDn;
}

/** Perfil ascent_hedge: no líder só SUB; no oposto só DESC. */
function levelAllowedForProfile(lado, nivel, leaderSide, ladderProfile) {
  if (ladderProfile !== 'ascent_hedge' || !leaderSide) return true;
  if (lado === leaderSide) return nivel.tipo === 'SUB';
  return nivel.tipo === 'DESC';
}

function shouldFillRestingBuy(prevAsk, currAsk, limitPrice, epsilon = 0.01) {
  if (prevAsk == null || currAsk == null || limitPrice == null) return false;
  if (!Number.isFinite(prevAsk) || !Number.isFinite(currAsk) || !Number.isFinite(limitPrice)) return false;
  return prevAsk >= limitPrice && currAsk <= limitPrice - epsilon;
}

function resolveLiquidityForSide(lado, leaderSide, liquidityMode) {
  if (liquidityMode === 'maker') return 'maker';
  if (liquidityMode === 'taker') return 'taker';
  if (!leaderSide) return 'taker';
  return lado === leaderSide ? 'taker' : 'maker';
}

function buyFillPriceCents(limitCents, liquidity, params, extraSlip = 0) {
  const lim = Number(limitCents);
  if (!(lim > 0)) return lim;
  if (liquidity === 'maker') return clampCents(lim);
  const half = (params.spreadCents || 0) / 2;
  return clampCents(lim + half + (params.slippageCents || 0) + (extraSlip || 0));
}

function parseBookLevels(rawLevels, direction = 'ask') {
  let levels = rawLevels;
  if (typeof rawLevels === 'string') {
    try { levels = JSON.parse(rawLevels); } catch { levels = []; }
  }
  if (!Array.isArray(levels)) return [];
  const parsed = levels
    .map((level) => ({ price: toFiniteNumber(level?.price), size: toFiniteNumber(level?.size) }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.size > 0);
  return parsed.sort((a, b) => (direction === 'bid' ? b.price - a.price : a.price - b.price));
}

function walkBook(rawAsks, sharesDesejadas, bestAsk) {
  const levels = parseBookLevels(rawAsks, 'ask');
  if (!levels.length) return { avgPrice: bestAsk };
  let restante = sharesDesejadas;
  let custo = 0;
  let execSh = 0;
  let ultimo = levels[0].price;
  for (const level of levels) {
    if (restante <= 1e-9) break;
    ultimo = level.price;
    const se = Math.min(restante, level.size);
    if (se <= 0) continue;
    execSh += se;
    custo += se * level.price;
    restante -= se;
  }
  if (restante > 1e-9) {
    custo += restante * ultimo;
    execSh += restante;
  }
  return { avgPrice: execSh > 0 ? custo / execSh : bestAsk };
}

function sideFields(tick, side) {
  if (side === 'UP') {
    const fallback = toFiniteNumber(tick.up_price);
    return {
      ask: toFiniteNumber(tick.up_best_ask, fallback),
      bid: toFiniteNumber(tick.up_best_bid, fallback),
      rawAsks: tick.up_book_asks,
      price: fallback,
    };
  }
  const fallback = toFiniteNumber(tick.down_price);
  return {
    ask: toFiniteNumber(tick.down_best_ask, fallback),
    bid: toFiniteNumber(tick.down_best_bid, fallback),
    rawAsks: tick.down_book_asks,
    price: fallback,
  };
}

function eventKey(tickOrState) {
  const raw = tickOrState.event_start ?? tickOrState.eventStart;
  const eventStart = raw instanceof Date ? raw.toISOString() : new Date(raw).toISOString();
  return `${eventStart}|${tickOrState.condition_id ?? tickOrState.eventId}`;
}

function secondsRemaining(state, tick) {
  return Math.max(0, (state.eventEndMs - new Date(tick.ts).getTime()) / 1000);
}

function buildLadder(params) {
  const levels = [];
  for (const n of params.subLevels) levels.push({ ...n, armado: true, vezes: 0 });
  for (const n of params.descLevels) levels.push({ ...n, armado: true, vezes: 0 });
  return { UP: levels.map((n) => ({ ...n })), DOWN: levels.map((n) => ({ ...n })) };
}

function createEventState(tick, params) {
  const eventStartMs = new Date(tick.event_start).getTime();
  return {
    eventId: tick.condition_id,
    eventStart: new Date(tick.event_start).toISOString(),
    eventEndMs: eventStartMs + 300000,
    priceToBeat: toFiniteNumber(tick.price_to_beat),
    lastTick: tick,
    leaderSide: null,
    ladder: buildLadder(params),
    subEntryCountByIdx: new Map(),
    shares: { UP: 0, DOWN: 0 },
    cost: { UP: 0, DOWN: 0 },
    fills: { UP: [], DOWN: [] },
    restingOrders: [], // multi-resting no lado maker
    restingStats: { placed: 0, filled: 0, cancelled: 0, rejected: 0 },
    equalized: false,
    frozenByPairEdge: false,
    startedLadder: false,
    rearmCount: new Map(), // key `${lado}|${tipo}|${idx}` → rearms feitos
    lastDiagnostics: null,
  };
}

function detectLeader(askUpC, askDownC, threshold, currentLeader) {
  if (currentLeader) return currentLeader;
  if (askUpC >= threshold) return 'UP';
  if (askDownC >= threshold) return 'DOWN';
  return null;
}

/**
 * Simula um caminho de odds UP em centavos (sintético — lab/paridade).
 * Retorna inventário e PnL bruto (sem settlement winner → passa winner).
 */
function simulateEscadaPath(paramsRaw, upPathCents, winnerSide) {
  const params = mergeEscadaParams(paramsRaw);
  const ladder = buildLadder(params);
  const subEntryCountByIdx = new Map();
  let leaderSide = null;
  const shares = { UP: 0, DOWN: 0 };
  const cost = { UP: 0, DOWN: 0 };
  const fills = [];
  let equalized = false;

  const applyBuy = (lado, nivel, sh, limitCents, tipoLabel) => {
    if (sh <= 0) return;
    if (shares[lado] + sh > params.maxSharesPerSide) {
      sh = Math.max(0, params.maxSharesPerSide - shares[lado]);
      if (sh <= 0) return;
    }
    const totalNotional = cost.UP + cost.DOWN;
    const liq = resolveLiquidityForSide(lado, leaderSide, params.liquidityMode);
    const fillC = buyFillPriceCents(limitCents, liq, params);
    const addCost = sh * fillC / 100;
    if (totalNotional + addCost > params.maxEventNotional) {
      const room = params.maxEventNotional - totalNotional;
      if (room <= 0) return;
      sh = Math.floor((room / (fillC / 100)) * 100) / 100;
      if (sh <= 0) return;
    }
    const finalCost = sh * fillC / 100;
    shares[lado] += sh;
    cost[lado] += finalCost;
    fills.push({
      lado, tipo: tipoLabel, idx: nivel.idx, tipoBase: nivel.tipo,
      shares: sh, precoLimit: limitCents, preco: fillC, valor: finalCost, liquidity: liq,
    });
    if (nivel.tipo === 'SUB') {
      subEntryCountByIdx.set(nivel.idx, (subEntryCountByIdx.get(nivel.idx) || 0) + 1);
    }
  };

  const step = (upC) => {
    const dnC = 100 - upC;
    leaderSide = detectLeader(upC, dnC, params.leaderThresholdCents, leaderSide);
    if (!leaderSide) return;
    const asks = { UP: upC, DOWN: dnC };

    const pairSum = pairAvgSumCents(shares, cost);
    if (pairSum != null && pairSum > params.maxPairAvgSumCents) {
      // só equaliza abaixo
    } else {
      for (const lado of ['UP', 'DOWN']) {
        const ask = asks[lado];
        for (const n of ladder[lado]) {
          if (!n.armado) continue;
          if (!levelAllowedForProfile(lado, n, leaderSide, params.ladderProfile)) continue;
          const disparaSub = n.tipo === 'SUB' && ask >= n.preco;
          const disparaDesc = n.tipo === 'DESC' && ask <= n.preco;
          if (!disparaSub && !disparaDesc) continue;

          let sh = n.shares;
          if (disparaSub && params.sideMultiplier > 1) {
            const ja = subEntryCountByIdx.get(n.idx) || 0;
            sh = n.shares * Math.pow(params.sideMultiplier, ja);
          }
          n.armado = false;
          n.vezes += 1;
          applyBuy(lado, n, sh, n.preco, `${n.tipo}-${n.idx}`);

          if (params.rearmMode !== 'off') {
            const compTipo = n.tipo === 'SUB' ? 'DESC' : 'SUB';
            const comp = ladder[lado].find((x) => x.tipo === compTipo && x.idx === n.idx);
            if (comp) comp.armado = true;
          }
        }
      }
    }

    if (params.equalizeEnabled && !equalized && shares.UP !== shares.DOWN) {
      const eqLado = shares.UP < shares.DOWN ? 'UP' : 'DOWN';
      const eqAsk = eqLado === 'UP' ? upC : dnC;
      if (eqAsk <= params.equalizeMaxAskCents) {
        const falta = Math.abs(shares.UP - shares.DOWN);
        const lim = params.equalizeMaxAskCents;
        const liq = resolveLiquidityForSide(eqLado, leaderSide, params.liquidityMode);
        const fillC = buyFillPriceCents(lim, liq, params, params.equalizeExtraSlipCents);
        const finalCost = falta * fillC / 100;
        shares[eqLado] += falta;
        cost[eqLado] += finalCost;
        fills.push({
          lado: eqLado, tipo: 'EQUALIZA', shares: falta,
          precoLimit: lim, preco: fillC, valor: finalCost, liquidity: liq,
        });
        equalized = true;
      }
    }
  };

  let cur = upPathCents[0] ?? 50;
  step(cur);
  for (let i = 1; i < upPathCents.length; i++) {
    const target = upPathCents[i];
    const st = target > cur ? 1 : -1;
    if (target === cur) continue;
    for (let p = cur + st; st > 0 ? p <= target : p >= target; p += st) step(p);
    cur = target;
  }

  const inv = cost.UP + cost.DOWN;
  const winSh = winnerSide === 'UP' ? shares.UP : shares.DOWN;
  return {
    leaderSide,
    shares,
    cost,
    inv,
    fills,
    equalized,
    pnlGross: winSh - inv,
    params,
  };
}

function expandPathTargets(targets) {
  const path = [50];
  let cur = 50;
  for (const a of targets) {
    const st = a > cur ? 1 : -1;
    for (let p = cur + st; st > 0 ? p <= a : p >= a; p += st) path.push(p);
    cur = a;
  }
  return path;
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeEscadaParams(rawParams);
  const log = [];
  const events = [];
  const equity = [];
  const completedEvents = new Set();

  let current = null;
  let totalEvents = 0;
  let totalNoEntry = 0;
  let totalEntries = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnl = 0;
  let ticksProcessed = 0;
  let periodStart = null;
  let periodEnd = null;

  const addLog = (ts, msg, type = 'info') => {
    log.push({ ts, msg, type });
  };
  const equityNow = () => Math.max(0, params.walletSize + totalPnl);

  const cancelResting = (key, reason) => {
    if (!current) return;
    const idx = current.restingOrders.findIndex((o) => o.key === key && o.status === 'open');
    if (idx < 0) return;
    const o = current.restingOrders[idx];
    o.status = 'cancelled';
    o.cancelReason = reason;
    current.restingStats.cancelled += 1;
    current.restingOrders.splice(idx, 1);
    if (params.rearmOnMakerCancel && o.rearmLevel) {
      const { lado, tipo, idx: levelIdx } = o.rearmLevel;
      const level = current.ladder[lado]?.find((n) => n.tipo === tipo && n.idx === levelIdx);
      if (level) level.armado = true;
    }
    addLog(current.lastTick?.ts || new Date().toISOString(), `RESTING CANCEL | ${o.side} ${o.tipo} @ ${o.price} | ${reason}`, 'info');
  };

  const applyFill = (lado, qty, fillPrice, type, ts, liquidity, meta = {}) => {
    if (qty <= 0) return 0;
    if (current.shares[lado] + qty > params.maxSharesPerSide) {
      qty = Math.max(0, params.maxSharesPerSide - current.shares[lado]);
      if (qty <= 0) return 0;
    }
    const notional = current.cost.UP + current.cost.DOWN;
    const addCost = qty * fillPrice;
    if (notional + addCost > params.maxEventNotional) {
      const room = params.maxEventNotional - notional;
      if (room <= 0) return 0;
      qty = Math.floor((room / fillPrice) * 1e6) / 1e6;
      if (qty <= 0) return 0;
    }
    const cost = qty * fillPrice;
    current.shares[lado] += qty;
    current.cost[lado] += cost;
    current.fills[lado].push({
      price: fillPrice,
      qty,
      time: ts,
      type,
      liquidity,
      ...meta,
    });
    addLog(ts, `COMPRA Escada | ${lado} ${qty.toFixed(0)}sh @ $${fillPrice.toFixed(4)} | ${type} | ${liquidity}`, 'entry');
    return qty;
  };

  const placeOrFillBuy = (lado, qty, limitCents, type, ts, meta = {}) => {
    const liq = resolveLiquidityForSide(lado, current.leaderSide, params.liquidityMode);
    const fields = sideFields(current.lastTick, lado);
    const ask = fields.ask;
    if (ask == null) return 0;

    // Taker (líder ou modo taker): fórmula / walk / capped
    if (liq === 'taker' || params.executionMode === 'taker') {
      const fillC = buyFillPriceCents(limitCents, 'taker', params, meta.extraSlip || 0);
      let fillPrice = fillC / 100;
      const mode = params.takerPriceMode || 'formula';
      if (mode !== 'formula' && fields.rawAsks) {
        const walked = walkBook(fields.rawAsks, qty, ask);
        if (mode === 'walk') {
          fillPrice = Math.max(fillPrice, walked.avgPrice);
        } else if (mode === 'capped') {
          const cap = fillPrice + (params.takerMaxExtraCents || 0) / 100;
          fillPrice = Math.max(fillPrice, Math.min(walked.avgPrice, cap));
        }
      }
      return applyFill(lado, qty, fillPrice, type, ts, 'taker', meta);
    }

    // Maker + optimistic: fill no limit
    if (params.executionMode === 'optimistic_maker') {
      const fillC = buyFillPriceCents(limitCents, 'maker', params, meta.extraSlip || 0);
      return applyFill(lado, qty, fillC / 100, type, ts, 'maker', meta);
    }

    const limit = limitCents / 100;
    const epsilon = params.makerFillEpsilon || 0.01;
    const isTouch = params.executionMode === 'touch_maker';
    const postMode = params.makerPostMode || (isTouch ? 'limit' : 'bid');

    // touch_maker: se o ask já imprimiu no/abaixo do limit (DESC hedge), fill maker no limit.
    // Mais honesto que optimistic (exige preço ter chegado), mais fillável que resting-no-bid.
    if (isTouch && params.throughFillOnTrigger && ask <= limit) {
      return applyFill(lado, qty, limit, type, ts, 'maker', meta);
    }

    const bid = fields.bid;
    let postPrice = postMode === 'limit'
      ? limit
      : (bid != null ? Math.min(bid, limit) : limit);
    if (!(postPrice > 0) || !(ask > 0)) {
      current.restingStats.rejected += 1;
      return 0;
    }

    // Ordem marketable (post >= ask): só aceita fill maker se ask já <= limit
    if (postPrice >= ask) {
      current.restingStats.rejected += 1;
      if (ask <= limit) {
        return applyFill(lado, qty, limit, type, ts, 'maker', meta);
      }
      return 0;
    }

    const key = `${lado}|${type}|${meta.idx || 0}`;
    const existing = current.restingOrders.find((o) => o.key === key && o.status === 'open');
    if (existing) return 0;

    current.restingOrders.push({
      key,
      side: lado,
      price: postPrice,
      qty,
      type,
      meta,
      rearmLevel: meta.tipoBase && meta.idx
        ? { lado, tipo: meta.tipoBase, idx: meta.idx }
        : null,
      placedTs: ts,
      placedMs: new Date(ts).getTime(),
      lastAsk: ask,
      status: 'open',
    });
    current.restingStats.placed += 1;
    addLog(ts, `RESTING PLACE | ${lado} ${qty}sh @ $${postPrice.toFixed(4)} | ${type} | eps=${epsilon}`, 'info');
    return 0;
  };

  const checkResting = (tick) => {
    if (!current?.restingOrders.length) return;
    const tickMs = new Date(tick.ts).getTime();
    const timeoutMs = (params.makerTimeoutSec || 30) * 1000;
    const open = [...current.restingOrders];
    for (const resting of open) {
      if (resting.status !== 'open') continue;
      if (tickMs - resting.placedMs >= timeoutMs) {
        cancelResting(resting.key, 'timeout');
        continue;
      }
      const fields = sideFields(tick, resting.side);
      const currAsk = fields.ask;
      if (currAsk == null) continue;
      const prevAsk = resting.lastAsk;
      const crossed = shouldFillRestingBuy(prevAsk, currAsk, resting.price, params.makerFillEpsilon);
      resting.lastAsk = currAsk;
      if (!crossed) continue;

      applyFill(resting.side, resting.qty, resting.price, resting.type, tick.ts, 'maker', resting.meta || {});
      resting.status = 'filled';
      current.restingStats.filled += 1;
      current.restingOrders = current.restingOrders.filter((o) => o.key !== resting.key);

      // Re-arme já ocorreu no disparo; sub count no fill resting
      if (resting.meta?.tipoBase === 'SUB' && resting.meta?.idx) {
        const idx = resting.meta.idx;
        current.subEntryCountByIdx.set(idx, (current.subEntryCountByIdx.get(idx) || 0) + 1);
      }
    }
  };

  const tryEqualize = (tick, askUpC, askDownC) => {
    if (!params.equalizeEnabled || current.equalized) return;
    if (current.shares.UP === current.shares.DOWN) return;
    const eqLado = current.shares.UP < current.shares.DOWN ? 'UP' : 'DOWN';
    const eqAskC = eqLado === 'UP' ? askUpC : askDownC;
    if (eqAskC > params.equalizeMaxAskCents) return;
    const falta = Math.abs(current.shares.UP - current.shares.DOWN);
    if (falta <= 0) return;
    const filled = placeOrFillBuy(
      eqLado,
      falta,
      params.equalizeMaxAskCents,
      'EQUALIZA',
      tick.ts,
      { extraSlip: params.equalizeExtraSlipCents },
    );
    if (filled > 0 || params.executionMode === 'resting_maker' || params.executionMode === 'touch_maker') {
      // marca equalizado só se shares iguais (fill imediato) ou deixa resting tentar
      if (Math.abs(current.shares.UP - current.shares.DOWN) < 1e-9) current.equalized = true;
    }
  };

  const evaluateLadder = (tick) => {
    checkResting(tick);
    const tau = secondsRemaining(current, tick);
    const hasPos = current.fills.UP.length > 0 || current.fills.DOWN.length > 0;

    // Sem posição: só inicia na janela [minStart, maxStart]
    if (!hasPos) {
      if (tau < params.minSecondsLeftToStart) return;
      if (tau > params.maxSecondsLeftToStart) return;
    } else if (tau < params.minSecondsLeftToEnter) {
      // Com posição: ainda permite equalização tarde, mas não novos níveis
      tryEqualize(tick,
        (sideFields(tick, 'UP').ask || 0) * 100,
        (sideFields(tick, 'DOWN').ask || 0) * 100);
      return;
    }

    const up = sideFields(tick, 'UP');
    const down = sideFields(tick, 'DOWN');
    if (up.ask == null || down.ask == null) return;

    const askUpC = up.ask * 100;
    const askDownC = down.ask * 100;
    current.leaderSide = detectLeader(askUpC, askDownC, params.leaderThresholdCents, current.leaderSide);
    if (!current.leaderSide) return; // espera 1º 55¢

    // Freio de edge do par
    const pairSum = pairAvgSumCents(current.shares, current.cost);
    if (pairSum != null && pairSum > params.maxPairAvgSumCents) {
      current.frozenByPairEdge = true;
      tryEqualize(tick, askUpC, askDownC);
      return;
    }

    const asks = { UP: askUpC, DOWN: askDownC };

    for (const lado of ['UP', 'DOWN']) {
      const askC = asks[lado];
      for (const n of current.ladder[lado]) {
        if (!n.armado) continue;
        if (!levelAllowedForProfile(lado, n, current.leaderSide, params.ladderProfile)) continue;

        const disparaSub = n.tipo === 'SUB' && askC >= n.preco;
        const disparaDesc = n.tipo === 'DESC' && askC <= n.preco;
        if (!disparaSub && !disparaDesc) continue;

        let sh = n.shares;
        if (disparaSub && params.sideMultiplier > 1) {
          const jaHist = current.subEntryCountByIdx.get(n.idx) || 0;
          sh = n.shares * Math.pow(params.sideMultiplier, jaHist);
        }

        n.armado = false;
        n.vezes += 1;
        current.startedLadder = true;

        const filled = placeOrFillBuy(lado, sh, n.preco, `${n.tipo}-${n.idx}`, tick.ts, {
          idx: n.idx,
          tipoBase: n.tipo,
        });

        // Sem fill imediato: se não ficou resting aberta, reaponta o nível (reject / falta de book)
        if (filled <= 0 && params.executionMode !== 'optimistic_maker') {
          const restingOpen = current.restingOrders.some(
            (o) => o.status === 'open' && o.side === lado && o.type === `${n.tipo}-${n.idx}`,
          );
          if (!restingOpen && params.rearmOnMakerCancel) {
            n.armado = true;
            n.vezes = Math.max(0, n.vezes - 1);
          }
        }

        if (n.tipo === 'SUB' && filled > 0) {
          current.subEntryCountByIdx.set(n.idx, (current.subEntryCountByIdx.get(n.idx) || 0) + 1);
        }

        // Re-arme
        if (params.rearmMode !== 'off') {
          const rearmKey = `${lado}|${n.tipo}|${n.idx}`;
          const already = current.rearmCount.get(rearmKey) || 0;
          const canRearm = params.rearmMode === 'full' || (params.rearmMode === 'once' && already < 1);
          if (canRearm) {
            const compTipo = n.tipo === 'SUB' ? 'DESC' : 'SUB';
            const comp = current.ladder[lado].find((x) => x.tipo === compTipo && x.idx === n.idx);
            if (comp) {
              comp.armado = true;
              current.rearmCount.set(rearmKey, already + 1);
            }
          }
        }
      }
    }

    tryEqualize(tick, askUpC, askDownC);
    if (Math.abs(current.shares.UP - current.shares.DOWN) < 1e-9 && (current.shares.UP > 0)) {
      current.equalized = true;
    }
  };

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    for (const o of [...current.restingOrders]) cancelResting(o.key, 'event_end');
    completedEvents.add(eventKey(current));

    const tick = current.lastTick;
    const closedAt = closeTs || new Date(current.eventEndMs).toISOString();
    const totalFills = current.fills.UP.length + current.fills.DOWN.length;

    if (totalFills === 0) {
      totalNoEntry++;
      events.push({
        eventId: current.eventId,
        eventStart: current.eventStart,
        eventEnd: new Date(current.eventEndMs).toISOString(),
        positionType: null,
        quantity: 0,
        cost: 0,
        fills: [],
        exits: [],
        finalPnl: 0,
        reason: 'no_entry',
        closedAt,
        leaderSide: current.leaderSide,
        restingPlaced: current.restingStats.placed,
        restingFilled: current.restingStats.filled,
        restingCancelled: current.restingStats.cancelled,
        executionMode: params.executionMode,
      });
      equity.push({ ts: closedAt, pnl: totalPnl });
      current = null;
      return;
    }

    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    const winnerSide = btcPrice != null && priceToBeat != null && btcPrice >= priceToBeat ? 'UP' : 'DOWN';

    let expiryPnl = 0;
    if (current.shares.UP > 0) {
      expiryPnl += (winnerSide === 'UP' ? current.shares.UP : 0) - current.cost.UP;
    }
    if (current.shares.DOWN > 0) {
      expiryPnl += (winnerSide === 'DOWN' ? current.shares.DOWN : 0) - current.cost.DOWN;
    }

    const finalPnl = expiryPnl;
    totalPnl += finalPnl;
    totalEntries++;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    const allFills = [
      ...current.fills.UP.map((f) => ({ ...f, side: 'UP' })),
      ...current.fills.DOWN.map((f) => ({ ...f, side: 'DOWN' })),
    ];
    const first = allFills[0];

    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: new Date(current.eventEndMs).toISOString(),
      positionType: 'BOTH',
      entryTime: first?.time || null,
      quantity: current.shares.UP + current.shares.DOWN,
      cost: current.cost.UP + current.cost.DOWN,
      avgEntryPrice: 0,
      fills: allFills,
      exits: [],
      orders: allFills.map((f) => ({
        type: 'entry',
        side: f.side,
        shares: f.qty,
        price: f.price,
        liquidity: f.liquidity,
        createdAt: f.time,
      })),
      winnerSide,
      expiryPnl,
      finalPnl,
      reason,
      closedAt,
      leaderSide: current.leaderSide,
      equalized: current.equalized,
      sharesUp: current.shares.UP,
      sharesDown: current.shares.DOWN,
      restingPlaced: current.restingStats.placed,
      restingFilled: current.restingStats.filled,
      restingCancelled: current.restingStats.cancelled,
      executionMode: params.executionMode,
      diagnostics: {
        leaderSide: current.leaderSide,
        equalized: current.equalized,
        subCounts: Object.fromEntries(current.subEntryCountByIdx),
      },
    });
    equity.push({ ts: closedAt, pnl: totalPnl });
    addLog(closedAt, `EVENTO FIN | Escada Dupla | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | eq $${equityNow().toFixed(2)}`, finalPnl >= 0 ? 'profit' : 'loss');
    current = null;
  };

  const processTick = (tick) => {
    ticksProcessed++;
    if (!periodStart) periodStart = tick.ts;
    periodEnd = tick.ts;

    const key = eventKey(tick);
    if (!current && completedEvents.has(key)) return;

    if (!current || key !== eventKey(current)) {
      if (current) finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
      if (completedEvents.has(key)) return;
      current = createEventState(tick, params);
      totalEvents++;
      addLog(tick.ts, `Evento | Escada Dupla V1`, 'info');
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);
    const tickTimeMs = new Date(tick.ts).getTime();
    if (tickTimeMs < new Date(current.eventStart).getTime()) return;
    if (tickTimeMs >= current.eventEndMs) {
      finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
      return;
    }
    evaluateLadder(tick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
    const winRate = totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0;
    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equity) {
      if (point.pnl > peak) peak = point.pnl;
      maxDrawdown = Math.max(maxDrawdown, peak - point.pnl);
    }
    return {
      params,
      strategy: 'ESCADA_DUPLA_V1',
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins,
        totalLosses,
        winRate: parseFloat(winRate.toFixed(1)),
        totalPnl,
        avgPnl: totalEntries > 0 ? totalPnl / totalEntries : 0,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
        executionMode: params.executionMode,
        liquidityMode: params.liquidityMode,
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

function runEscadaDuplaBacktest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

var __escadaExports = {
  createBacktestRunner,
  mergeEscadaParams,
  resolveExecutionMode,
  resolveLiquidityMode,
  resolveLadderProfile,
  resolveRearmMode,
  resolveMakerPostMode,
  resolveTakerPriceMode,
  shouldFillRestingBuy,
  simulateEscadaPath,
  expandPathTargets,
  buyFillPriceCents,
  resolveLiquidityForSide,
  levelAllowedForProfile,
  pairAvgSumCents,
  runEscadaDuplaBacktest,
  DEFAULT_SUB,
  DEFAULT_DESC,
};
