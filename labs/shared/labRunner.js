import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { parse } from '../../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../../src/backtestStudio/gls/compiler.js';
import { compileStrategyJs } from '../../src/backtestStudio/strategyJs/compile.js';
import { glsToStrategyJs } from '../../src/backtestStudio/strategyJs/glsToStrategyJs.js';
import { composeGammaLadderStrategyJs } from '../../src/backtestStudio/strategyJs/composeGammaLadder.js';
import { EMBEDDED_RUNNER_COLUMN_ANALYSIS } from '../../src/backtestStudio/strategyJs/embeddedRunnerAdapter.js';
import { checkDatasetAvailability } from '../../src/query/availability.js';
import { runBacktestSweep } from '../../src/backtest/sweep.js';
import { expandParamGrid, countParamGridVariants } from './paramGrid.js';
import { runParallelVariantSweep } from './parallelVariantSweep.js';
import { createLabReportDir, gitMetadata, writeLabReport } from './reportWriter.js';
import { loadPreset } from './presets.js';

export async function runLabPreset(presetId, options = {}) {
  const { preset, strategyRoot, params } = loadPreset(presetId, {
    strategyFamily: options.strategyFamily || 'edge',
    strategyId: options.strategyId || 'edge-sniper-v3',
  });
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lab-preset-'));
  const experimentFile = path.join(tempDir, 'experiment.json');
  const searchSpaceFile = path.join(tempDir, 'search-space.json');
  writeFileSync(searchSpaceFile, `${JSON.stringify({
    variants: [{ id: preset.id, params }],
  }, null, 2)}\n`, 'utf8');
  const experiment = {
    name: `preset-${preset.id}`,
    strategyId: options.strategyId || 'edge-sniper-v3',
    strategyFamily: options.strategyFamily || 'edge',
    dataset: options.dataset || 'backtest_ticks',
    underlying: options.underlying || 'BTC',
    interval: options.interval || '5m',
    bookDepth: Number(options.bookDepth || preset.bookDepth || 25),
    from: options.from || preset.window?.from || '2026-04-23',
    to: options.to || preset.window?.to || '2026-05-30',
    engine: options.engine || 'soa',
    glsExecution: options.glsExecution || 'compiled-soa',
    fastRun: options.fastRun !== false,
    variantWorkers: 1,
    dailyMetrics: options.dailyMetrics === true,
    defaults: path.join(strategyRoot, 'defaults.json'),
    searchSpace: searchSpaceFile,
  };
  writeFileSync(experimentFile, `${JSON.stringify(experiment, null, 2)}\n`, 'utf8');
  try {
    return await runLabExperiment(experimentFile, {
      ...options,
      maxVariants: 1,
      variantWorkers: Number(options.variantWorkers || 1),
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runLabExperiment(experimentPath, options = {}) {
  const absoluteExperimentPath = path.resolve(experimentPath);
  const experimentDir = path.dirname(absoluteExperimentPath);
  const experiment = readJson(absoluteExperimentPath);
  const config = loadConfig();
  const strategyRoot = path.resolve('labs/strategies', experiment.strategyFamily, experiment.strategyId);
  const strategy = readJson(path.join(strategyRoot, 'strategy.json'));
  const defaults = readOptionalJson(resolveReference(experiment.defaults || 'defaults.json', experimentDir, strategyRoot)) || {};
  const searchSpace = experiment.searchSpace && typeof experiment.searchSpace === 'object'
    ? experiment.searchSpace
    : (readOptionalJson(resolveReference(experiment.searchSpace, experimentDir, strategyRoot)) || { grid: {} });
  const totalVariantCount = countParamGridVariants(searchSpace);
  const maxVariants = Math.max(Number(options.maxVariants || experiment.maxVariants || config.sweepMaxVariants), 1);
  const variants = expandParamGrid(searchSpace, { maxVariants });
  const sourcePath = resolveSourcePath(strategy.source, strategyRoot);
  const sourceCode = readFileSync(sourcePath, 'utf8');
  const glsAst = parse(sourceCode);
  const bookDepth = experiment.bookDepth ?? strategy.defaultBookDepth ?? config.backtestBookDepth;
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  const gammaLadder = isGammaLadderAst(glsAst);
  let embeddedRunner = false;
  let strategySourceCode = null;
  let columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth ?? config.backtestBookDepth);
  if (gammaLadder) {
    columnAnalysis = EMBEDDED_RUNNER_COLUMN_ANALYSIS;
    if (String(glsAst.name || '').toLowerCase().includes('v2')) {
      const enginePath = path.resolve('data/strategy-libraries/gamma-ladder-engine.v2.json');
      strategySourceCode = composeGammaLadderStrategyJs(sourceCode, { enginePath });
    } else {
      strategySourceCode = composeGammaLadderStrategyJs(sourceCode);
    }
    const compiled = compileStrategyJs(strategySourceCode, { db });
    if (!compiled.ok) {
      throw new Error(compiled.errors?.[0]?.message || 'Gamma Ladder Strategy JS compilation failed');
    }
    embeddedRunner = true;
  }
  const request = buildBacktestRequest({
    experiment, strategy, defaults, glsAst, columnAnalysis, bookDepth, options, db, embeddedRunner, strategySourceCode,
  });
  const availabilityRequest = {
    ...request,
    dataset: experiment.dataset,
    autoAcceptReviewPartitions: false,
  };
  const startedAt = performance.now();
  const envBackup = {
    BACKTEST_ENGINE: process.env.BACKTEST_ENGINE,
    GLS_EXECUTION: process.env.GLS_EXECUTION,
    BACKTEST_WORKERS: process.env.BACKTEST_WORKERS,
  };

  try {
    process.env.BACKTEST_ENGINE = experiment.engine || 'soa';
    process.env.GLS_EXECUTION = experiment.glsExecution || 'compiled-soa';
    if (options.workers || experiment.backtestWorkers) {
      process.env.BACKTEST_WORKERS = String(options.workers || experiment.backtestWorkers);
    }

    const availability = checkDatasetAvailability(db, availabilityRequest);
    const metadata = buildMetadata({
      experiment,
      strategy,
      sourcePath,
      variants,
      totalVariantCount,
      availability,
      startedAt,
      options,
    });

    if (!availability.ok) {
      return {
        ok: false,
        error: 'DATA_NOT_READY',
        availability,
        metadata,
      };
    }

    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        variants,
        metadata,
      };
    }

    const variantWorkers = Math.max(Number(options.variantWorkers || experiment.variantWorkers || 1) || 1, 1);
    const chunkDays = resolveChunkDays(experiment, options);
    const sweep = chunkDays > 0
      ? await runChunkedSweep(db, request, variants, {
        chunkDays,
        variantWorkers,
        maxVariants,
        onProgress: options.onProgress,
      })
      : await runSingleSweep(db, request, variants, { variantWorkers, maxVariants, onProgress: options.onProgress });
    const ranked = rankSweepResults(sweep.variants);
    const reportDir = createLabReportDir({
      strategyId: strategy.id,
      experimentName: experiment.name,
      root: options.reportRoot,
    });
    const report = {
      experiment,
      results: sweep,
      topResults: ranked.slice(0, Number(options.top || 25)),
      metadata: {
        ...metadata,
        reportDir,
        elapsedWallMs: Math.round(performance.now() - startedAt),
      },
    };
    writeLabReport(reportDir, report);

    return {
      ok: true,
      reportDir,
      sweep,
      topResults: report.topResults,
      metadata: report.metadata,
    };
  } finally {
    restoreEnv(envBackup);
    closeStateDatabase(db);
  }
}

async function runSingleSweep(db, request, variants, { variantWorkers, maxVariants, onProgress }) {
  return variantWorkers > 1
    ? runParallelVariantSweep(db, request, variants, { variantWorkers, onProgress })
    : runBacktestSweep(db, request, variants, { maxVariants, onProgress });
}

async function runChunkedSweep(db, request, variants, { chunkDays, variantWorkers, maxVariants, onProgress }) {
  const chunks = buildDateChunks(request.from, request.to, chunkDays);
  const aggregate = new Map();
  const chunkReports = [];
  const timings = { duckdbReadMs: 0, shareMs: 0, sweepProcessMs: 0, totalMs: 0, chunks: chunks.length, variantWorkers };
  let totalTicks = 0;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const chunkRequest = { ...request, from: chunk.from, to: chunk.to };
    const sweep = await runSingleSweep(db, chunkRequest, variants, {
      variantWorkers,
      maxVariants,
      onProgress: (progress) => {
        onProgress?.({
          ...progress,
          chunkIndex,
          chunkCount: chunks.length,
          variantIndex: chunkIndex * variants.length + (progress.variantIndex || 0),
          variantCount: chunks.length * variants.length,
        });
      },
    });

    totalTicks += Number(sweep.ticks || 0);
    timings.duckdbReadMs += Number(sweep.timings?.duckdbReadMs || 0);
    timings.shareMs += Number(sweep.timings?.shareMs || 0);
    timings.sweepProcessMs += Number(sweep.timings?.sweepProcessMs || 0);
    timings.totalMs += Number(sweep.timings?.totalMs || 0);
    chunkReports.push({
      index: chunkIndex,
      from: chunk.from,
      to: chunk.to,
      ticks: sweep.ticks,
      variantCount: sweep.variantCount,
      timings: sweep.timings,
    });

    for (const variant of sweep.variants || []) {
      const current = aggregate.get(variant.id) || {
        id: variant.id,
        params: variant.params,
        summary: emptyAggregateSummary(),
        ticks: 0,
        variantMs: 0,
        daily: [],
      };
      mergeVariantSummary(current, variant, chunk);
      aggregate.set(variant.id, current);
    }
  }

  const aggregateVariants = [...aggregate.values()].map(finalizeAggregateVariant);
  return {
    strategy: request.strategyLabel || request.strategy,
    source: 'lakehouse',
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    ticks: totalTicks,
    variantCount: aggregateVariants.length,
    variants: aggregateVariants,
    timings: {
      ...timings,
      avgVariantMs: aggregateVariants.length ? Math.round(timings.sweepProcessMs / aggregateVariants.length) : null,
    },
    chunks: chunkReports,
    strategyMeta: request.strategyMeta || null,
  };
}

function buildDateChunks(from, to, chunkDays) {
  const chunks = [];
  const stepDays = Math.max(Number(chunkDays) || 1, 1);
  let cursor = new Date(from);
  const end = new Date(to);
  while (cursor < end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + stepDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ from: chunkStart.toISOString(), to: chunkEnd.toISOString() });
    cursor = chunkEnd;
  }
  return chunks;
}

function emptyAggregateSummary() {
  return {
    totalEvents: 0,
    totalNoEntry: 0,
    eventsWithEntries: 0,
    totalEntries: 0,
    entries: 0,
    wins: 0,
    losses: 0,
    totalWins: 0,
    totalLosses: 0,
    totalPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    maxDrawdown: 0,
    volume: 0,
    ticksProcessed: 0,
    totalFees: 0,
    feesPaid: 0,
  };
}

function mergeVariantSummary(target, variant, chunk = null) {
  const summary = variant.summary || {};
  target.ticks += Number(variant.ticks || 0);
  target.variantMs += Number(variant.variantMs || 0);
  target.summary.totalEvents += Number(summary.totalEvents || 0);
  target.summary.totalNoEntry += Number(summary.totalNoEntry || 0);
  target.summary.eventsWithEntries += Number(summary.eventsWithEntries || 0);
  target.summary.totalEntries += Number(summary.totalEntries ?? summary.entries ?? 0);
  target.summary.entries = target.summary.totalEntries;
  target.summary.wins += Number(summary.wins ?? summary.totalWins ?? 0);
  target.summary.losses += Number(summary.losses ?? summary.totalLosses ?? 0);
  target.summary.totalWins = target.summary.wins;
  target.summary.totalLosses = target.summary.losses;
  target.summary.totalPnl += Number(summary.totalPnl || 0);
  target.summary.grossProfit += Number(summary.grossProfit || 0);
  target.summary.grossLoss += Number(summary.grossLoss || 0);
  target.summary.maxDrawdown = Math.max(target.summary.maxDrawdown, Number(summary.maxDrawdown || 0));
  target.summary.volume += Number(summary.volume || 0);
  target.summary.ticksProcessed += Number(summary.ticksProcessed || 0);
  target.summary.totalFees += Number(summary.totalFees || summary.feesPaid || 0);
  target.summary.feesPaid = target.summary.totalFees;
  if (chunk) {
    target.daily.push({
      dt: chunk.from.slice(0, 10),
      from: chunk.from,
      to: chunk.to,
      ticks: Number(variant.ticks || 0),
      variantMs: Number(variant.variantMs || 0),
      totalEvents: Number(summary.totalEvents || 0),
      entries: Number(summary.entries ?? summary.totalEntries ?? 0),
      wins: Number(summary.wins ?? summary.totalWins ?? 0),
      losses: Number(summary.losses ?? summary.totalLosses ?? 0),
      winRate: Number(summary.winRate || 0),
      totalPnl: Number(summary.totalPnl || 0),
      profitFactor: Number(summary.profitFactor || 0),
      maxDrawdown: Number(summary.maxDrawdown || 0),
      feesPaid: Number(summary.totalFees || summary.feesPaid || 0),
    });
  }
}

function finalizeAggregateVariant(variant) {
  const summary = variant.summary;
  summary.winRate = summary.totalEntries ? (summary.wins / summary.totalEntries) * 100 : 0;
  summary.avgPnl = summary.eventsWithEntries ? summary.totalPnl / summary.eventsWithEntries : 0;
  summary.profitFactor = summary.grossLoss > 0 ? summary.grossProfit / summary.grossLoss : summary.grossProfit > 0 ? 999 : 0;
  summary.pnl = summary.totalPnl;
  summary.feeDrag = summary.totalPnl + summary.totalFees !== 0
    ? summary.totalFees / Math.abs(summary.totalPnl + summary.totalFees)
    : 0;
  summary.daily = summarizeDaily(variant.daily || []);
  return variant;
}

function summarizeDaily(days) {
  const pnls = days.map((day) => Number(day.totalPnl || 0));
  const profitableDays = pnls.filter((pnl) => pnl > 0).length;
  const losingDays = pnls.filter((pnl) => pnl < 0).length;
  const flatDays = pnls.length - profitableDays - losingDays;
  const sorted = [...pnls].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  let cumulative = 0;
  const series = days.map((day) => {
    const pnl = Number(day.totalPnl || 0);
    cumulative += pnl;
    return { dt: day.dt, pnl, cumulativePnl: cumulative };
  });
  return {
    days: days.length,
    profitableDays,
    losingDays,
    flatDays,
    positiveDayRate: days.length ? (profitableDays / days.length) * 100 : 0,
    worstDayPnl: sorted.length ? sorted[0] : 0,
    bestDayPnl: sorted.length ? sorted[sorted.length - 1] : 0,
    avgDailyPnl: days.length ? pnls.reduce((sum, pnl) => sum + pnl, 0) / days.length : 0,
    medianDailyPnl: median,
    maxDailyDrawdown: days.reduce((max, day) => Math.max(max, Number(day.maxDrawdown || 0)), 0),
    series,
  };
}

function buildBacktestRequest({
  experiment, strategy, defaults, glsAst, columnAnalysis, bookDepth, options, db = null,
  embeddedRunner = false, strategySourceCode = null,
}) {
  const executionKind = embeddedRunner ? 'embedded-runner' : (experiment.glsExecution || 'compiled-soa');
  return {
    from: parseDateStart(experiment.from).toISOString(),
    to: parseDateEnd(experiment.to).toISOString(),
    underlying: String(experiment.underlying || 'BTC').toUpperCase(),
    interval: String(experiment.interval || '5m'),
    dataset: experiment.dataset,
    autoAcceptReviewPartitions: false,
    bookDepth,
    batchSize: Number(experiment.batchSize || 25_000),
    strategy: `gls:${strategy.id}`,
    strategyLabel: strategy.name,
    glsAst,
    columnAnalysis,
    params: defaults,
    fastRun: experiment.fastRun !== false,
    glsExecution: executionKind,
    backtestWorkers: Number(options.workers || experiment.backtestWorkers || process.env.BACKTEST_WORKERS || 1),
    feeOptions: experiment.feeOptions || undefined,
    db,
    embeddedRunner,
    strategySourceCode,
    strategyMeta: {
      lab: true,
      id: strategy.id,
      family: strategy.family,
      source: strategy.source,
      execution_kind: executionKind,
    },
  };
}

function isGammaLadderAst(ast) {
  return String(ast?.name || '').toLowerCase().includes('gamma ladder');
}

export function resolveChunkDays(experiment, options = {}) {
  const explicit = Number(experiment.chunkDays ?? options.chunkDays ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (experiment.dailyMetrics === true) return 1;
  return 0;
}

function buildMetadata({ experiment, strategy, sourcePath, variants, totalVariantCount, availability, startedAt, options }) {
  const usablePartitions = availability.partitions?.filter((partition) => partition.usable) || [];
  const chunkDays = resolveChunkDays(experiment, options);
  return {
    generatedAt: new Date().toISOString(),
    experimentName: experiment.name,
    strategyId: strategy.id,
    strategyStatus: strategy.status,
    sourcePath: path.relative(process.cwd(), sourcePath),
    dataset: experiment.dataset,
    window: {
      from: parseDateStart(experiment.from).toISOString(),
      to: parseDateEnd(experiment.to).toISOString(),
    },
    sweepMode: chunkDays > 0 ? `chunked-${chunkDays}d` : 'single-pass',
    chunkDays: chunkDays > 0 ? chunkDays : null,
    dailyMetrics: chunkDays > 0,
    engine: experiment.engine || 'soa',
    glsExecution: experiment.glsExecution || 'compiled-soa',
    fastRun: experiment.fastRun !== false,
    workers: Number(options.workers || experiment.backtestWorkers || process.env.BACKTEST_WORKERS || 1),
    variantWorkers: Number(options.variantWorkers || experiment.variantWorkers || 1),
    totalVariantCount,
    variantCount: variants.length,
    truncated: variants.length < totalVariantCount,
    availability: {
      ok: availability.ok,
      validPartitions: availability.summary?.valid ?? null,
      estimatedTicks: usablePartitions.reduce((sum, partition) => sum + (Number(partition.rows) || 0), 0),
      files: availability.files?.length ?? null,
      missing: availability.missing,
      unavailable: availability.unavailable,
    },
    git: gitMetadata(),
    startedMonotonicMs: Math.round(startedAt),
  };
}

export function rankSweepResults(variants) {
  return (variants || [])
    .map((variant) => ({
      ...variant,
      score: scoreVariant(variant.summary),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if ((right.summary?.totalPnl ?? 0) !== (left.summary?.totalPnl ?? 0)) {
        return (right.summary?.totalPnl ?? 0) - (left.summary?.totalPnl ?? 0);
      }
      if ((right.summary?.profitFactor ?? 0) !== (left.summary?.profitFactor ?? 0)) {
        return (right.summary?.profitFactor ?? 0) - (left.summary?.profitFactor ?? 0);
      }
      return (right.summary?.entries ?? 0) - (left.summary?.entries ?? 0);
    })
    .map((variant, index) => ({ ...variant, rank: index + 1 }));
}

function scoreVariant(summary = {}) {
  const pnl = Number(summary.totalPnl || 0);
  const entries = Number(summary.entries ?? summary.totalEntries ?? 0);
  const profitFactor = finiteCap(summary.profitFactor, 10);
  const drawdown = Number(summary.maxDrawdown || 0);
  const winRate = Number(summary.winRate || 0) / 100;
  const activityPenalty = entries > 0 ? 0 : 1000;
  return pnl + profitFactor * 2 + winRate - drawdown * 0.25 - activityPenalty;
}

function finiteCap(value, cap) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(number, cap);
}

function resolveSourcePath(source, strategyRoot) {
  const sourcePath = source?.path || source?.glsPath;
  if (!sourcePath) throw new Error('strategy.source.path or strategy.source.glsPath is required');
  const fromRoot = path.resolve(sourcePath);
  if (fromRoot.startsWith(process.cwd())) return fromRoot;
  return path.resolve(strategyRoot, sourcePath);
}

function resolveReference(reference, experimentDir, strategyRoot) {
  if (!reference) return null;
  const fromExperiment = path.resolve(experimentDir, reference);
  if (existsLike(fromExperiment)) return fromExperiment;
  return path.resolve(strategyRoot, reference);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readOptionalJson(file) {
  if (!file || !existsLike(file)) return null;
  return readJson(file);
}

function existsLike(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function parseDateStart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function parseDateEnd(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function restoreEnv(envBackup) {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}
