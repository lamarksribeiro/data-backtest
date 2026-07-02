/**
 * Avaliação do portfólio final: TFC-core (terminal) + LAG-strong (meio) +
 * LIM-prime (início). Janelas de τ disjuntas — um robô pode operar as três
 * como uma única estratégia com 3 gatilhos.
 */
import { loadCube, evalRule, summarize, maxDrawdown } from './lib/cube.js';

const cube = loadCube({ minCoverage: 0.9 });
const c = cube.cols;
const SPLIT = '2026-06-01';
const FRESH = '2026-06-15';

const legs = {
  'LIM-prime  (tau 150-295)': (i) =>
    c.tau[i] >= 150 && c.tau[i] <= 295
    && c.dist_abs[i] >= 60 && c.dist_abs[i] < 100
    && c.edge_phys[i] >= 0.15
    && c.ask_fav[i] >= 0.5 && c.ask_fav[i] < 0.65
    && c.spread_fav[i] <= 0.011,
  'LAG-strong (tau 40-240)': (i) =>
    c.tau[i] >= 40 && c.tau[i] <= 240 && c.dist_abs[i] >= 12
    && Math.sign(c.d_spot_20[i]) === Math.sign(c.dist[i])
    && Math.abs(c.d_spot_20[i]) >= 40
    && Math.abs(c.d_askfav_15[i]) < 0.02
    && c.ask_fav[i] >= 0.62 && c.ask_fav[i] < 0.74,
  'TFC-core   (tau 5-30)': (i) =>
    c.tau[i] >= 5 && c.tau[i] < 30
    && c.dist_abs[i] < 20
    && c.fill_px_fav[i] >= 0.55 && c.fill_px_fav[i] < 0.80
    && c.spread_fav[i] <= 0.03
    && c.odds_sum[i] >= 0.98 && c.odds_sum[i] <= 1.06,
};

function fmtB(b) {
  return `n=${String(b.n).padStart(5)} wr=${(b.wr * 100).toFixed(1).padStart(5)}% pnl=${String(b.pnl).padStart(9)} exp=${String(b.exp).padStart(8)}${b.perDay != null ? ` /dia=${b.perDay}` : ''}`;
}

const dailyByLeg = {};
let allTrades = [];
for (const [name, pred] of Object.entries(legs)) {
  const trades = evalRule(cube, pred);
  const s = summarize(trades, cube.days, SPLIT);
  console.log(`${name}  FULL ${fmtB(s.full)} | hold exp=${s.holdout.exp}`);
  const daily = new Float64Array(cube.days.length);
  for (const t of trades) daily[t.day] += t.pnl;
  dailyByLeg[name] = daily;
  allTrades = allTrades.concat(trades.map((t) => ({ ...t, leg: name })));
}

// ordena por dia e ts implícito (ordem dentro do dia não importa para DD diário)
allTrades.sort((a, b) => a.day - b.day || c.ts_ms[a.i] - c.ts_ms[b.i]);

const s = summarize(allTrades, cube.days, SPLIT);
const fresh = summarize(allTrades, cube.days, FRESH).holdout;
console.log('\n=== PORTFOLIO (3 pernas, $10/trade) ===');
console.log(`  FULL    ${fmtB(s.full)}`);
console.log(`  train   ${fmtB(s.train)}`);
console.log(`  holdout ${fmtB(s.holdout)}`);
console.log(`  fresh   ${fmtB(fresh)}`);
console.log(`  maxDD (trade a trade) = ${maxDrawdown(allTrades)}`);

// estatística diária
const daily = new Float64Array(cube.days.length);
for (const t of allTrades) daily[t.day] += t.pnl;
const pnls = [...daily];
const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
const sd = Math.sqrt(pnls.reduce((a, v) => a + (v - avg) ** 2, 0) / pnls.length);
const pos = pnls.filter((v) => v > 0).length;
let eq = 0; let peak = 0; let ddDaily = 0;
for (const v of pnls) { eq += v; peak = Math.max(peak, eq); ddDaily = Math.max(ddDaily, peak - eq); }
console.log(`  dias=${pnls.length} | positivos=${(pos / pnls.length * 100).toFixed(0)}% | media/dia=${avg.toFixed(2)} | pior dia=${Math.min(...pnls).toFixed(2)} | melhor dia=${Math.max(...pnls).toFixed(2)}`);
console.log(`  maxDD diario=${ddDaily.toFixed(2)} | sharpe diario anualizado=${(avg / sd * Math.sqrt(365)).toFixed(2)}`);

// correlação diária entre pernas
const names = Object.keys(legs);
console.log('\ncorrelação diária entre pernas:');
for (let a = 0; a < names.length; a += 1) {
  for (let b = a + 1; b < names.length; b += 1) {
    const x = dailyByLeg[names[a]]; const y = dailyByLeg[names[b]];
    const mx = x.reduce((s2, v) => s2 + v, 0) / x.length;
    const my = y.reduce((s2, v) => s2 + v, 0) / y.length;
    let sxy = 0; let sxx = 0; let syy = 0;
    for (let d = 0; d < x.length; d += 1) {
      sxy += (x[d] - mx) * (y[d] - my);
      sxx += (x[d] - mx) ** 2;
      syy += (y[d] - my) ** 2;
    }
    console.log(`  ${names[a].trim()} × ${names[b].trim()}: ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`);
  }
}

// equity semanal para o relatório
console.log('\nequity acumulada (semanal):');
eq = 0;
for (let d = 0; d < cube.days.length; d += 1) {
  eq += daily[d];
  if (d % 7 === 6 || d === cube.days.length - 1) console.log(`  ${cube.days[d]}  eq=${eq.toFixed(2)}`);
}
