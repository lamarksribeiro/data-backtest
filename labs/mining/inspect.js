/** Lista os trades individuais de uma regra para auditoria de outliers. */
import { loadCube, evalRule } from './lib/cube.js';

const cube = loadCube({ minCoverage: 0.9 });
const c = cube.cols;

const rules = {
  whipsaw: (i) =>
    c.flips_60[i] >= 3 && Math.abs(c.d_spot_20[i]) <= 5 && c.dist_abs[i] >= 22
    && c.ask_fav[i] <= 0.57 && c.spread_fav[i] <= 0.025
    && c.tau[i] >= 35 && c.tau[i] <= 160,
  sbri: (i) =>
    c.secs_since_flip[i] <= 10 && c.tau[i] >= 40 && c.tau[i] <= 100
    && c.dist_abs[i] >= 15 && c.edge_phys[i] >= 0.10
    && c.ask_fav[i] <= 0.48 && c.spread_fav[i] <= 0.035
    && c.odds_sum[i] >= 0.96 && c.odds_sum[i] <= 1.06,
  stale: (i) =>
    c.sigma_askfav_15[i] <= 0.008 && c.tau[i] >= 60 && c.tau[i] <= 220
    && c.dist_abs[i] >= 20 && c.ask_fav[i] <= 0.72 && c.spread_fav[i] <= 0.04
    && Math.sign(c.d_spot_20[i]) === Math.sign(c.dist[i]) && Math.abs(c.d_spot_20[i]) >= 22
    && Math.abs(c.d_askfav_15[i]) <= 0.015,
};

const name = process.argv[2] || 'whipsaw';
const trades = evalRule(cube, rules[name]);
console.log(`${name}: ${trades.length} trades`);
for (const t of trades) {
  const i = t.i;
  console.log([
    cube.days[t.day],
    new Date(c.ts_ms[i]).toISOString(),
    `tau=${c.tau[i]}`,
    `dist=${c.dist[i].toFixed(1)}`,
    `ask=${c.ask_fav[i].toFixed(2)}`,
    `fill=${c.fill_px_fav[i].toFixed(3)}`,
    `sh=${c.fill_sh_fav[i].toFixed(1)}`,
    `spread=${c.spread_fav[i].toFixed(3)}`,
    `oddsSum=${c.odds_sum[i].toFixed(2)}`,
    `won=${t.won}`,
    `pnl=${t.pnl.toFixed(2)}`,
  ].join(' '));
}
