/**
 * Revalida os padrões promovidos/candidatos do catálogo de anomalias no cubo
 * completo (66 dias), incluindo a janela nunca minerada (2026-06-15+).
 *
 * Uso: node --max-old-space-size=8192 labs/mining/champions.js
 */
import { loadCube, evalRule, summarize, maxDrawdown } from './lib/cube.js';

const cube = loadCube({ minCoverage: 0.9 });
console.log(`cubo: ${cube.n} linhas, ${cube.numEvents} eventos, ${cube.days.length} dias (${cube.days[0]} -> ${cube.days.at(-1)})`);

const c = cube.cols;
const SPLIT = '2026-06-01';
const FRESH = '2026-06-15';

const rules = {
  // ANOM-22/33 Whipsaw Lock ws-spread25 (campeão do catálogo)
  'whipsaw-lock (ws-spread25)': (i) =>
    c.flips_60[i] >= 3 && Math.abs(c.d_spot_20[i]) <= 5 && c.dist_abs[i] >= 22
    && c.ask_fav[i] <= 0.57 && c.spread_fav[i] <= 0.025
    && c.tau[i] >= 35 && c.tau[i] <= 160,

  // ANOM-10 SBRI tight: cruzou o PTB há <=10s, desconto físico >= 0.10
  'sbri-tight': (i) =>
    c.secs_since_flip[i] <= 10 && c.tau[i] >= 40 && c.tau[i] <= 100
    && c.dist_abs[i] >= 15 && c.edge_phys[i] >= 0.10
    && c.ask_fav[i] <= 0.48 && c.spread_fav[i] <= 0.035
    && c.odds_sum[i] >= 0.96 && c.odds_sum[i] <= 1.06,

  // ANOM-12 TAT: rompimento com velocidade (>=0.25 USD/s em 10s) recém-cruzado
  'tat': (i) =>
    c.secs_since_flip[i] <= 10 && c.tau[i] >= 5 && c.tau[i] <= 80
    && Math.abs(c.d_spot_10[i]) >= 2.5 && Math.sign(c.d_spot_10[i]) === Math.sign(c.dist[i])
    && c.ask_fav[i] <= 0.56 && c.spread_fav[i] <= 0.10,

  // ANOM-34 Terminal Pin Favorite Lock (candidato ciclo 10)
  'anom-34 terminal-pin': (i) =>
    c.tau[i] < 20 && c.dist_abs[i] < 8
    && c.fill_px_fav[i] >= 0.50 && c.fill_px_fav[i] < 0.62
    && c.spread_fav[i] < 0.015
    && c.flips_60[i] >= 1 && c.flips_60[i] <= 2
    && c.odds_sum[i] >= 1.00 && c.odds_sum[i] < 1.04,

  // ANOM-26 Late Drift ld-tight: drift >=12 USD e ask_fav caiu >=0.04
  'anom-26 late-drift': (i) =>
    c.tau[i] >= 25 && c.tau[i] <= 75
    && Math.abs(c.d_spot_15[i]) >= 12 && Math.sign(c.d_spot_15[i]) === Math.sign(c.dist[i])
    && c.d_askfav_10[i] <= -0.04,

  // ANOM-09 LIM: início do evento, distância grande, mispricing browniano
  'lim': (i) =>
    c.tau[i] >= 180 && c.tau[i] <= 290 && c.dist_abs[i] >= 60
    && c.edge_phys[i] >= 0.08 && c.ask_fav[i] <= 0.88,

  // ANOM-15 stale quote
  'anom-15 stale-quote': (i) =>
    c.sigma_askfav_15[i] <= 0.008 && c.tau[i] >= 60 && c.tau[i] <= 220
    && c.dist_abs[i] >= 20 && c.ask_fav[i] <= 0.72 && c.spread_fav[i] <= 0.04
    && Math.sign(c.d_spot_20[i]) === Math.sign(c.dist[i]) && Math.abs(c.d_spot_20[i]) >= 22
    && Math.abs(c.d_askfav_15[i]) <= 0.015,
};

function fmtB(b) {
  return `n=${String(b.n).padStart(5)} wr=${(b.wr * 100).toFixed(1).padStart(5)}% pnl=${String(b.pnl).padStart(9)} exp=${String(b.exp).padStart(8)} med=${String(b.median).padStart(7)}${b.perDay != null ? ` /dia=${b.perDay}` : ''}`;
}

for (const [name, pred] of Object.entries(rules)) {
  const trades = evalRule(cube, pred);
  const s = summarize(trades, cube.days, SPLIT);
  const fresh = summarize(trades, cube.days, FRESH).holdout;
  const dd = maxDrawdown(trades);
  console.log(`\n== ${name} ==`);
  console.log(`  FULL    ${fmtB(s.full)}  maxDD=${dd}`);
  console.log(`  train   ${fmtB(s.train)}   (< ${SPLIT})`);
  console.log(`  holdout ${fmtB(s.holdout)}   (>= ${SPLIT})`);
  console.log(`  fresh   ${fmtB(fresh)}   (>= ${FRESH}, nunca minerado)`);
}
