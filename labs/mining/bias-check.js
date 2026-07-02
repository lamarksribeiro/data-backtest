/**
 * Testa sensibilidade dos candidatos ao filtro mkt_agree (viés de label) e
 * quantifica quantos eventos foram descartados por discordância.
 */
import { loadCube, evalRule, summarize } from './lib/cube.js';

const SPLIT = '2026-06-01';

function fmtB(b) {
  return `n=${String(b.n).padStart(5)} wr=${(b.wr * 100).toFixed(1)}% pnl=${String(b.pnl).padStart(9)} exp=${String(b.exp).padStart(8)}`;
}

const defs = (c) => ({
  'TFC-broad': (i) =>
    c.tau[i] >= 5 && c.tau[i] < 30
    && c.fill_px_fav[i] >= 0.55 && c.fill_px_fav[i] < 0.93
    && c.spread_fav[i] <= 0.03
    && c.odds_sum[i] >= 0.98 && c.odds_sum[i] <= 1.06,
  'TFC-core': (i) =>
    c.tau[i] >= 5 && c.tau[i] < 30
    && c.dist_abs[i] < 20
    && c.fill_px_fav[i] >= 0.55 && c.fill_px_fav[i] < 0.80
    && c.spread_fav[i] <= 0.03
    && c.odds_sum[i] >= 0.98 && c.odds_sum[i] <= 1.06,
  'LIM-prime': (i) =>
    c.tau[i] >= 150 && c.tau[i] <= 295
    && c.dist_abs[i] >= 60 && c.dist_abs[i] < 100
    && c.edge_phys[i] >= 0.15
    && c.ask_fav[i] >= 0.5 && c.ask_fav[i] < 0.65
    && c.spread_fav[i] <= 0.011,
  'LAG-strong': (i) =>
    c.tau[i] >= 40 && c.tau[i] <= 240 && c.dist_abs[i] >= 12
    && Math.sign(c.d_spot_20[i]) === Math.sign(c.dist[i])
    && Math.abs(c.d_spot_20[i]) >= 40
    && Math.abs(c.d_askfav_15[i]) < 0.02
    && c.ask_fav[i] >= 0.62 && c.ask_fav[i] < 0.74,
});

for (const requireMktAgree of [true, false]) {
  const cube = loadCube({ minCoverage: 0.9, requireMktAgree });
  const c = cube.cols;
  console.log(`\n##### requireMktAgree=${requireMktAgree}: ${cube.numEvents} eventos, ${cube.n} linhas`);
  for (const [name, pred] of Object.entries(defs(c))) {
    const s = summarize(evalRule(cube, pred), cube.days, SPLIT);
    console.log(`${name.padEnd(10)} FULL ${fmtB(s.full)} | train exp=${s.train.exp} | hold exp=${s.holdout.exp}`);
  }
}
