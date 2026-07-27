/**
 * Checa liquidez real no lado bid no instante em que a regra anti-flip dispara.
 * Regra: entrada tau=30 no favorito (ask 0.5-0.94, $10); saida quando
 *        spot perde lideranca E nosso bid < 0.45.
 * Mede: profundidade acumulada disponivel varrendo o book bid do nosso lado,
 *       preco medio de execucao real p/ vender N shares (slippage vs best bid).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const OUT = process.argv[process.argv.indexOf('--out') + 1] || path.join(ROOT, 'scratch/exit-liq.csv');
const TAU_ENTRY = 30, BUDGET = 10, SETTLE = 0.995;
const FEE = (p) => 0.07 * p * (1 - p);
const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs.readdirSync(baseDir).filter((d) => d.startsWith('dt=')).map((d) => d.slice(3)).sort();

const cols = ['event_start', 'ts_rel', 'spot', 'ptb', 'ub', 'ua', 'db', 'da'];
for (let i = 1; i <= 25; i += 1) cols.push(`up_bid_px_${i}`, `up_bid_sz_${i}`, `down_bid_px_${i}`, `down_bid_sz_${i}`);

const out = fs.createWriteStream(OUT);
out.write('day,event_start,side,ask,win,secsLeft,bestBid,shares,depthTotal,fillAvg,slip,filledFrac,pnlIdeal,pnlReal\n');

function sweepBid(levels, shares) {
  // levels: [{px, sz}] ordenado desc por preco. Vende `shares` varrendo.
  let rem = shares, notional = 0, depth = 0;
  for (const l of levels) depth += l.sz;
  for (const l of levels) {
    if (rem <= 0) break;
    const take = Math.min(rem, l.sz);
    notional += take * l.px;
    rem -= take;
  }
  const filled = shares - rem;
  return { filled, avg: filled > 0 ? notional / filled : 0, depth };
}

function runEvent(rows, day, eventStart) {
  const n = rows.length;
  if (n < 100) return null;
  const last = rows[n - 1];
  const ptb = last.ptb;
  if (!(ptb > 0)) return null;
  const dur = last.t;
  const winner = last.spot > ptb ? 1 : -1;
  let ms = 0, mn = 0;
  for (let i = n - 1; i >= 0 && last.t - rows[i].t <= 5; i -= 1) {
    if (rows[i].ub != null && rows[i].ua != null) { ms += (rows[i].ub + rows[i].ua) / 2; mn += 1; }
  }
  if (!mn || (ms / mn > 0.5 ? 1 : -1) !== winner) return null;

  const tEntry = dur - TAU_ENTRY;
  let ei = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (rows[i].t <= tEntry) { ei = i; break; }
  if (ei < 30) return null;
  const e = rows[ei];
  if (e.ub == null || e.ua == null || e.db == null || e.da == null) return null;
  const d0 = e.spot - ptb;
  if (d0 === 0) return null;
  const side = d0 > 0 ? 1 : -1;
  const ask = side === 1 ? e.ua : e.da;
  if (!(ask > 0.5 && ask <= 0.94)) return null;
  const shares = BUDGET / ask;
  const feeIn = FEE(ask) * shares;
  const win = side === winner ? 1 : 0;

  for (let i = ei + 1; i < n; i += 1) {
    const tk = rows[i];
    if (tk.ub == null || tk.ua == null || tk.db == null || tk.da == null) continue;
    const secsLeft = dur - tk.t;
    if (secsLeft < 2) break;
    const dist = tk.spot - ptb;
    const leaderNow = dist > 0 ? 1 : dist < 0 ? -1 : side;
    const ourBid = side === 1 ? tk.ub : tk.db;
    if (leaderNow !== side && ourBid < 0.45) {
      const levels = [];
      for (let k = 1; k <= 25; k += 1) {
        const px = side === 1 ? tk[`up_bid_px_${k}`] : tk[`down_bid_px_${k}`];
        const sz = side === 1 ? tk[`up_bid_sz_${k}`] : tk[`down_bid_sz_${k}`];
        if (px != null && sz != null && sz > 0) levels.push({ px: Number(px), sz: Number(sz) });
      }
      levels.sort((a, b) => b.px - a.px);
      const { filled, avg, depth } = sweepBid(levels, shares);
      const idealPx = Math.max(0.01, Math.min(0.99, ourBid));
      const pnlIdeal = shares * idealPx - BUDGET - feeIn - FEE(idealPx) * shares;
      // real: parte preenchida sai ao avg; resto segue ate settlement
      const rem = shares - filled;
      const settleRem = win ? rem * SETTLE : 0;
      const pnlReal = filled * avg + settleRem - BUDGET - feeIn - (filled > 0 ? FEE(avg) * filled : 0);
      return [day, eventStart, side, ask.toFixed(3), win, secsLeft.toFixed(1),
        ourBid.toFixed(3), shares.toFixed(2), depth.toFixed(1),
        avg.toFixed(4), (idealPx - avg).toFixed(4), (filled / shares).toFixed(3),
        pnlIdeal.toFixed(4), pnlReal.toFixed(4)].join(',');
    }
  }
  return null;
}

async function main() {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run('SET threads TO 6');
  const bidCols = [];
  for (let i = 1; i <= 25; i += 1) bidCols.push(`up_bid_px_${i}`, `up_bid_sz_${i}`, `down_bid_px_${i}`, `down_bid_sz_${i}`);
  let total = 0;
  for (const day of days) {
    const glob = path.join(baseDir, `dt=${day}`, '*.parquet').replace(/\\/g, '/');
    const res = await conn.runAndReadAll(`
      SELECT event_start,
        EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
        underlying_price AS spot, price_to_beat AS ptb,
        up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da,
        ${bidCols.join(', ')}
      FROM read_parquet('${glob}')
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND price_to_beat > 0 AND coverage >= 0.9
      ORDER BY event_start, ts`);
    const rows = res.getRowObjectsJson();
    let key = null, buf = [], cnt = 0;
    const flush = () => { if (buf.length) { const l = runEvent(buf, day, key); if (l) { out.write(l + '\n'); cnt += 1; } } };
    for (const r of rows) {
      const k = String(r.event_start);
      if (k !== key) { flush(); key = k; buf = []; }
      const o = { t: Number(r.t), spot: Number(r.spot), ptb: Number(r.ptb),
        ub: r.ub == null ? null : Number(r.ub), ua: r.ua == null ? null : Number(r.ua),
        db: r.db == null ? null : Number(r.db), da: r.da == null ? null : Number(r.da) };
      for (const c of bidCols) o[c] = r[c] == null ? null : Number(r[c]);
      buf.push(o);
    }
    flush();
    total += cnt;
    console.error(`[${day}] exits=${cnt}`);
  }
  out.end();
  console.error(`DONE exits=${total} -> ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
