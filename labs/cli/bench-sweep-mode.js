#!/usr/bin/env node
/**
 * Compara sweep chunked (legado) vs single-pass em unidades de trabalho e tempo.
 *
 * Uso:
 *   npm run lab:bench-sweep
 *   npm run lab:bench-sweep -- --days 7 --variants 8 --variant-workers 8
 */
import 'dotenv/config';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { clearAllDatasetCaches } from '../../src/backtest/datasetCache.js';
import { runLabExperiment } from '../shared/labRunner.js';

const DEFAULT_EXPERIMENT = 'labs/strategies/edge/edge-sniper-v2/experiments/2026-06-13-btc-5m-depth25-midpoint-sampled-sweep.json';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildTempExperiment(basePath, { from, to, chunkDays }) {
  const absoluteBase = path.resolve(basePath);
  const experimentDir = path.dirname(absoluteBase);
  const experiment = JSON.parse(readFileSync(absoluteBase, 'utf8'));
  experiment.from = from;
  experiment.to = to;
  if (experiment.defaults) {
    experiment.defaults = path.resolve(experimentDir, experiment.defaults);
  }
  if (experiment.searchSpace) {
    experiment.searchSpace = path.resolve(experimentDir, experiment.searchSpace);
  }
  if (experiment.baseline) {
    experiment.baseline = path.resolve(experimentDir, experiment.baseline);
  }
  if (chunkDays > 0) {
    experiment.chunkDays = chunkDays;
    delete experiment.dailyMetrics;
  } else {
    delete experiment.chunkDays;
    delete experiment.dailyMetrics;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-lab-'));
  const file = path.join(dir, 'experiment.json');
  writeFileSync(file, `${JSON.stringify(experiment, null, 2)}\n`, 'utf8');
  return { file, dir };
}

async function runMode(label, experimentFile, options) {
  clearAllDatasetCaches();
  const startedAt = performance.now();
  const result = await runLabExperiment(experimentFile, {
    ...options,
    quiet: true,
    onProgress: () => {},
  });
  const elapsedWallMs = Math.round(performance.now() - startedAt);
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.error || 'unknown'}`);
  }
  const timings = result.sweep?.timings || {};
  return {
    label,
    sweepMode: result.metadata?.sweepMode,
    chunkDays: result.metadata?.chunkDays,
    variantCount: result.metadata?.variantCount,
    ticks: result.sweep?.ticks,
    elapsedWallMs,
    duckdbReadMs: timings.duckdbReadMs ?? null,
    sweepProcessMs: timings.sweepProcessMs ?? null,
    totalMs: timings.totalMs ?? null,
    chunks: timings.chunks ?? null,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const experimentPath = flags.experiment || DEFAULT_EXPERIMENT;
  const dayCount = Math.max(Number(flags.days || 7), 2);
  const maxVariants = Math.max(Number(flags.variants || flags['max-variants'] || 8), 1);
  const variantWorkers = Math.max(Number(flags['variant-workers'] || flags.variantWorkers || 8), 1);
  const to = flags.to || '2026-05-30';
  const from = flags.from || shiftDate(to, -dayCount);

  const modes = [];
  const tempDirs = [];

  try {
    const chunked = buildTempExperiment(experimentPath, { from, to, chunkDays: 1 });
    tempDirs.push(chunked.dir);
    modes.push(await runMode('chunked-1d', chunked.file, { maxVariants, variantWorkers, chunkDays: 1 }));

    const single = buildTempExperiment(experimentPath, { from, to, chunkDays: 0 });
    tempDirs.push(single.dir);
    modes.push(await runMode('single-pass', single.file, { maxVariants, variantWorkers }));

    const chunkedMs = modes[0].elapsedWallMs;
    const singleMs = modes[1].elapsedWallMs;
    const speedup = chunkedMs > 0 ? Math.round((chunkedMs / singleMs) * 100) / 100 : null;
    const readReduction = modes[0].duckdbReadMs && modes[1].duckdbReadMs
      ? Math.round((1 - modes[1].duckdbReadMs / modes[0].duckdbReadMs) * 1000) / 10
      : null;
    const variantCount = modes[1].variantCount || maxVariants;
    const chunkCount = modes[0].chunks || dayCount;
    const workUnitsChunked = chunkCount * variantCount;
    const workUnitsSingle = variantCount;
    const workUnitReduction = workUnitsSingle > 0
      ? Math.round((workUnitsChunked / workUnitsSingle) * 100) / 100
      : null;

    const summary = {
      ok: true,
      window: { from, to, dayCount },
      maxVariants,
      variantWorkers,
      modes,
      workUnitsChunked,
      workUnitsSingle,
      workUnitReduction,
      speedupSinglePassVsChunked: speedup,
      duckdbReadReductionPct: readReduction,
      pass: workUnitReduction != null
        && workUnitReduction >= Math.max(dayCount - 1, 2)
        && variantCount >= 2,
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pass) {
      console.error(`bench: expected workUnitReduction>=${Math.max(dayCount - 1, 2)} with variantCount>=2`);
      process.exitCode = 1;
    }
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
