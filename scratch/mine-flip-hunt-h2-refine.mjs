/**
 * Refino denso de H2 post_cross_lead (única tese que sobreviveu).
 * node scratch/mine-flip-hunt-h2-refine.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOLDOUT_FROM = '2026-07-01';
const OUT = path.join(__dirname, 'flip-hunt-h2-refine.json');
const BUDGET = 10;
const SETTLE = 0.995;
const feePerShare = (p) => 0.07 * p * (1 - p);
const N_DAYS = 60;

const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs
  .readdirSync(baseDir)
  .filter((d) => d.startsWith('dt='))
  .map((d) => d.slice(3))
  .sort()
  .slice(-N_DAYS);

function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}
const phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function pnlShares(ask, win) {
  const shares = BUDGET / ask;
  const feeIn = feePerShare(ask) * shares;
  return win ? shares * SETTLE - BUDGET - feeIn : -BUDGET - feeIn;
}
function cart(...dims) {
  return dims.reduce((a, b) => a.flatMap((x) => b.map((y) => [...x, y])), [[]]);
}

const variants = cart(
  [4, 6, 8, 10, 12, 15], // maxCrossAge
  [0.58, 0.62, 0.65, 0.68, 0.72, 0.78], // maxAsk
  [0.0, 0.03, 0.05, 0.08, 0.1, 0.12], // minEdge
  [
    [5, 30],
    [8, 40],
    [10, 50],
    [10, 60],
    [12, 70],
    [15, 90],
  ],
  [5, 8, 10, 12, 15, 20], // minDist
  [0.02, 0.03, 0.04, 0.05], // maxSpread
).map(([maxCrossAge, maxAsk, minEdge, tau, minDist, maxSpread], idx) => ({
  idx,
  maxCrossAge,
  maxAsk,
  minEdge,
  minTau: tau[0],
  maxTau: tau[1],
  minDist,
  maxSpread,
  id: `ca${maxCrossAge}_a${maxAsk}_e${minEdge}_t${tau[0]}-${tau[1]}_d${minDist}_s${maxSpread}`,
}));

console.error(`variants=${variants.length}`);
const stats = variants.map(() => ({
  train: { n: 0, wins: 0, pnl: 0, gw: 0, gl: 0 },
  hold: { n: 0, wins: 0, pnl: 0, gw: 0, gl: 0 },
}));

function add(st, pnl, win) {
  st.n += 1;
  st.pnl += pnl;
  if (win) {
    st.wins += 1;
    st.gw += pnl;
  } else st.gl += -pnl;
}

function processEvent(ticks, day) {
  const n = ticks.length;
  if (n < 100) return;
  const last = ticks[n - 1];
  const ptb = last.ptb;
  if (!(ptb > 0)) return;
  const winner = last.spot > ptb ? 1 : -1;
  let ms = 0;
  let mn = 0;
  for (let i = n - 1; i >= 0 && last.t - ticks[i].t <= 5; i -= 1) {
    if (ticks[i].ub != null && ticks[i].ua != null) {
      ms += (ticks[i].ub + ticks[i].ua) / 2;
      mn += 1;
    }
  }
  if (!mn || (ms / mn > 0.5 ? 1 : -1) !== winner) return;

  const dur = last.t;
  const split = day >= HOLDOUT_FROM ? 'hold' : 'train';
  const entered = new Uint8Array(variants.length);
  let prevSign = null;
  let lastCross = null;
  let lastSampleT = -1e9;

  for (let i = 40; i < n; i += 1) {
    const tk = ticks[i];
    const sg0 = tk.spot > ptb ? 1 : tk.spot < ptb ? -1 : 0;
    if (sg0 !== 0) {
      if (prevSign != null && sg0 !== prevSign) lastCross = tk.t;
      prevSign = sg0;
    }
    const tau = dur - tk.t;
    if (tau > 95 || tau < 3) continue;
    if (tk.t - lastSampleT < 0.95) continue;
    if (tk.ub == null || tk.ua == null || tk.db == null || tk.da == null) continue;
    lastSampleT = tk.t;
    if (lastCross == null) continue;
    const lca = tk.t - lastCross;
    if (lca > 15) continue;

    const dist = tk.spot - ptb;
    if (dist === 0) continue;
    const leader = dist > 0 ? 1 : -1;
    const absDist = Math.abs(dist);
    if (absDist < 5) continue;

    let sumSq = 0;
    let dtSum = 0;
    for (let j = i; j >= 1; j -= 1) {
      if (tk.t - ticks[j].t > 60) break;
      const d = ticks[j].spot - ticks[j - 1].spot;
      const dt = ticks[j].t - ticks[j - 1].t;
      if (dt > 0) {
        sumSq += d * d;
        dtSum += dt;
      }
    }
    if (dtSum < 5) continue;
    const sigma1s = Math.sqrt(sumSq / dtSum);
    if (!(sigma1s > 0)) continue;
    const z = absDist / (sigma1s * Math.sqrt(Math.max(tau, 1)));
    const pPhys = phi(z);
    const favAsk = leader === 1 ? tk.ua : tk.da;
    const favBid = leader === 1 ? tk.ub : tk.db;
    if (!(favAsk >= 0.2 && favAsk <= 0.78)) continue;
    const spread = favAsk - favBid;
    if (tk.ua + tk.da < 0.96 || tk.ua + tk.da > 1.08) continue;
    const edge = pPhys - favAsk;

    for (const v of variants) {
      if (entered[v.idx]) continue;
      if (lca > v.maxCrossAge) continue;
      if (tau < v.minTau || tau > v.maxTau) continue;
      if (absDist < v.minDist) continue;
      if (favAsk > v.maxAsk) continue;
      if (edge < v.minEdge) continue;
      if (spread > v.maxSpread) continue;
      const win = leader === winner;
      add(stats[v.idx][split], pnlShares(favAsk, win), win);
      entered[v.idx] = 1;
    }
  }
}

const inst = await DuckDBInstance.create(':memory:');
const conn = await inst.connect();
await conn.run('SET threads TO 8');
await conn.run("SET memory_limit = '6GB'");

let events = 0;
for (const day of days) {
  const dir = path.join(baseDir, `dt=${day}`);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')) : [];
  if (!files.length) continue;
  const glob = path.join(dir, '*.parquet').replace(/\\/g, '/');
  const res = await conn.runAndReadAll(`
    SELECT event_start,
      EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
      underlying_price AS spot, price_to_beat AS ptb,
      up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da
    FROM read_parquet('${glob}')
    WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND price_to_beat > 0 AND coverage >= 0.9
    ORDER BY event_start, ts`);
  const rows = res.getRowObjectsJson();
  let cur = null;
  let buf = [];
  const flush = () => {
    if (buf.length) {
      processEvent(buf, day);
      events += 1;
    }
  };
  for (const r of rows) {
    const key = String(r.event_start);
    if (key !== cur) {
      flush();
      cur = key;
      buf = [];
    }
    buf.push({
      t: Number(r.t),
      spot: Number(r.spot),
      ptb: Number(r.ptb),
      ub: r.ub == null ? null : Number(r.ub),
      ua: r.ua == null ? null : Number(r.ua),
      db: r.db == null ? null : Number(r.db),
      da: r.da == null ? null : Number(r.da),
    });
  }
  flush();
  console.error(`[${day}]`);
}

function pack(st) {
  const wr = st.n ? st.wins / st.n : null;
  const exp = st.n ? st.pnl / st.n : null;
  const pf = st.gl > 0 ? st.gw / st.gl : st.gw > 0 ? 99 : null;
  return {
    n: st.n,
    wr: wr != null ? +wr.toFixed(4) : null,
    pnl: +st.pnl.toFixed(2),
    exp: exp != null ? +exp.toFixed(4) : null,
    pf: pf != null ? +Math.min(pf, 99).toFixed(3) : null,
  };
}

const ranked = variants
  .map((v) => ({
    id: v.id,
    params: {
      maxCrossAge: v.maxCrossAge,
      maxAsk: v.maxAsk,
      minEdge: v.minEdge,
      minTau: v.minTau,
      maxTau: v.maxTau,
      minDist: v.minDist,
      maxSpread: v.maxSpread,
    },
    train: pack(stats[v.idx].train),
    hold: pack(stats[v.idx].hold),
    score:
      Math.min(pack(stats[v.idx].train).pnl, pack(stats[v.idx].hold).pnl) +
      0.3 * Math.min(pack(stats[v.idx].train).pnl, pack(stats[v.idx].hold).pnl < 0 ? -1e9 : pack(stats[v.idx].hold).pnl),
  }))
  .map((r) => {
    // robust score: min(train,hold) pnl if both positive and pf ok
    const ok =
      r.train.n >= 40 &&
      r.hold.n >= 20 &&
      r.train.exp > 0 &&
      r.hold.exp > 0 &&
      r.train.pf >= 1.15 &&
      r.hold.pf >= 1.15;
    const robust = ok ? Math.min(r.train.pnl, r.hold.pnl) : -1e9;
    const total = ok ? r.train.pnl + r.hold.pnl : -1e9;
    return { ...r, ok, robust, total };
  })
  .filter((r) => r.ok)
  .sort((a, b) => b.robust - a.robust || b.total - a.total);

// also top by hold pnl and by hold pf
const byHold = [...ranked].sort((a, b) => b.hold.pnl - a.hold.pnl);
const byPf = [...ranked].filter((r) => r.hold.n >= 50).sort((a, b) => b.hold.pf - a.hold.pf);

const report = {
  generatedAt: new Date().toISOString(),
  events,
  days: { first: days[0], last: days[days.length - 1], n: days.length },
  holdoutFrom: HOLDOUT_FROM,
  survivors: ranked.length,
  championRobust: ranked[0] || null,
  championHoldPnl: byHold[0] || null,
  championHoldPf: byPf[0] || null,
  topRobust: ranked.slice(0, 20),
  topHoldPnl: byHold.slice(0, 15),
  topHoldPf: byPf.slice(0, 15),
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log('\n=== CHAMPION ROBUST (min train/hold pnl) ===');
if (ranked[0]) {
  const r = ranked[0];
  console.log(JSON.stringify(r, null, 2));
}
console.log('\n=== TOP 10 ROBUST ===');
for (const r of ranked.slice(0, 10)) {
  console.log(
    `robust=${r.robust.toFixed(1)} total=${r.total.toFixed(1)} | T n=${r.train.n} pnl=${r.train.pnl} pf=${r.train.pf} wr=${r.train.wr} | H n=${r.hold.n} pnl=${r.hold.pnl} pf=${r.hold.pf} wr=${r.hold.wr} | ${r.id}`,
  );
}
console.log('\n=== TOP 5 HOLD PnL ===');
for (const r of byHold.slice(0, 5)) {
  console.log(
    `H=${r.hold.pnl} pf=${r.hold.pf} n=${r.hold.n} | T=${r.train.pnl} n=${r.train.n} | ${r.id}`,
  );
}
console.error(`DONE survivors=${ranked.length} -> ${OUT}`);
