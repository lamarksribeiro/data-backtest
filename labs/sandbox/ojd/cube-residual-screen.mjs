/**
 * Fast anomaly screen on mining cube (no full parquet).
 * Maps where market ask / p_phys leave residual vs winner.
 *
 * Usage: node labs/sandbox/ojd/cube-residual-screen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CUBE = path.join('labs', 'mining', 'cube');
const OUT = path.join('labs', 'sandbox', 'ojd', 'reports', 'cube-residual-screen.json');
const OUT_MD = path.join('labs', 'sandbox', 'ojd', 'reports', 'cube-residual-screen.md');

const COL = {
  dt: 0, tau: 3, dist_abs: 7, fav: 8, ask_fav: 9, ask_up: 12, ask_down: 13,
  odds_sum: 14, sigma: 21, flips: 22, secs_flip: 23, pin45: 24,
  obi5: 31, p_phys: 37, edge_phys: 38, coverage: 39, degraded: 40,
  mkt_agree: 41, winner: 42, fav_won: 43,
};

function num(s) {
  if (s == null || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function brier(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i++) s += (ps[i] - ys[i]) ** 2;
  return s / ps.length;
}

function clip01(x) {
  return Math.min(0.999, Math.max(0.001, x));
}

function tauBin(t) {
  if (t == null) return 'na';
  if (t < 15) return '[0,15)';
  if (t < 30) return '[15,30)';
  if (t < 60) return '[30,60)';
  if (t < 120) return '[60,120)';
  if (t < 200) return '[120,200)';
  return '[200,300]';
}

function distBin(d) {
  if (d == null) return 'na';
  if (d < 5) return '[0,5)';
  if (d < 15) return '[5,15)';
  if (d < 30) return '[15,30)';
  if (d < 50) return '[30,50)';
  return '[50+)';
}

function sigmaBin(s) {
  if (s == null) return 'na';
  if (s < 10) return '[0,10)';
  if (s < 20) return '[10,20)';
  if (s < 35) return '[20,35)';
  if (s < 50) return '[35,50)';
  return '[50+)';
}

function flipsBin(f) {
  if (f == null) return 'na';
  if (f <= 0) return '0';
  if (f === 1) return '1';
  if (f <= 3) return '2-3';
  return '4+';
}

function askBin(a) {
  if (a == null) return 'na';
  if (a < 0.35) return '[0,0.35)';
  if (a < 0.45) return '[0.35,0.45)';
  if (a < 0.55) return '[0.45,0.55)';
  if (a < 0.70) return '[0.55,0.70)';
  return '[0.70,1]';
}

async function loadCube() {
  const files = fs.readdirSync(CUBE).filter((f) => f.endsWith('.csv')).sort();
  const rows = [];
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(CUBE, f)), crlfDelay: Infinity });
    let first = true;
    for await (const line of rl) {
      if (first) {
        first = false;
        continue;
      }
      if (!line) continue;
      const p = line.split(',');
      const tau = num(p[COL.tau]);
      const askUp = num(p[COL.ask_up]);
      const winner = p[COL.winner];
      if (tau == null || askUp == null || (winner !== 'UP' && winner !== 'DOWN')) continue;
      // subsample: keep ticks near eval seconds to reduce dependence (tau near 30/60/90/120)
      const near = [30, 45, 60, 90, 120].some((t) => Math.abs(tau - t) <= 2);
      if (!near) continue;

      const upWins = winner === 'UP' ? 1 : 0;
      const pM = clip01(askUp);
      const pPhys = num(p[COL.p_phys]);
      // p_phys is for fav side in cube — convert carefully using fav
      const fav = p[COL.fav];
      let pPhysUp = null;
      if (pPhys != null && (fav === 'UP' || fav === 'DOWN')) {
        pPhysUp = fav === 'UP' ? clip01(pPhys) : clip01(1 - pPhys);
      }

      rows.push({
        dt: p[COL.dt],
        tau,
        dist_abs: num(p[COL.dist_abs]),
        sigma: num(p[COL.sigma]),
        flips: num(p[COL.flips]),
        pin45: num(p[COL.pin45]),
        obi5: num(p[COL.obi5]),
        ask_up: askUp,
        odds_sum: num(p[COL.odds_sum]),
        coverage: num(p[COL.coverage]),
        degraded: p[COL.degraded] === '1' || p[COL.degraded] === 'true',
        upWins,
        pM,
        pPhysUp,
        residM: upWins - pM,
        residP: pPhysUp != null ? upWins - pPhysUp : null,
      });
    }
  }
  return rows;
}

function agg(rows, keyFn, keyName) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([k, arr]) => {
      if (arr.length < 80) return null;
      const y = arr.map((r) => r.upWins);
      const pM = arr.map((r) => r.pM);
      const withP = arr.filter((r) => r.pPhysUp != null);
      return {
        [keyName]: k,
        n: arr.length,
        up_rate: mean(y),
        mean_pM: mean(pM),
        resid_m: mean(arr.map((r) => r.residM)),
        abs_resid_m: mean(arr.map((r) => Math.abs(r.residM))),
        brier_m: brier(pM, y),
        brier_phys: withP.length >= 80 ? brier(withP.map((r) => r.pPhysUp), withP.map((r) => r.upWins)) : null,
        mean_sigma: mean(arr.map((r) => r.sigma).filter((x) => x != null)),
        mean_dist: mean(arr.map((r) => r.dist_abs).filter((x) => x != null)),
      };
    })
    .filter(Boolean);
}

function topMisprice(rows, minN = 120) {
  // 2D cells tau x dist
  const m = new Map();
  for (const r of rows) {
    const k = `${tauBin(r.tau)}|${distBin(r.dist_abs)}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()]
    .map(([k, arr]) => {
      if (arr.length < minN) return null;
      const y = arr.map((r) => r.upWins);
      const pM = arr.map((r) => r.pM);
      const resid = mean(arr.map((r) => r.residM));
      return {
        cell: k,
        n: arr.length,
        resid_m: resid,
        abs_resid: Math.abs(resid),
        up_rate: mean(y),
        mean_pM: mean(pM),
        brier_m: brier(pM, y),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.abs_resid - a.abs_resid)
    .slice(0, 15);
}

async function main() {
  console.log('Loading cube (subsample tau≈30/45/60/90/120)...');
  const rows = await loadCube();
  console.log('rows', rows.length);

  const cut = rows[Math.floor(rows.length * 0.7)]?.dt;
  const train = rows.filter((r) => r.dt < cut);
  const valid = rows.filter((r) => r.dt >= cut);

  const report = {
    generated_at: new Date().toISOString(),
    n: rows.length,
    cut_dt: cut,
    n_train: train.length,
    n_valid: valid.length,
    global: {
      up_rate: mean(rows.map((r) => r.upWins)),
      brier_m: brier(rows.map((r) => r.pM), rows.map((r) => r.upWins)),
      resid_m: mean(rows.map((r) => r.residM)),
    },
    by_tau: agg(rows, (r) => tauBin(r.tau), 'tau'),
    by_dist: agg(rows, (r) => distBin(r.dist_abs), 'dist'),
    by_sigma: agg(rows, (r) => sigmaBin(r.sigma), 'sigma'),
    by_flips: agg(rows, (r) => flipsBin(r.flips), 'flips'),
    by_ask: agg(rows, (r) => askBin(r.ask_up), 'ask_up'),
    top_cells_all: topMisprice(rows),
    top_cells_valid: topMisprice(valid, 80),
    notes: [
      'resid_m = upWins - ask_up (positive => market underpriced UP)',
      'Cube is BTC-oriented mining features; not multi-asset',
      'Use cells with |resid| large AND stable train→valid as hypothesis seeds',
    ],
  };

  // Stability: cells with |resid|>=0.03 in both train and valid
  const tCells = new Map(topMisprice(train, 80).map((c) => [c.cell, c]));
  const vCells = new Map(topMisprice(valid, 60).map((c) => [c.cell, c]));
  const stable = [];
  for (const [cell, t] of tCells) {
    const v = vCells.get(cell);
    if (!v) continue;
    if (Math.sign(t.resid_m) === Math.sign(v.resid_m) && Math.abs(t.resid_m) >= 0.025 && Math.abs(v.resid_m) >= 0.02) {
      stable.push({ cell, train: t, valid: v });
    }
  }
  report.stable_misprice_cells = stable;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const md = [];
  md.push('# Cube residual screen (hypothesis seeds)');
  md.push('');
  md.push(`n=${report.n} cut_dt=${cut} global resid_m=${report.global.resid_m?.toFixed(4)} brier_m=${report.global.brier_m?.toFixed(4)}`);
  md.push('');
  md.push('## By tau');
  md.push('');
  md.push('| tau | n | up_rate | mean_pM | resid_m | brier |');
  md.push('|---|---:|---:|---:|---:|---:|');
  for (const r of report.by_tau) {
    md.push(`| ${r.tau} | ${r.n} | ${r.up_rate?.toFixed(3)} | ${r.mean_pM?.toFixed(3)} | ${r.resid_m?.toFixed(4)} | ${r.brier_m?.toFixed(4)} |`);
  }
  md.push('');
  md.push('## Top |residual| cells (tau × dist)');
  md.push('');
  for (const c of report.top_cells_all) {
    md.push(`- **${c.cell}** n=${c.n} resid=${c.resid_m?.toFixed(4)} up=${c.up_rate?.toFixed(3)} pM=${c.mean_pM?.toFixed(3)}`);
  }
  md.push('');
  md.push('## Stable train→valid seeds');
  md.push('');
  if (!stable.length) md.push('_Nenhuma célula estável com |resid| threshold._');
  for (const s of stable) {
    md.push(
      `- **${s.cell}** train resid=${s.train.resid_m?.toFixed(4)} (n=${s.train.n}) | valid resid=${s.valid.resid_m?.toFixed(4)} (n=${s.valid.n})`,
    );
  }
  md.push('');
  fs.writeFileSync(OUT_MD, md.join('\n'));

  console.log('global', report.global);
  console.table(report.by_tau);
  console.table(report.by_dist);
  console.table(report.by_flips);
  console.log('stable seeds', stable.length);
  console.log('Wrote', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
