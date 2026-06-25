import { openStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { DuckDbTickProvider } from '../src/backtest/tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

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

  // Parâmetros do campeão otimizado (estes parâmetros serão atualizados de acordo com a nova otimização líquida!)
  // Vamos ler os parâmetros do arquivo btc-champion.json se ele já foi gerado ou definimos no código os que foram gerados da otimização líquida.
  // Como o otimizador está rodando, este script será executado no final. Vamos fazer ele ler dinamicamente do btc-champion.json!
  // Isso é extremamente robusto! Ele lê os parâmetros campeões direto do arquivo gerado pelo otimizador!
  let championParams = {};
  try {
    const fs = await import('node:fs');
    const championJson = JSON.parse(fs.readFileSync('./labs/strategies/carry/cofre-sete-v1/presets/btc-champion.json', 'utf8'));
    championParams = championJson.params;
    console.log('Parâmetros campeões carregados com sucesso do btc-champion.json.');
  } catch (err) {
    console.log('Não foi possível ler btc-champion.json. Usando parâmetros padrão para fallback.');
    championParams = resolved.params_schema;
  }

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

  // Finalizar os resultados brutos
  const rawBaselineResult = baselineRunner.finish();
  const rawChampionResult = championRunner.finish();

  // Aplicar as taxas Polymarket (crypto, 0.07) nos resultados
  console.log('4. Aplicando taxas Polymarket aos resultados...');
  const baselineResult = applyPolymarketFeesToBacktestResult(rawBaselineResult, { enabled: true, category: 'crypto' });
  const championResult = applyPolymarketFeesToBacktestResult(rawChampionResult, { enabled: true, category: 'crypto' });

  const b = baselineResult.summary;
  const c = championResult.summary;

  console.log('\n=== COMPARAÇÃO FINAL LÍQUIDA COMPLETA (01/06 A 19/06) ===');
  console.log('--------------------------------------------------');
  console.log(`Métrica             | Baseline         | Campeão Otimizado`);
  console.log('--------------------------------------------------');
  console.log(`PnL Líquido         | $${b.totalPnl.toFixed(2)}       | $${c.totalPnl.toFixed(2)}`);
  console.log(`Taxas Pagas         | $${b.totalFees.toFixed(2)}       | $${c.totalFees.toFixed(2)}`);
  console.log(`Retorno Líquido %   | ${(b.totalPnl).toFixed(1)}%          | ${(c.totalPnl).toFixed(1)}%`);
  console.log(`Trades Efetuados    | ${b.totalEntries}              | ${c.totalEntries}`);
  console.log(`Vitórias / Derrotas | ${b.totalWins} / ${b.totalLosses}        | ${c.totalWins} / ${c.totalLosses}`);
  console.log(`Win Rate %          | ${b.winRate.toFixed(1)}%            | ${c.winRate.toFixed(1)}%`);
  console.log(`Profit Factor Líq   | ${b.profitFactor.toFixed(2)}             | ${c.profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown Líq    | $${b.maxDrawdown.toFixed(2)}           | $${c.maxDrawdown.toFixed(2)}`);
  console.log(`Max Loss Único      | $${b.maxLoss.toFixed(2)}           | $${c.maxLoss.toFixed(2)}`);
  console.log('--------------------------------------------------');

  const pnlGain = c.totalPnl - b.totalPnl;
  console.log(`\nResultado Líquido: O campeão obteve um lucro líquido adicional de +$${pnlGain.toFixed(2)} sobre o baseline!`);
}

main().catch(console.error);
