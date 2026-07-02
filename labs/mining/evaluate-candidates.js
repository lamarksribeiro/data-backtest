/**
 * Avaliação final de candidatos compostos: métricas completas + sensibilidade.
 * Uso: node --max-old-space-size=8192 labs/mining/evaluate-candidates.js
 */
import { loadCube, evalRule, summarize, maxDrawdown, median } from './lib/cube.js';

const cube = loadCube({ minCoverage: 0.9 });
const c = cube.cols;
const SPLIT = '2026-06-01';
const FRESH = '2026-06-15';
console.log(`cubo: ${cube.n} linhas, ${cube.numEvents} eventos, ${cube.days.length} dias`);

const candidates = {
  // Platô terminal completo (τ 5–30s, favorito consolidado, book saudável)
  'TFC-broad (tau5-30 fill.55-.93)': (i) =>
    c.tau[i] >= 5 && c.tau[i] < 30
    && c.fill_px_fav[i] >= 0.55 && c.fill_px_fav[i] < 0.93
    && c.spread_fav[i] <= 0.03
    && c.odds_sum[i] >= 0.98 && c.odds_sum[i] <= 1.06,

  // Núcleo de maior expectativa do platô
  'TFC-core (tau5-30 dist<20 fill.55-.80)': (i) =>
    c.tau[i] >= 5 && c.tau[i] < 30
    && c.dist_abs[i] < 20
    && c.fill_px_fav[i] >= 0.55 && c.fill_px_fav[i] < 0.80
    && c.spread_fav[i] <= 0.03
    && c.odds_sum[i] >= 0.98 && c.odds_sum[i] <= 1.06,

  // LIM prime: célula campeã do grid lim
  'LIM-prime (ask.5-.65 edge>=.15 dist60-100)': (i) =>
    c.tau[i] >= 150 && c.tau[i] <= 295
    && c.dist_abs[i] >= 60 && c.dist_abs[i] < 100
    && c.edge_phys[i] >= 0.15
    && c.ask_fav[i] >= 0.5 && c.ask_fav[i] < 0.65
    && c.spread_fav[i] <= 0.011,

  // Lag forte: spot moveu >=40 a favor, ask parado, meio caro
  'LAG-strong (move>=40 askflat ask.62-.74)': (i) =>
    c.tau[i] >= 40 && c.tau[i] <= 240 && c.dist_abs[i] >= 12
    && Math.sign(c.d_spot_20[i]) === Math.sign(c.dist[i])
    && Math.abs(c.d_spot_20[i]) >= 40
    && Math.abs(c.d_askfav_15[i]) < 0.02
    && c.ask_fav[i] >= 0.62 && c.ask_fav[i] < 0.74,

  'SBRI-tight (catalogo)': (i) =>
    c.secs_since_flip[i] <= 10 && c.tau[i] >= 40 && c.tau[i] <= 100
    && c.dist_abs[i] >= 15 && c.edge_phys[i] >= 0.10
    && c.ask_fav[i] <= 0.48 && c.spread_fav[i] <= 0.035
    && c.odds_sum[i] >= 0.96 && c.odds_sum[i] <= 1.06,
};

function dayStats(trades, days) {
  const byDay = new Map();
  for (const t of trades) {
    byDay.set(t.day, (byDay.get(t.day) || 0) + t.pnl);
  }
  const pnls = [...byDay.values()];
  const nDays = pnls.length;
  const avg = pnls.reduce((s, v) => s + v, 0) / Math.max(1, nDays);
  const sd = Math.sqrt(pnls.reduce((s, v) => s + (v - avg) ** 2, 0) / Math.max(1, nDays));
  const posDays = pnls.filter((v) => v > 0).length;
  return {
    tradingDays: nDays,
    posDayRate: nDays ? posDays / nDays : 0,
    worstDay: nDays ? Math.min(...pnls) : 0,
    bestDay: nDays ? Math.max(...pnls) : 0,
    dailySharpe: sd > 0 ? (avg / sd) * Math.sqrt(365) : 0,
    avgDay: avg,
  };
}

function fmtB(b) {
  return `n=${String(b.n).padStart(5)} wr=${(b.wr * 100).toFixed(1).padStart(5)}% pnl=${String(b.pnl).padStart(9)} exp=${String(b.exp).padStart(8)} med=${String(b.median).padStart(7)}${b.perDay != null ? ` /dia=${b.perDay}` : ''}`;
}

for (const [name, pred] of Object.entries(candidates)) {
  const trades = evalRule(cube, pred);
  const s = summarize(trades, cube.days, SPLIT);
  const fresh = summarize(trades, cube.days, FRESH).holdout;
  const dd = maxDrawdown(trades);
  const ds = dayStats(trades, cube.days);
  console.log(`\n=== ${name} ===`);
  console.log(`  FULL    ${fmtB(s.full)}`);
  console.log(`  train   ${fmtB(s.train)}`);
  console.log(`  holdout ${fmtB(s.holdout)}`);
  console.log(`  fresh   ${fmtB(fresh)}`);
  console.log(`  maxDD=${dd} | dias c/ trade=${ds.tradingDays} | dias positivos=${(ds.posDayRate * 100).toFixed(0)}% | pior dia=${ds.worstDay.toFixed(2)} | melhor dia=${ds.bestDay.toFixed(2)} | sharpe diario (anualizado)=${ds.dailySharpe.toFixed(2)}`);
}

// ---- Sensibilidade do candidato líder (TFC): perturbar cortes ±20% ----
console.log('\n===== SENSIBILIDADE TFC-broad =====');
const variants = {
  base: [5, 30, 0.55, 0.93, 0.03],
  'tauMax 24': [5, 24, 0.55, 0.93, 0.03],
  'tauMax 36': [5, 36, 0.55, 0.93, 0.03],
  'tauMin 8': [8, 30, 0.55, 0.93, 0.03],
  'fillMin .50': [5, 30, 0.50, 0.93, 0.03],
  'fillMin .60': [5, 30, 0.60, 0.93, 0.03],
  'fillMax .85': [5, 30, 0.55, 0.85, 0.03],
  'fillMax .97': [5, 30, 0.55, 0.97, 0.03],
  'spread .02': [5, 30, 0.55, 0.93, 0.02],
  'spread .04': [5, 30, 0.55, 0.93, 0.04],
};
for (const [label, [t0, t1, f0, f1, sp]] of Object.entries(variants)) {
  const trades = evalRule(cube, (i) =>
    c.tau[i] >= t0 && c.tau[i] < t1
    && c.fill_px_fav[i] >= f0 && c.fill_px_fav[i] < f1
    && c.spread_fav[i] <= sp
    && c.odds_sum[i] >= 0.98 && c.odds_sum[i] <= 1.06);
  const s = summarize(trades, cube.days, SPLIT);
  console.log(`${label.padEnd(12)} train exp=${s.train.exp.toFixed(3).padStart(7)} (n=${s.train.n}) | hold exp=${s.holdout.exp.toFixed(3).padStart(7)} (n=${s.holdout.n}) | full pnl=${s.full.pnl}`);
}

// ---- Curva de equity diária do líder para o relatório ----
console.log('\n===== EQUITY DIÁRIO TFC-broad =====');
const lead = evalRule(cube, candidates['TFC-broad (tau5-30 fill.55-.93)']);
const byDay = new Map();
for (const t of lead) byDay.set(t.day, (byDay.get(t.day) || 0) + t.pnl);
let eq = 0;
for (let d = 0; d < cube.days.length; d += 1) {
  const v = byDay.get(d) || 0;
  eq += v;
  console.log(`${cube.days[d]} ${v >= 0 ? '+' : ''}${v.toFixed(2)} eq=${eq.toFixed(2)}`);
}
