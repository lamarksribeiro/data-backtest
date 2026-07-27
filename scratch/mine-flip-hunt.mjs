/**
 * Caça a flips no BTC 5m — miner de teses acionáveis (hold-to-settlement).
 *
 * Teses:
 *   H1 fake_leader_dog  — spot líder com ask fraco → compra o OPPOSITE
 *   H2 post_cross_lead  — acabou de cruzar PTB → compra o NOVO líder
 *   H3 late_phys_cheap  — favorito físico ainda barato no ask
 *   H4 cross_mom        — momentum forte perto da barreira → lado do mom
 *
 * Uso:
 *   node scratch/mine-flip-hunt.mjs
 *   node scratch/mine-flip-hunt.mjs --days 60 --holdout-from 2026-07-01
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}

const N_DAYS = Number(flag('days', '60'));
const HOLDOUT_FROM = flag('holdout-from', '2026-07-01');
const OUT = flag('out', path.join(__dirname, 'flip-hunt-results.json'));
const BUDGET = 10;
const SETTLE = 0.995;
const feePerShare = (p) => 0.07 * p * (1 - p);

const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs
  .readdirSync(baseDir)
  .filter((d) => d.startsWith('dt='))
  .map((d) => d.slice(3))
  .sort();
const sampleDays = days.slice(-N_DAYS);

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
  if (win) return shares * SETTLE - BUDGET - feeIn;
  return -BUDGET - feeIn;
}

function cart(...dims) {
  return dims.reduce((a, b) => a.flatMap((x) => b.map((y) => [...x, y])), [[]]);
}

// Compact but dense grids per thesis
const h1 = cart(
  [0.52, 0.55, 0.58, 0.62], // maxFavAsk
  [0.48, 0.52, 0.55, 0.60], // maxDogAsk
  [
    [3, 15],
    [5, 20],
    [8, 30],
    [10, 45],
  ],
  [15, 25, 40, 80], // maxDist
).map(([maxFavAsk, maxDogAsk, tau, maxDist]) => ({
  thesis: 'H1_fake_leader_dog',
  maxFavAsk,
  maxDogAsk,
  minTau: tau[0],
  maxTau: tau[1],
  maxDist,
  minDist: 0,
  minEdge: -1,
  maxCrossAge: 999,
  momMin: 0,
  minZ: 0,
}));

const h2 = cart(
  [3, 5, 8, 12],
  [0.55, 0.6, 0.65, 0.72],
  [0, 0.05, 0.08, 0.12],
  [
    [5, 25],
    [8, 40],
    [10, 60],
    [15, 90],
  ],
  [5, 8, 12, 20],
).map(([maxCrossAge, maxFavAsk, minEdge, tau, minDist]) => ({
  thesis: 'H2_post_cross_lead',
  maxFavAsk,
  maxDogAsk: 1,
  minTau: tau[0],
  maxTau: tau[1],
  maxDist: 200,
  minDist,
  minEdge,
  maxCrossAge,
  momMin: 0,
  minZ: 0,
}));

const h3 = cart(
  [0.3, 0.35, 0.4, 0.45],
  [0.08, 0.12, 0.15, 0.2],
  [5, 8, 12, 20],
  [
    [3, 12],
    [3, 15],
    [5, 20],
    [8, 25],
  ],
).map(([maxFavAsk, minEdge, minDist, tau]) => ({
  thesis: 'H3_late_phys_cheap',
  maxFavAsk,
  maxDogAsk: 1,
  minTau: tau[0],
  maxTau: tau[1],
  maxDist: 80,
  minDist,
  minEdge,
  maxCrossAge: 999,
  momMin: 0,
  minZ: 0.5,
}));

const h4 = cart(
  [3, 5, 8, 12],
  [0.48, 0.52, 0.55, 0.6],
  [
    [5, 20],
    [8, 30],
    [10, 45],
  ],
  [8, 15, 25],
).map(([momMin, maxAsk, tau, maxDist]) => ({
  thesis: 'H4_cross_mom',
  maxFavAsk: maxAsk,
  maxDogAsk: maxAsk,
  minTau: tau[0],
  maxTau: tau[1],
  maxDist,
  minDist: 0,
  minEdge: -1,
  maxCrossAge: 999,
  momMin,
  minZ: 0,
}));

const variants = [...h1, ...h2, ...h3, ...h4].map((v, i) => ({
  ...v,
  id: `${v.thesis}|fa${v.maxFavAsk}|da${v.maxDogAsk}|t${v.minTau}-${v.maxTau}|D${v.maxDist}|d${v.minDist}|e${v.minEdge}|ca${v.maxCrossAge}|m${v.momMin}`,
  idx: i,
}));

const byThesis = {
  H1_fake_leader_dog: variants.filter((v) => v.thesis === 'H1_fake_leader_dog'),
  H2_post_cross_lead: variants.filter((v) => v.thesis === 'H2_post_cross_lead'),
  H3_late_phys_cheap: variants.filter((v) => v.thesis === 'H3_late_phys_cheap'),
  H4_cross_mom: variants.filter((v) => v.thesis === 'H4_cross_mom'),
};

console.error(
  `variants=${variants.length} H1=${byThesis.H1_fake_leader_dog.length} H2=${byThesis.H2_post_cross_lead.length} H3=${byThesis.H3_late_phys_cheap.length} H4=${byThesis.H4_cross_mom.length}`,
);

const stats = variants.map(() => ({
  train: { n: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0 },
  hold: { n: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0 },
}));

function addTrade(st, pnl, win) {
  st.n += 1;
  st.pnl += pnl;
  if (win) {
    st.wins += 1;
    st.grossWin += pnl;
  } else {
    st.grossLoss += -pnl;
  }
}

function bookOk(ua, da, spread, maxSpread = 0.05) {
  if (ua + da < 0.96 || ua + da > 1.08) return false;
  if (spread > maxSpread) return false;
  return true;
}

function fire(vi, split, side, ask, winner) {
  if (!(ask > 0.05 && ask < 0.95)) return;
  const win = side === winner;
  addTrade(stats[vi][split], pnlShares(ask, win), win);
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
  if (!mn) return;
  if ((ms / mn > 0.5 ? 1 : -1) !== winner) return;

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
    if (tau > 90 || tau < 2) continue;
    if (tk.t - lastSampleT < 0.95) continue;
    if (tk.ub == null || tk.ua == null || tk.db == null || tk.da == null) continue;
    lastSampleT = tk.t;

    const dist = tk.spot - ptb;
    if (dist === 0) continue;
    const leader = dist > 0 ? 1 : -1;
    const absDist = Math.abs(dist);

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

    let spot10 = null;
    for (let j = i; j >= 0; j -= 1) {
      if (tk.t - ticks[j].t >= 10) {
        spot10 = ticks[j].spot;
        break;
      }
    }
    const mom10 = spot10 != null ? tk.spot - spot10 : 0;
    const lca = lastCross != null ? tk.t - lastCross : null;

    const favAsk = leader === 1 ? tk.ua : tk.da;
    const dogAsk = leader === 1 ? tk.da : tk.ua;
    const favBid = leader === 1 ? tk.ub : tk.db;
    const dogBid = leader === 1 ? tk.db : tk.ub;

    // H1 gate: weak spot-leader ask
    if (favAsk <= 0.62 && dogAsk <= 0.6) {
      const spr = dogAsk - dogBid;
      if (bookOk(tk.ua, tk.da, spr)) {
        for (const v of byThesis.H1_fake_leader_dog) {
          if (entered[v.idx]) continue;
          if (tau < v.minTau || tau > v.maxTau) continue;
          if (absDist > v.maxDist) continue;
          if (favAsk > v.maxFavAsk) continue;
          if (dogAsk > v.maxDogAsk) continue;
          fire(v.idx, split, -leader, dogAsk, winner);
          entered[v.idx] = 1;
        }
      }
    }

    // H2 gate: recent cross
    if (lca != null && lca <= 12) {
      const spr = favAsk - favBid;
      const edge = pPhys - favAsk;
      if (bookOk(tk.ua, tk.da, spr) && favAsk >= 0.2) {
        for (const v of byThesis.H2_post_cross_lead) {
          if (entered[v.idx]) continue;
          if (tau < v.minTau || tau > v.maxTau) continue;
          if (absDist < v.minDist) continue;
          if (lca > v.maxCrossAge) continue;
          if (favAsk > v.maxFavAsk) continue;
          if (edge < v.minEdge) continue;
          fire(v.idx, split, leader, favAsk, winner);
          entered[v.idx] = 1;
        }
      }
    }

    // H3 gate: cheap fav with phys edge
    if (favAsk <= 0.45 && z >= 0.5 && absDist >= 5) {
      const spr = favAsk - favBid;
      const edge = pPhys - favAsk;
      if (tk.ua + tk.da >= 0.94 && tk.ua + tk.da <= 1.12 && spr <= 0.06 && edge >= 0.08) {
        for (const v of byThesis.H3_late_phys_cheap) {
          if (entered[v.idx]) continue;
          if (tau < v.minTau || tau > v.maxTau) continue;
          if (absDist < v.minDist || absDist > v.maxDist) continue;
          if (z < v.minZ) continue;
          if (favAsk > v.maxFavAsk) continue;
          if (edge < v.minEdge) continue;
          fire(v.idx, split, leader, favAsk, winner);
          entered[v.idx] = 1;
        }
      }
    }

    // H4 gate: strong mom near barrier
    if (Math.abs(mom10) >= 3 && absDist <= 25) {
      const momSide = mom10 > 0 ? 1 : -1;
      const ask = momSide === 1 ? tk.ua : tk.da;
      const bid = momSide === 1 ? tk.ub : tk.db;
      const spr = ask - bid;
      if (ask <= 0.6 && ask >= 0.15 && bookOk(tk.ua, tk.da, spr)) {
        for (const v of byThesis.H4_cross_mom) {
          if (entered[v.idx]) continue;
          if (tau < v.minTau || tau > v.maxTau) continue;
          if (absDist > v.maxDist) continue;
          if (Math.abs(mom10) < v.momMin) continue;
          if (ask > v.maxFavAsk) continue;
          fire(v.idx, split, momSide, ask, winner);
          entered[v.idx] = 1;
        }
      }
    }
  }
}

const inst = await DuckDBInstance.create(':memory:');
const conn = await inst.connect();
await conn.run('SET threads TO 8');
await conn.run("SET memory_limit = '6GB'");

console.error(`days ${sampleDays[0]} -> ${sampleDays[sampleDays.length - 1]} n=${sampleDays.length}`);
console.error(`holdout-from ${HOLDOUT_FROM}`);

let events = 0;
for (const day of sampleDays) {
  const dir = path.join(baseDir, `dt=${day}`);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet'));
  if (!files.length) continue;
  const glob = path.join(dir, '*.parquet').replace(/\\/g, '/');
  const t0 = Date.now();
  const res = await conn.runAndReadAll(`
    SELECT event_start,
      EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
      underlying_price AS spot, price_to_beat AS ptb,
      up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da
    FROM read_parquet('${glob}')
    WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND price_to_beat > 0
      AND coverage >= 0.9
    ORDER BY event_start, ts
  `);
  const rows = res.getRowObjectsJson();
  let cur = null;
  let buf = [];
  let dayEvents = 0;
  const flush = () => {
    if (buf.length) {
      processEvent(buf, day);
      dayEvents += 1;
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
  console.error(`[${day}] events=${dayEvents} ${Date.now() - t0}ms`);
}

function pack(st) {
  const wr = st.n ? st.wins / st.n : null;
  const exp = st.n ? st.pnl / st.n : null;
  const pf = st.grossLoss > 0 ? st.grossWin / st.grossLoss : st.grossWin > 0 ? 99 : null;
  return {
    n: st.n,
    wins: st.wins,
    wr: wr != null ? +wr.toFixed(4) : null,
    pnl: +st.pnl.toFixed(2),
    exp: exp != null ? +exp.toFixed(4) : null,
    pf: pf != null ? +Math.min(pf, 99).toFixed(3) : null,
  };
}

function slimParams(v) {
  return {
    maxFavAsk: v.maxFavAsk,
    maxDogAsk: v.maxDogAsk,
    minTau: v.minTau,
    maxTau: v.maxTau,
    maxDist: v.maxDist,
    minDist: v.minDist,
    minEdge: v.minEdge,
    maxCrossAge: v.maxCrossAge,
    momMin: v.momMin,
    minZ: v.minZ,
  };
}

const all = variants.map((v) => ({
  id: v.id,
  thesis: v.thesis,
  params: slimParams(v),
  train: pack(stats[v.idx].train),
  hold: pack(stats[v.idx].hold),
}));

const strict = all
  .filter((r) => r.train.n >= 30 && r.hold.n >= 15)
  .filter((r) => r.train.exp > 0 && r.hold.exp > 0)
  .filter((r) => r.train.pf >= 1.15 && r.hold.pf >= 1.1)
  .sort((a, b) => b.hold.pnl - a.hold.pnl);

const loose = all
  .filter((r) => r.train.n >= 20 && r.hold.n >= 10)
  .filter((r) => r.train.exp > 0 && r.hold.exp > 0)
  .sort((a, b) => b.hold.pnl - a.hold.pnl);

const champions = {};
for (const r of strict) {
  if (!champions[r.thesis] || r.hold.pnl > champions[r.thesis].hold.pnl) champions[r.thesis] = r;
}
// if thesis has no strict, take best loose with hold pf>=1
for (const th of Object.keys(byThesis)) {
  if (champions[th]) continue;
  const c = loose.find((r) => r.thesis === th && r.hold.pf >= 1.0);
  if (c) champions[th] = { ...c, note: 'loose_filters' };
}

// per-thesis holdout ranking
const perThesisTop = {};
for (const th of Object.keys(byThesis)) {
  perThesisTop[th] = all
    .filter((r) => r.thesis === th && r.hold.n >= 10 && r.train.n >= 15)
    .sort((a, b) => b.hold.pnl - a.hold.pnl)
    .slice(0, 8);
}

const report = {
  generatedAt: new Date().toISOString(),
  sampleDays: { first: sampleDays[0], last: sampleDays[sampleDays.length - 1], n: sampleDays.length },
  holdoutFrom: HOLDOUT_FROM,
  events,
  variantCount: variants.length,
  survivorsStrict: strict.length,
  championsByThesis: champions,
  topHoldoutStrict: strict.slice(0, 25),
  topHoldoutLoose: loose.slice(0, 30),
  perThesisTop,
  // diagnostics: how many variants have any activity
  activity: {
    trainWithTrades: all.filter((r) => r.train.n > 0).length,
    holdWithTrades: all.filter((r) => r.hold.n > 0).length,
    bothPositiveExp: all.filter((r) => r.train.exp > 0 && r.hold.exp > 0).length,
  },
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log('\n=== ACTIVITY ===');
console.log(JSON.stringify(report.activity));

console.log('\n=== CHAMPIONS BY THESIS ===');
for (const [th, r] of Object.entries(champions)) {
  console.log(
    `\n${th}${r.note ? ' [' + r.note + ']' : ''}\n  params ${JSON.stringify(r.params)}\n  train n=${r.train.n} wr=${r.train.wr} pnl=${r.train.pnl} pf=${r.train.pf} exp=${r.train.exp}\n  hold  n=${r.hold.n} wr=${r.hold.wr} pnl=${r.hold.pnl} pf=${r.hold.pf} exp=${r.hold.exp}`,
  );
}

console.log('\n=== TOP 12 HOLDOUT (strict) ===');
for (const r of strict.slice(0, 12)) {
  console.log(
    `${String(r.hold.pnl).padStart(8)} pfH=${r.hold.pf} nH=${String(r.hold.n).padStart(4)} wrH=${r.hold.wr} | ${r.thesis} | t${r.params.minTau}-${r.params.maxTau} fa${r.params.maxFavAsk} e${r.params.minEdge} ca${r.params.maxCrossAge}`,
  );
}

console.log('\n=== TOP 5 PER THESIS (any positive hold) ===');
for (const [th, rows] of Object.entries(perThesisTop)) {
  console.log(`\n-- ${th}`);
  for (const r of rows.slice(0, 5)) {
    console.log(
      `  hold pnl=${r.hold.pnl} n=${r.hold.n} wr=${r.hold.wr} pf=${r.hold.pf} | train pnl=${r.train.pnl} n=${r.train.n} | ${JSON.stringify(r.params)}`,
    );
  }
}

console.error(`\nDONE strict=${strict.length} loose=${loose.length} -> ${OUT}`);
