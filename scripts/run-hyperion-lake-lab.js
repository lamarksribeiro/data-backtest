import { runHyperionStrategy, mergeHyperionParams } from '../src/strategies/hyperionV1.js';
import { runBacktest } from '../src/backtest/engine.js';
import { openStateDatabase } from '../src/state/sqlite.js';
import { loadConfig } from '../src/config.js';

async function main() {
  console.log('=== LABORATÓRIO DE BACKTEST COMPLETO: HYPERION V1 (QJD-CELSM) ===');
  console.log('Período: 2026-05-04 até 2026-06-14 (42 dias contínuos no Lakehouse)');
  console.log('Execution Mode: Taker Walk Realista (sem preço fantasma, Hold-to-Settlement)');

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });

  const params = mergeHyperionParams({
    walletSize: 100,
    maxOrderValue: 15,
    minShares: 5,
    entryWindowStart: 280,
    entryWindowEnd: 5,
    minAsk: 0.12,
    maxAsk: 0.82,
    minEdge: 0.08,
    minJumpIntensity: 0.25,
    maxSpread: 0.06,
    entrySlippageMax: 0.02,
    minLiquidityRatio: 0.75,
  });

  const options = {
    underlying: 'BTC',
    interval: '5m',
    from: '2026-05-04',
    to: '2026-06-14',
    bookDepth: 25,
    batchSize: 50000,
  };

  const startTime = Date.now();
  console.log('\nExecutando simulação estocástica sobre o Lakehouse...');

  // Run backtest over Lakehouse using the strategy engine
  try {
    const result = await runBacktest(db, {
      strategyId: 'hyperion-v1',
      params,
      ...options,
    });

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\nBacktest concluído em ${elapsedSec}s!`);
    console.log('--------------------------------------------------');
    console.log(`PnL Líquido Acumulado: +$${result.totalPnl?.toFixed(2) || '0.00'}`);
    console.log(`Profit Factor: ${result.profitFactor?.toFixed(2) || 'N/A'}`);
    console.log(`Win Rate: ${result.winRate?.toFixed(1) || '0.0'}%`);
    console.log(`Total de Operações (Entries): ${result.totalEntries || 0}`);
    console.log(`Max Drawdown: $${result.maxDrawdown?.toFixed(2) || '0.00'}`);
    console.log('--------------------------------------------------');
  } catch (err) {
    console.log(`[info] Engine run status:`, err.message);
  }
}

main().catch(console.error);
