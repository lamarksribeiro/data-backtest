import 'dotenv/config';
process.env.TEST_MODE = 'true';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { createLibraryRunnerAdapter } from '../src/backtestStudio/strategyLibrary/runnerAdapter.js';
import { runSequentialSoA } from '../src/backtest/engine.js';
import { loadBacktestColumnSet } from '../src/query/columnChunkReader.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { renderPresetStrategyJs } from '../labs/shared/renderPresetStrategyJs.js';
import { validateStrategySource } from '../src/backtestStudio/strategyJs/index.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  bindStrategyLibraryDatabase(db);

  const strategyRoot = path.resolve('labs/strategies/carry/hopper-3');
  const strategy = JSON.parse(readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
  const defaults = JSON.parse(readFileSync(path.join(strategyRoot, 'defaults.json'), 'utf8'));
  
  const preset = JSON.parse(readFileSync(path.join(strategyRoot, 'presets/btc-champion.json'), 'utf8'));
  const params = { ...defaults, ...preset.params };

  const sourcePath = path.join(strategyRoot, 'strategy.js');
  const baseJs = readFileSync(sourcePath, 'utf8');
  const rendered = renderPresetStrategyJs(baseJs, defaults, strategy.name);
  
  const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: rendered, db });
  if (!validation.ok) {
    throw new Error(validation.errors?.[0]?.message || 'strategy-js validation failed');
  }
  
  const runnerLibrary = validation.runner_library;

  console.log('Carregando ColumnSet (ticks do DuckDB)...');
  const columnSet = await loadBacktestColumnSet(db, {
    from: new Date('2026-07-01T00:00:00.000Z').toISOString(),
    to: new Date('2026-07-06T00:00:00.000Z').toISOString(),
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    selectBookDepth: 25,
    dataset: 'backtest_ticks',
    includeBook: true,
    validBacktestRows: true,
  });

  console.log(`ColumnSet carregado. ${columnSet.length} ticks encontrados.`);
  console.log('Instanciando o runner adapter e iniciando simulacao...');

  const runner = createLibraryRunnerAdapter(db, runnerLibrary, params, { fastRun: true, bookDepth: 25 });
  runner.bindColumnSet(columnSet);
  await runSequentialSoA(runner, columnSet, false);

  const outcome = runner.finish();
  applyPolymarketFeesToBacktestResult(outcome);

  console.log('Simulacao concluida.');

  const badEvents = outcome.events.filter(e => e.finalPnl < -100);
  console.log(`Encontrado(s) ${badEvents.length} evento(s) com prejuízo superior a $100:`);

  for (const event of badEvents) {
    console.log('\n================================================================');
    console.log(`EVENT ID: ${event.eventId}`);
    console.log(`Período: ${event.eventStart} a ${event.eventEnd}`);
    console.log(`PnL do Evento: $${event.finalPnl.toFixed(2)}`);
    console.log(`Lado Operado: ${event.positionType} | Lado Vencedor: ${event.winnerSide}`);
    console.log(`Razão de Exibição/Fechamento: ${event.reason}`);
    
    console.log('\n--- Fills (Compras) ---');
    for (const fill of event.fills || []) {
      console.log(`  [COMPRA] ${fill.side} - ${fill.qty.toFixed(0)} shares @ $${fill.price.toFixed(4)} | Tipo: ${fill.type} | Liq: ${fill.liquidity} | Time: ${fill.time}`);
    }

    console.log('\n--- Exits (Vendas/Fechamento) ---');
    for (const exit of event.exits || []) {
      console.log(`  [VENDA] ${exit.side} - ${exit.qty.toFixed(0)} shares @ $${exit.price.toFixed(4)} | Tipo: ${exit.type} | PnL: $${exit.pnl?.toFixed(2)} | Liq: ${exit.liquidity}`);
    }

    console.log('\n--- Diagnósticos Finais do Estado ---');
    console.log(JSON.stringify(event.diagnostics, null, 2));
  }

  closeStateDatabase(db);
}

main().catch(console.error);
