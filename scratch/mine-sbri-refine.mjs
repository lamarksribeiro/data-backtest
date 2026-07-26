/**
 * Refino SBRI-tight no cubo (side-symmetric: compra favorito pós-flip).
 * node --max-old-space-size=8192 scratch/mine-sbri-refine.mjs
 */
import { loadCube, evalRule, summarize, maxDrawdown } from '../labs/mining/lib/cube.js';

const cube = loadCube({ minCoverage: 0.9 });
const c = cube.cols;
const SPLIT = '2026-06-01';
const FRESH = '2026-06-15';
const JULY = '2026-07-01';

console.log(`cube n=${cube.n} events=${cube.numEvents} days=${cube.days[0]}..${cube.days.at(-1)}`);

const rules = [];

for (const maxSince of [8, 10, 12, 15]) {
  for (const minDist of [12, 15, 18, 22]) {
    for (const minEdge of [0.08, 0.10, 0.12, 0.15]) {
      for (const maxAsk of [0.45, 0.48, 0.50, 0.52]) {
        for (const maxSpread of [0.025, 0.03, 0.035, 0.04]) {
          for (const tauLo of [35, 40, 45]) {
            for (const tauHi of [90, 100, 120]) {
              if (tauHi <= tauLo) continue;
              rules.push({
                id: `sf${maxSince}_d${minDist}_e${minEdge}_a${maxAsk}_s${maxSpread}_t${tauLo}-${tauHi}`,
                pred: (i) =>
                  c.secs_since_flip[i] <= maxSince
                  && c.tau[i] >= tauLo && c.tau[i] <= tauHi
                  && c.dist_abs[i] >= minDist
                  && c.edge_phys[i] >= minEdge
                  && c.ask_fav[i] <= maxAsk
                  && c.spread_fav[i] <= maxSpread
                  && c.odds_sum[i] >= 0.96 && c.odds_sum[i] <= 1.06,
              });
            }
          }
        }
      }
    }
  }
}

// also classic sbri-cross10 style
rules.push({
  id: 'classic-cross10',
  pred: (i) =>
    c.secs_since_flip[i] <= 10
    && c.tau[i] >= 40 && c.tau[i] <= 120
    && c.dist_abs[i] >= 10
    && c.edge_phys[i] >= 0.08
    && c.ask_fav[i] <= 0.50
    && c.spread_fav[i] <= 0.04
    && c.odds_sum[i] >= 0.94 && c.odds_sum[i] <= 1.08,
});

rules.push({
  id: 'sbri-tight-catalog',
  pred: (i) =>
    c.secs_since_flip[i] <= 10
    && c.tau[i] >= 40 && c.tau[i] <= 100
    && c.dist_abs[i] >= 15
    && c.edge_phys[i] >= 0.10
    && c.ask_fav[i] <= 0.48
    && c.spread_fav[i] <= 0.035
    && c.odds_sum[i] >= 0.96 && c.odds_sum[i] <= 1.06,
});

function score(s) {
  // require all splits non-negative or train+hold+fresh positive-ish
  if (s.full.n < 15) return -1e9;
  if (s.holdout.pnl <= 0) return -1e9;
  if (s.train.pnl <= 0) return -1e9;
  // prefer positive fresh, high full pnl, decent n
  const freshPen = s.fresh.pnl < 0 ? s.fresh.pnl * 2 : s.fresh.pnl;
  return s.full.pnl + 0.5 * s.holdout.pnl + freshPen + Math.min(s.full.n, 80) * 0.5;
}

const results = [];
for (const r of rules) {
  const trades = evalRule(cube, r.pred);
  const s = summarize(trades, cube.days, SPLIT);
  const fresh = summarize(trades, cube.days, FRESH).holdout;
  const july = summarize(trades, cube.days, JULY).holdout;
  const pack = {
    id: r.id,
    full: s.full,
    train: s.train,
    holdout: s.holdout,
    fresh,
    july,
    dd: maxDrawdown(trades),
  };
  pack._score = score({
    full: s.full,
    train: s.train,
    holdout: s.holdout,
    fresh,
  });
  results.push(pack);
}

results.sort((a, b) => b._score - a._score);
console.log('\nTOP 20 by robust score (train>0, hold>0):');
for (const r of results.slice(0, 20)) {
  console.log(JSON.stringify({
    id: r.id,
    score: Math.round(r._score * 100) / 100,
    n: r.full.n,
    pnl: round(r.full.pnl),
    exp: round(r.full.exp),
    wr: round(r.full.wr),
    train: round(r.train.pnl),
    hold: round(r.holdout.pnl),
    fresh: round(r.fresh.pnl),
    july: round(r.july.pnl),
    dd: round(r.dd),
  }));
}

// best by full pnl among train&hold positive
const pos = results.filter((r) => r.train.pnl > 0 && r.holdout.pnl > 0 && r.full.n >= 20);
pos.sort((a, b) => b.full.pnl - a.full.pnl);
console.log('\nTOP 10 by full PnL (train&hold > 0, n>=20):');
for (const r of pos.slice(0, 10)) {
  console.log(JSON.stringify({
    id: r.id,
    n: r.full.n,
    pnl: round(r.full.pnl),
    exp: round(r.full.exp),
    train: round(r.train.pnl),
    hold: round(r.holdout.pnl),
    fresh: round(r.fresh.pnl),
    july: round(r.july.pnl),
  }));
}

function round(x) {
  return Math.round(Number(x) * 100) / 100;
}
