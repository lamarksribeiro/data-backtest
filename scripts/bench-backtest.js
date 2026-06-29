#!/usr/bin/env node
/**
 * Benchmark padrão do backtest V2.
 * Uso: npm run bench:backtest -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--save]
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { parse } from '../src/backtestStudio/gls/parser.js';
import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { checkDatasetAvailability } from '../src/query/availability.js';

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

function defaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 7);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const defaults = defaultRange();
  const from = parseDateStart(flags.from || defaults.from).toISOString();
  const to = parseDateEnd(flags.to || defaults.to).toISOString();
  const underlying = String(flags.underlying || 'BTC').toUpperCase();
  const interval = String(flags.interval || '5m');
  const bookDepth = Number.parseInt(String(flags['book-depth'] || flags.bookDepth || '10'), 10) || 10;
  const batchSize = Number.parseInt(String(flags['batch-size'] || '25000'), 10) || 25000;
  const runs = Math.max(Number.parseInt(String(flags.runs || '1'), 10) || 1, 1);

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const availability = checkDatasetAvailability(db, {
      dataset: 'backtest_ticks',
      from,
      to,
      underlying,
      interval,
      bookDepth,
    });
    if (!availability.ok) {
      console.error(JSON.stringify({
        error: 'DATA_NOT_READY',
        missing: availability.missing,
        unavailable: availability.unavailable,
      }, null, 2));
      process.exit(2);
    }

    const source = getEdgeSniperV2GlsSource();
    const ast = parse(source);
    const request = {
      from,
      to,
      underlying,
      interval,
      bookDepth,
      batchSize,
      strategy: 'gls:edge-snipper',
      strategyLabel: ast.name,
      glsAst: ast,
      params: {},
    };

    const memBefore = process.memoryUsage();
    const wallStart = performance.now();
    let lastResult = null;

    for (let i = 0; i < runs; i += 1) {
      lastResult = await runBacktest(db, request);
    }

    const wallMs = performance.now() - wallStart;
    const memAfter = process.memoryUsage();
    const timings = lastResult.timings || {};

    const report = {
      at: new Date().toISOString(),
      glsExecution: config.glsExecution,
      backtestEngine: config.backtestEngine,
      request: { from, to, underlying, interval, bookDepth, batchSize, runs },
      ticks: lastResult.ticks,
      batches: lastResult.batches,
      timings: {
        duckdbReadMs: timings.duckdbReadMs,
        processMs: timings.processMs,
        finishMs: timings.finishMs,
        totalMs: timings.totalMs,
        wallMs: Math.round(wallMs),
        ticksPerSec: timings.totalMs ? Math.round((lastResult.ticks / timings.totalMs) * 1000) : null,
      },
      memory: {
        rssMb: Math.round(memAfter.rss / 1024 / 1024),
        heapUsedMb: Math.round(memAfter.heapUsed / 1024 / 1024),
        rssDeltaMb: Math.round((memAfter.rss - memBefore.rss) / 1024 / 1024),
      },
      summary: {
        totalEvents: lastResult.summary?.totalEvents,
        totalPnl: lastResult.summary?.totalPnl,
      },
    };

    console.log(JSON.stringify(report, null, 2));

    if (flags.save) {
      const dir = path.resolve('reports/bench');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `bench-${report.at.replace(/[:.]/g, '-')}.json`);
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
