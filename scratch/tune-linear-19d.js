import { readFileSync } from 'node:fs';
import { openStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { DuckDbTickProvider } from '../src/backtest/tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { computeMaxDrawdown } from '../src/backtest/equityMetrics.js';

function std(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

function linearityScore(equity) {
  const deltas = [];
  for (let i = 1; i < equity.length; i++) deltas.push(equity[i].pnl - equity[i - 1].pnl);
  const positive = deltas.filter((d) => d > 0).length;
  const upRatio = deltas.length ? positive / deltas.length : 0;
  const smoothness = deltas.length ? 100 / (1 + std(deltas)) : 0;
  return upRatio * 100 + smoothness;
}

async function loadRunner(db) {
  const strategyDef = getStrategyBySlug(db, 'cofre-sete-v1');
  const row = db.prepare(`SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1`).get(strategyDef.id);
  const version = { ...row, params_schema: JSON.parse(row.params_schema_json || '{}'), validation: JSON.parse(row.validation_json || '{}'), compiled: row.compiled_json ? JSON.parse(row.compiled_json) : null };
  const resolved = resolveVersionForBacktest(version, { bookDepth: 25, db });
  return loadStrategy({ glsAst: resolved.glsAst, columnAnalysis: resolved.columnAnalysis, runnerLibrary: resolved.runnerLibrary, extensionLibraries: resolved.extensionLibraries, generatedSource: resolved.generatedSource, embeddedModels: resolved.embeddedModels, strategySourceCode: resolved.strategySourceCode, db, bookDepth: 25 });
}

async function run(loaded, params, db, from, to) {
  const runner = loaded.createRunner(params, { fastRun: true, bookDepth: 25 });
  const provider = new DuckDbTickProvider(db, { underlying: 'BTC', interval: '5m', bookDepth: 25 });
  let count = 0;
  for await (const batch of provider.streamTicks({ from, to })) {
    for (const tick of batch) runner.processTick(tick);
    count += batch.length;
    if (count % 500000 === 0) console.log(`  ...${count} ticks`);
  }
  const result = applyPolymarketFeesToBacktestResult(runner.finish(), { enabled: true, category: 'crypto' });
  const dd = computeMaxDrawdown(result.equity);
  return {
    pnl: result.summary.totalPnl,
    dd,
    pf: result.summary.profitFactor,
    trades: result.summary.totalEntries,
    maxLoss: result.summary.maxLoss,
    winRate: result.summary.winRate,
    linearity: linearityScore(result.equity),
  };
}

async function main() {
  const from = '2026-06-01';
  const to = '2026-06-19';
  const db = openStateDatabase('./state/data-backtest.db', { readOnly: true });
  bindStrategyLibraryDatabase(db);
  const loaded = await loadRunner(db);
  const base = JSON.parse(readFileSync('./labs/strategies/carry/cofre-sete-v1/presets/btc-champion.json', 'utf8')).params;

  const variants = [
    ['champion', base],
    ['linear-v2', {
      ...base,
      riskBudgetPct: 0.34,
      maxWorstLossAbs: 30,
      kellyFraction: 0.13,
      maxKellyPct: 0.15,
      trailDrop: 0.09,
      takeProfitPct: 0.42,
      takeProfitBid: 0.89,
      lateExitSec: 9,
      eventWorstCaseStop: 16,
      lossStreakPause: 3,
      lossStreakCooldownEvents: 2,
      drawdownKellyThrottle: true,
      drawdownKellyFloor: 0.55,
      equityPeakThrottlePct: 0.1,
      directionalMinQualityScore: 0.48,
      maxDirectionalPerEvent: 5,
      hedgeEnabled: false,
      autoDeriskEnabled: false,
    }],
    ['linear-v2-tight', {
      ...base,
      minEdge: 0.09,
      minDirectionalProb: 0.62,
      riskBudgetPct: 0.32,
      maxWorstLossAbs: 26,
      kellyFraction: 0.12,
      maxKellyPct: 0.14,
      trailDrop: 0.08,
      takeProfitPct: 0.45,
      takeProfitBid: 0.88,
      lateExitSec: 10,
      eventWorstCaseStop: 14,
      lossStreakPause: 2,
      lossStreakCooldownEvents: 3,
      drawdownKellyThrottle: true,
      drawdownKellyFloor: 0.5,
      equityPeakThrottlePct: 0.08,
      directionalMinQualityScore: 0.52,
      maxDirectionalPerEvent: 4,
      maxVolForDirectional: 22,
      hedgeEnabled: false,
      autoDeriskEnabled: false,
    }],
  ];

  console.log(`Tuning 19d (${from} a ${to})`);
  console.log('Variante          | PnL      | DD     | PF   | Trades | MaxLoss | Linear');
  for (const [name, params] of variants) {
    console.log(`Rodando ${name}...`);
    const r = await run(loaded, params, db, from, to);
    console.log(`${name.padEnd(17)} | $${r.pnl.toFixed(2).padStart(7)} | $${r.dd.toFixed(2).padStart(5)} | ${r.pf.toFixed(2).padStart(4)} | ${String(r.trades).padStart(6)} | $${r.maxLoss.toFixed(2).padStart(6)} | ${r.linearity.toFixed(1)}`);
  }
}

main().catch(console.error);