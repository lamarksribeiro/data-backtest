#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPORT_ROOT = path.resolve('reports/labs/apex-triad-v1');
const BOOTSTRAP_SAMPLES = 10_000;
const BLOCK_LENGTH = 5;

const segments = [
  {
    name: 'train',
    reference: loadVariant('apex-triad-phase1-train', 'terminal-reference'),
    candidate: loadVariant('apex-triad-phase2-risk-train', 'hybrid-balanced-risk-075'),
  },
  {
    name: 'validation',
    reference: loadVariant('apex-triad-phase2-validate-june', 'terminal-reference'),
    candidate: loadVariant('apex-triad-phase2-validate-june', 'hybrid-balanced-risk-075'),
  },
  {
    name: 'holdout',
    reference: loadVariant('apex-triad-phase3-holdout-july', 'terminal-reference'),
    candidate: loadVariant('apex-triad-phase3-holdout-july', 'apex-triad-frozen-075'),
  },
];

const pairedDays = segments.flatMap((segment) => pairDailySeries(segment));
const differences = pairedDays.map((day) => day.delta);
const referenceDaily = pairedDays.map((day) => day.referencePnl);
const candidateDaily = pairedDays.map((day) => day.candidatePnl);
const positiveDays = differences.filter((value) => value > 1e-9).length;
const negativeDays = differences.filter((value) => value < -1e-9).length;
const zeroDays = differences.length - positiveDays - negativeDays;
const bootstrap = movingBlockBootstrap(differences, BOOTSTRAP_SAMPLES, BLOCK_LENGTH, 0xA9E5_2026);
const fullReference = loadVariant('apex-triad-final-full-single-pass', 'terminal-reference');
const fullCandidate = loadVariant('apex-triad-final-full-single-pass', 'apex-triad-frozen-075');

const analysis = {
  generatedAt: new Date().toISOString(),
  observations: pairedDays.length,
  segments: segments.map(({ name, reference, candidate }) => ({
    name,
    reference: compactSummary(reference.summary),
    candidate: compactSummary(candidate.summary),
    pnlDelta: candidate.summary.totalPnl - reference.summary.totalPnl,
  })),
  fullSinglePass: {
    reference: compactSummary(fullReference.summary),
    candidate: compactSummary(fullCandidate.summary),
    pnlDelta: fullCandidate.summary.totalPnl - fullReference.summary.totalPnl,
    pnlDeltaPct: pctDelta(fullCandidate.summary.totalPnl, fullReference.summary.totalPnl),
    entriesDelta: fullCandidate.summary.entries - fullReference.summary.entries,
    entriesDeltaPct: pctDelta(fullCandidate.summary.entries, fullReference.summary.entries),
    drawdownDelta: fullCandidate.summary.maxDrawdown - fullReference.summary.maxDrawdown,
    drawdownDeltaPct: pctDelta(fullCandidate.summary.maxDrawdown, fullReference.summary.maxDrawdown),
  },
  pairedDaily: {
    meanDelta: mean(differences),
    medianDelta: median(differences),
    stdDelta: sampleStd(differences),
    tStatistic: mean(differences) / (sampleStd(differences) / Math.sqrt(differences.length)),
    positiveDays,
    negativeDays,
    zeroDays,
    positiveRate: positiveDays / differences.length,
    exactTwoSidedSignPValue: exactSignTest(positiveDays, negativeDays),
    pnlCorrelation: correlation(referenceDaily, candidateDaily),
    referenceDailySharpe: mean(referenceDaily) / sampleStd(referenceDaily),
    candidateDailySharpe: mean(candidateDaily) / sampleStd(candidateDaily),
    movingBlockBootstrap: {
      samples: BOOTSTRAP_SAMPLES,
      blockLength: BLOCK_LENGTH,
      meanDelta95: bootstrap.mean95,
      totalDelta95: bootstrap.mean95.map((value) => value * differences.length),
      probabilityMeanDeltaPositive: bootstrap.positiveProbability,
    },
  },
};

console.log(JSON.stringify(analysis, null, 2));

function loadVariant(experimentSuffix, variantId) {
  const reportDir = latestReport(experimentSuffix);
  const variants = JSON.parse(readFileSync(path.join(reportDir, 'top-results.json'), 'utf8'));
  const variant = variants.find((item) => item.id === variantId);
  if (!variant) throw new Error(`Variant ${variantId} not found in ${reportDir}`);
  return variant;
}

function latestReport(suffix) {
  if (!existsSync(REPORT_ROOT)) throw new Error(`Report root not found: ${REPORT_ROOT}`);
  const matches = readdirSync(REPORT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${suffix}`))
    .map((entry) => path.join(REPORT_ROOT, entry.name))
    .filter((dir) => existsSync(path.join(dir, 'top-results.json')))
    .sort();
  if (!matches.length) throw new Error(`No report found for ${suffix}`);
  return matches[matches.length - 1];
}

function pairDailySeries(segment) {
  const reference = new Map(dailySeries(segment.reference).map((day) => [day.dt, day.pnl]));
  const candidate = new Map(dailySeries(segment.candidate).map((day) => [day.dt, day.pnl]));
  return [...reference.entries()].map(([dt, referencePnl]) => {
    if (!candidate.has(dt)) throw new Error(`Candidate missing ${dt} in ${segment.name}`);
    const candidatePnl = candidate.get(dt);
    return { segment: segment.name, dt, referencePnl, candidatePnl, delta: candidatePnl - referencePnl };
  });
}

function dailySeries(variant) {
  const fromSummary = variant.summary?.daily?.series;
  if (Array.isArray(fromSummary)) return fromSummary;
  if (Array.isArray(variant.daily)) return variant.daily.map((day) => ({ dt: day.dt, pnl: day.totalPnl }));
  throw new Error(`Daily series missing for ${variant.id}`);
}

function compactSummary(summary = {}) {
  return {
    pnl: summary.totalPnl,
    entries: summary.entries,
    winRate: summary.winRate,
    profitFactor: summary.profitFactor,
    maxDrawdown: summary.maxDrawdown,
    feesPaid: summary.feesPaid,
  };
}

function movingBlockBootstrap(values, samples, blockLength, seed) {
  const random = seededRandom(seed);
  const means = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const drawn = [];
    while (drawn.length < values.length) {
      const start = Math.floor(random() * values.length);
      for (let offset = 0; offset < blockLength && drawn.length < values.length; offset += 1) {
        drawn.push(values[(start + offset) % values.length]);
      }
    }
    means.push(mean(drawn));
  }
  means.sort((a, b) => a - b);
  return {
    mean95: [quantileSorted(means, 0.025), quantileSorted(means, 0.975)],
    positiveProbability: means.filter((value) => value > 0).length / means.length,
  };
}

function exactSignTest(positive, negative) {
  const n = positive + negative;
  if (n === 0) return 1;
  const k = Math.min(positive, negative);
  let lowerTail = 0;
  for (let i = 0; i <= k; i += 1) lowerTail += binomialProbability(n, i);
  return Math.min(1, 2 * lowerTail);
}

function binomialProbability(n, k) {
  let coefficient = 1;
  for (let i = 1; i <= k; i += 1) coefficient *= (n - (k - i)) / i;
  return coefficient * (0.5 ** n);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleStd(values) {
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / Math.max(1, values.length - 1));
}

function correlation(left, right) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  return numerator / Math.sqrt(leftSquares * rightSquares);
}

function quantileSorted(values, probability) {
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + ((values[upper] - values[lower]) * (index - lower));
}

function pctDelta(value, reference) {
  return reference === 0 ? null : ((value - reference) / Math.abs(reference)) * 100;
}
