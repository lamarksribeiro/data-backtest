import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const BINANCE_DIR = path.resolve('data/binance-1s');
const EXTRACT_DIR = path.join(BINANCE_DIR, 'extracted');
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
  stopPct: 0,
  timeoutSec: 8,
  cooldownSec: 3,
  maxTradesPerEvent: 5,
  minTau: 20,
  maxTau: 280,
  feeRate: 0.07,
  impulseVolMult: 2.5,
  impulseFloor: 5,
  impulseCap: 12,
  volWindowSec: 300,
  rescue: true,
  rescueOffset: 0.01,
  rescueStop: 0.15,
  exitMode: 'maker-ladder',
  ladderOffsets: [0.08, 0.14],
  sizingMode: 'none', // none | sharesCap | dynamicBudget
  immediateDisasterDump: true,
};

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
          if (cfg.immediateDisasterDump && cfg.rescueStop > 0 && bid <= pos.entryAsk - cfg.rescueStop) {
            dumpReason = 'rescue_stop';
            dumpPx = bid;
          } else {
            dumpReason = maker ? 'ladder_stop' : 'stop';
            dumpPx = bid;
          }
        } else if (holdSec >= cfg.timeoutSec) {
          dumpReason = maker
            ? pos.fills.length
              ? 'ladder_timeout_partial'
              : 'ladder_timeout'
            : 'timeout';
          dumpPx = bid;
        }
        if (maker && cfg.rescue && dumpReason && dumpReason !== 'rescue_stop') {
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

    let shares = cfg.budget / book.ask;
    if (cfg.sizingMode === 'sharesCap') {
      const maxShares = Math.floor(cfg.budget / 0.50);
      if (shares > maxShares) shares = maxShares;
    } else if (cfg.sizingMode === 'dynamicBudget') {
      const effBudget = book.ask < 0.50 ? cfg.budget * (book.ask / 0.50) : cfg.budget;
      shares = effBudget / book.ask;
    }

    if (!(shares > 0)) continue;
    if (Number.isFinite(book.askSz) && book.askSz > 0 && book.askSz < shares * 0.75) continue;

    const entryFee = feeEst(book.ask, shares, cfg.feeRate);
    const nLvl = maker ? cfg.ladderOffsets.length : 0;
    const perLvl = nLvl > 0 ? shares / nLvl : shares;
    pos = {
      side,
      entryAsk: book.ask,
      shares,
      remaining: shares,
      entryFee,
      entryTsMs: tsMs,
      tauAtEntry: tau,
      binRet,
      rescue: false,
      fills: [],
      ladder: maker
        ? cfg.ladderOffsets.map((off) => ({
            offset: off,
            limitPx: Math.round((book.ask + off) * 100) / 100,
            shares: perLvl,
            filled: false,
          }))
        : [],
    };
    entryCount++;
  }
  return trades;
}

async function runComparisonLab() {
  console.log('================================================================');
  console.log('  TESTE COMPARATIVO NO LAKEHOUSE: 3 VARIANTES DE SIZING (32 DIAS)');
  console.log('================================================================\n');

  const days = listDays('2026-05-15', '2026-06-15');
  console.log(`Carregando ${days.length} dias do Lakehouse (2026-05-15 a 2026-06-15)...`);

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  async function evalConfig(name, extraCfg) {
    const cfg = { ...DEFAULTS, ...extraCfg };
    let totalTrades = [];

    for (const dt of days) {
      const csv = ensureExtracted(dt);
      if (!csv) continue;
      const binMap = loadBinanceCloses(csv);
      const impulseThr = buildImpulseThresholds(binMap, cfg);

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

      for (const ticks of by.values()) {
        const trs = simulateEvent(ticks, binMap, cfg, impulseThr);
        totalTrades.push(...trs);
      }
    }

    const n = totalTrades.length;
    const wins = totalTrades.filter((t) => t.pnl > 0);
    const losses = totalTrades.filter((t) => t.pnl < 0);
    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const netPnl = grossProfit - grossLoss;
    const winRate = n > 0 ? (wins.length / n) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 99;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    const byReason = {};
    for (const t of totalTrades) {
      if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0 };
      byReason[t.reason].n++;
      byReason[t.reason].pnl += t.pnl;
    }

    return { name, n, wins: wins.length, losses: losses.length, winRate, grossProfit, grossLoss, netPnl, profitFactor, avgWin, avgLoss, byReason };
  }

  console.log('1. Avaliando Baseline Atual (Sizing Fixo em Dólar)...');
  const resBase = await evalConfig('Baseline (Sem Cap)', { sizingMode: 'none', immediateDisasterDump: false });

  console.log('2. Avaliando Variante A (Cap de Shares Fixo)...');
  const resCap = await evalConfig('Variante A (Cap Shares Fixo)', { sizingMode: 'sharesCap', immediateDisasterDump: true });

  console.log('3. Avaliando Variante B (Budget Dinâmico Proporcional)...');
  const resDyn = await evalConfig('Variante B (Budget Dinâmico)', { sizingMode: 'dynamicBudget', immediateDisasterDump: true });

  console.log('\n================================================================');
  console.log('  RESULTADO COMPARATIVO NO LAKEHOUSE (32 DIAS CONTINUOS BTC 5M)');
  console.log('================================================================');
  console.log(`📌 ${resBase.name}:`);
  console.log(`   • Trades: ${resBase.n} | Win Rate: ${resBase.winRate.toFixed(2)}% | Profit Factor: ${resBase.profitFactor.toFixed(3)} | PnL: +$${resBase.netPnl.toFixed(2)}`);
  console.log(`   • Disaster Loss: -$${Math.abs(resBase.byReason.rescue_stop?.pnl || 0).toFixed(2)} (n=${resBase.byReason.rescue_stop?.n || 0})`);

  console.log(`\n📌 ${resCap.name}:`);
  console.log(`   • Trades: ${resCap.n} | Win Rate: ${resCap.winRate.toFixed(2)}% | Profit Factor: ${resCap.profitFactor.toFixed(3)} | PnL: +$${resCap.netPnl.toFixed(2)}`);
  console.log(`   • Disaster Loss: -$${Math.abs(resCap.byReason.rescue_stop?.pnl || 0).toFixed(2)} (n=${resCap.byReason.rescue_stop?.n || 0})`);

  console.log(`\n📌 ${resDyn.name}:`);
  console.log(`   • Trades: ${resDyn.n} | Win Rate: ${resDyn.winRate.toFixed(2)}% | Profit Factor: 🚀 ${resDyn.profitFactor.toFixed(3)} | PnL: 💰 +$${resDyn.netPnl.toFixed(2)}`);
  console.log(`   • Disaster Loss: -$${Math.abs(resDyn.byReason.rescue_stop?.pnl || 0).toFixed(2)} (n=${resDyn.byReason.rescue_stop?.n || 0})`);
  console.log('================================================================\n');
}

runComparisonLab().catch(console.error);
