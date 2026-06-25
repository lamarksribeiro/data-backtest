import { openStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { DuckDbTickProvider } from '../src/backtest/tickProvider.js';

async function main() {
  const db = openStateDatabase('./state/data-backtest.db', { readOnly: true });
  bindStrategyLibraryDatabase(db);

  const from = '2026-06-01';
  const to = '2026-06-19';

  console.log(`1. Carregando estratégia cofre-sete-v1...`);
  const strategyDef = getStrategyBySlug(db, 'cofre-sete-v1');
  if (!strategyDef) {
    console.error('Estratégia cofre-sete-v1 não encontrada.');
    return;
  }

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
  const loaded = await loadStrategy({
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

  // Parâmetros do campeão otimizado
  const championParams = {
    ...resolved.params_schema, // defaults
    cooldownSec: 5,
    maxAsk: 0.8,
    minDirectionalProb: 0.55,
    minDistanceAbs: 40,
    trailDrop: 0.1,
    stopBid: 0.12,
  };

  console.log(`2. Inicializando provedor de ticks em streaming para todo o período (${from} a ${to})...`);
  const provider = new DuckDbTickProvider(db, {
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
  });

  // Criamos os dois runners (baseline e campeão)
  const baselineRunner = loaded.createRunner({}, { fastRun: true, bookDepth: 25 });
  const championRunner = loaded.createRunner(championParams, { fastRun: true, bookDepth: 25 });

  console.log('3. Executando backtests paralelos em streaming (memória constante)...');
  const start = performance.now();
  let count = 0;

  for await (const batch of provider.streamTicks({ from, to })) {
    for (const tick of batch) {
      baselineRunner.processTick(tick);
      championRunner.processTick(tick);
      count++;
    }
    if (count % 200000 === 0) {
      console.log(`Progresso: ${count} ticks processados...`);
    }
  }

  const duration = (performance.now() - start) / 1000;
  console.log(`\nFim do processamento de ${count} ticks em ${duration.toFixed(2)}s.`);

  const baselineResult = baselineRunner.finish();
  const championResult = championRunner.finish();

  const b = baselineResult.summary;
  const c = championResult.summary;

  console.log('\n=== COMPARAÇÃO FINAL COMPLETA (01/06 A 19/06) ===');
  console.log('--------------------------------------------------');
  console.log(`Métrica             | Baseline         | Campeão Otimizado`);
  console.log('--------------------------------------------------');
  console.log(`PnL Total           | $${b.totalPnl.toFixed(2)}       | $${c.totalPnl.toFixed(2)}`);
  console.log(`Retorno Líquido %   | ${(b.totalPnl).toFixed(1)}%          | ${(c.totalPnl).toFixed(1)}%`);
  console.log(`Trades Efetuados    | ${b.totalEntries}              | ${c.totalEntries}`);
  console.log(`Vitórias / Derrotas | ${b.totalWins} / ${b.totalLosses}        | ${c.totalWins} / ${c.totalLosses}`);
  console.log(`Win Rate %          | ${b.winRate.toFixed(1)}%            | ${c.winRate.toFixed(1)}%`);
  console.log(`Profit Factor       | ${b.profitFactor.toFixed(2)}             | ${c.profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown        | $${b.maxDrawdown.toFixed(2)}           | $${c.maxDrawdown.toFixed(2)}`);
  console.log(`Max Loss Único      | $${b.maxLoss.toFixed(2)}           | $${c.maxLoss.toFixed(2)}`);
  console.log('--------------------------------------------------');

  const pnlGain = c.totalPnl - b.totalPnl;
  console.log(`\nResultado: O campeão obteve um ganho adicional de +$${pnlGain.toFixed(2)} (+${(pnlGain).toFixed(1)}% de capital inicial) sobre o baseline!`);
}

main().catch(console.error);
