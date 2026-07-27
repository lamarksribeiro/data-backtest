/**
 * REVERSE TEST — a síntese das duas análises.
 *
 * Anti-Flip diz: quando o spot cruza o PTB contra nós, VENDA o líder velho.
 * Flip Hunt diz: quando o spot cruza o PTB, COMPRE o líder novo.
 * Se ambos valem, a saída deveria virar uma REVERSÃO (vende + compra o outro lado).
 *
 * Entrada MIDAS-like: favorito em tau=30s, ask 0.50-0.94, $10 taker.
 * No gatilho `lead_bid40` (perdeu liderança E nosso bid < 0.40) testa:
 *   exit_only  — só vende (campeã do estudo anti-flip)
 *   reverse_*  — vende e compra o novo líder com filtros Flip Hunt de rigor crescente
 *
 * Entrada e saída varrem book depth 25. Fee 0.07*p*(1-p). Settle 0.995.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const OUT = process.argv[process.argv.indexOf('--out') + 1] || path.join(ROOT, 'scratch/reverse-test.csv');
const TAU_ENTRY = 30, BUDGET = 10, SETTLE = 0.995;
const FEE = (p) => 0.07 * p * (1 - p);

const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs.readdirSync(baseDir).filter((d) => d.startsWith('dt=')).map((d) => d.slice(3)).sort();

// variantes de reversão: filtros aplicados ao NOVO líder no instante do gatilho
const REV = [
  { name: 'exit_only', rev: null },
  { name: 'rev_naive', rev: { maxAsk: 1.01, maxSpread: 1.0, minTau: 0, minDist: 0 } },
  { name: 'rev_fh', rev: { maxAsk: 0.78, maxSpread: 0.02, minTau: 10, minDist: 8 } },
  { name: 'rev_fh_loose', rev: { maxAsk: 0.78, maxSpread: 0.05, minTau: 8, minDist: 5 } },
  { name: 'rev_cheap', rev: { maxAsk: 0.65, maxSpread: 0.02, minTau: 10, minDist: 8 } },
];

const bidCols = [], askCols = [];
for (let i = 1; i <= 25; i += 1) {
  bidCols.push(`up_bid_px_${i}`, `up_bid_sz_${i}`, `down_bid_px_${i}`, `down_bid_sz_${i}`);
  askCols.push(`up_ask_px_${i}`, `up_ask_sz_${i}`, `down_ask_px_${i}`, `down_ask_sz_${i}`);
}
function levelsAt(tk, side, kind) {
  const out = [];
  const pre = side === 1 ? 'up' : 'down';
  for (let k = 1; k <= 25; k += 1) {
    const px = tk[`${pre}_${kind}_px_${k}`], sz = tk[`${pre}_${kind}_sz_${k}`];
    if (px != null && sz != null && sz > 0) out.push({ px: Number(px), sz: Number(sz) });
  }
  out.sort((a, b) => (kind === 'bid' ? b.px - a.px : a.px - b.px));
  return out;
}
function sweep(levels, shares) {
  let rem = shares, notional = 0;
  for (const l of levels) { if (rem <= 0) break; const t = Math.min(rem, l.sz); notional += t * l.px; rem -= t; }
  const filled = shares - rem;
  return { filled, avg: filled > 0 ? notional / filled : 0 };
}

const out = fs.createWriteStream(OUT);
out.write(['day', 'event_start', 'side', 'ask', 'win', 'triggered', 'tExit',
  ...REV.map((r) => `pnl_${r.name}`), ...REV.map((r) => `revAsk_${r.name}`)].join(',') + '\n');

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

  const entLv = levelsAt(e, side, 'ask');
  const ent = sweep(entLv, BUDGET / ask);
  if (ent.filled <= 0) return null;
  const shares = ent.filled, cost = shares * ent.avg, feeIn = FEE(ent.avg) * shares;
  const win = side === winner ? 1 : 0;
  const pnlHold = (win ? shares * SETTLE : 0) - cost - feeIn;

  // procura o gatilho lead_bid40
  let trig = null;
  for (let j = ei + 1; j < n; j += 1) {
    const t2 = rows[j];
    if (t2.ub == null || t2.ua == null || t2.db == null || t2.da == null) continue;
    const sl = dur - t2.t;
    if (sl < 2) break;
    const dd = t2.spot - ptb;
    const leaderNow = dd > 0 ? 1 : dd < 0 ? -1 : side;
    const ourBid = side === 1 ? t2.ub : t2.db;
    if (leaderNow !== side && ourBid < 0.40) { trig = { j, tk: t2, sl, leaderNow, dist: Math.abs(dd) }; break; }
  }

  if (!trig) {
    return [day, eventStart, side, ask.toFixed(3), win, 0, '',
      ...REV.map(() => pnlHold.toFixed(4)), ...REV.map(() => '')].join(',');
  }

  // venda do lado velho
  const sellLv = levelsAt(trig.tk, side, 'bid');
  const sold = sweep(sellLv, shares);
  const remOld = shares - sold.filled;
  const settleOld = win ? remOld * SETTLE : 0;
  const pnlExit = sold.filled * sold.avg + settleOld - cost - feeIn - (sold.filled > 0 ? FEE(sold.avg) * sold.filled : 0);

  // proceeds disponíveis para reverter
  const proceeds = sold.filled * sold.avg;
  const newSide = trig.leaderNow;
  const newAsk = newSide === 1 ? trig.tk.ua : trig.tk.da;
  const newBid = newSide === 1 ? trig.tk.ub : trig.tk.db;
  const newSpread = newAsk - newBid;
  const newWin = newSide === winner ? 1 : 0;

  const pnls = [], revAsks = [];
  for (const v of REV) {
    if (!v.rev) { pnls.push(pnlExit); revAsks.push(''); continue; }
    const ok = newAsk > 0.01 && newAsk <= v.rev.maxAsk && newSpread <= v.rev.maxSpread
      && trig.sl >= v.rev.minTau && trig.dist >= v.rev.minDist && proceeds > 0.5;
    if (!ok) { pnls.push(pnlExit); revAsks.push(''); continue; }
    const budget = Math.min(BUDGET, proceeds);
    const revLv = levelsAt(trig.tk, newSide, 'ask');
    const rv = sweep(revLv, budget / newAsk);
    if (rv.filled <= 0) { pnls.push(pnlExit); revAsks.push(''); continue; }
    const revCost = rv.filled * rv.avg, revFee = FEE(rv.avg) * rv.filled;
    const revPnl = (newWin ? rv.filled * SETTLE : 0) - revCost - revFee;
    pnls.push(pnlExit + revPnl);
    revAsks.push(newAsk.toFixed(3));
  }

  return [day, eventStart, side, ask.toFixed(3), win, 1, trig.sl.toFixed(1),
    ...pnls.map((p) => p.toFixed(4)), ...revAsks].join(',');
}

async function main() {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run('SET threads TO 6');
  let total = 0;
  for (const day of days) {
    const glob = path.join(baseDir, `dt=${day}`, '*.parquet').replace(/\\/g, '/');
    const res = await conn.runAndReadAll(`
      SELECT event_start,
        EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
        underlying_price AS spot, price_to_beat AS ptb,
        up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da,
        ${bidCols.join(', ')}, ${askCols.join(', ')}
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
      for (const c of askCols) o[c] = r[c] == null ? null : Number(r[c]);
      buf.push(o);
    }
    flush();
    total += cnt;
    console.error(`[${day}] trades=${cnt}`);
  }
  out.end();
  console.error(`DONE trades=${total} -> ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
