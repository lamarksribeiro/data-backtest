import { readFileSync } from 'node:fs';
import { openStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { DuckDbTickProvider } from '../src/backtest/tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { computeMaxDrawdown, computeRecoveryFactor } from '../src/backtest/equityMetrics.js';

function std(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

function linearityScore(equity) {
  const deltas = [];
  for (let i = 1; i < equity.length; i++) {
    deltas.push(equity[i].pnl - equity[i - 1].pnl);
  }
  const positiveDeltas = deltas.filter((d) => d > 0);
  const negativeDeltas = deltas.filter((d) => d < 0);
  const upRatio = deltas.length ? positiveDeltas.length / deltas.length : 0;
  const avgUp = positiveDeltas.length ? positiveDeltas.reduce((s, d) => s + d, 0) / positiveDeltas.length : 0;
  const avgDown = negativeDeltas.length ? Math.abs(negativeDeltas.reduce((s, d) => s + d, 0) / negativeDeltas.length) : 0;
  const monotonicity = upRatio * 100;
  const smoothness = deltas.length ? 100 / (1 + std(deltas)) : 0;
  const asymmetry = avgDown > 0 ? avgUp / avgDown : (avgUp > 0 ? 99 : 0);
  return { monotonicity, smoothness, asymmetry, score: monotonicity + smoothness + asymmetry * 5 };
}

async function loadRunner(db, slug) {
  const strategyDef = getStrategyBySlug(db, slug);
  const row = db.prepare(`
    SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1
  `).get(strategyDef.id);
  const version = {
    ...row,
    params_schema: JSON.parse(row.params_schema_json || '{}'),
    validation: JSON.parse(row.validation_json || '{}'),
    compiled: row.compiled_json ? JSON.parse(row.compiled_json) : null,
  };
  const resolved = resolveVersionForBacktest(version, { bookDepth: 25, db });
  return loadStrategy({
    glsAst: resolved.glsAst,
    columnAnalysis: resolved.columnAnalysis,
    runnerLibrary: resolved.runnerLibrary,
    extensionLibraries: resolved.extensionLibraries,
    generatedSource: resolved.generatedSource,
    embeddedModels: resolved.embeddedModels,
    strategySourceCode: resolved.strategySourceCode,
    db,
    bookDepth: 25,
  });
}

async function runVariant(loaded, params, provider, from, to) {
  const runner = loaded.createRunner(params, { fastRun: true, bookDepth: 25 });
  for await (const batch of provider.streamTicks({ from, to })) {
    for (const tick of batch) runner.processTick(tick);
  }
  const raw = runner.finish();
  const result = applyPolymarketFeesToBacktestResult(raw, { enabled: true, category: 'crypto' });
  const dd = computeMaxDrawdown(result.equity);
  const linearity = linearityScore(result.equity);
  return {
    summary: { ...result.summary, maxDrawdown: dd, recoveryFactor: computeRecoveryFactor(result.summary.totalPnl, dd) },
    linearity,
    equity: result.equity,
  };
}

async function main() {
  const from = process.argv[2] || '2026-06-01';
  const to = process.argv[3] || '2026-06-19';
  const db = openStateDatabase('./state/data-backtest.db', { readOnly: true });
  bindStrategyLibraryDatabase(db);

  const championParams = JSON.parse(readFileSync('./labs/strategies/carry/cofre-sete-v1/presets/btc-champion.json', 'utf8')).params;
  const linearParams = JSON.parse(readFileSync('./labs/strategies/carry/cofre-sete-v2/defaults.json', 'utf8'));

  const loadedV1 = await loadRunner(db, 'cofre-sete-v1');
  const loadedV2 = await loadRunner(db, 'cofre-sete-v2');

  console.log(`Comparando Cofre Sete (${from} a ${to})...`);
  const champion = await runVariant(
    loadedV1,
    championParams,
    new DuckDbTickProvider(db, { underlying: 'BTC', interval: '5m', bookDepth: 25 }),
    from,
    to,
  );
  const linear = await runVariant(
    loadedV2,
    linearParams,
    new DuckDbTickProvider(db, { underlying: 'BTC', interval: '5m', bookDepth: 25 }),
    from,
    to,
  );

  const rows = [
    ['Métrica', 'V1 Champion', 'V2 Linear'],
    ['PnL Líquido', `$${champion.summary.totalPnl.toFixed(2)}`, `$${linear.summary.totalPnl.toFixed(2)}`],
    ['Max Drawdown', `$${champion.summary.maxDrawdown.toFixed(2)}`, `$${linear.summary.maxDrawdown.toFixed(2)}`],
    ['Max Loss', `$${champion.summary.maxLoss.toFixed(2)}`, `$${linear.summary.maxLoss.toFixed(2)}`],
    ['Profit Factor', champion.summary.profitFactor.toFixed(2), linear.summary.profitFactor.toFixed(2)],
    ['Trades', champion.summary.totalEntries, linear.summary.totalEntries],
    ['Win Rate %', `${champion.summary.winRate}%`, `${linear.summary.winRate}%`],
    ['Recovery Factor', champion.summary.recoveryFactor?.toFixed(2) ?? 'n/a', linear.summary.recoveryFactor?.toFixed(2) ?? 'n/a'],
    ['Linearidade (score)', champion.linearity.score.toFixed(1), linear.linearity.score.toFixed(1)],
    ['% eventos positivos', `${champion.linearity.monotonicity.toFixed(1)}%`, `${linear.linearity.monotonicity.toFixed(1)}%`],
    ['Suavidade', champion.linearity.smoothness.toFixed(1), linear.linearity.smoothness.toFixed(1)],
  ];

  console.log('\n=== COMPARAÇÃO ANTI-DRAWDOWN ===');
  for (const row of rows) console.log(`${row[0].padEnd(22)} | ${String(row[1]).padEnd(14)} | ${row[2]}`);
}

main().catch(console.error);