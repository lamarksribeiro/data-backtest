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
  return (deltas.length ? (positive / deltas.length) * 100 : 0) + (deltas.length ? 100 / (1 + std(deltas)) : 0);
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
  for await (const batch of provider.streamTicks({ from, to })) {
    for (const tick of batch) runner.processTick(tick);
  }
  const result = applyPolymarketFeesToBacktestResult(runner.finish(), { enabled: true, category: 'crypto' });
  return {
    pnl: result.summary.totalPnl,
    dd: computeMaxDrawdown(result.equity),
    pf: result.summary.profitFactor,
    trades: result.summary.totalEntries,
    boxEntries: result.summary.boxEntries,
    dirEntries: result.summary.directionalEntries,
    maxLoss: result.summary.maxLoss,
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
    ['vault+', { ...base, boxMinProfit: 0.006, boxMaxSumAsk: 0.993, boxMaxPairValue: 18 }],
    ['dir-cap', { ...base, maxDirectionalPerEvent: 4, kellyFraction: 0.13, maxKellyPct: 0.15 }],
    ['vault+dir-cap', { ...base, boxMinProfit: 0.006, boxMaxSumAsk: 0.993, boxMaxPairValue: 18, maxDirectionalPerEvent: 4, kellyFraction: 0.13, maxKellyPct: 0.15, trailDrop: 0.12, takeProfitPct: 0.38 }],
    ['smooth-size', { ...base, kellyFraction: 0.11, maxKellyPct: 0.12, maxEntryValue: 6, maxDirectionalPerEvent: 4, cooldownSec: 7 }],
  ];

  console.log(`Vault focus 19d`);
  for (const [name, params] of variants) {
    console.log(`Rodando ${name}...`);
    const r = await run(loaded, params, db, from, to);
    console.log(`${name.padEnd(14)} | PnL $${r.pnl.toFixed(2).padStart(7)} | DD $${r.dd.toFixed(2).padStart(5)} | PF ${r.pf.toFixed(2)} | Tr ${r.trades} | Box ${r.boxEntries} Dir ${r.dirEntries} | Lin ${r.linearity.toFixed(1)}`);
  }
}

main().catch(console.error);