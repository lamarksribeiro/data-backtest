/**
 * MERGE: Flip Hunt V1 (entrada pós-cross) x Anti-Flip (saída lead+bid).
 *
 * Replica as entradas do preset `btc-tight-spread` sobre o parquet cru em 91 dias
 * (inclui 2026-04-23 → 2026-05-27, janela NUNCA minerada pelo Flip Hunt), e para cada
 * trade simula tick-a-tick as variantes de saída do estudo anti-flip.
 *
 * Também grava z / pPhys=Phi(z) / ask / outcome para medir a calibração empírica do
 * termo de física usado no gate `edge = pPhys - ask >= minEdge`.
 *
 * Entrada e saída varrem o book depth 25 (fill honesto). Fee 0.07*p*(1-p). Settle 0.995.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const OUT = process.argv[process.argv.indexOf('--out') + 1] || path.join(ROOT, 'scratch/merge-fliphunt.csv');

// preset btc-tight-spread
const P = {
  minSecondsLeft: 10, maxSecondsLeft: 50, maxSecsSinceFlip: 15, minFlipsInWindow: 1,
  minDistAbs: 8, maxDistAbs: 200, minEdge: 0.05, volStepSecs: 30,
  minAsk: 0.20, maxAsk: 0.78, maxSpread: 0.02, minOddsSum: 0.96, maxOddsSum: 1.08,
  entryBudget: 10, entrySlippageMax: 0.02,
};
const SETTLE = 0.995;
const FEE = (p) => 0.07 * p * (1 - p);

const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs.readdirSync(baseDir).filter((d) => d.startsWith('dt=')).map((d) => d.slice(3)).sort();

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

const EXITS = [
  { name: 'hold', fn: () => false },
  { name: 'lead', fn: (s) => s.leaderNow !== s.side },
  { name: 'lead_bid40', fn: (s) => s.leaderNow !== s.side && s.ourBid < 0.40 },
  { name: 'lead_bid45', fn: (s) => s.leaderNow !== s.side && s.ourBid < 0.45 },
  { name: 'lead_bid50', fn: (s) => s.leaderNow !== s.side && s.ourBid < 0.50 },
];

function sweep(levels, shares) {
  let rem = shares, notional = 0;
  for (const l of levels) {
    if (rem <= 0) break;
    const take = Math.min(rem, l.sz);
    notional += take * l.px; rem -= take;
  }
  const filled = shares - rem;
  return { filled, avg: filled > 0 ? notional / filled : 0 };
}

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

const out = fs.createWriteStream(OUT);
out.write(['day', 'event_start', 'side', 'tau', 'dist', 'z', 'pPhys', 'ask', 'edge', 'entryAvg', 'shares', 'win',
  ...EXITS.map((e) => `pnl_${e.name}`), ...EXITS.map((e) => `t_${e.name}`)].join(',') + '\n');

function runEvent(rows, day, eventStart) {
  const n = rows.length;
  if (n < 100) return null;
  const last = rows[n - 1];
  const ptb = last.ptb;
  if (!(ptb > 0)) return null;
  const dur = last.t;
  const winner = last.spot > ptb ? 1 : -1;
  // valida label pelo book final (mesmo criterio do estudo anti-flip)
  let ms = 0, mn = 0;
  for (let i = n - 1; i >= 0 && last.t - rows[i].t <= 5; i -= 1) {
    if (rows[i].ub != null && rows[i].ua != null) { ms += (rows[i].ub + rows[i].ua) / 2; mn += 1; }
  }
  if (!mn || (ms / mn > 0.5 ? 1 : -1) !== winner) return null;

  const spotAgo = (i, secs) => {
    const target = rows[i].t - secs;
    for (let j = i; j >= 0; j -= 1) if (rows[j].t <= target) return rows[j].spot;
    return null;
  };

  for (let i = 5; i < n; i += 1) {
    const tk = rows[i];
    const secsLeft = dur - tk.t;
    if (secsLeft > P.maxSecondsLeft) continue;
    if (secsLeft < P.minSecondsLeft) break;
    if (tk.ub == null || tk.ua == null || tk.db == null || tk.da == null) continue;
    const dist = Math.abs(tk.spot - ptb);
    if (dist < P.minDistAbs || dist > P.maxDistAbs) continue;

    // ptbFlipCount nos ultimos maxSecsSinceFlip
    let flips = 0, prevSign = null;
    for (let j = 0; j <= i; j += 1) {
      const d = rows[j].spot - ptb;
      const sg = d > 0 ? 1 : d < 0 ? -1 : 0;
      if (sg === 0) continue;
      if (prevSign != null && sg !== prevSign && tk.t - rows[j].t <= P.maxSecsSinceFlip) flips += 1;
      if (prevSign == null || sg !== prevSign) prevSign = sg;
    }
    if (flips < P.minFlipsInWindow) continue;

    const side = tk.spot > ptb ? 1 : -1;
    const ask = side === 1 ? tk.ua : tk.da;
    const bid = side === 1 ? tk.ub : tk.db;
    if (!(ask >= P.minAsk && ask <= P.maxAsk)) continue;
    if (ask - bid > P.maxSpread) continue;
    const oddsSum = tk.ua + tk.da;
    if (oddsSum < P.minOddsSum || oddsSum > P.maxOddsSum) continue;

    const u1 = spotAgo(i, P.volStepSecs), u2 = spotAgo(i, P.volStepSecs * 2), u3 = spotAgo(i, P.volStepSecs * 3);
    if (u1 == null || u2 == null || u3 == null) continue;
    const d1 = tk.spot - u1, d2 = u1 - u2, d3 = u2 - u3;
    const sigmaPs = Math.sqrt((d1 * d1 + d2 * d2 + d3 * d3) / (3 * P.volStepSecs));
    if (!(sigmaPs > 0) || !(secsLeft > 0)) continue;
    const z = dist / (sigmaPs * Math.sqrt(secsLeft));
    const pPhys = Phi(z);
    const edge = pPhys - ask;
    if (edge < P.minEdge) continue;

    // ---- ENTRADA: varredura do book ask depth 25, com teto de slippage
    const askLv = levelsAt(tk, side, 'ask').filter((l) => l.px <= ask + P.entrySlippageMax);
    const wantShares = P.entryBudget / ask;
    const ent = sweep(askLv, wantShares);
    if (ent.filled <= 0) continue;
    const shares = ent.filled;
    const entryAvg = ent.avg;
    const cost = shares * entryAvg;
    const feeIn = FEE(entryAvg) * shares;
    const win = side === winner ? 1 : 0;

    // ---- MONITOR de saida tick-a-tick
    const st = EXITS.map(() => ({ exited: false, px: null, t: null, filled: 0 }));
    for (let j = i + 1; j < n; j += 1) {
      const t2 = rows[j];
      if (t2.ub == null || t2.ua == null || t2.db == null || t2.da == null) continue;
      const sl = dur - t2.t;
      if (sl < 2) break;
      const dd = t2.spot - ptb;
      const leaderNow = dd > 0 ? 1 : dd < 0 ? -1 : side;
      const ourBid = side === 1 ? t2.ub : t2.db;
      const s = { side, leaderNow, ourBid, secsLeft: sl };
      for (let v = 0; v < EXITS.length; v += 1) {
        if (st[v].exited || !EXITS[v].fn(s)) continue;
        const lv = levelsAt(t2, side, 'bid');
        const sw = sweep(lv, shares);
        st[v].exited = true; st[v].t = sl;
        st[v].px = sw.filled > 0 ? sw.avg : ourBid;
        st[v].filled = sw.filled;
      }
    }

    const pnls = st.map((s) => {
      if (!s.exited) return (win ? shares * SETTLE : 0) - cost - feeIn;
      const rem = shares - s.filled;
      const settleRem = win ? rem * SETTLE : 0;
      return s.filled * s.px + settleRem - cost - feeIn - (s.filled > 0 ? FEE(s.px) * s.filled : 0);
    });

    return [day, eventStart, side, secsLeft.toFixed(1), dist.toFixed(1), z.toFixed(3), pPhys.toFixed(4),
      ask.toFixed(3), edge.toFixed(4), entryAvg.toFixed(4), shares.toFixed(2), win,
      ...pnls.map((p) => p.toFixed(4)), ...st.map((s) => (s.exited ? s.t.toFixed(1) : ''))].join(',');
  }
  return null;
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
    console.error(`[${day}] entries=${cnt}`);
  }
  out.end();
  console.error(`DONE entries=${total} -> ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
