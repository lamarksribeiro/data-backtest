/**
 * Estatística pareada por dia para o stress test de latência canônico.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const INPUT = path.join(ROOT, 'scratch/tick-exit-latency-canonical.csv');
const OUT = path.join(ROOT, 'scratch/tick-exit-latency-stats.json');

const lines = fs.readFileSync(INPUT, 'utf8').trim().split(/\r?\n/);
const header = lines.shift().split(',');
const rows = lines.map((line) => {
  const values = line.split(',');
  return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
});

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function wilson(successes, n, z = 1.959963984540054) {
  const p = successes / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [center - half, center + half];
}

function bootstrap(values, iterations = 50_000) {
  let seed = 0xc0ffee42;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const sums = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    sums[iteration] = sum;
  }
  sums.sort((a, b) => a - b);
  const firstPositive = sums.findIndex((value) => value > 0);
  return {
    iterations,
    ci95: [quantile(sums, 0.025), quantile(sums, 0.975)],
    median: quantile(sums, 0.5),
    probabilityPositive: firstPositive < 0 ? 0 : 1 - firstPositive / iterations,
  };
}

const variants = [
  'lead_bid40_delay0',
  'lead_bid40_delay0p5',
  'lead_bid40_delay1',
  'lead_bid40_delay2',
  'lead_bid40_delay3',
  'lead_bid40_delay5',
];
const result = {};
for (const variant of variants) {
  const dayDelta = new Map();
  for (const row of rows) {
    const delta = Number(row[`pnl_${variant}`]) - Number(row.pnl_hold);
    dayDelta.set(row.day, (dayDelta.get(row.day) ?? 0) + delta);
  }
  const days = [...dayDelta.entries()].sort(([a], [b]) => a.localeCompare(b));
  const values = days.map(([, delta]) => delta);
  const positiveDays = values.filter((value) => value > 0).length;
  result[variant] = {
    delta: values.reduce((a, b) => a + b, 0),
    positiveDays,
    totalDays: days.length,
    positiveDayRate: positiveDays / days.length,
    positiveDayWilson95: wilson(positiveDays, days.length),
    bootstrapDailyDelta: bootstrap(values),
    dailyDelta: Object.fromEntries(days),
  };
}
const report = { generatedAt: new Date().toISOString(), result };
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
