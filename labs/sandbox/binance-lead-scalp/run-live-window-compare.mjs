/**
 * Comparativo: janela do dry Giovanna vs replay no data-colector + Binance 1s (API).
 *
 *   node labs/sandbox/binance-lead-scalp/run-live-window-compare.mjs \
 *     --ticks data/scalp-e-live-window-ticks.csv
 *
 * Params = setup E (maker +8/+14, $12/2s, stop -5¢, timeout 20s, …).
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const OUT_DIR = path.join('labs', 'sandbox', 'binance-lead-scalp', 'reports');

const CFG_E = {
  leadSec: 2,
  impulseUsd: 12,
  minAsk: 0.15,
  maxAsk: 0.7,
  maxSpread: 0.04,
  staleMidMoveMax: 0.02,
  budget: 10,
  stopLoss: 0.05,
  timeoutSec: 20,
  cooldownSec: 3,
  maxTradesPerEvent: 5,
  minTau: 20,
  maxTau: 280,
  feeRate: 0.07,
  exitMode: 'maker-ladder',
  ladderOffsets: [0.08, 0.14],
};

const DRY_OBSERVED = {
  note: 'Giovanna dry scalp-e (honest) — eventos concluídos no overlap',
  events: [
    { slugStart: 1785680700, trades: 0 },
    { slugStart: 1785681000, trades: 0 },
    { slugStart: 1785681300, trades: 1, pnl: 1.7465, reason: 'ladder_full', side: 'UP', entry: 0.53 },
    { slugStart: 1785681600, trades: 0 },
    { slugStart: 1785681900, trades: 0 },
  ],
};

function parseArgs(argv) {
  const out = {
    ticks: path.join('data', 'scalp-e-live-window-ticks.csv'),
    fromMs: Date.parse('2026-08-02T14:25:00Z'),
    toMs: Date.parse('2026-08-02T14:50:00Z'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ticks') out.ticks = argv[++i];
    else if (argv[i] === '--from') out.fromMs = Date.parse(argv[++i]);
    else if (argv[i] === '--to') out.toMs = Date.parse(argv[++i]);
  }
  return out;
}

function feeEst(price, shares, rate) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return rate * p * (1 - p) * shares;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'goldenlens-scalp-compare/1' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/** Binance spot 1s klines via REST (Vision zip ainda não existe no dia corrente). */
async function fetchBinance1s(fromMs, toMs) {
  const map = new Map();
  let cursor = fromMs - 5_000; // margem leadSec
  const end = toMs + 5_000;
  while (cursor < end) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s` +
      `&startTime=${cursor}&endTime=${end}&limit=1000`;
    const rows = await httpsGetJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      const t = Math.floor(Number(r[0]) / 1000);
      const close = Number(r[4]);
      if (Number.isFinite(t) && Number.isFinite(close)) map.set(t, close);
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    const next = lastOpen + 1000;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1000) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return map;
}

function loadTicksCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const get = (k) => p[idx[k]];
    rows.push({
      condition_id: get('condition_id'),
      event_start: get('event_start'),
      ts_ms: Number(get('ts_ms')),
      event_end_ms: Number(get('event_end_ms')),
      up_best_ask: Number(get('up_best_ask')),
      up_best_bid: Number(get('up_best_bid')),
      down_best_ask: Number(get('down_best_ask')),
      down_best_bid: Number(get('down_best_bid')),
      up_ask_sz_1: Number(get('up_ask_sz_1')),
      down_ask_sz_1: Number(get('down_ask_sz_1')),
    });
  }
  return rows;
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
  const dumpShares = pos.remaining > 1e-9 ? pos.remaining : 0;
  const proceeds =
    pos.fills.reduce((a, f) => a + f.shares * f.px, 0) + (dumpShares > 0 ? dumpShares * exitPx : 0);
  const exitFee = pos.fills.reduce((a, f) => a + f.fee, 0) + exitFeeExtra;
  const sold = pos.fills.reduce((a, f) => a + f.shares, 0) + dumpShares;
  const avgExit = sold > 0 ? proceeds / sold : exitPx;
  const pnl = Math.round((proceeds - pos.shares * pos.entryAsk - pos.entryFee - exitFee) * 1e4) / 1e4;
  trades.push({
    side: pos.side,
    entryAsk: pos.entryAsk,
    exitPx: Math.round(avgExit * 1e4) / 1e4,
    shares: pos.shares,
    entryFee: pos.entryFee,
    exitFee: Math.round(exitFee * 1e4) / 1e4,
    pnl,
    holdSec: Math.round(((tsMs - pos.entryTsMs) / 1000) * 100) / 100,
    reason,
    tauAtEntry: pos.tauAtEntry,
    binRet: pos.binRet,
    entryTsMs: pos.entryTsMs,
    exitTsMs: tsMs,
  });
}

function simulateEvent(ticks, binanceBySec, cfg) {
  if (!ticks?.length) return [];
  const eventEnd = Number(ticks[0].event_end_ms);
  const lakeSec = new Map();
  for (const t of ticks) lakeSec.set(Math.floor(Number(t.ts_ms) / 1000), t);

  const trades = [];
  let pos = null;
  let entryCount = 0;
  let cooldownUntilMs = 0;

  for (const tick of ticks) {
    const tsMs = Number(tick.ts_ms);
    const tau = (eventEnd - tsMs) / 1000;
    const sec = Math.floor(tsMs / 1000);

    if (pos) {
      const book = sideBook(tick, pos.side);
      const bid = book.bid;
      const holdSec = (tsMs - pos.entryTsMs) / 1000;
      if (Number.isFinite(bid) && bid > 0) {
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
          closePosition(pos, 0, 0, 'ladder_full', tsMs, trades);
          pos = null;
          cooldownUntilMs = tsMs + cfg.cooldownSec * 1000;
          continue;
        }
        let dump = null;
        let px = null;
        if (bid <= pos.entryAsk - cfg.stopLoss) {
          dump = 'ladder_stop';
          px = bid;
        } else if (holdSec >= cfg.timeoutSec) {
          dump = pos.fills.length ? 'ladder_timeout_partial' : 'ladder_timeout';
          px = bid;
        }
        if (dump) {
          const rem = pos.remaining;
          closePosition(pos, px, rem > 0 ? feeEst(px, rem, cfg.feeRate) : 0, dump, tsMs, trades);
          pos = null;
          cooldownUntilMs = tsMs + cfg.cooldownSec * 1000;
        }
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
    if (Math.abs(binRet) < cfg.impulseUsd) continue;

    const side = binRet > 0 ? 'UP' : 'DOWN';
    const book = sideBook(tick, side);
    if (!Number.isFinite(book.ask) || !Number.isFinite(book.bid)) continue;
    if (book.ask < cfg.minAsk || book.ask > cfg.maxAsk) continue;
    const spread = book.ask - book.bid;
    if (!(spread >= 0) || spread > cfg.maxSpread) continue;

    const prevTick = lakeSec.get(sec - cfg.leadSec);
    if (prevTick) {
      const m0 = midOf(prevTick, side);
      const m1 = midOf(tick, side);
      if (m0 != null && m1 != null && Math.abs(m1 - m0) > cfg.staleMidMoveMax) continue;
    }

    const shares = cfg.budget / book.ask;
    if (!(shares > 0)) continue;
    if (Number.isFinite(book.askSz) && book.askSz > 0 && book.askSz < shares * 0.75) continue;

    const entryFee = feeEst(book.ask, shares, cfg.feeRate);
    const perLvl = shares / cfg.ladderOffsets.length;
    pos = {
      side,
      entryAsk: book.ask,
      shares,
      remaining: shares,
      fills: [],
      ladder: cfg.ladderOffsets.map((off) => ({
        limitPx: Math.round((book.ask + off) * 100) / 100,
        shares: perLvl,
        filled: false,
      })),
      entryFee,
      entryTsMs: tsMs,
      tauAtEntry: Math.round(tau),
      binRet: Math.round(binRet * 100) / 100,
    };
    entryCount += 1;
  }

  if (pos) {
    const last = ticks[ticks.length - 1];
    const book = sideBook(last, pos.side);
    const px = Number.isFinite(book.bid) && book.bid > 0 ? book.bid : pos.entryAsk;
    const rem = pos.remaining;
    closePosition(
      pos,
      px,
      rem > 0 ? feeEst(px, rem, cfg.feeRate) : 0,
      pos.fills.length ? 'ladder_eod_partial' : 'ladder_eod',
      Number(last.ts_ms),
      trades,
    );
  }
  return trades;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.ticks)) {
    console.error('ticks CSV missing:', args.ticks);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Loading ticks…', args.ticks);
  const allTicks = loadTicksCsv(args.ticks);
  console.log(`ticks=${allTicks.length}`);

  console.log('Fetching Binance 1s REST…', new Date(args.fromMs).toISOString(), '→', new Date(args.toMs).toISOString());
  const binMap = await fetchBinance1s(args.fromMs, args.toMs);
  console.log(`binance seconds=${binMap.size}`);

  const byEvent = new Map();
  for (const t of allTicks) {
    if (!byEvent.has(t.condition_id)) byEvent.set(t.condition_id, []);
    byEvent.get(t.condition_id).push(t);
  }

  const perEvent = [];
  const allTrades = [];
  for (const [cid, ticks] of byEvent) {
    ticks.sort((a, b) => a.ts_ms - b.ts_ms);
    const startSec = Math.floor(Number(ticks[0].event_end_ms) / 1000) - 300;
    const trades = simulateEvent(ticks, binMap, CFG_E);
    allTrades.push(...trades);
    perEvent.push({
      condition_id: cid.slice(0, 14) + '…',
      eventStartSec: startSec,
      eventStartIso: new Date(startSec * 1000).toISOString(),
      ticks: ticks.length,
      trades: trades.length,
      pnl: Math.round(trades.reduce((a, t) => a + t.pnl, 0) * 1000) / 1000,
      details: trades.map((t) => ({
        side: t.side,
        entryAsk: t.entryAsk,
        exitPx: t.exitPx,
        pnl: t.pnl,
        reason: t.reason,
        holdSec: t.holdSec,
        binRet: t.binRet,
        tauAtEntry: t.tauAtEntry,
      })),
    });
  }
  perEvent.sort((a, b) => a.eventStartSec - b.eventStartSec);

  const dryTotal = DRY_OBSERVED.events.reduce((a, e) => a + e.trades, 0);
  const replayTotal = allTrades.length;
  const summary = {
    generatedAt: new Date().toISOString(),
    window: {
      from: new Date(args.fromMs).toISOString(),
      to: new Date(args.toMs).toISOString(),
    },
    sources: {
      ticks: 'data-colector PG (Brutus vgiav63…)',
      binance: 'api.binance.com klines 1s',
      note: 'Vision zip do dia ainda não disponível; REST 1s ≈ grain do lab',
    },
    config: CFG_E,
    dryObserved: {
      ...DRY_OBSERVED,
      totalTrades: dryTotal,
    },
    replay: {
      events: perEvent.length,
      totalTrades: replayTotal,
      totalPnl: Math.round(allTrades.reduce((a, t) => a + t.pnl, 0) * 1000) / 1000,
      perEvent,
    },
    match: {
      sameTradeCount: dryTotal === replayTotal,
      deltaTrades: replayTotal - dryTotal,
      verdict:
        dryTotal === replayTotal
          ? 'MATCH — mesmo nº de trades no período'
          : replayTotal === 0 && dryTotal <= 1
            ? 'QUASE — dry teve poucos trades; replay também escasso (checar alinhamento temporal)'
            : 'DIVERGE — investigar fill/proxy, mid-stale ou grain Binance WS vs 1s',
    },
  };

  const outPath = path.join(OUT_DIR, `live-window-compare-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log('\n=== DRY (Giovanna) ===');
  for (const e of DRY_OBSERVED.events) {
    console.log(
      `  ${new Date(e.slugStart * 1000).toISOString()} trades=${e.trades}` +
        (e.pnl != null ? ` pnl=${e.pnl}` : ''),
    );
  }
  console.log(`  TOTAL trades=${dryTotal}`);

  console.log('\n=== REPLAY (colector + Binance 1s) ===');
  for (const e of perEvent) {
    console.log(
      `  ${e.eventStartIso} ticks=${e.ticks} trades=${e.trades} pnl=${e.pnl}` +
        (e.details[0] ? ` [${e.details.map((d) => `${d.side}@${d.entryAsk} ${d.reason}`).join('; ')}]` : ''),
    );
  }
  console.log(`  TOTAL trades=${replayTotal}`);
  console.log('\n=== VERDICT ===');
  console.log(summary.match.verdict);
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
