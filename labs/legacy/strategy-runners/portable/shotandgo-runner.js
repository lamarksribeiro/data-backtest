/**
 * Shotandgo V1 (Escada Dupla / Phil_Hopper_Real) — library runner portable.
 *
 * Mecânica: escada dual SUB/DESC, multiplicador por virada, contagio,
 * PISO, STOP, equalização limite/taker, DESC maker honesto.
 *
 * Surface de testes: __shotandgoExports
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

function clampCents(c) {
  return Math.min(99, Math.max(1, Math.round(Number(c) * 10) / 10));
}

const DEFAULT_SUB = [
  [55, 20], [60, 15], [65, 10], [70, 10], [75, 5], [80, 5], [85, 1], [90, 1],
];
const DEFAULT_DESC = [
  [45, 5], [40, 5], [35, 5], [30, 5], [25, 5], [20, 5], [15, 5], [10, 5],
];

const DEFAULT_PARAMS = {
  walletSize: 100,
  sizeScale: 1,
  mult: [2, 3, 4, 5, 6, 6],
  contagio: 'global',
  contagioMin: 5,
  equalizar: true,
  eqPreco: 0.05,
  eqEncerra: true,
  equalizaIgnoraTeto: true,
  eqLimiteAtivo: true,
  eqLimiteArmaC: 10,
  eqLimiteCancelaC: 40,
  eqLimiteReposta: true,
  eqLimiteResizeSh: 5,
  stopAtivo: true,
  stopVirada: 4,
  stopLimiar: 1.0,
  pisoAtivo: true,
  pisoViradas: [4, 5],
  pisoMargem: 0.20,
  maxViradasAtivo: true,
  maxViradas: 6,
  descModo: 'gatilho',
  descVirada: 5,
  saidaAtiva: false,
  saidaVirada: 4,
  saidaDelta: 10,
  fokAtivo: true,
  fokPrecoTeto: 0.95,
  slippageCompra: 0.03,
  filterLo: 0.10,
  filterHi: 0.90,
  antiGlitch: true,
  somaMinValida: 85,
  somaMaxValida: 115,
  minSecondsLeftToStart: 20,
  maxSecondsLeftToStart: 280,
  maxEventNotional: 500,
  makerFillEpsilon: 0.01,
  makerTimeoutSec: 45,
  takerMaxExtraCents: 3,
  takerMissPolicy: 'rearm',
  takerLatencyTicks: 0,
  takerPriceMode: 'taker_limit',
  executionMode: 'honest',
  applyPolymarketFees: true,
  polymarketFeeCategory: 'crypto',
  subLevels: null,
  descLevels: null,
};

function resolveExecutionMode(raw = {}) {
  const mode = String(raw.executionMode ?? DEFAULT_PARAMS.executionMode).trim().toLowerCase();
  if (mode === 'honest' || mode === 'realistic') return 'honest';
  if (mode === 'optimistic' || mode === 'optimistic_maker') return 'optimistic';
  return 'honest';
}

function resolveTakerMissPolicy(raw = {}) {
  const mode = String(raw.takerMissPolicy ?? DEFAULT_PARAMS.takerMissPolicy).trim().toLowerCase();
  return mode === 'skip' ? 'skip' : 'rearm';
}

function resolveDescModo(raw = {}) {
  const m = String(raw.descModo ?? DEFAULT_PARAMS.descModo).trim().toLowerCase();
  if (m === 'comprar' || m === 'gatilho' || m === 'congela') return m;
  return 'gatilho';
}

function resolveContagio(raw = {}) {
  const c = String(raw.contagio ?? DEFAULT_PARAMS.contagio).trim().toLowerCase();
  if (c === 'off' || c === 'piso' || c === 'lado' || c === 'global') return c;
  return 'global';
}

function parseLevels(raw, fallback, tipo) {
  if (!Array.isArray(raw) || !raw.length) {
    return fallback.map(([price, shares], i) => ({
      tipo,
      idx: i + 1,
      preco: price,
      shares,
    }));
  }
  return raw.map((row, i) => {
    if (Array.isArray(row)) {
      return { tipo, idx: i + 1, preco: Number(row[0]), shares: Number(row[1]) };
    }
    return {
      tipo: row.tipo || tipo,
      idx: Number(row.idx) || i + 1,
      preco: Number(row.preco ?? row.price),
      shares: Number(row.shares ?? row.size),
    };
  }).filter((n) => n.preco > 0 && n.shares > 0);
}

function mergeShotandgoParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS, ...raw };
  const sizeScale = clamp(toFiniteNumber(raw.sizeScale, DEFAULT_PARAMS.sizeScale), 0.05, 10);
  params.sizeScale = sizeScale;
  params.walletSize = toFiniteNumber(raw.walletSize, DEFAULT_PARAMS.walletSize);
  params.mult = Array.isArray(raw.mult) && raw.mult.length
    ? raw.mult.map((v) => Number(v))
    : [...DEFAULT_PARAMS.mult];
  params.contagio = resolveContagio(raw);
  params.contagioMin = Math.max(1, toFiniteNumber(raw.contagioMin, DEFAULT_PARAMS.contagioMin));
  params.equalizar = toBool(raw.equalizar, DEFAULT_PARAMS.equalizar);
  params.eqPreco = toFiniteNumber(raw.eqPreco, DEFAULT_PARAMS.eqPreco);
  params.eqEncerra = toBool(raw.eqEncerra, DEFAULT_PARAMS.eqEncerra);
  params.equalizaIgnoraTeto = toBool(raw.equalizaIgnoraTeto, DEFAULT_PARAMS.equalizaIgnoraTeto);
  params.eqLimiteAtivo = toBool(raw.eqLimiteAtivo, DEFAULT_PARAMS.eqLimiteAtivo);
  params.eqLimiteArmaC = toFiniteNumber(raw.eqLimiteArmaC, DEFAULT_PARAMS.eqLimiteArmaC);
  params.eqLimiteCancelaC = toFiniteNumber(raw.eqLimiteCancelaC, DEFAULT_PARAMS.eqLimiteCancelaC);
  params.eqLimiteReposta = toBool(raw.eqLimiteReposta, DEFAULT_PARAMS.eqLimiteReposta);
  params.eqLimiteResizeSh = toFiniteNumber(raw.eqLimiteResizeSh, DEFAULT_PARAMS.eqLimiteResizeSh);
  params.stopAtivo = toBool(raw.stopAtivo, DEFAULT_PARAMS.stopAtivo);
  params.stopVirada = Math.round(toFiniteNumber(raw.stopVirada, DEFAULT_PARAMS.stopVirada));
  params.stopLimiar = toFiniteNumber(raw.stopLimiar, DEFAULT_PARAMS.stopLimiar);
  params.pisoAtivo = toBool(raw.pisoAtivo, DEFAULT_PARAMS.pisoAtivo);
  params.pisoViradas = Array.isArray(raw.pisoViradas)
    ? raw.pisoViradas.map((v) => Math.round(Number(v)))
    : [...DEFAULT_PARAMS.pisoViradas];
  params.pisoMargem = toFiniteNumber(raw.pisoMargem, DEFAULT_PARAMS.pisoMargem);
  params.maxViradasAtivo = toBool(raw.maxViradasAtivo, DEFAULT_PARAMS.maxViradasAtivo);
  params.maxViradas = Math.round(toFiniteNumber(raw.maxViradas, DEFAULT_PARAMS.maxViradas));
  params.descModo = resolveDescModo(raw);
  params.descVirada = Math.round(toFiniteNumber(raw.descVirada, DEFAULT_PARAMS.descVirada));
  params.saidaAtiva = toBool(raw.saidaAtiva, DEFAULT_PARAMS.saidaAtiva);
  params.saidaVirada = Math.round(toFiniteNumber(raw.saidaVirada, DEFAULT_PARAMS.saidaVirada));
  params.saidaDelta = toFiniteNumber(raw.saidaDelta, DEFAULT_PARAMS.saidaDelta);
  params.fokAtivo = toBool(raw.fokAtivo, DEFAULT_PARAMS.fokAtivo);
  params.fokPrecoTeto = toFiniteNumber(raw.fokPrecoTeto, DEFAULT_PARAMS.fokPrecoTeto);
  params.slippageCompra = toFiniteNumber(raw.slippageCompra, DEFAULT_PARAMS.slippageCompra);
  params.filterLo = toFiniteNumber(raw.filterLo, DEFAULT_PARAMS.filterLo);
  params.filterHi = toFiniteNumber(raw.filterHi, DEFAULT_PARAMS.filterHi);
  params.antiGlitch = toBool(raw.antiGlitch, DEFAULT_PARAMS.antiGlitch);
  params.somaMinValida = toFiniteNumber(raw.somaMinValida, DEFAULT_PARAMS.somaMinValida);
  params.somaMaxValida = toFiniteNumber(raw.somaMaxValida, DEFAULT_PARAMS.somaMaxValida);
  params.minSecondsLeftToStart = toFiniteNumber(raw.minSecondsLeftToStart, DEFAULT_PARAMS.minSecondsLeftToStart);
  params.maxSecondsLeftToStart = toFiniteNumber(raw.maxSecondsLeftToStart, DEFAULT_PARAMS.maxSecondsLeftToStart);
  params.maxEventNotional = toFiniteNumber(raw.maxEventNotional, DEFAULT_PARAMS.maxEventNotional);
  params.makerFillEpsilon = toFiniteNumber(raw.makerFillEpsilon, DEFAULT_PARAMS.makerFillEpsilon);
  params.makerTimeoutSec = toFiniteNumber(raw.makerTimeoutSec ?? raw.pendenteTimeoutSeg, DEFAULT_PARAMS.makerTimeoutSec);
  params.takerMaxExtraCents = toFiniteNumber(raw.takerMaxExtraCents, DEFAULT_PARAMS.takerMaxExtraCents);
  params.takerMissPolicy = resolveTakerMissPolicy(raw);
  params.takerLatencyTicks = clamp(Math.round(toFiniteNumber(raw.takerLatencyTicks, DEFAULT_PARAMS.takerLatencyTicks)), 0, 10);
  params.takerPriceMode = String(raw.takerPriceMode ?? DEFAULT_PARAMS.takerPriceMode).trim().toLowerCase();
  params.executionMode = resolveExecutionMode(raw);
  params.applyPolymarketFees = toBool(raw.applyPolymarketFees, DEFAULT_PARAMS.applyPolymarketFees);
  params.polymarketFeeCategory = String(raw.polymarketFeeCategory ?? DEFAULT_PARAMS.polymarketFeeCategory).trim().toLowerCase();

  if (sizeScale !== 1) {
    params.maxEventNotional = Math.round(params.maxEventNotional * sizeScale * 100) / 100;
    params.walletSize = Math.round(params.walletSize * sizeScale * 100) / 100;
  }

  let sub = parseLevels(raw.subLevels, DEFAULT_SUB, 'SUB');
  let desc = parseLevels(raw.descLevels, DEFAULT_DESC, 'DESC');
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

function resolveFator(idx, lado, histSub, ativo, params) {
  const n = histSub.filter((h) => h.idx === idx).length;
  const mult = params.mult;
  let f = n === 0 ? 1 : mult[Math.min(n, mult.length) - 1];

  const travadoLado = ativo[lado] >= params.contagioMin;
  const travadoGlobal = ativo.G >= params.contagioMin;
  if (params.contagio === 'lado' && travadoLado) {
    f = Math.max(f, ativo[lado]);
  } else if (params.contagio === 'global' && travadoGlobal) {
    f = Math.max(f, ativo.G);
  } else if (params.contagio === 'piso' && travadoLado) {
    f = Math.max(f, mult[0]);
  }

  if (f > 1) {
    ativo[lado] = Math.max(ativo[lado], f);
    ativo.G = Math.max(ativo.G, f);
  }
  return f;
}

function shouldFillRestingBuy(prevAsk, currAsk, limitPrice, epsilon = 0.01) {
  if (prevAsk == null || currAsk == null || limitPrice == null) return false;
  if (!Number.isFinite(prevAsk) || !Number.isFinite(currAsk) || !Number.isFinite(limitPrice)) return false;
  return prevAsk >= limitPrice && currAsk <= limitPrice - epsilon;
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
  if (!levels.length) return { avgPrice: bestAsk, filled: sharesDesejadas, depthOk: false };
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
  return {
    avgPrice: execSh > 0 ? custo / execSh : bestAsk,
    filled: execSh,
    depthOk: restante <= 1e-9,
  };
}

function analyzeFok(rawAsks, shares, bestAsk, fokPrecoTeto) {
  const walked = walkBook(rawAsks, shares, bestAsk);
  const cabe = walked.depthOk;
  const executavel = cabe && walked.avgPrice <= fokPrecoTeto + 1e-9;
  return { executavel, cabe, avgPrice: walked.avgPrice, motivo: !cabe ? 'book raso' : 'preco medio alto' };
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

function createEventState(tick, params) {
  const eventStartMs = new Date(tick.event_start).getTime();
  return {
    eventId: tick.condition_id,
    eventStart: new Date(tick.event_start).toISOString(),
    eventEndMs: eventStartMs + 300000,
    priceToBeat: toFiniteNumber(tick.price_to_beat),
    lastTick: tick,
    ladder: buildLadder(params),
    ativo: { UP: 1, DOWN: 1, G: 1 },
    histSub: [],
    viradas: 0,
    ladoVirada: null,
    shares: { UP: 0, DOWN: 0 },
    cost: { UP: 0, DOWN: 0 },
    invested: 0,
    fills: [],
    restingOrders: [],
    pendingTakerOrders: [],
    eqOrder: null,
    equalized: false,
    encerrado: false,
    vendeu: false,
    saleRevenue: 0,
    escadaArmada: false,
    prevAsk: { UP: null, DOWN: null },
    telemetry: {
      blockReasons: {},
      takerMisses: 0,
      descTimeouts: 0,
      eqCancels: 0,
      eqPosts: 0,
      viradas: 0,
      gaps: 0,
      takerAttempts: 0,
      takerFills: 0,
      descPlaced: 0,
      descFilled: 0,
    },
  };
}

function recordBlock(state, reason) {
  state.telemetry.blockReasons[reason] = (state.telemetry.blockReasons[reason] || 0) + 1;
}

/**
 * Simula caminho sintético UP em centavos (dn = 100-up).
 * Modo simplificado para testes de fator/contagio/rearm/DESC/PISO/MAX_VIRADAS.
 */
function simulateShotandgoPath(paramsRaw, upPathCents, winnerSide, options = {}) {
  const params = mergeShotandgoParams(paramsRaw);
  const honest = options.honest === true || params.executionMode === 'honest';
  const ladder = buildLadder(params);
  const ativo = { UP: 1, DOWN: 1, G: 1 };
  const histSub = [];
  let viradas = 0;
  const shares = { UP: 0, DOWN: 0 };
  const cost = { UP: 0, DOWN: 0 };
  const fills = [];
  let equalized = false;
  let encerrado = false;

  const buy = (lado, nivel, sh, priceCents, liquidity) => {
    if (sh <= 0 || encerrado) return false;
    const price = priceCents / 100;
    const notional = cost.UP + cost.DOWN;
    if (notional + sh * price > params.maxEventNotional) return false;
    shares[lado] += sh;
    cost[lado] += sh * price;
    fills.push({
      lado, tipo: `${nivel.tipo}-${nivel.idx}`, shares: sh, price, liquidity,
    });
    if (nivel.tipo === 'SUB') histSub.push({ lado, idx: nivel.idx });
    return true;
  };

  const step = (upC) => {
    if (encerrado) return;
    const dnC = 100 - upC;
    const asks = { UP: upC, DOWN: dnC };
    const congelado = params.maxViradasAtivo && viradas >= params.maxViradas;

    for (const lado of ['UP', 'DOWN']) {
      const askC = asks[lado];
      for (const n of ladder[lado]) {
        if (!n.armado || congelado) continue;
        const dispSub = n.tipo === 'SUB' && askC >= n.preco;
        const dispDesc = n.tipo === 'DESC' && askC <= n.preco;
        if (!dispSub && !dispDesc) continue;

        const cortaDesc = dispDesc && params.descModo !== 'comprar' && viradas >= params.descVirada;
        if (cortaDesc && params.descModo === 'congela') continue;

        if (!cortaDesc) {
          let sh = n.shares;
          if (dispSub) {
            const fator = resolveFator(n.idx, lado, histSub, ativo, params);
            sh = Math.round(n.shares * fator * 100) / 100;
            if (params.pisoAtivo && n.idx === 1) {
              const proxVirada = viradas + 1;
              if (params.pisoViradas.includes(proxVirada)) {
                const oposto = lado === 'UP' ? shares.DOWN : shares.UP;
                const meu = lado === 'UP' ? shares.UP : shares.DOWN;
                const dif = oposto - meu;
                if (dif > 0) {
                  const piso = Math.round(dif * (1 + params.pisoMargem) * 100) / 100;
                  if (piso > sh) sh = piso;
                }
              }
            }
          }
          const liq = dispDesc && honest ? 'maker' : 'taker';
          const fillC = dispDesc ? n.preco : askC;
          if (buy(lado, n, sh, fillC, liq)) {
            if (dispSub && n.idx === 1) viradas += 1;
            n.vezes += 1;
          }
        }

        n.armado = false;
        const compTipo = n.tipo === 'SUB' ? 'DESC' : 'SUB';
        const comp = ladder[lado].find((x) => x.tipo === compTipo && x.idx === n.idx);
        if (comp) comp.armado = true;
      }
    }

    if (params.equalizar && !equalized && shares.UP !== shares.DOWN) {
      const menor = shares.UP < shares.DOWN ? 'UP' : 'DOWN';
      const eqAskC = asks[menor];
      if (eqAskC <= params.eqPreco * 100) {
        const falta = Math.abs(shares.UP - shares.DOWN);
        buy(menor, { tipo: 'EQUALIZA', idx: 0 }, falta, eqAskC, 'taker');
        equalized = true;
        if (params.eqEncerra) encerrado = true;
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
    shares, cost, inv, fills, equalized, viradas,
    pnlGross: winSh - inv,
    params,
    histSub,
    ativo,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeShotandgoParams(rawParams);
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

  const addLog = (ts, msg, type = 'info') => { log.push({ ts, msg, type }); };
  const equityNow = () => Math.max(0, params.walletSize + totalPnl);

  const totalInvested = () => (current ? current.invested : 0);

  const applyBuyCost = (lado, qty, fillPrice, type, ts, liquidity, meta = {}) => {
    if (qty <= 0) return 0;
    // Fees NÃO entram no cost aqui — o lab aplica via applyPolymarketFeesToBacktestResult
    // (mesmo padrão do escada-dupla-runner). Embutir fee + flag applyPolymarketFees=true
    // cobrava taxa em dobro e com fórmula errada.
    const addCost = qty * fillPrice;
    const notional = current.cost.UP + current.cost.DOWN;
    if (!meta.ignoraTeto && notional + addCost > params.maxEventNotional) {
      recordBlock(current, 'TETO_EXPOSICAO');
      return 0;
    }
    current.shares[lado] += qty;
    current.cost[lado] += addCost;
    current.invested += addCost;
    current.fills.push({
      side: lado,
      shares: qty,
      qty,
      price: fillPrice,
      liquidity,
      tipo: type,
      time: ts,
      ...meta,
    });
    addLog(ts, `COMPRA Shotandgo | ${lado} ${qty.toFixed(2)}sh @ $${fillPrice.toFixed(4)} | ${type} | ${liquidity}`, 'entry');
    return qty;
  };

  const executeTakerBuy = (lado, qty, limitCents, type, ts, meta = {}) => {
    const fields = sideFields(current.lastTick, lado);
    const ask = fields.ask;
    if (ask == null || qty <= 0) return 0;
    current.telemetry.takerAttempts += 1;

    const cap = Math.min(params.fokPrecoTeto, ask + params.slippageCompra);
    const formulaCents = cap * 100;
    const limitCap = (formulaCents + params.takerMaxExtraCents) / 100;

    if (params.fokAtivo) {
      const fok = analyzeFok(fields.rawAsks, qty, ask, params.fokPrecoTeto);
      if (!fok.executavel) {
        current.telemetry.takerMisses += 1;
        recordBlock(current, fok.cabe ? 'FOK_PRECO' : 'FOK_LIQUIDEZ');
        return 0;
      }
    }

    let fillPrice = ask;
    if (params.executionMode === 'honest' || params.takerPriceMode === 'taker_limit') {
      const walked = walkBook(fields.rawAsks, qty, ask);
      if (walked.avgPrice > limitCap + 1e-9) {
        current.telemetry.takerMisses += 1;
        recordBlock(current, 'TAKER_MISS');
        return 0;
      }
      fillPrice = Math.max(ask, walked.avgPrice);
    }

    const filled = applyBuyCost(lado, qty, fillPrice, type, ts, 'taker', meta);
    if (filled > 0) current.telemetry.takerFills += 1;
    return filled;
  };

  const placeDescResting = (lado, qty, limitCents, type, ts, meta = {}) => {
    const fields = sideFields(current.lastTick, lado);
    const ask = fields.ask;
    if (ask == null) return 0;
    const limit = limitCents / 100;

    if (params.executionMode === 'optimistic') {
      return applyBuyCost(lado, qty, limit, type, ts, 'maker', meta);
    }

    const key = `${lado}|${type}|${meta.idx || 0}`;
    if (current.restingOrders.some((o) => o.key === key && o.status === 'open')) return 0;
    current.restingOrders.push({
      key,
      side: lado,
      price: limit,
      qty,
      type,
      meta,
      placedTs: ts,
      placedMs: new Date(ts).getTime(),
      lastAsk: ask,
      status: 'open',
    });
    current.telemetry.descPlaced += 1;
    addLog(ts, `DESC RESTING | ${lado} ${qty}sh @ $${limit.toFixed(4)} | ${type}`, 'info');
    return 0;
  };

  const processPendingTaker = (tick) => {
    if (!current?.pendingTakerOrders?.length) return;
    for (const o of current.pendingTakerOrders) o.ticksLeft -= 1;
    const due = current.pendingTakerOrders.filter((o) => o.ticksLeft <= 0);
    current.pendingTakerOrders = current.pendingTakerOrders.filter((o) => o.ticksLeft > 0);
    for (const o of due) {
      const filled = executeTakerBuy(o.lado, o.qty, o.limitCents, o.type, tick.ts, o.meta || {});
      if (filled > 0 && o.meta?.isSub) onSubFilled(o.lado, o.meta.idx);
    }
  };

  const onSubFilled = (lado, idx) => {
    current.histSub.push({ lado, idx });
    if (idx === 1) {
      current.viradas += 1;
      current.ladoVirada = lado;
      current.telemetry.viradas = current.viradas;
    }
  };

  const cancelResting = (key, reason) => {
    const idx = current.restingOrders.findIndex((o) => o.key === key && o.status === 'open');
    if (idx < 0) return;
    current.restingOrders[idx].status = 'cancelled';
    current.restingOrders.splice(idx, 1);
    if (reason === 'timeout') current.telemetry.descTimeouts += 1;
    addLog(current.lastTick?.ts || new Date().toISOString(), `DESC CANCEL | ${key} | ${reason}`, 'info');
  };

  const checkResting = (tick) => {
    if (!current?.restingOrders.length) return;
    const tickMs = new Date(tick.ts).getTime();
    const timeoutMs = (params.makerTimeoutSec || 45) * 1000;
    for (const resting of [...current.restingOrders]) {
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
      const filled = applyBuyCost(resting.side, resting.qty, resting.price, resting.type, tick.ts, 'maker', resting.meta || {});
      if (filled > 0) {
        resting.status = 'filled';
        current.restingOrders = current.restingOrders.filter((o) => o.key !== resting.key);
        current.telemetry.descFilled += 1;
      }
    }
  };

  const placeOrFillBuy = (lado, qty, limitCents, type, ts, meta = {}) => {
    const isDesc = meta.isDesc === true;
    if (isDesc) return placeDescResting(lado, qty, limitCents, type, ts, meta);

    if ((params.takerLatencyTicks || 0) > 0) {
      const pendKey = `${lado}|${type}|${meta.idx || 0}`;
      if (current.pendingTakerOrders.some((o) => o.key === pendKey)) return -1; // already pending
      current.pendingTakerOrders.push({
        key: pendKey,
        lado,
        qty,
        limitCents,
        type,
        meta,
        ticksLeft: params.takerLatencyTicks,
      });
      // Consume trigger now (order "sent"); fill arrives after latency ticks.
      return -1;
    }

    if (params.executionMode === 'optimistic') {
      const ask = sideFields(current.lastTick, lado).ask;
      const fillPrice = ask != null ? ask : limitCents / 100;
      const filled = applyBuyCost(lado, qty, fillPrice, type, ts, 'taker', meta);
      if (filled > 0 && meta.isSub) onSubFilled(lado, meta.idx);
      return filled;
    }

    const filled = executeTakerBuy(lado, qty, limitCents, type, ts, meta);
    if (filled > 0 && meta.isSub) onSubFilled(lado, meta.idx);
    return filled;
  };

  const sellBothSides = (tick, reason) => {
    let revenue = 0;
    for (const lado of ['UP', 'DOWN']) {
      const sh = current.shares[lado];
      if (sh <= 0) continue;
      const bid = sideFields(tick, lado).bid;
      if (bid == null) continue;
      const val = sh * bid;
      revenue += val;
      current.fills.push({
        side: lado, shares: -sh, price: bid, liquidity: 'taker', tipo: reason, time: tick.ts,
      });
      current.shares[lado] = 0;
    }
    current.saleRevenue = revenue;
    current.vendeu = true;
    current.encerrado = true;
    addLog(tick.ts, `${reason.toUpperCase()} | receita $${revenue.toFixed(2)} de $${totalInvested().toFixed(2)}`, 'exit');
  };

  const eqCancel = (motivo) => {
    if (!current.eqOrder) return;
    current.eqOrder = null;
    current.telemetry.eqCancels += 1;
    addLog(current.lastTick?.ts || new Date().toISOString(), `EQ CANCEL | ${motivo}`, 'info');
  };

  const eqExecute = (lado, shares, price, tick, ts) => {
    applyBuyCost(lado, shares, price, 'EQUALIZA', ts, 'maker', { ignoraTeto: params.equalizaIgnoraTeto });
    current.equalized = true;
    current.eqOrder = null;
    addLog(ts, `EQUALIZOU | ${lado} +${shares}sh @ $${price.toFixed(4)}`, 'profit');
    if (params.eqEncerra) current.encerrado = true;
  };

  const eqPost = (lado, shares) => {
    current.eqOrder = { lado, shares, price: params.eqPreco, postedMs: Date.now() };
    current.telemetry.eqPosts += 1;
    addLog(current.lastTick?.ts || new Date().toISOString(), `EQ POST | ${lado} ${shares}sh @ ${params.eqPreco}`, 'info');
  };

  const manageEqLimite = (tick, asks) => {
    if (!params.equalizar || !params.eqLimiteAtivo || current.equalized || current.encerrado) return;
    const dif = Math.abs(current.shares.UP - current.shares.DOWN);
    const menor = current.shares.UP < current.shares.DOWN ? 'UP' : 'DOWN';
    const askMenor = asks[menor];
    if (askMenor == null) return;

    if (current.eqOrder) {
      if (askMenor <= current.eqOrder.price + 1e-9) {
        eqExecute(current.eqOrder.lado, current.eqOrder.shares, current.eqOrder.price, tick, tick.ts);
        return;
      }
      if (current.eqOrder.lado !== menor) {
        eqCancel(`lado menor virou ${menor}`);
        return;
      }
      if (askMenor * 100 >= params.eqLimiteCancelaC) {
        eqCancel(`${menor} voltou a ${(askMenor * 100).toFixed(0)}c`);
        return;
      }
      if (Math.abs(dif - current.eqOrder.shares) > params.eqLimiteResizeSh) {
        eqCancel(`tamanho mudou ${current.eqOrder.shares} -> ${dif}`);
        if (dif > 1e-9) eqPost(menor, dif);
      }
      return;
    }

    if (dif <= 1e-9) return;
    if (current.telemetry.eqCancels > 0 && !params.eqLimiteReposta) return;
    if (askMenor * 100 <= params.eqLimiteArmaC) eqPost(menor, dif);
  };

  const tryEqTaker = (tick, asks) => {
    if (!params.equalizar || current.equalized || current.encerrado || current.eqOrder) return;
    const dif = Math.abs(current.shares.UP - current.shares.DOWN);
    if (dif <= 1e-9) return;
    const menor = current.shares.UP < current.shares.DOWN ? 'UP' : 'DOWN';
    if (asks[menor] > params.eqPreco) return;
    const filled = placeOrFillBuy(menor, dif, params.eqPreco * 100, 'EQUALIZA', tick.ts, {
      ignoraTeto: params.equalizaIgnoraTeto,
    });
    if (filled > 0) {
      current.equalized = true;
      if (params.eqEncerra) current.encerrado = true;
    }
  };

  const evaluateTick = (tick) => {
    const tau = secondsRemaining(current, tick);
    if (tau > params.maxSecondsLeftToStart) return;
    if (tau < params.minSecondsLeftToStart && current.shares.UP + current.shares.DOWN <= 0) return;

    const up = sideFields(tick, 'UP');
    const down = sideFields(tick, 'DOWN');
    if (up.ask == null || down.ask == null) {
      recordBlock(current, 'SEM_ODDS');
      return;
    }

    if (params.antiGlitch) {
      const soma = (up.ask + down.ask) * 100;
      if (soma <= params.somaMinValida || soma >= params.somaMaxValida) {
        current.telemetry.gaps += 1;
        recordBlock(current, 'ANTI_GLITCH');
        return;
      }
    }

    checkResting(tick);
    processPendingTaker(tick);

    if (!current.escadaArmada) {
      if (up.ask >= params.filterLo && up.ask <= params.filterHi) {
        current.escadaArmada = true;
      } else {
        recordBlock(current, 'ESCADA_NAO_ARMADA');
        return;
      }
    }

    if (current.encerrado) return;

    const asks = { UP: up.ask, DOWN: down.ask };
    const asksC = { UP: up.ask * 100, DOWN: down.ask * 100 };

    if (params.saidaAtiva && !current.vendeu && current.viradas >= params.saidaVirada
        && current.ladoVirada && asksC[current.ladoVirada] >= params.subLevels[0].preco + params.saidaDelta) {
      sellBothSides(tick, 'sold');
      return;
    }

    if (params.stopAtivo && !current.vendeu && current.viradas >= params.stopVirada
        && current.shares.UP + current.shares.DOWN > 0) {
      const bidUp = up.bid ?? up.ask;
      const bidDn = down.bid ?? down.ask;
      const saldo = current.shares.UP * bidUp + current.shares.DOWN * bidDn - totalInvested();
      if (saldo >= params.stopLimiar) {
        sellBothSides(tick, 'stop');
        return;
      }
    }

    const congelado = params.maxViradasAtivo && current.viradas >= params.maxViradas;

    if (!congelado) {
      for (const lado of ['UP', 'DOWN']) {
        const askC = asksC[lado];
        for (const n of current.ladder[lado]) {
          if (!n.armado) continue;
          const dispSub = n.tipo === 'SUB' && askC >= n.preco;
          const dispDesc = n.tipo === 'DESC' && askC <= n.preco;
          if (!dispSub && !dispDesc) continue;

          const cortaDesc = dispDesc && params.descModo !== 'comprar' && current.viradas >= params.descVirada;
          if (cortaDesc) recordBlock(current, 'DESC_SO_GATILHO');
          if (cortaDesc && params.descModo === 'congela') continue;

          let consumed = cortaDesc;
          if (!cortaDesc) {
            let sh = n.shares;
            let fator = 1;
            if (dispSub) {
              fator = resolveFator(n.idx, lado, current.histSub, current.ativo, params);
              sh = Math.round(n.shares * fator * 100) / 100;
              if (params.pisoAtivo && n.idx === 1) {
                const proxVirada = current.viradas + 1;
                if (params.pisoViradas.includes(proxVirada)) {
                  const oposto = lado === 'UP' ? current.shares.DOWN : current.shares.UP;
                  const meu = lado === 'UP' ? current.shares.UP : current.shares.DOWN;
                  const dif = oposto - meu;
                  if (dif > 0) {
                    const piso = Math.round(dif * (1 + params.pisoMargem) * 100) / 100;
                    if (piso > sh) sh = piso;
                  }
                }
              }
            }

            const tipo = `${n.tipo}-${n.idx}`;
            const meta = {
              idx: n.idx,
              isSub: dispSub,
              isDesc: dispDesc,
              fator,
            };
            if (dispDesc && params.executionMode === 'honest') {
              placeDescResting(lado, sh, n.preco, tipo, tick.ts, meta);
              consumed = true;
            } else {
              const filled = placeOrFillBuy(lado, sh, n.preco, tipo, tick.ts, meta);
              // filled > 0: executed; filled < 0: latency pending (consume like Python send)
              if (filled > 0 || filled < 0) consumed = true;
              else if (dispDesc) consumed = true;
              else continue;
            }
            if (consumed) n.vezes += 1;
          }

          if (!consumed) continue;
          n.armado = false;
          const compTipo = n.tipo === 'SUB' ? 'DESC' : 'SUB';
          const comp = current.ladder[lado].find((x) => x.tipo === compTipo && x.idx === n.idx);
          if (comp) comp.armado = true;
        }
      }
    } else {
      recordBlock(current, 'CONGELADA');
    }

    manageEqLimite(tick, asks);
    tryEqTaker(tick, asks);

    current.prevAsk.UP = up.ask;
    current.prevAsk.DOWN = down.ask;
  };

  const buildEventDiagnostics = () => ({
    viradas: current.viradas,
    blocks: { ...current.telemetry.blockReasons },
    takerAttempts: current.telemetry.takerAttempts,
    takerFills: current.telemetry.takerFills,
    takerMisses: current.telemetry.takerMisses,
    descPlaced: current.telemetry.descPlaced,
    descFilled: current.telemetry.descFilled,
    descTimeouts: current.telemetry.descTimeouts,
    eqPosts: current.telemetry.eqPosts,
    eqCancels: current.telemetry.eqCancels,
    gaps: current.telemetry.gaps,
    ativo: { ...current.ativo },
    histSub: [...current.histSub],
  });

  const finalizeCurrentEvent = (reason, closeTs = null) => {
    if (!current) return;
    for (const o of [...current.restingOrders]) cancelResting(o.key, 'event_end');
    if (current.eqOrder) eqCancel('event_end');
    completedEvents.add(eventKey(current));

    const tick = current.lastTick;
    const closedAt = closeTs || new Date(current.eventEndMs).toISOString();

    if (current.fills.length === 0) {
      totalNoEntry++;
      events.push({
        eventId: current.eventId,
        eventStart: current.eventStart,
        eventEnd: new Date(current.eventEndMs).toISOString(),
        finalPnl: 0,
        reason: 'no_entry',
        sharesUp: 0,
        sharesDown: 0,
        fills: [],
        diagnostics: buildEventDiagnostics(),
        closedAt,
      });
      equity.push({ ts: closedAt, pnl: totalPnl });
      current = null;
      return;
    }

    let finalPnl;
    let closeReason = reason;

    if (current.vendeu) {
      finalPnl = current.saleRevenue - totalInvested();
      closeReason = current.fills.some((f) => f.tipo === 'stop') ? 'stop' : 'sold';
    } else if (current.equalized && params.eqEncerra) {
      closeReason = 'equalized';
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      const btcPrice = toFiniteNumber(tick.btc_price);
      const winnerSide = btcPrice != null && priceToBeat != null && btcPrice >= priceToBeat ? 'UP' : 'DOWN';
      const winSh = winnerSide === 'UP' ? current.shares.UP : current.shares.DOWN;
      finalPnl = winSh - totalInvested();
    } else {
      const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
      const btcPrice = toFiniteNumber(tick.btc_price);
      const upFinal = toFiniteNumber(tick.up_price, sideFields(tick, 'UP').ask);
      const winnerSide = btcPrice != null && priceToBeat != null
        ? (btcPrice >= priceToBeat ? 'UP' : 'DOWN')
        : (upFinal >= 0.5 ? 'UP' : 'DOWN');
      const winSh = winnerSide === 'UP' ? current.shares.UP : current.shares.DOWN;
      finalPnl = winSh - totalInvested();
      closeReason = 'expired';
    }

    totalPnl += finalPnl;
    totalEntries++;
    if (finalPnl > 0) totalWins++;
    else if (finalPnl < 0) totalLosses++;

    const entryFills = current.fills.filter((f) => Number(f.shares) > 0);
    const invested = totalInvested();
    events.push({
      eventId: current.eventId,
      eventStart: current.eventStart,
      eventEnd: new Date(current.eventEndMs).toISOString(),
      positionType: 'BOTH',
      quantity: current.shares.UP + current.shares.DOWN,
      cost: invested,
      finalPnl,
      finalPnlBeforeFees: finalPnl,
      reason: closeReason,
      sharesUp: current.shares.UP,
      sharesDown: current.shares.DOWN,
      fills: entryFills.map((f) => ({
        side: f.side,
        shares: f.shares,
        qty: f.shares,
        price: f.price,
        liquidity: f.liquidity,
        tipo: f.tipo,
        time: f.time,
      })),
      orders: entryFills.map((f) => ({
        type: 'entry',
        side: f.side,
        shares: f.shares,
        price: f.price,
        liquidity: f.liquidity,
        createdAt: f.time,
      })),
      exits: current.fills.filter((f) => Number(f.shares) < 0).map((f) => ({
        side: f.side,
        shares: Math.abs(f.shares),
        price: f.price,
        liquidity: f.liquidity,
        reason: f.tipo,
        time: f.time,
      })),
      diagnostics: buildEventDiagnostics(),
      closedAt,
      equalized: current.equalized,
      viradas: current.viradas,
      executionMode: params.executionMode,
      takerAttempts: current.telemetry.takerAttempts,
      takerFills: current.telemetry.takerFills,
      takerMisses: current.telemetry.takerMisses,
      descTimeouts: current.telemetry.descTimeouts,
      eqPosts: current.telemetry.eqPosts,
      eqCancels: current.telemetry.eqCancels,
    });
    equity.push({ ts: closedAt, pnl: totalPnl });
    addLog(closedAt, `EVENTO FIN | Shotandgo | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | eq $${equityNow().toFixed(2)}`, finalPnl >= 0 ? 'profit' : 'loss');
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
      addLog(tick.ts, 'Evento | Shotandgo V1', 'info');
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);
    const tickTimeMs = new Date(tick.ts).getTime();
    if (tickTimeMs < new Date(current.eventStart).getTime()) return;
    if (tickTimeMs >= current.eventEndMs) {
      finalizeCurrentEvent('expired', new Date(current.eventEndMs).toISOString());
      return;
    }
    evaluateTick(tick);
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
      strategy: 'SHOTANDGO_V1',
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

function runShotandgoBacktest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

var __shotandgoExports = {
  createBacktestRunner,
  mergeShotandgoParams,
  resolveFator,
  simulateShotandgoPath,
  expandPathTargets,
  shouldFillRestingBuy,
  walkBook,
  runShotandgoBacktest,
  DEFAULT_SUB,
  DEFAULT_DESC,
};
