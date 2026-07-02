/**
 * Minerador em grade por família de hipótese.
 * Agrega células (cross-product de bins) em uma passada, uma entrada por
 * evento (primeiro tick qualificado), lado favorito, hold-to-settlement.
 *
 * Uso: node --max-old-space-size=8192 labs/mining/mine-grid.js <family>
 * Famílias: lim, postflip, lag, terminal
 */
import { loadCube } from './lib/cube.js';

const SPLIT = '2026-06-01';
const cube = loadCube({ minCoverage: 0.9 });
const c = cube.cols;
console.log(`cubo: ${cube.n} linhas, ${cube.numEvents} eventos, dias ${cube.days[0]} -> ${cube.days.at(-1)}`);

const families = {
  // LIM: início do evento, favorito distante, mispricing browniano
  lim: {
    base: (i) => c.tau[i] >= 150 && c.tau[i] <= 295 && c.dist_abs[i] >= 30,
    dims: {
      ask: { col: (i) => c.ask_fav[i], bins: [[0.5, 0.65], [0.65, 0.75], [0.75, 0.82], [0.82, 0.88]] },
      edge: { col: (i) => c.edge_phys[i], bins: [[0.04, 0.08], [0.08, 0.15], [0.15, 9]] },
      dist: { col: (i) => c.dist_abs[i], bins: [[30, 60], [60, 100], [100, 9e9]] },
      spread: { col: (i) => c.spread_fav[i], bins: [[0, 0.011], [0.011, 0.03]] },
    },
  },
  // Pós-cruzamento do PTB (SBRI/TAT unificado)
  postflip: {
    base: (i) => c.secs_since_flip[i] <= 15 && c.dist_abs[i] >= 8 && c.tau[i] >= 20 && c.tau[i] <= 160,
    dims: {
      tau: { col: (i) => c.tau[i], bins: [[20, 60], [60, 100], [100, 160]] },
      ask: { col: (i) => c.ask_fav[i], bins: [[0.2, 0.4], [0.4, 0.48], [0.48, 0.56], [0.56, 0.66]] },
      edge: { col: (i) => c.edge_phys[i], bins: [[-9, 0.05], [0.05, 0.12], [0.12, 9]] },
      mom: { col: (i) => c.d_spot_10[i] * Math.sign(c.dist[i]), bins: [[-9e9, 0], [0, 5], [5, 9e9]] },
    },
  },
  // Repricing lag: spot andou a favor do favorito, ask não acompanhou
  lag: {
    base: (i) => c.tau[i] >= 40 && c.tau[i] <= 240 && c.dist_abs[i] >= 12
      && Math.sign(c.d_spot_20[i]) === Math.sign(c.dist[i]) && Math.abs(c.d_spot_20[i]) >= 10,
    dims: {
      move: { col: (i) => Math.abs(c.d_spot_20[i]), bins: [[10, 22], [22, 40], [40, 9e9]] },
      askchg: { col: (i) => c.d_askfav_15[i], bins: [[-9, -0.02], [-0.02, 0.02], [0.02, 9]] },
      ask: { col: (i) => c.ask_fav[i], bins: [[0.3, 0.5], [0.5, 0.62], [0.62, 0.74]] },
      sigask: { col: (i) => c.sigma_askfav_15[i], bins: [[0, 0.008], [0.008, 9]] },
    },
  },
  // Terminal: últimos segundos, favorito definido
  terminal: {
    base: (i) => c.tau[i] < 45 && c.spread_fav[i] <= 0.03,
    dims: {
      tau: { col: (i) => c.tau[i], bins: [[0, 15], [15, 30], [30, 45]] },
      dist: { col: (i) => c.dist_abs[i], bins: [[0, 8], [8, 20], [20, 45], [45, 9e9]] },
      fill: { col: (i) => c.fill_px_fav[i], bins: [[0.4, 0.55], [0.55, 0.68], [0.68, 0.8], [0.8, 0.93]] },
      flips: { col: (i) => c.flips_60[i], bins: [[0, 1], [1, 3], [3, 99]] },
    },
  },
};

const famName = process.argv[2] || 'lim';
const fam = families[famName];
if (!fam) throw new Error(`família desconhecida: ${famName}`);

const dimNames = Object.keys(fam.dims);
const dimBins = dimNames.map((d) => fam.dims[d].bins);
const dimCols = dimNames.map((d) => fam.dims[d].col);
const sizes = dimBins.map((b) => b.length);
const cells = sizes.reduce((a, b) => a * b, 1);

function binIndex(bins, v) {
  if (!Number.isFinite(v)) return -1;
  for (let k = 0; k < bins.length; k += 1) {
    if (v >= bins[k][0] && v < bins[k][1]) return k;
  }
  return -1;
}

// uma entrada por evento POR CÉLULA: manter stamp por (evento, célula)
const agg = [];
for (let s = 0; s < 2; s += 1) {
  agg.push({ n: new Int32Array(cells), w: new Int32Array(cells), pnl: new Float64Array(cells) });
}
const seen = new Int32Array(cube.numEvents * cells >= 2 ** 31 ? 0 : cube.numEvents * cells);
if (!seen.length) throw new Error('grade grande demais');

const splitIdx = cube.days.findIndex((d) => d >= SPLIT);
for (let i = 0; i < cube.n; i += 1) {
  if (!fam.base(i)) continue;
  let cell = 0;
  let ok = true;
  for (let d = 0; d < dimNames.length; d += 1) {
    const k = binIndex(dimBins[d], dimCols[d](i));
    if (k < 0) { ok = false; break; }
    cell = cell * sizes[d] + k;
  }
  if (!ok) continue;
  const key = cube.eventId[i] * cells + cell;
  if (seen[key]) continue;
  seen[key] = 1;
  const bucket = cube.dayId[i] >= splitIdx ? 1 : 0;
  const a = agg[bucket];
  a.n[cell] += 1;
  a.w[cell] += cube.favWon[i];
  a.pnl[cell] += c.pnl_fav[i];
}

const rows = [];
for (let cell = 0; cell < cells; cell += 1) {
  const tr = agg[0]; const ho = agg[1];
  if (tr.n[cell] < 30 || ho.n[cell] < 20) continue;
  const expTr = tr.pnl[cell] / tr.n[cell];
  const expHo = ho.pnl[cell] / ho.n[cell];
  if (expTr <= 0.3) continue;
  let rem = cell;
  const labels = [];
  for (let d = dimNames.length - 1; d >= 0; d -= 1) {
    const k = rem % sizes[d]; rem = (rem - k) / sizes[d];
    labels.unshift(`${dimNames[d]}=[${dimBins[d][k][0]},${dimBins[d][k][1]})`);
  }
  rows.push({
    labels: labels.join(' '),
    trN: tr.n[cell], trWr: tr.w[cell] / tr.n[cell], trExp: expTr,
    hoN: ho.n[cell], hoWr: ho.w[cell] / ho.n[cell], hoExp: expHo,
    score: Math.min(expTr, expHo),
  });
}
rows.sort((a, b) => b.score - a.score);
console.log(`\n${famName}: ${rows.length} células com trainExp>0.3, nTr>=30, nHo>=20 (de ${cells})`);
for (const r of rows.slice(0, 25)) {
  console.log(
    `train n=${String(r.trN).padStart(4)} wr=${(r.trWr * 100).toFixed(0)}% exp=${r.trExp.toFixed(2).padStart(6)} | ` +
    `hold n=${String(r.hoN).padStart(4)} wr=${(r.hoWr * 100).toFixed(0)}% exp=${r.hoExp.toFixed(2).padStart(6)} | ${r.labels}`,
  );
}
