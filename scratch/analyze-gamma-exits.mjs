/**
 * Estatisticas pareadas das saidas anti-flip usando settlement canônico.
 * Requer os CSVs gerados pela simulacao tick-a-tick e pela validacao Gamma.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const TICK_CSV = path.join(ROOT, 'scratch/tick-exit-codex.csv');
const FEATURE_CSV = path.join(ROOT, 'scratch/flip-features.csv');
const GAMMA_CSV = path.join(ROOT, 'scratch/gamma-outcomes.csv');
const OUT = path.join(ROOT, 'scratch/gamma-exit-stats.json');

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(header.map((key, i) => [key, values[i] ?? '']));
  });
}

function wilson(successes, n, z = 1.959963984540054) {
  if (!n) return [null, null];
  const p = successes / n;
  const den = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / den;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [center - half, center + half];
}

function quantile(sorted, q) {
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function bootstrapDailySum(deltas, iterations = 50_000) {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const sums = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i += 1) {
      sum += deltas[Math.floor(random() * deltas.length)];
    }
    sums[iteration] = sum;
  }
  sums.sort((a, b) => a - b);
  const firstPositive = sums.findIndex((value) => value > 0);
  return {
    iterations,
    p025: quantile(sums, 0.025),
    median: quantile(sums, 0.5),
    p975: quantile(sums, 0.975),
    probabilityPositive: firstPositive < 0 ? 0 : 1 - firstPositive / iterations,
  };
}

const tickRows = parseCsv(TICK_CSV);
const featureRows = parseCsv(FEATURE_CSV);
const gammaRows = parseCsv(GAMMA_CSV);
const winnerByEvent = new Map(gammaRows.map((row) => [row.event_start, Number(row.winner)]));

function holdPnl(row) {
  const ask = Number(row.ask);
  const shares = 10 / ask;
  const entryFee = 0.07 * ask * (1 - ask) * shares;
  return Number(row.side) === winnerByEvent.get(row.event_start)
    ? shares * 0.995 - 10 - entryFee
    : -10 - entryFee;
}

function variantPnl(row, variant) {
  const exited = variant !== 'hold' && row[`t_${variant}`] !== '';
  return exited ? Number(row[`pnl_${variant}`]) : holdPnl(row);
}

function maxDrawdown(pnls) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

const matched = tickRows.filter((row) => winnerByEvent.has(row.event_start));
const localOutcomeMismatches = matched.filter((row) => {
  const canonicalWin = Number(row.side) === winnerByEvent.get(row.event_start) ? 1 : 0;
  return canonicalWin !== Number(row.win);
});

const variantStats = {};
for (const variant of ['lead', 'lead_bid45', 'lead_bid40']) {
  const dayMap = new Map();
  const monthMap = new Map();
  let deltaTotal = 0;
  let savedOnCanonicalLosers = 0;
  let costOnCanonicalWinners = 0;
  const signalTimes = [];
  for (const row of matched) {
    const base = holdPnl(row);
    const candidate = variantPnl(row, variant);
    const delta = candidate - base;
    const day = row.day;
    const month = day.slice(0, 7);
    dayMap.set(day, (dayMap.get(day) ?? 0) + delta);
    monthMap.set(month, (monthMap.get(month) ?? 0) + delta);
    deltaTotal += delta;
    if (row[`t_${variant}`] !== '') {
      signalTimes.push(Number(row[`t_${variant}`]));
      const canonicalWin = Number(row.side) === winnerByEvent.get(row.event_start);
      if (canonicalWin) costOnCanonicalWinners += delta;
      else savedOnCanonicalLosers += delta;
    }
  }
  const days = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const deltas = days.map(([, value]) => value);
  const positiveDays = deltas.filter((value) => value > 0).length;
  const sortedTimes = signalTimes.sort((a, b) => a - b);
  variantStats[variant] = {
    deltaTotal,
    positiveDays,
    totalDays: days.length,
    positiveDayRate: positiveDays / days.length,
    positiveDayWilson95: wilson(positiveDays, days.length),
    bootstrapDailyDelta95: bootstrapDailySum(deltas),
    savedOnCanonicalLosers,
    costOnCanonicalWinners,
    signalTimeSecondsLeft: {
      n: sortedTimes.length,
      p25: quantile(sortedTimes, 0.25),
      median: quantile(sortedTimes, 0.5),
      p75: quantile(sortedTimes, 0.75),
      over10Seconds: sortedTimes.filter((value) => value > 10).length / sortedTimes.length,
    },
    monthlyDelta: Object.fromEntries([...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
    dailyDelta: Object.fromEntries(days),
  };
}

function gateStats(rows, predicate) {
  const selected = rows.filter(predicate);
  const flips = selected.filter((row) => row.canonicalFlip === 1).length;
  return {
    n: selected.length,
    flips,
    flipRate: flips / selected.length,
    flipRateWilson95: wilson(flips, selected.length),
  };
}

const tau30 = featureRows
  .filter((row) => Number(row.tau) === 30 && winnerByEvent.has(row.event_start))
  .map((row) => ({
    ...row,
    canonicalFlip: Number(row.leader) === winnerByEvent.get(row.event_start) ? 0 : 1,
  }));
const highConfidenceGates = {};
for (const threshold of [0.90, 0.92, 0.95, 0.97]) {
  highConfidenceGates[threshold.toFixed(2)] = {
    full: gateStats(tau30, (row) => Number(row.favMid) >= threshold),
    holdout: gateStats(tau30, (row) => row.day >= '2026-07-01' && Number(row.favMid) >= threshold),
  };
}

function featureEntryPnl(row) {
  const ask = Number(row.favAsk);
  const shares = 10 / ask;
  const entryFee = 0.07 * ask * (1 - ask) * shares;
  return row.canonicalFlip
    ? -10 - entryFee
    : shares * 0.995 - 10 - entryFee;
}

const midasLike = tau30
  .filter((row) => row.day >= '2026-07-01'
    && Number(row.favAsk) >= 0.55
    && Number(row.favAsk) <= 0.94
    && Math.abs(Number(row.dist)) < 40
    && Number(row.spread) <= 0.03
    && Number(row.oddsSum) >= 0.98
    && Number(row.oddsSum) <= 1.06)
  .sort((a, b) => a.event_start.localeCompare(b.event_start));
const midasPnls = midasLike.map(featureEntryPnl);
const midasFlips = midasLike.filter((row) => row.canonicalFlip).length;
const midasNoEntry = {
  baseline: {
    n: midasLike.length,
    flips: midasFlips,
    pnl: midasPnls.reduce((a, b) => a + b, 0),
    maxDrawdown: maxDrawdown(midasPnls),
  },
  gates: {},
};
const noEntryGates = {
  'favMid<0.90': (row) => Number(row.favMid) < 0.90,
  'favMid<0.85': (row) => Number(row.favMid) < 0.85,
  'favMid<0.80': (row) => Number(row.favMid) < 0.80,
  'favMid<0.75': (row) => Number(row.favMid) < 0.75,
  'favMid<=0.70_and_z<=4': (row) => Number(row.favMid) <= 0.70 && Number(row.z) <= 4,
};
for (const [name, predicate] of Object.entries(noEntryGates)) {
  const skipped = midasLike.filter(predicate);
  const kept = midasLike.filter((row) => !predicate(row));
  const skippedFlips = skipped.filter((row) => row.canonicalFlip).length;
  const keptPnls = kept.map(featureEntryPnl);
  const skippedPnl = skipped.map(featureEntryPnl).reduce((a, b) => a + b, 0);
  midasNoEntry.gates[name] = {
    kept: kept.length,
    skipped: skipped.length,
    skippedFlips,
    precision: skippedFlips / skipped.length,
    flipRecall: skippedFlips / midasFlips,
    pnl: keptPnls.reduce((a, b) => a + b, 0),
    pnlDelta: -skippedPnl,
    maxDrawdown: maxDrawdown(keptPnls),
  };
}

const result = {
  generatedAt: new Date().toISOString(),
  matchedTrades: matched.length,
  tickLocalOutcomeMismatches: localOutcomeMismatches.length,
  tickLocalOutcomeMismatchRate: localOutcomeMismatches.length / matched.length,
  highConfidenceGates,
  midasNoEntry,
  variantStats,
};
fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  matchedTrades: result.matchedTrades,
  tickLocalOutcomeMismatches: result.tickLocalOutcomeMismatches,
  highConfidenceGates,
  midasNoEntry,
  variantStats: Object.fromEntries(Object.entries(variantStats).map(([key, row]) => [key, {
    deltaTotal: row.deltaTotal,
    positiveDays: `${row.positiveDays}/${row.totalDays}`,
    positiveDayWilson95: row.positiveDayWilson95,
    bootstrapDailyDelta95: row.bootstrapDailyDelta95,
    savedOnCanonicalLosers: row.savedOnCanonicalLosers,
    costOnCanonicalWinners: row.costOnCanonicalWinners,
    signalTimeSecondsLeft: row.signalTimeSecondsLeft,
    monthlyDelta: row.monthlyDelta,
  }])),
}, null, 2)}\n`);
