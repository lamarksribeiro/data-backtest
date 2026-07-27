/**
 * Taxas empíricas de flip (líder no checkpoint ≠ winner) no BTC 5m.
 * Sem lookahead: features no checkpoint; label no settlement.
 *
 * Uso: node scratch/analyze-late-flip-rates.mjs [--days 30] [--out scratch/late-flip-rates.json]
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
const N_DAYS = Number(flag('days', '30'));
const OUT = flag('out', path.join(__dirname, 'late-flip-rates.json'));

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

const checkpoints = [120, 90, 60, 45, 30, 20, 15, 10, 5];
const byTau = Object.fromEntries(
  checkpoints.map((t) => [t, { n: 0, flips: 0, sumAbsDist: 0, sumZ: 0, sumP: 0 }]),
);
const byZ = {};
const byDist = {};
const byFavAsk = {};
const byCross = {}; // crosses60 at tau
const hazard = {}; // flip rate conditional on leader change in [tau, tau-dt]

function zBucket(z) {
  if (!Number.isFinite(z)) return 'na';
  if (z < 0.5) return '0-0.5';
  if (z < 1) return '0.5-1';
  if (z < 1.5) return '1-1.5';
  if (z < 2) return '1.5-2';
  if (z < 3) return '2-3';
  return '3+';
}
function distBucket(d) {
  const a = Math.abs(d);
  if (a < 5) return '0-5';
  if (a < 15) return '5-15';
  if (a < 30) return '15-30';
  if (a < 50) return '30-50';
  if (a < 100) return '50-100';
  return '100+';
}
function askBucket(a) {
  if (!(a > 0)) return 'na';
  if (a < 0.55) return '<0.55';
  if (a < 0.65) return '0.55-0.65';
  if (a < 0.75) return '0.65-0.75';
  if (a < 0.85) return '0.75-0.85';
  return '0.85+';
}
function crossBucket(c) {
  if (c === 0) return '0';
  if (c === 1) return '1';
  if (c === 2) return '2';
  return '3+';
}
function bump(map, key, flip) {
  if (!map[key]) map[key] = { n: 0, flips: 0 };
  map[key].n += 1;
  map[key].flips += flip;
}

function summarize(map, prefix) {
  return Object.fromEntries(
    Object.entries(map)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [
        k.slice(prefix.length),
        { n: v.n, flipRate: +(v.flips / v.n).toFixed(4), flips: v.flips },
      ])
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })),
  );
}

let totalEvents = 0;
let labeled = 0;
const flipLastCrossTau = []; // last PTB cross tau among events that flipped after T-30
const allLastCrossTau = [];

const inst = await DuckDBInstance.create(':memory:');
const conn = await inst.connect();
await conn.run('SET threads TO 8');
await conn.run("SET memory_limit = '6GB'");

console.error(`days ${sampleDays[0]} -> ${sampleDays[sampleDays.length - 1]} n=${sampleDays.length}`);

for (const day of sampleDays) {
  const dir = path.join(baseDir, `dt=${day}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet'));
  if (!files.length) continue;
  const glob = path.join(dir, '*.parquet').replace(/\\/g, '/');
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

  const flush = () => {
    if (buf.length < 100) return;
    totalEvents += 1;
    const last = buf[buf.length - 1];
    const ptb = last.ptb;
    if (!(ptb > 0)) return;
    const winner = last.spot > ptb ? 1 : -1;

    let ms = 0;
    let mn = 0;
    for (let i = buf.length - 1; i >= 0 && last.t - buf[i].t <= 5; i -= 1) {
      if (buf[i].ub != null && buf[i].ua != null) {
        ms += (buf[i].ub + buf[i].ua) / 2;
        mn += 1;
      }
    }
    if (!mn) return;
    if ((ms / mn > 0.5 ? 1 : -1) !== winner) return;
    labeled += 1;
    const dur = last.t;

    // last cross
    let lastCrossT = null;
    let prevSign = null;
    let crossTot = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const s = buf[i].spot - ptb;
      const sg = s > 0 ? 1 : s < 0 ? -1 : 0;
      if (sg === 0) continue;
      if (prevSign != null && sg !== prevSign) {
        crossTot += 1;
        lastCrossT = buf[i].t;
      }
      prevSign = sg;
    }
    if (lastCrossT != null) allLastCrossTau.push(dur - lastCrossT);

    for (const tau of checkpoints) {
      const cutoff = dur - tau;
      if (cutoff < 30) continue;
      let idx = -1;
      for (let i = buf.length - 1; i >= 0; i -= 1) {
        if (buf[i].t <= cutoff) {
          idx = i;
          break;
        }
      }
      if (idx < 20) continue;
      const curT = buf[idx];
      const dist = curT.spot - ptb;
      if (dist === 0) continue;
      const leader = dist > 0 ? 1 : -1;

      let sumSq = 0;
      let dtSum = 0;
      let start = 0;
      for (let i = 0; i <= idx; i += 1) {
        if (curT.t - buf[i].t <= 60) {
          start = i;
          break;
        }
      }
      let prev = null;
      let crosses60 = 0;
      for (let i = start; i <= idx; i += 1) {
        const s = buf[i].spot - ptb;
        const sg = s > 0 ? 1 : s < 0 ? -1 : 0;
        if (sg === 0) continue;
        if (prev != null && sg !== prev) crosses60 += 1;
        prev = sg;
      }

      for (let i = idx; i >= 1; i -= 1) {
        const age = curT.t - buf[i].t;
        if (age > 60) break;
        const d = buf[i].spot - buf[i - 1].spot;
        const dt = buf[i].t - buf[i - 1].t;
        if (dt > 0) {
          sumSq += d * d;
          dtSum += dt;
        }
      }
      if (dtSum <= 0) continue;
      const sigma1s = Math.sqrt(sumSq / dtSum);
      const z = sigma1s > 0 ? Math.abs(dist) / (sigma1s * Math.sqrt(Math.max(tau, 1))) : 99;
      const pL = phi(z);
      let favAsk = null;
      if (curT.ua != null && curT.da != null) favAsk = leader === 1 ? curT.ua : curT.da;
      const flip = leader !== winner ? 1 : 0;

      const st = byTau[tau];
      st.n += 1;
      st.flips += flip;
      st.sumAbsDist += Math.abs(dist);
      st.sumZ += z;
      st.sumP += pL;
      bump(byZ, `${tau}:${zBucket(z)}`, flip);
      bump(byDist, `${tau}:${distBucket(dist)}`, flip);
      if (favAsk != null) bump(byFavAsk, `${tau}:${askBucket(favAsk)}`, flip);
      bump(byCross, `${tau}:${crossBucket(crosses60)}`, flip);
    }

    // events that flip after T-30: when was the decisive cross?
    let idx30 = -1;
    const c30 = dur - 30;
    for (let i = buf.length - 1; i >= 0; i -= 1) {
      if (buf[i].t <= c30) {
        idx30 = i;
        break;
      }
    }
    if (idx30 >= 0) {
      const d = buf[idx30].spot - ptb;
      if (d !== 0) {
        const lead = d > 0 ? 1 : -1;
        if (lead !== winner && lastCrossT != null) {
          flipLastCrossTau.push(dur - lastCrossT);
        }
      }
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
  console.error(`[${day}] labeled=${labeled} events=${totalEvents}`);
}

function quantiles(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  return {
    n: a.length,
    p10: +q(0.1).toFixed(2),
    p25: +q(0.25).toFixed(2),
    p50: +q(0.5).toFixed(2),
    p75: +q(0.75).toFixed(2),
    p90: +q(0.9).toFixed(2),
    mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  sampleDays: { first: sampleDays[0], last: sampleDays[sampleDays.length - 1], n: sampleDays.length },
  totalEvents,
  labeled,
  definition: 'flip = leader(spot vs PTB) at checkpoint tau != winner at settlement; label requires book mid consensus last 5s',
  byTau: Object.fromEntries(
    Object.entries(byTau).map(([k, v]) => [
      k,
      {
        n: v.n,
        flips: v.flips,
        flipRate: v.n ? +(v.flips / v.n).toFixed(4) : null,
        avgAbsDist: v.n ? +(v.sumAbsDist / v.n).toFixed(2) : null,
        avgZ: v.n ? +(v.sumZ / v.n).toFixed(3) : null,
        avgPphys: v.n ? +(v.sumP / v.n).toFixed(4) : null,
        calibGap: v.n ? +((v.sumP / v.n) - (1 - v.flips / v.n)).toFixed(4) : null,
      },
    ]),
  ),
  byZ: {
    tau30: summarize(byZ, '30:'),
    tau15: summarize(byZ, '15:'),
    tau10: summarize(byZ, '10:'),
    tau5: summarize(byZ, '5:'),
  },
  byDist: {
    tau30: summarize(byDist, '30:'),
    tau15: summarize(byDist, '15:'),
    tau10: summarize(byDist, '10:'),
    tau5: summarize(byDist, '5:'),
  },
  byFavAsk: {
    tau30: summarize(byFavAsk, '30:'),
    tau15: summarize(byFavAsk, '15:'),
    tau10: summarize(byFavAsk, '10:'),
  },
  byCross60: {
    tau30: summarize(byCross, '30:'),
    tau15: summarize(byCross, '15:'),
    tau10: summarize(byCross, '10:'),
  },
  lastCrossTau_allEvents: quantiles(allLastCrossTau),
  lastCrossTau_flippedAfterT30: quantiles(flipLastCrossTau),
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error(`DONE -> ${OUT}`);
