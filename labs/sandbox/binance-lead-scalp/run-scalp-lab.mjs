/**
 * Binance → Polymarket lead-lag scalp lab (multi-flip).
 *
 * Dados reais: lake backtest_ticks BTC 5m depth25 ⨝ Binance Vision klines 1s.
 * NOTA: Binance 1s é lower-bound vs WS ao vivo (sub-segundo).
 *
 *   node --max-old-space-size=8192 labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs \
 *     --from 2026-05-15 --to 2026-05-22
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { downloadBinanceDailyZip } from '../../../scripts/download-binance-1s.js';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const BINANCE_DIR = path.resolve('data/binance-1s');
const EXTRACT_DIR = path.join(BINANCE_DIR, 'extracted');
const OUT_DIR = path.join('labs', 'sandbox', 'binance-lead-scalp', 'reports');
const LAKE_BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');

const DEFAULTS = {
  leadSec: 2,
  impulseUsd: 12,
  minAsk: 0.15,
  maxAsk: 0.7,
  maxSpread: 0.04,
  staleMidMoveMax: 0.02,
  budget: 10,
  takeProfit: 0.03,
  stopLoss: 0.05,
  /** se >0, stop = bid <= entryAsk*(1-stopPct); senão usa stopLoss absoluto */
  stopPct: 0,
  timeoutSec: 8,
  cooldownSec: 3,
  maxTradesPerEvent: 5,
  minTau: 20,
  maxTau: 280,
  feeRate: 0.07,
  /**
   * Impulso adaptativo: se >0, limiar = clamp(mult * sigma(ret leadSec, janela volWindowSec), floor, cap).
   * impulseUsd vira fallback quando não há sigma (início do dia).
   */
  impulseVolMult: 0,
  impulseFloor: 5,
  impulseCap: 12,
  volWindowSec: 300,
  /**
   * Modo resgate (só maker-ladder): stop/timeout não dumpa; posiciona ask maker em
   * entryAsk+rescueOffset e segura até fim do evento. rescueStop>0 = stop-desastre
   * absoluto (dump se bid <= entryAsk - rescueStop); 0 = segura até EOD.
   */
  rescue: false,
  rescueOffset: 0.01,
  rescueStop: 0.15,
  /** taker = sell no bid (fee); maker-ladder = asks limit sem fee + dump residual taker */
  exitMode: 'taker',
  /** offsets em $ do entryAsk para asks maker (realização parcial) */
  ladderOffsets: [0.01, 0.02, 0.03],
  /**
   * Sizing: none = budget/ask (atual);
   * sharesCap = min(budget/ask, floor(budget/sharesCapAsk));
   * dynamicBudget = se ask < sharesCapAsk, budget efetivo = budget*(ask/sharesCapAsk);
   * liqCap = min(budget/ask, askSz * liqCapMult) quando askSz conhecido.
   */
  sizingMode: 'none',
  sharesCapAsk: 0.5,
  /** Exige askSz >= shares * askSizeMult (baseline histórico = 0.75). */
  askSizeMult: 0.75,
  /** Fração do top-of-book usada no sizing liqCap. */
  liqCapMult: 0.9,
  /** Mínimo de shares (espelha CLOB live). */
  minShares: 5,
  tag: '',
};

function parseArgs(argv) {
  const out = { from: '2026-05-15', to: '2026-05-22', ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--impulse-usd') out.impulseUsd = Number(argv[++i]);
    else if (a === '--rescue') out.rescue = true;
    else if (a === '--rescue-offset') out.rescueOffset = Number(argv[++i]);
    else if (a === '--rescue-stop') out.rescueStop = Number(argv[++i]);
    else if (a === '--impulse-vol-mult') out.impulseVolMult = Number(argv[++i]);
    else if (a === '--impulse-floor') out.impulseFloor = Number(argv[++i]);
    else if (a === '--impulse-cap') out.impulseCap = Number(argv[++i]);
    else if (a === '--vol-window') out.volWindowSec = Number(argv[++i]);
    else if (a === '--lead-sec') out.leadSec = Number(argv[++i]);
    else if (a === '--stale-mid') out.staleMidMoveMax = Number(argv[++i]);
    else if (a === '--tp') out.takeProfit = Number(argv[++i]);
    else if (a === '--stop') out.stopLoss = Number(argv[++i]);
    else if (a === '--stop-pct') out.stopPct = Number(argv[++i]);
    else if (a === '--timeout') out.timeoutSec = Number(argv[++i]);
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--min-tau') out.minTau = Number(argv[++i]);
    else if (a === '--max-tau') out.maxTau = Number(argv[++i]);
    else if (a === '--max-trades') out.maxTradesPerEvent = Number(argv[++i]);
    else if (a === '--exit-mode') out.exitMode = String(argv[++i]);
    else if (a === '--tag') out.tag = String(argv[++i]);
    else if (a === '--sizing') out.sizingMode = String(argv[++i]);
    else if (a === '--shares-cap-ask') out.sharesCapAsk = Number(argv[++i]);
    else if (a === '--ask-size-mult') out.askSizeMult = Number(argv[++i]);
    else if (a === '--liq-cap-mult') out.liqCapMult = Number(argv[++i]);
    else if (a === '--min-shares') out.minShares = Number(argv[++i]);
    else if (a === '--ladder') {
      out.ladderOffsets = String(argv[++i])
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0);
    }
  }
  if (!out.ladderOffsets?.length) out.ladderOffsets = [...DEFAULTS.ladderOffsets];
  if (out.exitMode !== 'maker-ladder') out.exitMode = 'taker';
  if (!['none', 'sharesCap', 'dynamicBudget', 'liqCap'].includes(out.sizingMode)) {
    out.sizingMode = 'none';
  }
  if (!(Number.isFinite(out.sharesCapAsk) && out.sharesCapAsk > 0)) out.sharesCapAsk = DEFAULTS.sharesCapAsk;
  if (!(Number.isFinite(out.askSizeMult) && out.askSizeMult > 0)) out.askSizeMult = DEFAULTS.askSizeMult;
  if (!(Number.isFinite(out.liqCapMult) && out.liqCapMult > 0)) out.liqCapMult = DEFAULTS.liqCapMult;
  if (!(Number.isFinite(out.minShares) && out.minShares > 0)) out.minShares = DEFAULTS.minShares;
  return out;
}

/** Posição em shares a partir do budget, ask e (opcional) askSz. */
function sizeShares(budget, ask, cfg, askSz = null) {
  if (!(Number.isFinite(budget) && budget > 0 && Number.isFinite(ask) && ask > 0)) return 0;
  let shares = budget / ask;
  if (cfg.sizingMode === 'sharesCap') {
    const maxShares = Math.floor(budget / cfg.sharesCapAsk);
    shares = Math.min(shares, maxShares);
  } else if (cfg.sizingMode === 'dynamicBudget') {
    const eff = ask < cfg.sharesCapAsk ? budget * (ask / cfg.sharesCapAsk) : budget;
    shares = eff / ask;
  } else if (cfg.sizingMode === 'liqCap') {
    if (Number.isFinite(askSz) && askSz > 0) {
      shares = Math.min(shares, askSz * cfg.liqCapMult);
    }
  }
  return shares;
}

function stopHit(entryAsk, bid, cfg) {
  if (!(Number.isFinite(bid) && bid > 0 && Number.isFinite(entryAsk))) return false;
  if (cfg.stopPct > 0) return bid <= entryAsk * (1 - cfg.stopPct);
  return bid <= entryAsk - cfg.stopLoss;
}

function listDays(from, to) {
  if (!fs.existsSync(LAKE_BASE)) return [];
  return fs
    .readdirSync(LAKE_BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((dt) => dt >= from && dt <= to)
    .sort();
}

function filesFor(dt) {
  const dir = path.join(LAKE_BASE, `dt=${dt}`);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.resolve(dir, f));
}

function ensureExtracted(dateStr) {
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  const csv = path.join(EXTRACT_DIR, `BTCUSDT-1s-${dateStr}.csv`);
  if (fs.existsSync(csv) && fs.statSync(csv).size > 1000) return csv;
  const zip = path.join(BINANCE_DIR, `BTCUSDT-1s-${dateStr}.zip`);
  if (!fs.existsSync(zip)) return null;
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${EXTRACT_DIR.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.warn('extract fail', dateStr, e.message);
    return null;
  }
  return fs.existsSync(csv) ? csv : null;
}

function loadBinanceCloses(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    let t = Number(parts[0]);
    const close = Number(parts[4]);
    if (!Number.isFinite(t) || !Number.isFinite(close)) continue;
    if (t > 1e14) t = Math.floor(t / 1000);
    map.set(Math.floor(t / 1000), close);
  }
  return map;
}

/**
 * Limiar de impulso adaptativo por segundo: clamp(mult * sigma_rolling, floor, cap).
 * sigma = desvio-padrão dos retornos de leadSec sobre os últimos volWindowSec segundos.
 */
function buildImpulseThresholds(binMap, cfg) {
  const secs = [...binMap.keys()].sort((a, b) => a - b);
  const thr = new Map();
  const win = [];
  let sum = 0;
  let sumSq = 0;
  for (const sec of secs) {
    const prev = binMap.get(sec - cfg.leadSec);
    const now = binMap.get(sec);
    if (prev != null && now != null) {
      const r = now - prev;
      win.push({ sec, r });
      sum += r;
      sumSq += r * r;
    }
    const cutoff = sec - cfg.volWindowSec;
    while (win.length && win[0].sec < cutoff) {
      const old = win.shift();
      sum -= old.r;
      sumSq -= old.r * old.r;
    }
    if (win.length >= 30) {
      const n = win.length;
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      const sigma = Math.sqrt(variance);
      thr.set(
        sec,
        Math.min(cfg.impulseCap, Math.max(cfg.impulseFloor, cfg.impulseVolMult * sigma)),
      );
    }
  }
  return thr;
}

function feeEst(price, shares, rate) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return rate * p * (1 - p) * shares;
}

function sideBook(tick, side) {
  if (side === 'UP') {
    return {
      ask: Number(tick.up_best_ask),
      bid: Number(tick.up_best_bid),
      askSz: Number(tick.up_ask_sz_1),
    };
  }
  return {
    ask: Number(tick.down_best_ask),
    bid: Number(tick.down_best_bid),
    askSz: Number(tick.down_ask_sz_1),
  };
}

function midOf(tick, side) {
  const b = sideBook(tick, side);
  if (!Number.isFinite(b.ask) || !Number.isFinite(b.bid)) return null;
  return (b.ask + b.bid) / 2;
}

function closePosition(pos, exitPx, exitFeeExtra, reason, tsMs, trades) {
  const holdSec = (tsMs - pos.entryTsMs) / 1000;
  const dumpShares = pos.remaining > 1e-9 ? pos.remaining : 0;
  const proceeds =
    pos.fills.reduce((a, f) => a + f.shares * f.px, 0) + (dumpShares > 0 ? dumpShares * exitPx : 0);
  const exitFee = pos.fills.reduce((a, f) => a + f.fee, 0) + exitFeeExtra;
  const soldShares = pos.fills.reduce((a, f) => a + f.shares, 0) + dumpShares;
  const avgExit = soldShares > 0 ? proceeds / soldShares : exitPx;
  const pnl =
    Math.round((proceeds - pos.shares * pos.entryAsk - pos.entryFee - exitFee) * 1e4) / 1e4;
  const makerShares = pos.fills.reduce((a, f) => a + f.shares, 0);
  trades.push({
    side: pos.side,
    entryAsk: pos.entryAsk,
    exitPx: Math.round(avgExit * 1e4) / 1e4,
    shares: pos.shares,
    entryFee: pos.entryFee,
    exitFee: Math.round(exitFee * 1e4) / 1e4,
    makerExitShares: Math.round(makerShares * 100) / 100,
    takerExitShares: Math.round(dumpShares * 100) / 100,
    pnl,
    holdSec: Math.round(holdSec * 100) / 100,
    reason,
    tauAtEntry: pos.tauAtEntry,
    binRet: pos.binRet,
    entryTsMs: pos.entryTsMs,
    exitTsMs: tsMs,
    ladderFills: pos.fills.length,
  });
}

/**
 * Simulate one event chronologically.
 * exitMode=taker: TP/stop/timeout no bid (fee saí­da).
 * exitMode=maker-ladder: asks limit em offsets (fee 0); residual stop/timeout = taker.
 * Fill proxy: bid >= limitPx (conservador vs trade print; assume hit no nosso ask).
 */
function simulateEvent(ticks, binanceBySec, cfg, impulseThr = null) {
  if (!ticks?.length) return [];
  const eventEnd = Number(ticks[0].event_end_ms);
  if (!Number.isFinite(eventEnd)) return [];

  const lakeSec = new Map();
  for (const t of ticks) {
    const sec = Math.floor(Number(t.ts_ms) / 1000);
    lakeSec.set(sec, t);
  }

  const trades = [];
  let pos = null;
  let entryCount = 0;
  let cooldownUntilMs = 0;
  const maker = cfg.exitMode === 'maker-ladder';

  for (const tick of ticks) {
    const tsMs = Number(tick.ts_ms);
    const tau = (eventEnd - tsMs) / 1000;
    const sec = Math.floor(tsMs / 1000);

    if (pos) {
      const book = sideBook(tick, pos.side);
      const bid = book.bid;
      const holdSec = (tsMs - pos.entryTsMs) / 1000;

      if (maker && Number.isFinite(bid) && bid > 0) {
        for (const lvl of pos.ladder) {
          if (lvl.filled || pos.remaining <= 1e-9) continue;
          if (bid >= lvl.limitPx) {
            const qty = Math.min(lvl.shares, pos.remaining);
            pos.fills.push({ px: lvl.limitPx, shares: qty, fee: 0 });
            pos.remaining -= qty;
            lvl.filled = true;
          }
        }
        if (pos.remaining <= 1e-9) {
          closePosition(pos, 0, 0, pos.rescue ? 'rescue_full' : 'ladder_full', tsMs, trades);
          pos = null;
          cooldownUntilMs = tsMs + cfg.cooldownSec * 1000;
          continue;
        }
      }

      let dumpReason = null;
      let dumpPx = null;
      if (pos.rescue) {
        // em resgate: segura até fill do ask breakeven, stop-desastre ou EOD
        if (
          cfg.rescueStop > 0 &&
          Number.isFinite(bid) &&
          bid > 0 &&
          bid <= pos.entryAsk - cfg.rescueStop
        ) {
          dumpReason = 'rescue_stop';
          dumpPx = bid;
        }
      } else if (Number.isFinite(bid) && bid > 0) {
        if (!maker && bid >= pos.entryAsk + cfg.takeProfit) {
          dumpReason = 'tp';
          dumpPx = bid;
        } else if (stopHit(pos.entryAsk, bid, cfg)) {
          dumpReason = maker ? 'ladder_stop' : 'stop';
          dumpPx = bid;
        } else if (holdSec >= cfg.timeoutSec) {
          dumpReason = maker
            ? pos.fills.length
              ? 'ladder_timeout_partial'
              : 'ladder_timeout'
            : 'timeout';
          dumpPx = bid;
        }
        if (maker && cfg.rescue && dumpReason) {
          // vira resgate: troca ladder restante por ask único em entry+rescueOffset
          pos.rescue = true;
          pos.ladder = pos.ladder.filter((l) => l.filled);
          pos.ladder.push({
            offset: cfg.rescueOffset,
            limitPx: Math.round((pos.entryAsk + cfg.rescueOffset) * 100) / 100,
            shares: pos.remaining,
            filled: false,
          });
          dumpReason = null;
          dumpPx = null;
        }
      } else if (holdSec >= cfg.timeoutSec) {
        dumpReason = maker ? 'ladder_timeout_nobid' : 'timeout_nobid';
        dumpPx = pos.entryAsk;
      }

      if (dumpReason) {
        const rem = pos.remaining;
        const exitFeeExtra = rem > 0 ? feeEst(dumpPx, rem, cfg.feeRate) : 0;
        closePosition(pos, dumpPx, exitFeeExtra, dumpReason, tsMs, trades);
        pos = null;
        cooldownUntilMs = tsMs + cfg.cooldownSec * 1000;
      }
      continue;
    }

    if (entryCount >= cfg.maxTradesPerEvent) continue;
    if (tsMs < cooldownUntilMs) continue;
    if (tau < cfg.minTau || tau > cfg.maxTau) continue;

    const bNow = binanceBySec.get(sec);
    const bPrev = binanceBySec.get(sec - cfg.leadSec);
    if (bNow == null || bPrev == null) continue;
    const binRet = bNow - bPrev;
    const impulseMin = impulseThr?.get(sec) ?? cfg.impulseUsd;
    if (Math.abs(binRet) < impulseMin) continue;

    const side = binRet > 0 ? 'UP' : 'DOWN';
    const book = sideBook(tick, side);
    if (!Number.isFinite(book.ask) || !Number.isFinite(book.bid)) continue;
    if (book.ask < cfg.minAsk || book.ask > cfg.maxAsk) continue;
    const spread = book.ask - book.bid;
    if (!(spread >= 0) || spread > cfg.maxSpread) continue;

    const prevTick = lakeSec.get(sec - cfg.leadSec);
    let staleOk = true;
    if (prevTick) {
      const m0 = midOf(prevTick, side);
      const m1 = midOf(tick, side);
      if (m0 != null && m1 != null && Math.abs(m1 - m0) > cfg.staleMidMoveMax) {
        staleOk = false;
      }
    }
    if (!staleOk) continue;

    const shares = sizeShares(cfg.budget, book.ask, cfg, book.askSz);
    if (!(shares > 0)) continue;
    if (shares + 1e-9 < cfg.minShares) continue;
    const needSz = shares * cfg.askSizeMult;
    if (Number.isFinite(book.askSz) && book.askSz > 0 && book.askSz < needSz) continue;

    const entryFee = feeEst(book.ask, shares, cfg.feeRate);
    const nLvl = maker ? cfg.ladderOffsets.length : 0;
    const perLvl = nLvl > 0 ? shares / nLvl : shares;
    pos = {
      side,
      entryAsk: book.ask,
      entryBid: book.bid,
      shares,
      remaining: shares,
      fills: [],
      ladder: maker
        ? cfg.ladderOffsets.map((off) => ({
            offset: off,
            limitPx: Math.round((book.ask + off) * 100) / 100,
            shares: perLvl,
            filled: false,
          }))
        : [],
      entryFee,
      entryTsMs: tsMs,
      entrySec: sec,
      tauAtEntry: Math.round(tau),
      binRet,
    };
    entryCount += 1;
  }

  if (pos && ticks.length) {
    const last = ticks[ticks.length - 1];
    const book = sideBook(last, pos.side);
    const exitPx = Number.isFinite(book.bid) && book.bid > 0 ? book.bid : pos.entryAsk;
    const rem = pos.remaining;
    const exitFeeExtra = rem > 0 ? feeEst(exitPx, rem, cfg.feeRate) : 0;
    closePosition(
      pos,
      exitPx,
      exitFeeExtra,
      maker
        ? pos.rescue
          ? 'rescue_eod'
          : pos.fills.length
            ? 'ladder_eod_partial'
            : 'ladder_eod'
        : 'eod',
      Number(last.ts_ms),
      trades,
    );
  }

  return trades;
}

function summarize(trades, eventsSeen, cfg, meta) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const fees = trades.reduce((a, t) => a + t.entryFee + t.exitFee, 0);
  const entryFees = trades.reduce((a, t) => a + t.entryFee, 0);
  const exitFees = trades.reduce((a, t) => a + t.exitFee, 0);
  const makerExitShares = trades.reduce((a, t) => a + (t.makerExitShares || 0), 0);
  const takerExitShares = trades.reduce((a, t) => a + (t.takerExitShares || 0), 0);
  const byReason = {};
  for (const t of trades) {
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  }
  const pnlByReason = {};
  for (const t of trades) {
    const b = (pnlByReason[t.reason] ??= { n: 0, sum: 0, min: Infinity, wins: 0 });
    b.n += 1;
    b.sum += t.pnl;
    b.min = Math.min(b.min, t.pnl);
    if (t.pnl > 0) b.wins += 1;
  }
  for (const b of Object.values(pnlByReason)) {
    b.sum = Math.round(b.sum * 100) / 100;
    b.avg = Math.round((b.sum / b.n) * 1000) / 1000;
    b.min = Math.round(b.min * 100) / 100;
  }
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  const byMonth = {};
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    const d = new Date(t.entryTsMs);
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const m = (byMonth[mk] ??= { trades: 0, wins: 0, pnl: 0, fees: 0 });
    m.trades += 1;
    if (t.pnl > 0) m.wins += 1;
    m.pnl += t.pnl;
    m.fees += (t.entryFee || 0) + (t.exitFee || 0);
  }
  for (const m of Object.values(byMonth)) {
    m.pnl = Math.round(m.pnl * 100) / 100;
    m.fees = Math.round(m.fees * 100) / 100;
    m.winRate = m.trades ? Math.round((1000 * m.wins) / m.trades) / 10 : null;
  }
  const hold = trades.map((t) => t.holdSec);
  const avgHold = hold.length ? hold.reduce((a, b) => a + b, 0) / hold.length : null;

  return {
    ok: true,
    note: 'Binance grain=1s (conservative vs live WS); maker fill proxy = bid>=limit',
    config: cfg,
    meta,
    eventsSeen,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (100 * wins.length) / trades.length : null,
    totalPnl: Math.round(totalPnl * 100) / 100,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : wins.length ? Infinity : null,
    avgPnl: trades.length ? totalPnl / trades.length : null,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : null,
    avgHoldSec: avgHold != null ? Math.round(avgHold * 100) / 100 : null,
    tradesPerEvent: eventsSeen ? trades.length / eventsSeen : null,
    fees: Math.round(fees * 100) / 100,
    entryFees: Math.round(entryFees * 100) / 100,
    exitFees: Math.round(exitFees * 100) / 100,
    makerExitSharePct:
      makerExitShares + takerExitShares > 0
        ? Math.round((1000 * makerExitShares) / (makerExitShares + takerExitShares)) / 10
        : null,
    feeDrag: Math.abs(totalPnl) + fees > 0 ? fees / (Math.abs(grossProfit) + grossLossAbs + 1e-9) : null,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    exitReasons: byReason,
    pnlByReason,
    byMonth,
    goPreliminary:
      trades.length >= 30 &&
      grossLossAbs > 0 &&
      grossProfit / grossLossAbs >= 1.15 &&
      fees / (Math.abs(grossProfit) + grossLossAbs + 1e-9) < 0.6,
  };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const days = listDays(cfg.from, cfg.to);
  if (!days.length) {
    console.error('No lake days in range', cfg.from, cfg.to);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(BINANCE_DIR, { recursive: true });

  const stopDesc =
    cfg.stopPct > 0 ? `stop=-${(cfg.stopPct * 100).toFixed(0)}%` : `stop=-${cfg.stopLoss}`;
  console.log(`Binance-lead scalp | ${cfg.from}→${cfg.to} | ${days.length} days | exit=${cfg.exitMode}`);
  console.log(
    `impulse≥$${cfg.impulseUsd}/${cfg.leadSec}s τ=${cfg.minTau}-${cfg.maxTau}s ${stopDesc} timeout=${cfg.timeoutSec}s maxTrades=${cfg.maxTradesPerEvent} budget=$${cfg.budget}` +
      (cfg.exitMode === 'maker-ladder' ? ` ladder=[${cfg.ladderOffsets.join(',')}]` : ''),
  );

  for (const dt of days) {
    await downloadBinanceDailyZip('BTCUSDT', dt);
  }

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '6GB'`);

  const allTrades = [];
  let eventsSeen = 0;
  let daysOk = 0;

  for (const dt of days) {
    const zipOk = fs.existsSync(path.join(BINANCE_DIR, `BTCUSDT-1s-${dt}.zip`));
    if (!zipOk) {
      console.log(`  skip ${dt} (no binance zip)`);
      continue;
    }
    const csv = ensureExtracted(dt);
    if (!csv) {
      console.log(`  skip ${dt} (extract fail)`);
      continue;
    }
    const binMap = loadBinanceCloses(csv);
    if (binMap.size < 1000) {
      console.log(`  skip ${dt} (binance map small)`);
      continue;
    }

    const files = filesFor(dt);
    const pql = `[${files.map((f) => quotedString(f)).join(', ')}]`;
    const res = await conn.runAndReadAll(`
      SELECT condition_id, dt,
        CAST(epoch_ms(try_cast(ts AS TIMESTAMP)) AS BIGINT) AS ts_ms,
        CAST(epoch_ms(try_cast(event_end AS TIMESTAMP)) AS BIGINT) AS event_end_ms,
        underlying_price, price_to_beat,
        up_best_ask, up_best_bid, down_best_ask, down_best_bid,
        up_ask_sz_1, down_ask_sz_1
      FROM read_parquet(${pql})
      WHERE up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
      ORDER BY condition_id, ts_ms
    `);
    const rows = res.getRowObjectsJS();
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.condition_id)) by.set(r.condition_id, []);
      by.get(r.condition_id).push(r);
    }

    const impulseThr = cfg.impulseVolMult > 0 ? buildImpulseThresholds(binMap, cfg) : null;

    let dayTrades = 0;
    for (const ticks of by.values()) {
      eventsSeen += 1;
      const tr = simulateEvent(ticks, binMap, cfg, impulseThr);
      dayTrades += tr.length;
      allTrades.push(...tr);
    }
    daysOk += 1;
    console.log(`  ${dt}: events=${by.size} lakeTicks=${rows.length} trades=${dayTrades}`);
  }

  allTrades.sort((a, b) => a.entryTsMs - b.entryTsMs);
  const summary = summarize(allTrades, eventsSeen, cfg, {
    from: cfg.from,
    to: cfg.to,
    daysRequested: days.length,
    daysOk,
    generatedAt: new Date().toISOString(),
  });

  const modeTag =
    cfg.exitMode === 'maker-ladder'
      ? `maker-ladder-${cfg.ladderOffsets.map((x) => String(x).replace('.', 'p')).join('-')}`
      : 'taker';
  const tagPart = cfg.tag ? `_${cfg.tag}` : '';
  const stamp = `${cfg.from}_${cfg.to}_${modeTag}${tagPart}`.replace(/:/g, '');
  const jsonPath = path.join(OUT_DIR, `scalp-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `scalp-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, sampleTrades: allTrades.slice(0, 50) }, null, 2));

  const md = [
    `# Binance-lead scalp lab (${modeTag})`,
    ``,
    `Range **${cfg.from}→${cfg.to}** · Binance grain **1s** (conservative)`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Exit mode | ${modeTag} |`,
    `| Events | ${summary.eventsSeen} |`,
    `| Trades | ${summary.trades} |`,
    `| Win rate | ${summary.winRate != null ? summary.winRate.toFixed(1) + '%' : '—'} |`,
    `| PnL | ${summary.totalPnl} |`,
    `| Profit factor | ${summary.profitFactor != null && Number.isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(3) : summary.profitFactor} |`,
    `| Fees (entry/exit) | ${summary.fees} (${summary.entryFees}/${summary.exitFees}) |`,
    `| Maker exit % | ${summary.makerExitSharePct != null ? summary.makerExitSharePct + '%' : '—'} |`,
    `| Fee drag | ${summary.feeDrag != null ? summary.feeDrag.toFixed(3) : '—'} |`,
    `| Avg hold (s) | ${summary.avgHoldSec ?? '—'} |`,
    `| Trades/event | ${summary.tradesPerEvent != null ? summary.tradesPerEvent.toFixed(3) : '—'} |`,
    `| Max DD | ${summary.maxDrawdown} |`,
    `| GO preliminar | ${summary.goPreliminary ? 'YES' : 'NO'} |`,
    ``,
    `### Exit reasons`,
    ``,
    ...Object.entries(summary.exitReasons || {}).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `### Config`,
    ``,
    '```json',
    JSON.stringify(cfg, null, 2),
    '```',
    ``,
  ].join('\n');
  fs.writeFileSync(mdPath, md);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
