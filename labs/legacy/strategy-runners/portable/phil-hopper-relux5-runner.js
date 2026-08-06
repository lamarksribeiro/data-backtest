/**
 * Phil Hopper Relux5 — library runner portable.
 *
 * Port de Phil_Hopper_Real_Redux_Relux5.py (escada dual SUB/DESC, gerações,
 * TRAVA/EQ, sem venda de posição). Settlement = shares vencedoras − investido.
 *
 * Surface de testes: __philHopperRelux5Exports
 * NÃO modificar shotandgo-runner.js — este é um runner separado.
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
  [55, 10], [60, 10], [62, 10], [64, 10], [65, 10],
];
const DEFAULT_DESC = [
  [36, 10], [28, 10], [23, 10], [18, 10], [10, 10],
];

const DEFAULT_PARAMS = {
  walletSize: 100,
  sizeScale: 1,
  mult: [1.1, 1.4, 1.7, 1.9, 2.2, 2.5, 2.8, 3.1, 3.4, 3.6, 7, 13, 14, 15, 3, 3, 3, 3, 3, 3],
  multDesc: [1.1, 1.2, 1.3, 1.4, 1.5],
  multDescAtivo: true,
  contagio: 'off',
  contagioMin: 4,
  equalizar: true,
  eqPreco: 0.05,
  eqEncerra: true,
  equalizaIgnoraTeto: true,
  eqExigeLucro: true,
  eqLucroMinUsd: 0,
  eqLimiteAtivo: true,
  eqLimiteArmaC: 10,
  eqLimiteCancelaC: 40,
  eqLimiteReposta: true,
  eqLimiteResizeSh: 5,
  eqMakerAtivo: true,
  eqMakerFolgaC: 1,
  geracaoAtiva: true,
  viradaQualquerIdx: true,
  viradaSoAtras: true,
  viradaSoAtrasVirada: 1,
  intervaloComprasSeg: 2.0,
  esperaAtiva: true,
  esperaLimiteC: 70,
  esperaGatilhoC: 53,
  travaAtiva: true,
  travaSomaC: 100,
  travaTolSh: 1,
  travaMinSh: 5,
  travaExigeLucro: true,
  travaLucroMinUsd: 0,
  extratravaAtiva: true,
  extratravaDescontoC: 5,
  extratravaMinUsd: 1,
  pausaLiderAtiva: true,
  pausaLiderFolga: 0,
  tetoInvestAtivo: true,
  tetoInvestFolga: 0,
  tetoDescAtivo: false,
  tetoDescFolgaUsd: 0,
  multCalcAtivo: true,
  multCalcVirada: 6,
  multCalcFator: 1.55,
  pisoAtivo: true,
  pisoViradas: [4, 5],
  pisoMargem: 0.02,
  maxViradasAtivo: true,
  maxViradas: 4,
  descModo: 'comprar',
  descVirada: 5,
  descSoAtras: false,
  descSoAtrasVirada: 5,
  eqstopAtivo: false,
  eqstopVirada: 10,
  eqstopGatilhoC: 53,
  /** Force-EQ no fim do evento (tau ≤ forceEqFimSeg), bypass gate de lucro. */
  forceEqFimAtivo: false,
  forceEqFimSeg: 30,
  /** Force-EQ quando escada congela por maxViradas (bypass gate). */
  forceEqNoFreeze: false,
  bloco27Ativo: false,
  sub35Ativo: false,
  extraAtiva: false,
  fokAtivo: true,
  fokPrecoTeto: 0.98,
  slippageCompra: 0.04,
  filterLo: 0.10,
  filterHi: 0.95,
  antiGlitch: true,
  somaMinValida: 85,
  somaMaxValida: 115,
  minSecondsLeftToStart: 0,
  maxSecondsLeftToStart: 285,
  maxEventNotional: 10000,
  makerFillEpsilon: 0.01,
  makerTimeoutSec: 45,
  tetoSharesOrdem: 5000,
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
  return 'comprar';
}

function resolveContagio(raw = {}) {
  const c = String(raw.contagio ?? DEFAULT_PARAMS.contagio).trim().toLowerCase();
  if (c === 'off' || c === 'piso' || c === 'lado' || c === 'global') return c;
  return 'off';
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

function mergeRelux5Params(raw = {}) {
  const params = { ...DEFAULT_PARAMS, ...raw };
  const sizeScale = clamp(toFiniteNumber(raw.sizeScale, DEFAULT_PARAMS.sizeScale), 0.05, 10);
  params.sizeScale = sizeScale;
  params.walletSize = toFiniteNumber(raw.walletSize, DEFAULT_PARAMS.walletSize);
  params.mult = Array.isArray(raw.mult) && raw.mult.length
    ? raw.mult.map((v) => Number(v))
    : [...DEFAULT_PARAMS.mult];
  params.multDesc = Array.isArray(raw.multDesc) && raw.multDesc.length
    ? raw.multDesc.map((v) => Number(v))
    : [...DEFAULT_PARAMS.multDesc];
  params.multDescAtivo = toBool(raw.multDescAtivo, DEFAULT_PARAMS.multDescAtivo);
  params.contagio = resolveContagio(raw);
  params.contagioMin = Math.max(1, toFiniteNumber(raw.contagioMin, DEFAULT_PARAMS.contagioMin));
  params.equalizar = toBool(raw.equalizar, DEFAULT_PARAMS.equalizar);
  params.eqPreco = toFiniteNumber(raw.eqPreco, DEFAULT_PARAMS.eqPreco);
  params.eqEncerra = toBool(raw.eqEncerra, DEFAULT_PARAMS.eqEncerra);
  params.equalizaIgnoraTeto = toBool(raw.equalizaIgnoraTeto, DEFAULT_PARAMS.equalizaIgnoraTeto);
  params.eqExigeLucro = toBool(raw.eqExigeLucro, DEFAULT_PARAMS.eqExigeLucro);
  params.eqLucroMinUsd = toFiniteNumber(raw.eqLucroMinUsd, DEFAULT_PARAMS.eqLucroMinUsd);
  params.eqLimiteAtivo = toBool(raw.eqLimiteAtivo, DEFAULT_PARAMS.eqLimiteAtivo);
  params.eqLimiteArmaC = toFiniteNumber(raw.eqLimiteArmaC, DEFAULT_PARAMS.eqLimiteArmaC);
  params.eqLimiteCancelaC = toFiniteNumber(raw.eqLimiteCancelaC, DEFAULT_PARAMS.eqLimiteCancelaC);
  params.eqLimiteReposta = toBool(raw.eqLimiteReposta, DEFAULT_PARAMS.eqLimiteReposta);
  params.eqLimiteResizeSh = toFiniteNumber(raw.eqLimiteResizeSh, DEFAULT_PARAMS.eqLimiteResizeSh);
  params.eqMakerAtivo = toBool(raw.eqMakerAtivo, DEFAULT_PARAMS.eqMakerAtivo);
  params.eqMakerFolgaC = toFiniteNumber(raw.eqMakerFolgaC, DEFAULT_PARAMS.eqMakerFolgaC);
  params.geracaoAtiva = toBool(raw.geracaoAtiva, DEFAULT_PARAMS.geracaoAtiva);
  params.viradaQualquerIdx = toBool(raw.viradaQualquerIdx, DEFAULT_PARAMS.viradaQualquerIdx);
  params.viradaSoAtras = toBool(raw.viradaSoAtras, DEFAULT_PARAMS.viradaSoAtras);
  params.viradaSoAtrasVirada = Math.round(toFiniteNumber(raw.viradaSoAtrasVirada, DEFAULT_PARAMS.viradaSoAtrasVirada));
  params.intervaloComprasSeg = toFiniteNumber(raw.intervaloComprasSeg, DEFAULT_PARAMS.intervaloComprasSeg);
  params.esperaAtiva = toBool(raw.esperaAtiva, DEFAULT_PARAMS.esperaAtiva);
  params.esperaLimiteC = toFiniteNumber(raw.esperaLimiteC, DEFAULT_PARAMS.esperaLimiteC);
  params.esperaGatilhoC = toFiniteNumber(raw.esperaGatilhoC, DEFAULT_PARAMS.esperaGatilhoC);
  params.travaAtiva = toBool(raw.travaAtiva, DEFAULT_PARAMS.travaAtiva);
  params.travaSomaC = toFiniteNumber(raw.travaSomaC, DEFAULT_PARAMS.travaSomaC);
  params.travaTolSh = toFiniteNumber(raw.travaTolSh, DEFAULT_PARAMS.travaTolSh);
  params.travaMinSh = toFiniteNumber(raw.travaMinSh, DEFAULT_PARAMS.travaMinSh);
  params.travaExigeLucro = toBool(raw.travaExigeLucro, DEFAULT_PARAMS.travaExigeLucro);
  params.travaLucroMinUsd = toFiniteNumber(raw.travaLucroMinUsd, DEFAULT_PARAMS.travaLucroMinUsd);
  params.extratravaAtiva = toBool(raw.extratravaAtiva, DEFAULT_PARAMS.extratravaAtiva);
  params.extratravaDescontoC = toFiniteNumber(raw.extratravaDescontoC, DEFAULT_PARAMS.extratravaDescontoC);
  params.extratravaMinUsd = toFiniteNumber(raw.extratravaMinUsd, DEFAULT_PARAMS.extratravaMinUsd);
  params.pausaLiderAtiva = toBool(raw.pausaLiderAtiva, DEFAULT_PARAMS.pausaLiderAtiva);
  params.pausaLiderFolga = toFiniteNumber(raw.pausaLiderFolga, DEFAULT_PARAMS.pausaLiderFolga);
  params.tetoInvestAtivo = toBool(raw.tetoInvestAtivo, DEFAULT_PARAMS.tetoInvestAtivo);
  params.tetoInvestFolga = toFiniteNumber(raw.tetoInvestFolga, DEFAULT_PARAMS.tetoInvestFolga);
  params.tetoDescAtivo = toBool(raw.tetoDescAtivo, DEFAULT_PARAMS.tetoDescAtivo);
  params.tetoDescFolgaUsd = toFiniteNumber(raw.tetoDescFolgaUsd, DEFAULT_PARAMS.tetoDescFolgaUsd);
  params.multCalcAtivo = toBool(raw.multCalcAtivo, DEFAULT_PARAMS.multCalcAtivo);
  params.multCalcVirada = Math.round(toFiniteNumber(raw.multCalcVirada, DEFAULT_PARAMS.multCalcVirada));
  params.multCalcFator = toFiniteNumber(raw.multCalcFator, DEFAULT_PARAMS.multCalcFator);
  params.pisoAtivo = toBool(raw.pisoAtivo, DEFAULT_PARAMS.pisoAtivo);
  params.pisoViradas = Array.isArray(raw.pisoViradas)
    ? raw.pisoViradas.map((v) => Math.round(Number(v)))
    : [...DEFAULT_PARAMS.pisoViradas];
  params.pisoMargem = toFiniteNumber(raw.pisoMargem, DEFAULT_PARAMS.pisoMargem);
  params.maxViradasAtivo = toBool(raw.maxViradasAtivo, DEFAULT_PARAMS.maxViradasAtivo);
  params.maxViradas = Math.round(toFiniteNumber(raw.maxViradas, DEFAULT_PARAMS.maxViradas));
  params.descModo = resolveDescModo(raw);
  params.descVirada = Math.round(toFiniteNumber(raw.descVirada, DEFAULT_PARAMS.descVirada));
  params.descSoAtras = toBool(raw.descSoAtras, DEFAULT_PARAMS.descSoAtras);
  params.descSoAtrasVirada = Math.round(toFiniteNumber(raw.descSoAtrasVirada, DEFAULT_PARAMS.descSoAtrasVirada));
  params.eqstopAtivo = toBool(raw.eqstopAtivo, DEFAULT_PARAMS.eqstopAtivo);
  params.eqstopVirada = Math.round(toFiniteNumber(raw.eqstopVirada, DEFAULT_PARAMS.eqstopVirada));
  params.eqstopGatilhoC = toFiniteNumber(raw.eqstopGatilhoC, DEFAULT_PARAMS.eqstopGatilhoC);
  params.forceEqFimAtivo = toBool(raw.forceEqFimAtivo, DEFAULT_PARAMS.forceEqFimAtivo);
  params.forceEqFimSeg = toFiniteNumber(raw.forceEqFimSeg, DEFAULT_PARAMS.forceEqFimSeg);
  params.forceEqNoFreeze = toBool(raw.forceEqNoFreeze, DEFAULT_PARAMS.forceEqNoFreeze);
  params.bloco27Ativo = toBool(raw.bloco27Ativo, DEFAULT_PARAMS.bloco27Ativo);
  params.sub35Ativo = toBool(raw.sub35Ativo, DEFAULT_PARAMS.sub35Ativo);
  params.extraAtiva = toBool(raw.extraAtiva, DEFAULT_PARAMS.extraAtiva);
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
  params.tetoSharesOrdem = toFiniteNumber(raw.tetoSharesOrdem, DEFAULT_PARAMS.tetoSharesOrdem);
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

function multDescFator(idx, params) {
  if (!params.multDescAtivo) return 1;
  const i = idx - 1;
  if (i >= 0 && i < params.multDesc.length) return Number(params.multDesc[i]) || 1;
  return 1;
}

function shouldFillRestingBuy(prevAsk, currAsk, limitPrice, epsilon = 0.01) {
  if (currAsk == null || limitPrice == null) return false;
  if (!Number.isFinite(currAsk) || !Number.isFinite(limitPrice)) return false;
  // Ask já no/abaixo do limite (DESC postada in-the-money) → fill.
  if (currAsk <= limitPrice - epsilon) return true;
  // Cruzamento clássico: vinha acima e passou pelo limite.
  if (prevAsk == null || !Number.isFinite(prevAsk)) return false;
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

function opposite(lado) {
  return lado === 'UP' ? 'DOWN' : 'UP';
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

function avgPrice(cost, shares) {
  if (!shares || shares <= 0) return null;
  return cost / shares;
}

const POLYMARKET_CRYPTO_FEE_RATE = 0.07;

function resolveEqFeeRate(params) {
  if (params.polymarketFeeRate != null && Number.isFinite(Number(params.polymarketFeeRate))) {
    return Number(params.polymarketFeeRate);
  }
  const cat = String(params.polymarketFeeCategory || 'crypto').toLowerCase();
  if (cat === 'crypto') return POLYMARKET_CRYPTO_FEE_RATE;
  if (cat === 'sports') return 0.03;
  return 0.05;
}

function estimateEqFillFee(qty, price, params, liquidity = 'taker') {
  if (params.applyPolymarketFees === false) return 0;
  if (liquidity === 'maker') return 0;
  const q = Number(qty);
  const p = Number(price);
  if (!(q > 0) || !(p > 0) || p >= 1) return 0;
  return q * resolveEqFeeRate(params) * p * (1 - p);
}

function projectedEqualizeOutcome(shares, cost, dif, fillPrice) {
  const invested = cost.UP + cost.DOWN;
  const matchedAfter = Math.min(shares.UP, shares.DOWN) + dif;
  const costAfter = invested + dif * fillPrice;
  return {
    locked: matchedAfter - costAfter,
    matchedAfter,
    costAfter,
  };
}

function eqProjectedNet(shares, cost, dif, fillPrice, params, liquidity = 'taker') {
  const { locked } = projectedEqualizeOutcome(shares, cost, dif, fillPrice);
  const feeEst = estimateEqFillFee(dif, fillPrice, params, liquidity);
  return { locked, feeEst, net: locked - feeEst };
}

function eqWouldBeProfitable(shares, cost, dif, fillPrice, params, liquidity = 'taker') {
  if (!params.eqExigeLucro) return true;
  if (!(dif > 1e-9)) return false;
  const { net } = eqProjectedNet(shares, cost, dif, fillPrice, params, liquidity);
  return net >= params.eqLucroMinUsd - 1e-9;
}

function resolveEqMakerPostPrice(askMenor, params) {
  if (params.eqMakerAtivo && askMenor != null) {
    const folga = Math.max(params.eqPreco, askMenor - params.eqMakerFolgaC / 100);
    return Math.min(params.eqPreco, folga);
  }
  return params.eqPreco;
}

/** Congela escada quando ask do menor ≤ eqPreco mas EQ taker não fecharia lucrativa. */
function shouldFreezeEscadaForEq(shares, cost, asks, params) {
  if (!params.equalizar || !params.eqExigeLucro) return false;
  const dif = Math.abs(shares.UP - shares.DOWN);
  if (dif <= 1e-9) return false;
  const menor = shares.UP < shares.DOWN ? 'UP' : 'DOWN';
  const askMenor = asks[menor];
  if (askMenor == null || askMenor > params.eqPreco) return false;
  const takerPrice = Math.min(askMenor, params.eqPreco);
  return !eqWouldBeProfitable(shares, cost, dif, takerPrice, params, 'taker');
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
    tsUltimaViradaMs: 0,
    shares: { UP: 0, DOWN: 0 },
    cost: { UP: 0, DOWN: 0 },
    invested: 0,
    fills: [],
    restingOrders: [],
    pendingTakerOrders: [],
    eqOrder: null,
    equalized: false,
    encerrado: false,
    travaFeita: false,
    extratravaOrder: null,
    escadaArmada: false,
    esperaAvaliada: false,
    esperaAtivaFlag: false,
    esperaLado: null,
    esperaCaroC: null,
    snapTick: { UP: 0, DOWN: 0 },
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
      travaCount: 0,
      extratravaFills: 0,
      geracoes: 0,
      eqStopCount: 0,
      forceEqCount: 0,
    },
  };
}

function recordBlock(state, reason) {
  state.telemetry.blockReasons[reason] = (state.telemetry.blockReasons[reason] || 0) + 1;
}

function isEVirada(dispSub, idx, viradas, lado, ladoVirada, geracaoAtiva) {
  if (!dispSub) return false;
  if (idx === 1) return true;
  return geracaoAtiva && viradas > 0 && lado !== ladoVirada;
}

function registraViradaFlag(dispSub, idx, eVirada, lado, ladoVirada, viradaQualquerIdx) {
  if (!dispSub) return false;
  if (idx === 1) return true;
  return viradaQualquerIdx && eVirada && lado !== ladoVirada;
}

function nivelLabel(tipo, idx, geracaoAtiva, viradas, viraGeracao) {
  if (!geracaoAtiva) return `${tipo}-${idx}`;
  const ger = viraGeracao ? (viradas + 1) : Math.max(1, viradas);
  return `${tipo}${ger}-${idx}`;
}

/**
 * Simula caminho sintético UP em centavos (dn = 100-up).
 * Modo simplificado para testes de fator/geração/DESC/TRAVA/EQ.
 */
function simulateRelux5Path(paramsRaw, upPathCents, winnerSide, options = {}) {
  const params = mergeRelux5Params(paramsRaw);
  const honest = options.honest === true || params.executionMode === 'honest';
  let ladder = buildLadder(params);
  const ativo = { UP: 1, DOWN: 1, G: 1 };
  const histSub = [];
  let viradas = 0;
  let ladoVirada = null;
  const shares = { UP: 0, DOWN: 0 };
  const cost = { UP: 0, DOWN: 0 };
  const fills = [];
  let equalized = false;
  let encerrado = false;
  let travaFeita = false;

  const buy = (lado, nivel, sh, priceCents, liquidity, rotulo) => {
    if (sh <= 0 || encerrado) return false;
    const price = priceCents / 100;
    const notional = cost.UP + cost.DOWN;
    if (notional + sh * price > params.maxEventNotional) return false;
    shares[lado] += sh;
    cost[lado] += sh * price;
    fills.push({
      lado, tipo: rotulo || `${nivel.tipo}-${nivel.idx}`, shares: sh, price, liquidity,
    });
    if (nivel.tipo === 'SUB') histSub.push({ lado, idx: nivel.idx });
    return true;
  };

  const step = (upC) => {
    if (encerrado) return;
    const dnC = 100 - upC;
    const asks = { UP: upC, DOWN: dnC };
    const asksD = { UP: upC / 100, DOWN: dnC / 100 };
    const snap = { UP: shares.UP, DOWN: shares.DOWN };
    const eqEscadaFreeze = shouldFreezeEscadaForEq(shares, cost, asksD, params);
    const congelado = (params.maxViradasAtivo && viradas >= params.maxViradas) || eqEscadaFreeze;

    for (const lado of ['UP', 'DOWN']) {
      const askC = asks[lado];
      for (const n of ladder[lado]) {
        if (!n.armado || congelado || encerrado) continue;
        const dispSub = n.tipo === 'SUB' && askC >= n.preco;
        const dispDesc = n.tipo === 'DESC' && askC <= n.preco;
        if (!dispSub && !dispDesc) continue;

        const cortaDesc = dispDesc && params.descModo !== 'comprar' && viradas >= params.descVirada;
        if (cortaDesc && params.descModo === 'congela') continue;

        let rebuildBreak = false;
        if (!cortaDesc) {
          const eVirada = isEVirada(dispSub, n.idx, viradas, lado, ladoVirada, params.geracaoAtiva);
          if (params.viradaSoAtras && eVirada && (viradas + 1) >= params.viradaSoAtrasVirada) {
            if (snap[lado] > snap[opposite(lado)]) continue;
          }

          let sh = n.shares;
          if (dispSub) {
            const fator = resolveFator(n.idx, lado, histSub, ativo, params);
            sh = Math.round(n.shares * fator * 100) / 100;
            let multCalcUsado = false;
            if (params.multCalcAtivo && eVirada && (viradas + 1) >= params.multCalcVirada) {
              const dif = snap[opposite(lado)] - snap[lado];
              if (dif > 0) {
                sh = Math.max(Math.round(dif * params.multCalcFator * 100) / 100, sh);
                multCalcUsado = true;
              }
            }
            if (params.pisoAtivo && n.idx === 1 && !multCalcUsado) {
              const proxVirada = viradas + 1;
              if (params.pisoViradas.includes(proxVirada)) {
                const dif = snap[opposite(lado)] - snap[lado];
                if (dif > 0) {
                  const piso = Math.round(dif * (1 + params.pisoMargem) * 100) / 100;
                  if (piso > sh) sh = piso;
                }
              }
            }
          } else {
            sh = Math.round(n.shares * multDescFator(n.idx, params) * 100) / 100;
          }
          sh = Math.min(sh, params.tetoSharesOrdem);

          const regVirada = registraViradaFlag(
            dispSub, n.idx, eVirada, lado, ladoVirada, params.viradaQualquerIdx,
          );
          const viraGeracao = params.geracaoAtiva && regVirada && viradas > 0;
          const rotulo = nivelLabel(n.tipo, n.idx, params.geracaoAtiva, viradas, viraGeracao);
          const liq = dispDesc && honest ? 'maker' : 'taker';
          const fillC = dispDesc ? n.preco : askC;
          if (buy(lado, n, sh, fillC, liq, rotulo)) {
            if (dispSub && regVirada) {
              viradas += 1;
              ladoVirada = lado;
              if (viraGeracao) {
                ladder = buildLadder(params);
                for (const c of ladder[lado]) {
                  if (c.tipo === 'SUB' && c.idx === 1) {
                    c.armado = false;
                    c.vezes = 1;
                  }
                }
                rebuildBreak = true;
              }
            }
            n.vezes += 1;
          }
        }

        n.armado = false;
        const compTipo = n.tipo === 'SUB' ? 'DESC' : 'SUB';
        const comp = ladder[lado].find((x) => x.tipo === compTipo && x.idx === n.idx);
        if (comp) comp.armado = true;
        if (rebuildBreak) break;
      }
      if (encerrado) break;
    }

    if (params.travaAtiva && !travaFeita && !encerrado
        && shares.UP >= params.travaMinSh && shares.DOWN >= params.travaMinSh) {
      const caro = ladoVirada || (asks.UP >= asks.DOWN ? 'UP' : 'DOWN');
      const barato = opposite(caro);
      if (shares[barato] + params.travaTolSh >= shares[caro]) {
        const mu = avgPrice(cost.UP, shares.UP);
        const md = avgPrice(cost.DOWN, shares.DOWN);
        if (mu != null && md != null) {
          const soma = (mu + md) * 100;
          const lucro = Math.min(shares.UP, shares.DOWN) - (cost.UP + cost.DOWN);
          if (soma < params.travaSomaC
              && (!params.travaExigeLucro || lucro >= params.travaLucroMinUsd)) {
            travaFeita = true;
            encerrado = true;
            equalized = Math.abs(shares.UP - shares.DOWN) <= params.travaTolSh;
          }
        }
      }
    }

    if (params.equalizar && !equalized && !encerrado && shares.UP !== shares.DOWN) {
      const menor = shares.UP < shares.DOWN ? 'UP' : 'DOWN';
      const eqAskC = asks[menor];
      if (eqAskC <= params.eqPreco * 100) {
        const falta = Math.abs(shares.UP - shares.DOWN);
        const fillPrice = eqAskC / 100;
        if (eqWouldBeProfitable(shares, cost, falta, fillPrice, params, 'taker')) {
          buy(menor, { tipo: 'EQUALIZA', idx: 0 }, falta, eqAskC, 'taker', 'EQUALIZA');
          equalized = true;
          if (params.eqEncerra) encerrado = true;
        }
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
    shares, cost, inv, fills, equalized, viradas, travaFeita,
    pnlGross: winSh - inv,
    params,
    histSub,
    ativo,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeRelux5Params(rawParams);
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
    // Fees NÃO entram no cost — o lab aplica via applyPolymarketFeesToBacktestResult.
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
    addLog(ts, `COMPRA Relux5 | ${lado} ${qty.toFixed(2)}sh @ $${fillPrice.toFixed(4)} | ${type} | ${liquidity}`, 'entry');
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
      const filled = applyBuyCost(lado, qty, limit, type, ts, 'maker', meta);
      if (filled > 0) current.telemetry.descFilled += 1;
      return filled;
    }

    // Ask já no/abaixo do limite: fill imediato (equiv. dry-run Python).
    if (ask <= limit - (params.makerFillEpsilon || 0.01) + 1e-12
        || ask <= limit + 1e-12) {
      const filled = applyBuyCost(lado, qty, limit, type, ts, 'maker', meta);
      if (filled > 0) {
        current.telemetry.descPlaced += 1;
        current.telemetry.descFilled += 1;
        addLog(ts, `DESC FILL | ${lado} ${qty}sh @ $${limit.toFixed(4)} | ${type}`, 'entry');
      }
      return filled;
    }

    const key = `${lado}|${type}|${meta.idx || 0}|${meta.kind || 'DESC'}`;
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

  const cancelResting = (key, reason) => {
    const idx = current.restingOrders.findIndex((o) => o.key === key && o.status === 'open');
    if (idx < 0) return;
    current.restingOrders[idx].status = 'cancelled';
    current.restingOrders.splice(idx, 1);
    if (reason === 'timeout') current.telemetry.descTimeouts += 1;
    addLog(current.lastTick?.ts || new Date().toISOString(), `DESC CANCEL | ${key} | ${reason}`, 'info');
  };

  const cancelAllResting = (reason) => {
    for (const o of [...current.restingOrders]) cancelResting(o.key, reason);
    current.eqOrder = null;
  };

  const novaGeracao = (lado, geracao, ts) => {
    cancelAllResting(`virada -> geracao ${geracao}`);
    current.ladder = buildLadder(params);
    for (const c of current.ladder[lado]) {
      if (c.tipo === 'SUB' && c.idx === 1) {
        c.armado = false;
        c.vezes = 1;
        break;
      }
    }
    current.telemetry.geracoes += 1;
    addLog(ts, `NOVA GERACAO ${geracao} | virada no ${lado}`, 'info');
  };

  const onSubFilled = (lado, idx, meta = {}) => {
    current.histSub.push({ lado, idx });
    const eVirada = isEVirada(true, idx, current.viradas, lado, current.ladoVirada, params.geracaoAtiva);
    const reg = registraViradaFlag(
      true, idx, eVirada, lado, current.ladoVirada, params.viradaQualquerIdx,
    );
    if (!reg) return { rebuilt: false };

    const viraGeracao = params.geracaoAtiva && current.viradas > 0;
    current.viradas += 1;
    current.ladoVirada = lado;
    current.tsUltimaViradaMs = new Date(current.lastTick?.ts || Date.now()).getTime();
    current.telemetry.viradas = current.viradas;

    // stubs Phase-1 off features
    if (params.bloco27Ativo) { /* no-op Phase 1 */ }
    if (params.sub35Ativo) { /* no-op Phase 1 */ }
    if (params.extraAtiva) { /* no-op Phase 1 */ }

    if (viraGeracao) {
      novaGeracao(lado, current.viradas, current.lastTick?.ts || new Date().toISOString());
      return { rebuilt: true };
    }
    return { rebuilt: false };
  };

  const processPendingTaker = (tick) => {
    if (!current?.pendingTakerOrders?.length) return;
    for (const o of current.pendingTakerOrders) o.ticksLeft -= 1;
    const due = current.pendingTakerOrders.filter((o) => o.ticksLeft <= 0);
    current.pendingTakerOrders = current.pendingTakerOrders.filter((o) => o.ticksLeft > 0);
    for (const o of due) {
      const filled = executeTakerBuy(o.lado, o.qty, o.limitCents, o.type, tick.ts, o.meta || {});
      if (filled > 0 && o.meta?.isSub) onSubFilled(o.lado, o.meta.idx, o.meta);
    }
  };

  const checkResting = (tick) => {
    if (!current?.restingOrders.length) return;
    const tickMs = new Date(tick.ts).getTime();
    const timeoutMs = (params.makerTimeoutSec || 45) * 1000;
    for (const resting of [...current.restingOrders]) {
      if (resting.status !== 'open') continue;
      const isExtra = resting.meta?.kind === 'EXTRATRAVA';
      if (!isExtra && tickMs - resting.placedMs >= timeoutMs) {
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
      const filled = applyBuyCost(
        resting.side, resting.qty, resting.price, resting.type, tick.ts, 'maker', resting.meta || {},
      );
      if (filled > 0) {
        resting.status = 'filled';
        current.restingOrders = current.restingOrders.filter((o) => o.key !== resting.key);
        if (isExtra) {
          current.telemetry.extratravaFills += 1;
          current.extratravaOrder = null;
        } else {
          current.telemetry.descFilled += 1;
        }
      }
    }
  };

  const placeOrFillBuy = (lado, qty, limitCents, type, ts, meta = {}) => {
    const isDesc = meta.isDesc === true;
    if (isDesc) return placeDescResting(lado, qty, limitCents, type, ts, meta);

    if ((params.takerLatencyTicks || 0) > 0) {
      const pendKey = `${lado}|${type}|${meta.idx || 0}`;
      if (current.pendingTakerOrders.some((o) => o.key === pendKey)) return -1;
      current.pendingTakerOrders.push({
        key: pendKey,
        lado,
        qty,
        limitCents,
        type,
        meta,
        ticksLeft: params.takerLatencyTicks,
      });
      return -1;
    }

    if (params.executionMode === 'optimistic') {
      const ask = sideFields(current.lastTick, lado).ask;
      const fillPrice = ask != null ? ask : limitCents / 100;
      const filled = applyBuyCost(lado, qty, fillPrice, type, ts, 'taker', meta);
      if (filled > 0 && meta.isSub) onSubFilled(lado, meta.idx, meta);
      return filled;
    }

    const filled = executeTakerBuy(lado, qty, limitCents, type, ts, meta);
    if (filled > 0 && meta.isSub) onSubFilled(lado, meta.idx, meta);
    return filled;
  };

  const bloqueadoPorVirada = (lado, tipo, tickMs) => {
    if (current.ladoVirada == null || !current.tsUltimaViradaMs) return false;
    if ((tickMs - current.tsUltimaViradaMs) / 1000 >= params.intervaloComprasSeg) return false;
    const op = opposite(current.ladoVirada);
    if (tipo === 'SUB' && lado === op) return true;
    if (tipo === 'DESC' && lado === current.ladoVirada) return true;
    return false;
  };

  const pausaLiderAtiva = () => {
    if (!params.pausaLiderAtiva || !current.ladoVirada) {
      return { pausado: false, sobe: null, shS: 0, shO: 0 };
    }
    const sobe = current.ladoVirada;
    const shS = current.shares[sobe];
    const shO = current.shares[opposite(sobe)];
    const pausado = shS > shO + params.pausaLiderFolga
      && shS > current.invested + params.pausaLiderFolga;
    return { pausado, sobe, shS, shO };
  };

  const postExtratrava = (caro, barato, muCaro, ts) => {
    if (!params.extratravaAtiva || current.extratravaOrder) return;
    const sharesDif = Math.round((current.shares[barato] - current.shares[caro]) * 100) / 100;
    if (sharesDif <= 1e-9) return;
    let preco = Math.floor((muCaro * 100) - params.extratravaDescontoC) / 100;
    preco = Math.max(0.01, Math.min(preco, 0.97));
    const notional = sharesDif * preco;
    if (notional < params.extratravaMinUsd - 1e-9) {
      recordBlock(current, 'EXTRATRAVA_MINIMO');
      return;
    }
    current.extratravaOrder = { lado: caro, shares: sharesDif, price: preco };
    if (params.executionMode === 'optimistic') {
      applyBuyCost(caro, sharesDif, preco, 'EXTRATRAVA', ts, 'maker', {
        kind: 'EXTRATRAVA', ignoraTeto: true,
      });
      current.telemetry.extratravaFills += 1;
      current.extratravaOrder = null;
      return;
    }
    const fields = sideFields(current.lastTick, caro);
    current.restingOrders.push({
      key: `${caro}|EXTRATRAVA|0|EXTRATRAVA`,
      side: caro,
      price: preco,
      qty: sharesDif,
      type: 'EXTRATRAVA',
      meta: { kind: 'EXTRATRAVA', ignoraTeto: true },
      placedTs: ts,
      placedMs: new Date(ts).getTime(),
      lastAsk: fields.ask,
      status: 'open',
    });
    addLog(ts, `EXTRATRAVA POST | ${caro} ${sharesDif}sh @ $${preco.toFixed(4)}`, 'info');
  };

  const travaConferir = (asks, tick) => {
    if (!params.travaAtiva || current.travaFeita || current.encerrado || current.equalized) {
      return false;
    }
    if (current.shares.UP < params.travaMinSh || current.shares.DOWN < params.travaMinSh) {
      return false;
    }
    const caro = current.ladoVirada
      || (asks.UP >= asks.DOWN ? 'UP' : 'DOWN');
    const barato = opposite(caro);
    if (current.shares[barato] + params.travaTolSh < current.shares[caro]) return false;

    const mu = avgPrice(current.cost.UP, current.shares.UP);
    const md = avgPrice(current.cost.DOWN, current.shares.DOWN);
    if (mu == null || md == null) return false;
    const soma = (mu + md) * 100;
    if (soma >= params.travaSomaC) return false;

    const travadas = Math.min(current.shares.UP, current.shares.DOWN);
    const lucro = travadas - current.invested;
    if (params.travaExigeLucro && lucro < params.travaLucroMinUsd) {
      recordBlock(current, 'TRAVA_SEM_LUCRO');
      return false;
    }

    current.travaFeita = true;
    current.equalized = Math.abs(current.shares.UP - current.shares.DOWN) <= params.travaTolSh;
    current.encerrado = true;
    current.telemetry.travaCount += 1;
    cancelAllResting('TRAVA');
    addLog(tick.ts, `TRAVA | caro ${caro} / barato ${barato} | soma ${soma.toFixed(1)}c | lucro $${lucro.toFixed(2)}`, 'profit');
    postExtratrava(caro, barato, caro === 'UP' ? mu : md, tick.ts);
    return true;
  };

  const eqCancel = (motivo) => {
    if (!current.eqOrder) return;
    current.eqOrder = null;
    current.telemetry.eqCancels += 1;
    addLog(current.lastTick?.ts || new Date().toISOString(), `EQ CANCEL | ${motivo}`, 'info');
  };

  const eqExecute = (lado, sharesQty, price, ts) => {
    if (!eqWouldBeProfitable(current.shares, current.cost, sharesQty, price, params, 'maker')) {
      recordBlock(current, 'EQ_SEM_LUCRO');
      eqCancel('EQ_SEM_LUCRO');
      return;
    }
    applyBuyCost(lado, sharesQty, price, 'EQUALIZA', ts, 'maker', {
      ignoraTeto: params.equalizaIgnoraTeto,
    });
    current.equalized = true;
    current.eqOrder = null;
    addLog(ts, `EQUALIZOU | ${lado} +${sharesQty}sh @ $${price.toFixed(4)}`, 'profit');
    if (params.eqEncerra) current.encerrado = true;
  };

  const eqPostPrice = (askMenor) => resolveEqMakerPostPrice(askMenor, params);

  const eqPost = (lado, sharesQty, askMenor) => {
    const price = eqPostPrice(askMenor);
    if (!eqWouldBeProfitable(current.shares, current.cost, sharesQty, price, params, 'maker')) {
      recordBlock(current, 'EQ_SEM_LUCRO');
      return;
    }
    current.eqOrder = { lado, shares: sharesQty, price, postedMs: Date.now() };
    current.telemetry.eqPosts += 1;
    addLog(current.lastTick?.ts || new Date().toISOString(), `EQ POST | ${lado} ${sharesQty}sh @ ${price}`, 'info');
  };

  const manageEqLimite = (tick, asks) => {
    if (!params.equalizar || !params.eqLimiteAtivo || current.equalized || current.encerrado) return;
    const dif = Math.abs(current.shares.UP - current.shares.DOWN);
    const menor = current.shares.UP < current.shares.DOWN ? 'UP' : 'DOWN';
    const askMenor = asks[menor];
    if (askMenor == null) return;

    if (current.eqOrder) {
      if (askMenor <= current.eqOrder.price + 1e-9) {
        eqExecute(current.eqOrder.lado, current.eqOrder.shares, current.eqOrder.price, tick.ts);
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
        if (dif > 1e-9) {
          const postPrice = eqPostPrice(askMenor);
          if (eqWouldBeProfitable(current.shares, current.cost, dif, postPrice, params, 'maker')) {
            eqPost(menor, dif, askMenor);
          } else {
            recordBlock(current, 'EQ_SEM_LUCRO');
          }
        }
      }
      return;
    }

    if (dif <= 1e-9) return;
    if (current.telemetry.eqCancels > 0 && !params.eqLimiteReposta) return;
    if (askMenor * 100 <= params.eqLimiteArmaC) eqPost(menor, dif, askMenor);
  };

  const tryEqTaker = (tick, asks) => {
    if (!params.equalizar || current.equalized || current.encerrado || current.eqOrder) return;
    const dif = Math.abs(current.shares.UP - current.shares.DOWN);
    if (dif <= 1e-9) return;
    const menor = current.shares.UP < current.shares.DOWN ? 'UP' : 'DOWN';
    if (asks[menor] > params.eqPreco) return;
    const fillPrice = Math.min(asks[menor], params.eqPreco);
    if (!eqWouldBeProfitable(current.shares, current.cost, dif, fillPrice, params, 'taker')) {
      recordBlock(current, 'EQ_SEM_LUCRO');
      return;
    }
    const filled = placeOrFillBuy(menor, dif, params.eqPreco * 100, 'EQUALIZA', tick.ts, {
      ignoraTeto: params.equalizaIgnoraTeto,
    });
    if (filled > 0) {
      current.equalized = true;
      if (params.eqEncerra) current.encerrado = true;
    }
  };

  // Equaliza a mercado sem gate de lucro (EQ-STOP / force-EQ).
  const forceEqualizeAtMarket = (tick, asks, label) => {
    if (current.encerrado || current.equalized) return false;
    const dif = Math.abs(current.shares.UP - current.shares.DOWN);
    if (dif > 1e-9) {
      const menor = current.shares.UP < current.shares.DOWN ? 'UP' : 'DOWN';
      const ask = asks[menor];
      if (ask == null || !(ask > 0)) {
        recordBlock(current, `${label}_SEM_ASK`);
        return false;
      }
      // Cancela EQ limite antes de tomar mercado (evita fill duplo)
      if (current.eqOrder) eqCancel(`${label}`);
      const limitCents = Math.min(99, Math.max(1, Math.ceil(ask * 100 + params.takerMaxExtraCents)));
      placeOrFillBuy(menor, dif, limitCents, label, tick.ts, {
        ignoraTeto: true,
      });
    }
    cancelAllResting(label);
    current.encerrado = true;
    current.equalized = true;
    addLog(tick.ts, `${label} | virada ${current.viradas} | dif equilibrada`, 'exit');
    return true;
  };

  // EQUALIZE-STOP: na N-ésima virada (ou quando já atingiu), vigia lado oposto.
  const tryEqStop = (tick, asks, asksC) => {
    if (!params.eqstopAtivo || current.encerrado || current.equalized) return false;
    if (current.shares.UP + current.shares.DOWN <= 0) return false;
    // Dispara se a próxima virada seria a N-ésima, OU já estamos em >= N (congelado).
    if (current.viradas < params.eqstopVirada - 1) return false;
    if (current.viradas < params.eqstopVirada) {
      // Ainda não bateu N: exige gatilho de preço no lado vigiado (como Python).
      if (!current.ladoVirada) return false;
      const vig = opposite(current.ladoVirada);
      if (asksC[vig] < params.eqstopGatilhoC) return false;
    }
    const ok = forceEqualizeAtMarket(tick, asks, 'EQUALIZA-STOP');
    if (ok) current.telemetry.eqStopCount += 1;
    return ok;
  };

  // Force-EQ no freeze (maxViradas) ou no fim do evento.
  const tryForceEq = (tick, asks, tau, congeladoPorViradas) => {
    if (current.encerrado || current.equalized) return false;
    if (current.shares.UP + current.shares.DOWN <= 0) return false;
    const dif = Math.abs(current.shares.UP - current.shares.DOWN);
    if (dif <= 1e-9) return false;

    let label = null;
    if (params.forceEqNoFreeze && congeladoPorViradas) label = 'FORCE-EQ-FREEZE';
    else if (params.forceEqFimAtivo && tau <= params.forceEqFimSeg) label = 'FORCE-EQ-FIM';
    if (!label) return false;

    const ok = forceEqualizeAtMarket(tick, asks, label);
    if (ok) current.telemetry.forceEqCount += 1;
    return ok;
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

    // Espera abertura: uma vez ao armar; se max(askC) > limite, espera barato >= gatilho
    if (params.esperaAtiva && current.escadaArmada && !current.esperaAvaliada) {
      current.esperaAvaliada = true;
      const upC = up.ask * 100;
      const dnC = down.ask * 100;
      if (Math.max(upC, dnC) > params.esperaLimiteC) {
        current.esperaAtivaFlag = true;
        current.esperaLado = upC >= dnC ? 'DOWN' : 'UP';
        current.esperaCaroC = Math.max(upC, dnC);
        addLog(tick.ts, `ESPERA ABERTURA | caro ${current.esperaCaroC.toFixed(0)}c | vigia ${current.esperaLado}`, 'info');
      }
    }

    if (current.esperaAtivaFlag) {
      const vigAsk = (current.esperaLado === 'UP' ? up.ask : down.ask) * 100;
      if (vigAsk >= params.esperaGatilhoC) {
        current.esperaAtivaFlag = false;
        addLog(tick.ts, `ESPERA LIBERADA | ${current.esperaLado} ${vigAsk.toFixed(0)}c`, 'info');
      } else {
        recordBlock(current, 'ESPERA_ABERTURA');
        return;
      }
    }

    if (current.encerrado) {
      // Extratrava / EQ resting já processados em checkResting
      current.prevAsk.UP = up.ask;
      current.prevAsk.DOWN = down.ask;
      return;
    }

    const asks = { UP: up.ask, DOWN: down.ask };
    const asksC = { UP: up.ask * 100, DOWN: down.ask * 100 };
    const tickMs = new Date(tick.ts).getTime();

    if (tryEqStop(tick, asks, asksC)) {
      current.prevAsk.UP = up.ask;
      current.prevAsk.DOWN = down.ask;
      return;
    }

    const eqEscadaFreeze = shouldFreezeEscadaForEq(current.shares, current.cost, asks, params);
    if (eqEscadaFreeze) recordBlock(current, 'EQ_SEM_LUCRO');
    const congeladoPorViradas = params.maxViradasAtivo && current.viradas >= params.maxViradas;
    const congelado = congeladoPorViradas || eqEscadaFreeze;
    current.snapTick = { UP: current.shares.UP, DOWN: current.shares.DOWN };

    if (tryForceEq(tick, asks, tau, congeladoPorViradas)) {
      current.prevAsk.UP = up.ask;
      current.prevAsk.DOWN = down.ask;
      return;
    }

    if (!congelado) {
      outerLados:
      for (const lado of ['UP', 'DOWN']) {
        const askC = asksC[lado];
        for (const n of current.ladder[lado]) {
          if (!n.armado || current.encerrado) continue;
          const dispSub = n.tipo === 'SUB' && askC >= n.preco;
          const dispDesc = n.tipo === 'DESC' && askC <= n.preco;
          if (!dispSub && !dispDesc) continue;

          const cortaDesc = dispDesc && params.descModo !== 'comprar' && current.viradas >= params.descVirada;
          if (cortaDesc) recordBlock(current, 'DESC_SO_GATILHO');
          if (cortaDesc && params.descModo === 'congela') continue;

          if (bloqueadoPorVirada(lado, n.tipo, tickMs)) {
            recordBlock(current, 'COOLDOWN_VIRADA');
            continue; // nível segue armado
          }

          // descSoAtras stub (default false)
          if (params.descSoAtras && dispDesc
              && current.viradas >= params.descSoAtrasVirada
              && current.shares[lado] > current.shares[opposite(lado)]) {
            recordBlock(current, 'DESC_SO_ATRAS');
            continue;
          }

          let consumed = cortaDesc;
          let rebuilt = false;

          if (!cortaDesc) {
            const eVirada = isEVirada(
              dispSub, n.idx, current.viradas, lado, current.ladoVirada, params.geracaoAtiva,
            );

            const pausa = pausaLiderAtiva();
            // PAUSA bloqueia SUB no líder; DESC no lado barato (atrás) atravessa —
            // sem isso a hedge da escada nunca materializa (PAUSA liga após 1ª SUB).
            const descHedge = dispDesc && pausa.pausado && lado !== pausa.sobe;
            if (pausa.pausado && !(eVirada && lado !== current.ladoVirada) && !descHedge) {
              recordBlock(current, 'PAUSA_LIDER');
              continue;
            }

            if (params.viradaSoAtras && eVirada
                && (current.viradas + 1) >= params.viradaSoAtrasVirada) {
              const meu = current.snapTick[lado];
              const opo = current.snapTick[opposite(lado)];
              if (meu > opo) {
                recordBlock(current, 'VIRADA_SO_ATRAS');
                continue;
              }
            }

            let sh = n.shares;
            let fator = 1;
            let multCalcUsado = false;
            if (dispSub) {
              fator = resolveFator(n.idx, lado, current.histSub, current.ativo, params);
              sh = Math.round(n.shares * fator * 100) / 100;
              if (params.multCalcAtivo && eVirada
                  && (current.viradas + 1) >= params.multCalcVirada) {
                const dif = current.snapTick[opposite(lado)] - current.snapTick[lado];
                if (dif > 0) {
                  const novo = Math.max(Math.round(dif * params.multCalcFator * 100) / 100, sh);
                  sh = novo;
                  multCalcUsado = true;
                }
              }
              if (params.pisoAtivo && n.idx === 1 && !multCalcUsado) {
                const proxVirada = current.viradas + 1;
                if (params.pisoViradas.includes(proxVirada)) {
                  const dif = current.snapTick[opposite(lado)] - current.snapTick[lado];
                  if (dif > 0) {
                    const piso = Math.round(dif * (1 + params.pisoMargem) * 100) / 100;
                    if (piso > sh) sh = piso;
                  }
                }
              }
            } else {
              fator = multDescFator(n.idx, params);
              sh = Math.round(n.shares * fator * 100) / 100;
            }

            if (params.tetoDescAtivo && dispDesc) {
              const depois = current.shares[lado] + sh;
              if (depois > current.invested + params.tetoDescFolgaUsd) {
                recordBlock(current, 'TETO_DESC');
                continue;
              }
            }

            if (params.tetoInvestAtivo && dispDesc) {
              const custo = sh * (n.preco / 100);
              const acumDep = current.invested + custo;
              const sobeSh = current.shares[opposite(lado)];
              if (acumDep > sobeSh + params.tetoInvestFolga) {
                recordBlock(current, 'TETO_INVEST');
                continue;
              }
            }

            sh = Math.min(sh, params.tetoSharesOrdem);

            const regVirada = registraViradaFlag(
              dispSub, n.idx, eVirada, lado, current.ladoVirada, params.viradaQualquerIdx,
            );
            const viraGeracao = params.geracaoAtiva && regVirada && current.viradas > 0;
            const tipo = nivelLabel(n.tipo, n.idx, params.geracaoAtiva, current.viradas, viraGeracao);

            const meta = {
              idx: n.idx,
              isSub: dispSub,
              isDesc: dispDesc,
              fator,
              regVirada,
            };

            // Skip onSubFilled inside placeOrFill for SUB — we handle after fill
            // to control geração rebuild. Temporarily use custom path.
            let filled = 0;
            if (dispDesc && params.executionMode === 'honest') {
              placeDescResting(lado, sh, n.preco, tipo, tick.ts, meta);
              consumed = true;
            } else if (dispDesc) {
              filled = placeOrFillBuy(lado, sh, n.preco, tipo, tick.ts, meta);
              if (filled > 0 || filled < 0) consumed = true;
              else consumed = true;
            } else {
              // SUB taker — bypass onSubFilled in placeOrFillBuy by not setting isSub
              // then call onSubFilled ourselves
              const metaNoSub = { ...meta, isSub: false };
              if ((params.takerLatencyTicks || 0) > 0) {
                filled = placeOrFillBuy(lado, sh, n.preco, tipo, tick.ts, { ...meta, isSub: true });
                if (filled < 0) consumed = true;
                else if (filled > 0) {
                  consumed = true;
                  // already handled via pending path's onSubFilled
                } else {
                  if (params.takerMissPolicy === 'skip') {
                    n.armado = false;
                    const compTipo = 'DESC';
                    const comp = current.ladder[lado].find((x) => x.tipo === compTipo && x.idx === n.idx);
                    if (comp) comp.armado = true;
                  }
                  continue;
                }
              } else if (params.executionMode === 'optimistic') {
                const ask = sideFields(current.lastTick, lado).ask;
                const fillPrice = ask != null ? ask : n.preco / 100;
                filled = applyBuyCost(lado, sh, fillPrice, tipo, tick.ts, 'taker', metaNoSub);
                if (filled > 0) {
                  const r = onSubFilled(lado, n.idx, meta);
                  rebuilt = r.rebuilt;
                  consumed = true;
                } else {
                  continue;
                }
              } else {
                filled = executeTakerBuy(lado, sh, n.preco, tipo, tick.ts, metaNoSub);
                if (filled > 0) {
                  const r = onSubFilled(lado, n.idx, meta);
                  rebuilt = r.rebuilt;
                  consumed = true;
                } else {
                  continue;
                }
              }
            }
            if (consumed) n.vezes += 1;
          }

          if (!consumed) continue;
          if (rebuilt) break outerLados;

          n.armado = false;
          const compTipo = n.tipo === 'SUB' ? 'DESC' : 'SUB';
          const comp = current.ladder[lado].find((x) => x.tipo === compTipo && x.idx === n.idx);
          if (comp) comp.armado = true;
        }
      }
    } else {
      recordBlock(current, 'CONGELADA');
    }

    travaConferir(asks, tick);
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
    travaCount: current.telemetry.travaCount,
    extratravaFills: current.telemetry.extratravaFills,
    geracoes: current.telemetry.geracoes,
    eqStopCount: current.telemetry.eqStopCount,
    forceEqCount: current.telemetry.forceEqCount,
    ativo: { ...current.ativo },
    histSub: [...current.histSub],
  });

  const settlementPnl = (tick) => {
    const priceToBeat = toFiniteNumber(current.priceToBeat ?? tick.price_to_beat);
    const btcPrice = toFiniteNumber(tick.btc_price);
    const upFinal = toFiniteNumber(tick.up_price, sideFields(tick, 'UP').ask);
    const winnerSide = btcPrice != null && priceToBeat != null
      ? (btcPrice >= priceToBeat ? 'UP' : 'DOWN')
      : (upFinal >= 0.5 ? 'UP' : 'DOWN');
    const winSh = winnerSide === 'UP' ? current.shares.UP : current.shares.DOWN;
    return { finalPnl: winSh - totalInvested(), winnerSide };
  };

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

    // Relux5 nunca vende: payout = shares vencedoras − investido
    const { finalPnl } = settlementPnl(tick);
    let closeReason = reason;
    if (current.travaFeita) closeReason = 'trava';
    else if (current.equalized && params.eqEncerra) closeReason = 'equalized';
    else closeReason = 'expired';

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
      exits: [],
      diagnostics: buildEventDiagnostics(),
      closedAt,
      equalized: current.equalized,
      travaFeita: current.travaFeita,
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
    addLog(
      closedAt,
      `EVENTO FIN | Relux5 | PnL ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)} | eq $${equityNow().toFixed(2)}`,
      finalPnl >= 0 ? 'profit' : 'loss',
    );
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
      addLog(tick.ts, 'Evento | Phil Hopper Relux5', 'info');
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick.price_to_beat);
    const tickTimeMs = new Date(tick.ts).getTime();
    if (tickTimeMs < new Date(current.eventStart).getTime()) return;
    if (tickTimeMs >= current.eventEndMs) {
      // Última chance: force-EQ no fim se ainda desbalanceado
      if ((params.forceEqFimAtivo || params.forceEqNoFreeze)
          && current && !current.encerrado && !current.equalized) {
        const up = sideFields(tick, 'UP');
        const down = sideFields(tick, 'DOWN');
        const asks = { UP: up.ask, DOWN: down.ask };
        if (up.ask != null && down.ask != null) {
          const congeladoPorViradas = params.maxViradasAtivo
            && current.viradas >= params.maxViradas;
          tryForceEq(tick, asks, 0, congeladoPorViradas);
        }
      }
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
      strategy: 'PHIL_HOPPER_RELUX5',
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

function runRelux5Backtest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

var __philHopperRelux5Exports = {
  createBacktestRunner,
  mergeRelux5Params,
  resolveFator,
  multDescFator,
  simulateRelux5Path,
  expandPathTargets,
  shouldFillRestingBuy,
  walkBook,
  runRelux5Backtest,
  eqWouldBeProfitable,
  eqProjectedNet,
  projectedEqualizeOutcome,
  shouldFreezeEscadaForEq,
  DEFAULT_SUB,
  DEFAULT_DESC,
  DEFAULT_PARAMS,
};
