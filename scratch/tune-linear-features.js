import { readFileSync } from 'node:fs';
import { openStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { DuckDbTickProvider } from '../src/backtest/tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { computeMaxDrawdown } from '../src/backtest/equityMetrics.js';

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
  const dd = computeMaxDrawdown(result.equity);
  return { pnl: result.summary.totalPnl, dd, pf: result.summary.profitFactor, trades: result.summary.totalEntries, maxLoss: result.summary.maxLoss };
}

async function main() {
  const from = '2026-06-01';
  const to = '2026-06-05';
  const db = openStateDatabase('./state/data-backtest.db', { readOnly: true });
  bindStrategyLibraryDatabase(db);
  const loaded = await loadRunner(db);
  const base = JSON.parse(readFileSync('./labs/strategies/carry/cofre-sete-v1/presets/btc-champion.json', 'utf8')).params;

  const variants = [
    ['champion', base],
    ['+throttle', { ...base, drawdownKellyThrottle: true, drawdownKellyFloor: 0.55, equityPeakThrottlePct: 0.12 }],
    ['+streak', { ...base, lossStreakPause: 3, lossStreakCooldownEvents: 2 }],
    ['+worstStop', { ...base, eventWorstCaseStop: 18 }],
    ['+autoDerisk', { ...base, autoDeriskEnabled: true, autoDeriskWorstPnl: -9 }],
    ['+hedge', { ...base, hedgeEnabled: true, hedgeMinWorstCaseImprovement: 0.5, hedgeMinLockedProfit: 0.06 }],
    ['+tighterRisk', { ...base, riskBudgetPct: 0.35, maxWorstLossAbs: 32, kellyFraction: 0.13 }],
    ['+trail', { ...base, trailDrop: 0.09, takeProfitPct: 0.4, takeProfitBid: 0.89 }],
    ['combo-light', { ...base, drawdownKellyThrottle: true, drawdownKellyFloor: 0.55, equityPeakThrottlePct: 0.12, lossStreakPause: 3, lossStreakCooldownEvents: 2, eventWorstCaseStop: 18, autoDeriskEnabled: true, autoDeriskWorstPnl: -9, riskBudgetPct: 0.35, maxWorstLossAbs: 32, kellyFraction: 0.13, trailDrop: 0.09, takeProfitPct: 0.4 }],
    ['combo-no-hedge', { ...base, drawdownKellyThrottle: true, drawdownKellyFloor: 0.55, equityPeakThrottlePct: 0.1, lossStreakPause: 3, lossStreakCooldownEvents: 2, eventWorstCaseStop: 16, autoDeriskEnabled: true, autoDeriskWorstPnl: -8, directionalMinQualityScore: 0.45, maxDirectionalPerEvent: 5, riskBudgetPct: 0.34, maxWorstLossAbs: 30, kellyFraction: 0.13, trailDrop: 0.09, takeProfitPct: 0.42, takeProfitBid: 0.89, lateExitSec: 9 }],
  ];

  console.log('Variante               | PnL     | DD     | PF   | Trades | MaxLoss');
  for (const [name, params] of variants) {
    const r = await run(loaded, params, db, from, to);
    console.log(`${name.padEnd(22)} | $${r.pnl.toFixed(2).padStart(6)} | $${r.dd.toFixed(2).padStart(5)} | ${r.pf.toFixed(2).padStart(4)} | ${String(r.trades).padStart(6)} | $${r.maxLoss.toFixed(2)}`);
  }
}

main().catch(console.error);