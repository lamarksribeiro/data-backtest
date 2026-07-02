/** Sensibilidade ±20% dos cortes da perna TFC-core + consistência semanal. */
import { loadCube, evalRule, summarize } from './lib/cube.js';

const cube = loadCube({ minCoverage: 0.9 });
const c = cube.cols;
const SPLIT = '2026-06-01';

function core([t0, t1, dMax, f0, f1, sp]) {
  return (i) =>
    c.tau[i] >= t0 && c.tau[i] < t1
    && c.dist_abs[i] < dMax
    && c.fill_px_fav[i] >= f0 && c.fill_px_fav[i] < f1
    && c.spread_fav[i] <= sp
    && c.odds_sum[i] >= 0.98 && c.odds_sum[i] <= 1.06;
}

const base = [5, 30, 20, 0.55, 0.80, 0.03];
const variants = {
  base,
  'tauMax 24': [5, 24, 20, 0.55, 0.80, 0.03],
  'tauMax 36': [5, 36, 20, 0.55, 0.80, 0.03],
  'tauMin 10': [10, 30, 20, 0.55, 0.80, 0.03],
  'dist 15': [5, 30, 15, 0.55, 0.80, 0.03],
  'dist 25': [5, 30, 25, 0.55, 0.80, 0.03],
  'fill .50-.80': [5, 30, 20, 0.50, 0.80, 0.03],
  'fill .60-.80': [5, 30, 20, 0.60, 0.80, 0.03],
  'fill .55-.75': [5, 30, 20, 0.55, 0.75, 0.03],
  'fill .55-.85': [5, 30, 20, 0.55, 0.85, 0.03],
  'spread .02': [5, 30, 20, 0.55, 0.80, 0.02],
  'spread .045': [5, 30, 20, 0.55, 0.80, 0.045],
};
for (const [label, v] of Object.entries(variants)) {
  const s = summarize(evalRule(cube, core(v)), cube.days, SPLIT);
  console.log(`${label.padEnd(14)} train exp=${s.train.exp.toFixed(3).padStart(7)} (n=${s.train.n}) | hold exp=${s.holdout.exp.toFixed(3).padStart(7)} (n=${s.holdout.n}) | full pnl=${String(s.full.pnl).padStart(8)}`);
}

// consistência semanal da base
console.log('\nsemanal TFC-core (base):');
const trades = evalRule(cube, core(base));
const weekly = new Map();
for (const t of trades) {
  const week = cube.days[t.day].slice(0, 8) + 'W' + Math.ceil(Number(cube.days[t.day].slice(8)) / 7);
  const w = weekly.get(week) || { n: 0, pnl: 0, wins: 0 };
  w.n += 1; w.pnl += t.pnl; w.wins += t.won;
  weekly.set(week, w);
}
for (const [week, w] of [...weekly.entries()].sort()) {
  console.log(`  ${week} n=${String(w.n).padStart(4)} wr=${(w.wins / w.n * 100).toFixed(0)}% pnl=${w.pnl.toFixed(2)}`);
}
