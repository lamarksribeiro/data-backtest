#!/usr/bin/env node
/**
 * F0 — baseline V4: compara rows vs soa (frio/quente), fast-run e sweep.
 *
 * Uso:
 *   npm run bench:v4
 *   npm run bench:v4 -- --window 1d --save
 *   npm run bench:v4 -- --from 2026-05-29 --to 2026-05-30 --save
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { runBacktestSweep } from '../src/backtest/sweep.js';
import { parse } from '../src/backtestStudio/gls/parser.js';
import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { analyzeStrategyColumns } from '../src/backtestStudio/gls/compiler.js';
import { checkDatasetAvailability } from '../src/query/availability.js';
import { clearAllDatasetCaches } from '../src/backtest/datasetCache.js';

const WINDOW_PRESETS = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
};

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

function parseDateStart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function parseDateEnd(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function resolveWindow(flags) {
  if (flags.from && flags.to) {
    return {
      label: 'custom',
      from: parseDateStart(flags.from).toISOString(),
      to: parseDateEnd(flags.to).toISOString(),
    };
  }
  const days = WINDOW_PRESETS[String(flags.window || '7d')] ?? WINDOW_PRESETS['7d'];
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  return {
    label: flags.window || `${days}d`,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function ticksPerSec(ticks, totalMs) {
  if (!totalMs || totalMs <= 0) return null;
  return Math.round((ticks / totalMs) * 1000);
}

function buildRequest(ast, window, underlying, interval, bookDepth, options = {}) {
  const columnAnalysis = analyzeStrategyColumns(ast, bookDepth);
  return {
    from: window.from,
    to: window.to,
    underlying,
    interval,
    bookDepth,
    batchSize: 25_000,
    strategy: 'gls:edge-sniper-v2',
    strategyLabel: ast.name,
    glsAst: ast,
    columnAnalysis,
    params: options.params ?? {},
    fastRun: Boolean(options.fastRun),
    glsExecution: options.glsExecution,
    backtestWorkers: options.backtestWorkers,
  };
}

async function runScenario(db, request, { runs = 1, cold = false, label }) {
  if (cold) clearAllDatasetCaches();

  const memBefore = process.memoryUsage();
  const wallStart = performance.now();
  let lastResult = null;

  for (let i = 0; i < runs; i += 1) {
    if (i > 0 && cold) clearAllDatasetCaches();
    lastResult = await runBacktest(db, request);
  }

  const wallMs = performance.now() - wallStart;
  const memAfter = process.memoryUsage();
  const timings = lastResult.timings || {};

  return {
    label,
    ticks: lastResult.ticks,
    batches: lastResult.batches,
    runs,
    cold,
    timings: {
      duckdbReadMs: timings.duckdbReadMs,
      processMs: timings.processMs,
      finishMs: timings.finishMs,
      totalMs: timings.totalMs,
      wallMs: Math.round(wallMs),
      ticksPerSec: ticksPerSec(lastResult.ticks, timings.totalMs),
    },
    memory: {
      rssMb: Math.round(memAfter.rss / 1024 / 1024),
      rssDeltaMb: Math.round((memAfter.rss - memBefore.rss) / 1024 / 1024),
    },
    summary: {
      totalEvents: lastResult.summary?.totalEvents,
      totalPnl: lastResult.summary?.totalPnl,
    },
  };
}

async function runSweepScenario(db, baseRequest, variantCount, label) {
  clearAllDatasetCaches();
  const variants = Array.from({ length: variantCount }, (_, index) => ({
    id: `v${index}`,
    params: {
      minDistanceAbs: index * 5,
      minEdge: 0.05 + index * 0.01,
    },
  }));

  const memBefore = process.memoryUsage();
  const wallStart = performance.now();
  const sweep = await runBacktestSweep(db, baseRequest, variants);
  const wallMs = performance.now() - wallStart;
  const memAfter = process.memoryUsage();

  return {
    label,
    variantCount,
    ticks: sweep.ticks,
    timings: {
      duckdbReadMs: sweep.timings.duckdbReadMs,
      sweepProcessMs: sweep.timings.sweepProcessMs,
      avgVariantMs: sweep.timings.avgVariantMs,
      totalMs: sweep.timings.totalMs,
      wallMs: Math.round(wallMs),
      ticksPerSec: ticksPerSec(sweep.ticks * variantCount, sweep.timings.sweepProcessMs),
      variantsPerSec: sweep.timings.sweepProcessMs
        ? Math.round((variantCount / sweep.timings.sweepProcessMs) * 1000 * 100) / 100
        : null,
    },
    memory: {
      rssMb: Math.round(memAfter.rss / 1024 / 1024),
      rssDeltaMb: Math.round((memAfter.rss - memBefore.rss) / 1024 / 1024),
    },
  };
}

function computeSpeedups(scenarios, baselineId = 'rows-cold') {
  const baseline = scenarios.find((s) => s.label === baselineId && !s.skipped);
  if (!baseline?.timings?.totalMs) return null;

  const baseMs = baseline.timings.totalMs;
  const out = {};
  for (const scenario of scenarios) {
    if (scenario.skipped || !scenario.timings?.totalMs) continue;
    const ms = scenario.timings.totalMs ?? scenario.timings.sweepProcessMs;
    if (!ms) continue;
    out[scenario.label] = {
      vsBaseline: Math.round((baseMs / ms) * 100) / 100,
      totalMs: ms,
      ticksPerSec: scenario.timings.ticksPerSec ?? scenario.timings.variantsPerSec,
    };
  }
  return out;
}

function printSummary(report) {
  const lines = [
    '',
    '=== F0 V4 Benchmark ===',
    `window: ${report.window.label} (${report.window.from.slice(0, 10)} → ${report.window.to.slice(0, 10)})`,
    `ticks in lake window: ~${report.availability.estimatedTicks ?? '?'}`,
    `host: ${report.host.node} | cpus: ${report.host.cpus}`,
    '',
    'label                  totalMs  duckdbMs  processMs  ticks/s',
    '--------------------- -------- --------- ---------- -------',
  ];

  for (const s of report.scenarios) {
    if (s.skipped) {
      lines.push(`${s.label.padEnd(21)} SKIPPED  ${s.reason}`);
      continue;
    }
    const t = s.timings;
    const total = t.totalMs ?? t.sweepProcessMs ?? '-';
    const duck = t.duckdbReadMs ?? '-';
    const proc = t.processMs ?? t.sweepProcessMs ?? '-';
    const tps = t.ticksPerSec ?? t.variantsPerSec ?? '-';
    lines.push(
      `${s.label.padEnd(21)} ${String(total).padStart(8)} ${String(duck).padStart(9)} ${String(proc).padStart(10)} ${String(tps).padStart(7)}`,
    );
  }

  if (report.speedups) {
    lines.push('', 'Speedup vs rows-cold (totalMs):');
    for (const [label, data] of Object.entries(report.speedups)) {
      if (label === 'rows-cold') continue;
      lines.push(`  ${label}: ${data.vsBaseline}×`);
    }
  }

  console.error(lines.join('\n'));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const window = resolveWindow(flags);
  const underlying = String(flags.underlying || 'BTC').toUpperCase();
  const interval = String(flags.interval || '5m');
  const bookDepth = Number.parseInt(String(flags['book-depth'] || flags.bookDepth || '10'), 10) || 10;
  const sweepVariants = Math.max(Number.parseInt(String(flags['sweep-variants'] || '20'), 10) || 20, 2);

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  const scenarios = [];

  try {
    const availability = checkDatasetAvailability(db, {
      dataset: 'backtest_ticks',
      from: window.from,
      to: window.to,
      underlying,
      interval,
      bookDepth,
    });

    if (!availability.ok) {
      const report = {
        at: new Date().toISOString(),
        phase: 'F0',
        window,
        availability: {
          ok: false,
          missing: availability.missing,
          valid: availability.summary?.valid ?? 0,
        },
        scenarios: [],
        error: 'DATA_NOT_READY',
      };
      console.log(JSON.stringify(report, null, 2));
      printSummary({ ...report, scenarios: [{ label: '-', skipped: true, reason: 'DATA_NOT_READY' }], host: {} });
      process.exit(2);
    }

    const estimatedTicks = availability.partitions
      ?.filter((p) => p.usable)
      .reduce((sum, p) => sum + (Number(p.rows) || 0), 0) ?? null;

    const source = getEdgeSniperV2GlsSource();
    const ast = parse(source);
    const baseRequest = buildRequest(ast, window, underlying, interval, bookDepth);

    const envBackup = {
      BACKTEST_ENGINE: process.env.BACKTEST_ENGINE,
      GLS_EXECUTION: process.env.GLS_EXECUTION,
      BACKTEST_WORKERS: process.env.BACKTEST_WORKERS,
    };

    async function withEnv(overrides, fn) {
      for (const key of Object.keys(envBackup)) {
        if (overrides[key] !== undefined) process.env[key] = String(overrides[key]);
        else if (envBackup[key] !== undefined) process.env[key] = envBackup[key];
      }
      return fn();
    }

    scenarios.push(await withEnv({ BACKTEST_ENGINE: 'rows', GLS_EXECUTION: 'compiled' }, () => runScenario(db, baseRequest, {
      label: 'rows-cold',
      cold: true,
      runs: 1,
    })));

    scenarios.push(await withEnv({ BACKTEST_ENGINE: 'rows', GLS_EXECUTION: 'compiled' }, () => runScenario(db, baseRequest, {
      label: 'rows-warm',
      cold: false,
      runs: 3,
    })));

    scenarios.push(await withEnv({ BACKTEST_ENGINE: 'soa', GLS_EXECUTION: 'compiled-soa' }, () => runScenario(db, {
      ...baseRequest,
      fastRun: false,
    }, {
      label: 'soa-cold',
      cold: true,
      runs: 1,
    })));

    scenarios.push(await withEnv({ BACKTEST_ENGINE: 'soa', GLS_EXECUTION: 'compiled-soa' }, () => runScenario(db, {
      ...baseRequest,
      fastRun: false,
    }, {
      label: 'soa-warm',
      cold: false,
      runs: 3,
    })));

    scenarios.push(await withEnv({ BACKTEST_ENGINE: 'soa', GLS_EXECUTION: 'compiled-soa' }, () => runScenario(db, {
      ...baseRequest,
      fastRun: true,
    }, {
      label: 'soa-fast-warm',
      cold: false,
      runs: 3,
    })));

    scenarios.push(await withEnv({ BACKTEST_ENGINE: 'soa', GLS_EXECUTION: 'compiled-soa', BACKTEST_WORKERS: '2' }, () => runScenario(db, {
      ...baseRequest,
      fastRun: false,
      backtestWorkers: 2,
    }, {
      label: 'soa-parallel-warm',
      cold: false,
      runs: 2,
    })));

    scenarios.push(await withEnv({
      BACKTEST_ENGINE: 'soa',
      GLS_EXECUTION: 'compiled-soa',
      BACKTEST_WORKERS: '1',
    }, () => runSweepScenario(
      db,
      { ...baseRequest, fastRun: true, backtestWorkers: 1 },
      sweepVariants,
      `sweep-${sweepVariants}-warm`,
    )));

    for (const key of Object.keys(envBackup)) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }

    const report = {
      at: new Date().toISOString(),
      phase: 'F0-v4',
      host: {
        node: process.version,
        platform: process.platform,
        cpus: os.cpus().length,
        duckdbThreads: process.env.DUCKDB_THREADS || '4 (default)',
      },
      window,
      request: { underlying, interval, bookDepth, sweepVariants },
      availability: {
        ok: true,
        validPartitions: availability.summary?.valid,
        estimatedTicks,
        files: availability.files?.length,
      },
      scenarios,
      speedups: computeSpeedups(scenarios),
    };

    console.log(JSON.stringify(report, null, 2));
    printSummary(report);

    if (flags.save) {
      const dir = path.resolve('reports/bench');
      mkdirSync(dir, { recursive: true });
      const stamp = report.at.replace(/[:.]/g, '-');
      const file = path.join(dir, `f0-v4-${window.label}-${stamp}.json`);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.error(`Saved: ${file}`);
    }
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
