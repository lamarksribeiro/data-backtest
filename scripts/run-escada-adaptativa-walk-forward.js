#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runLabExperiment } from '../labs/shared/labRunner.js';

const STRATEGY_ID = 'escada-adaptativa-hibrida-v1';
const STRATEGY_FAMILY = 'carry';
const STRATEGY_ROOT = path.resolve('labs/strategies', STRATEGY_FAMILY, STRATEGY_ID);
const DEFAULTS_PATH = path.join(STRATEGY_ROOT, 'defaults.json');
const GRID_PATH = path.join(STRATEGY_ROOT, 'search-spaces', 'walk-forward-grid.json');
const RISK_LIMIT_USD = 2.5;

export const WALK_FORWARD_FOLDS = Object.freeze([
  { id: 'f01', trainFrom: '2026-04-23', trainTo: '2026-05-13', validateFrom: '2026-05-14', validateTo: '2026-05-20' },
  { id: 'f02', trainFrom: '2026-04-30', trainTo: '2026-05-20', validateFrom: '2026-05-21', validateTo: '2026-05-27' },
  { id: 'f03', trainFrom: '2026-05-07', trainTo: '2026-05-27', validateFrom: '2026-05-28', validateTo: '2026-06-03' },
  { id: 'f04', trainFrom: '2026-05-14', trainTo: '2026-06-03', validateFrom: '2026-06-04', validateTo: '2026-06-10' },
  { id: 'f05', trainFrom: '2026-05-21', trainTo: '2026-06-10', validateFrom: '2026-06-11', validateTo: '2026-06-17' },
  { id: 'f06', trainFrom: '2026-05-28', trainTo: '2026-06-17', validateFrom: '2026-06-18', validateTo: '2026-06-24' },
  { id: 'f07', trainFrom: '2026-06-04', trainTo: '2026-06-24', validateFrom: '2026-06-25', validateTo: '2026-07-01' },
  { id: 'f08', trainFrom: '2026-06-11', trainTo: '2026-07-01', validateFrom: '2026-07-02', validateTo: '2026-07-08' },
  { id: 'f09', trainFrom: '2026-06-18', trainTo: '2026-07-08', validateFrom: '2026-07-09', validateTo: '2026-07-15' },
  { id: 'f10', trainFrom: '2026-06-25', trainTo: '2026-07-15', validateFrom: '2026-07-16', validateTo: '2026-07-22' }
]);

function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dailyValues(summary = {}) {
  const series = summary.daily?.series || [];
  return series.map((day) => Number(day.pnl || 0));
}

export function selectTrainingVariant(variants, riskLimitUsd = RISK_LIMIT_USD) {
  const candidates = (variants || [])
    .filter((variant) => Number(variant.summary?.maxObservedWorstLoss || 0) <= riskLimitUsd + 1e-9)
    .map((variant) => {
      const summary = variant.summary || {};
      const days = Number(summary.daily?.days || dailyValues(summary).length || 1);
      const entries = Number(summary.entries ?? summary.totalEntries ?? 0);
      return {
        ...variant,
        selection: {
          medianDailyPnl: median(dailyValues(summary)),
          pnlPerRiskUnit: Number(summary.totalPnl || 0) / riskLimitUsd,
          entriesPerDay: entries / days,
          maxDrawdown: Number(summary.maxDrawdown || 0),
        },
      };
    });
  candidates.sort((left, right) => {
    if (right.selection.medianDailyPnl !== left.selection.medianDailyPnl) {
      return right.selection.medianDailyPnl - left.selection.medianDailyPnl;
    }
    if (right.selection.pnlPerRiskUnit !== left.selection.pnlPerRiskUnit) {
      return right.selection.pnlPerRiskUnit - left.selection.pnlPerRiskUnit;
    }
    return left.selection.maxDrawdown - right.selection.maxDrawdown;
  });
  return candidates[0] || null;
}

function makeExperiment({ name, from, to, searchSpace }) {
  return {
    name,
    strategyId: STRATEGY_ID,
    strategyFamily: STRATEGY_FAMILY,
    description: 'Walk-forward temporal pre-registrado; treino e validacao nunca se sobrepoem.',
    dataset: 'backtest_ticks',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    from,
    to,
    engine: 'soa',
    glsExecution: 'compiled-soa',
    fastRun: true,
    dailyMetrics: true,
    variantWorkers: 4,
    maxVariants: 400,
    defaults: DEFAULTS_PATH,
    feeOptions: { category: 'crypto' },
    searchSpace,
  };
}

async function runTemporaryExperiment(experiment, reportRoot) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'eah-walk-forward-'));
  const experimentPath = path.join(tempDir, 'experiment.json');
  writeFileSync(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`, 'utf8');
  try {
    const result = await runLabExperiment(experimentPath, {
      maxVariants: experiment.maxVariants,
      variantWorkers: experiment.variantWorkers,
      reportRoot,
      top: 25,
    });
    if (!result.ok) {
      throw new Error(`${experiment.name}: ${result.error || 'lab failed'}`);
    }
    return result;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function validationGate(summary = {}, { stress = false } = {}) {
  const days = Number(summary.daily?.days || 0);
  const entries = Number(summary.entries ?? summary.totalEntries ?? 0);
  const frequency = days > 0 ? entries / days : 0;
  return {
    risk: Number(summary.maxObservedWorstLoss || 0) <= RISK_LIMIT_USD + 1e-9,
    frequency: frequency >= 5 && frequency <= 15,
    profitFactor: Number(summary.profitFactor || 0) >= (stress ? 1 : 1.2),
    pnl: Number(summary.totalPnl || 0) > 0,
    frequencyPerDay: frequency,
  };
}

function renderSummary(report) {
  const lines = [
    '# Escada Adaptativa Híbrida V1 — Walk-forward',
    '',
    `- Gerado em: ${report.generatedAt}`,
    `- Folds: ${report.folds.length}`,
    `- Folds base positivos: ${report.aggregate.positiveBaseFolds}/${report.folds.length}`,
    `- Folds stress positivos: ${report.aggregate.positiveStressFolds}/${report.folds.length}`,
    `- Mediana PnL base: ${report.aggregate.medianBasePnl.toFixed(5)}`,
    `- Mediana PnL stress: ${report.aggregate.medianStressPnl.toFixed(5)}`,
    `- Gate histórico: ${report.aggregate.historicalGate ? 'PASS' : 'FAIL'}`,
    '',
    '| Fold | Variante | PnL base | PF base | Freq/dia | PnL stress | PF stress | Risco max |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const fold of report.folds) {
    lines.push(
      `| ${fold.id} | ${fold.variantId} | ${Number(fold.base.totalPnl || 0).toFixed(5)} | `
      + `${Number(fold.base.profitFactor || 0).toFixed(4)} | ${fold.baseGate.frequencyPerDay.toFixed(2)} | `
      + `${Number(fold.stress.totalPnl || 0).toFixed(5)} | ${Number(fold.stress.profitFactor || 0).toFixed(4)} | `
      + `${Math.max(Number(fold.base.maxObservedWorstLoss || 0), Number(fold.stress.maxObservedWorstLoss || 0)).toFixed(4)} |`,
    );
  }
  lines.push(
    '',
    'Este relatório histórico não é holdout puro. Mesmo com PASS, ainda são obrigatórios 30 dias futuros de shadow.',
  );
  return `${lines.join('\n')}\n`;
}

export async function runWalkForward({ reportRoot = 'reports/labs' } = {}) {
  const grid = JSON.parse(readFileSync(GRID_PATH, 'utf8'));
  const runRoot = path.resolve(
    reportRoot,
    STRATEGY_ID,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-walk-forward-protocol`,
  );
  mkdirSync(runRoot, { recursive: true });
  const folds = [];

  for (const fold of WALK_FORWARD_FOLDS) {
    const train = await runTemporaryExperiment(
      makeExperiment({
        name: `eah-${fold.id}-train`,
        from: fold.trainFrom,
        to: fold.trainTo,
        searchSpace: grid,
      }),
      path.join(runRoot, 'train'),
    );
    const selected = selectTrainingVariant(train.results?.variants);
    if (!selected) throw new Error(`${fold.id}: nenhuma variante respeitou o limite de risco`);

    const singleVariant = {
      variants: [{ id: selected.id, params: selected.params }],
    };
    const base = await runTemporaryExperiment(
      makeExperiment({
        name: `eah-${fold.id}-validate-base`,
        from: fold.validateFrom,
        to: fold.validateTo,
        searchSpace: singleVariant,
      }),
      path.join(runRoot, 'validate-base'),
    );
    const stressParams = {
      ...selected.params,
      makerFillMode: 'adverse_entry_touch',
      cancelLatencyTicks: 2,
      takerLatencyTicks: 2,
    };
    const stress = await runTemporaryExperiment(
      makeExperiment({
        name: `eah-${fold.id}-validate-stress`,
        from: fold.validateFrom,
        to: fold.validateTo,
        searchSpace: { variants: [{ id: `${selected.id}-stress`, params: stressParams }] },
      }),
      path.join(runRoot, 'validate-stress'),
    );
    const baseSummary = base.results?.variants?.[0]?.summary || {};
    const stressSummary = stress.results?.variants?.[0]?.summary || {};
    folds.push({
      ...fold,
      variantId: selected.id,
      params: selected.params,
      trainingSelection: selected.selection,
      base: baseSummary,
      stress: stressSummary,
      baseGate: validationGate(baseSummary),
      stressGate: validationGate(stressSummary, { stress: true }),
    });
  }

  const positiveBaseFolds = folds.filter((fold) => Number(fold.base.totalPnl || 0) > 0).length;
  const positiveStressFolds = folds.filter((fold) => Number(fold.stress.totalPnl || 0) > 0).length;
  const allRiskSafe = folds.every((fold) => fold.baseGate.risk && fold.stressGate.risk);
  const baseGrossProfit = folds.reduce((sum, fold) => sum + Number(fold.base.grossProfit || 0), 0);
  const baseGrossLoss = folds.reduce((sum, fold) => sum + Number(fold.base.grossLoss || 0), 0);
  const stressGrossProfit = folds.reduce((sum, fold) => sum + Number(fold.stress.grossProfit || 0), 0);
  const stressGrossLoss = folds.reduce((sum, fold) => sum + Number(fold.stress.grossLoss || 0), 0);
  const aggregateBaseProfitFactor = baseGrossLoss > 0 ? baseGrossProfit / baseGrossLoss : 0;
  const aggregateStressProfitFactor = stressGrossLoss > 0 ? stressGrossProfit / stressGrossLoss : 0;
  const maxFoldDrawdown = folds.reduce(
    (max, fold) => Math.max(max, Number(fold.base.maxDrawdown || 0), Number(fold.stress.maxDrawdown || 0)),
    0,
  );
  const aggregate = {
    positiveBaseFolds,
    positiveStressFolds,
    medianBasePnl: median(folds.map((fold) => fold.base.totalPnl)),
    medianStressPnl: median(folds.map((fold) => fold.stress.totalPnl)),
    aggregateBaseProfitFactor,
    aggregateStressProfitFactor,
    maxFoldDrawdown,
    allRiskSafe,
    historicalGate: allRiskSafe
      && positiveBaseFolds >= Math.ceil(folds.length * 0.7)
      && positiveStressFolds >= Math.ceil(folds.length * 0.5)
      && aggregateBaseProfitFactor >= 1.2
      && aggregateStressProfitFactor >= 1
      && maxFoldDrawdown < 50
      && folds.every((fold) => fold.baseGate.frequency),
  };
  const report = {
    strategyId: STRATEGY_ID,
    generatedAt: new Date().toISOString(),
    protocol: {
      trainingDays: 21,
      validationDays: 7,
      riskLimitUsd: RISK_LIMIT_USD,
      selection: 'medianDailyPnl, then pnlPerRiskUnit, then lower maxDrawdown',
      historicalDataContaminated: true,
    },
    folds,
    aggregate,
  };
  writeFileSync(path.join(runRoot, 'walk-forward.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(runRoot, 'summary.md'), renderSummary(report), 'utf8');
  return { ok: true, reportDir: runRoot, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runWalkForward()
    .then((result) => {
      process.stdout.write(`${JSON.stringify({
        ok: result.ok,
        reportDir: result.reportDir,
        historicalGate: result.report.aggregate.historicalGate,
      }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
