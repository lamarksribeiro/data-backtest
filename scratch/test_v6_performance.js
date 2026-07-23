import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

async function testV6Multiday() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];

    console.log('====================================================================================');
    console.log(` TESTANDO A NOVA VERSÃO V6 (HIGH PROFIT CARRY DIP) EM 5 DIAS DO LAKE REAL`);
    console.log('====================================================================================\n');

    const version = db.prepare(`
      SELECT sv.*, sd.slug
      FROM strategy_versions sv
      JOIN strategy_definitions sd ON sd.id = sv.strategy_id
      WHERE sd.slug = 'abrupt-spike-scalper' AND sv.version = 6
    `).get();

    let aggEvents = 0;
    let aggEntries = 0;
    let aggWins = 0;
    let aggLosses = 0;
    let aggPnl = 0;

    for (const dt of days) {
      const from = `${dt}T00:00:00.000Z`;
      const to = `${dt}T23:59:59.999Z`;

      const resolved = resolveVersionForBacktest(version, { bookDepth: config.backtestBookDepth, db });
      const rawResult = await runBacktest(db, {
        from,
        to,
        underlying: 'BTC',
        interval: '5m',
        bookDepth: config.backtestBookDepth,
        batchSize: 25000,
        fastRun: true,
        glsAst: resolved.glsAst,
        columnAnalysis: resolved.columnAnalysis,
        embeddedRunner: resolved.embeddedRunner,
        embeddedModels: resolved.embeddedModels,
        strategySourceCode: resolved.strategySourceCode,
        db,
        strategyMeta: resolved.strategyMeta,
        params: {},
      });

      aggEvents += rawResult.summary?.totalEvents || 0;
      aggEntries += rawResult.summary?.totalEntries || 0;
      aggWins += rawResult.summary?.totalWins || 0;
      aggLosses += rawResult.summary?.totalLosses || 0;
      aggPnl += rawResult.summary?.totalPnl || 0;

      console.log(` Dia ${dt}: Eventos=${rawResult.summary?.totalEvents} | Entradas=${rawResult.summary?.totalEntries} | Wins=${rawResult.summary?.totalWins} | Losses=${rawResult.summary?.totalLosses} | PnL=$${rawResult.summary?.totalPnl?.toFixed(2)}`);
    }

    const winRate = aggEntries > 0 ? (aggWins / aggEntries) * 100 : 0;
    console.log('\n------------------------------------------------------------------------------------');
    console.log(` RESULTADO FINAL V6 EM 5 DIAS REAIS DO LAKE:`);
    console.log(` Total Operações         : ${aggEntries}`);
    console.log(` Operações Vencedoras    : ${aggWins}`);
    console.log(` Operações Perdedoras    : ${aggLosses}`);
    console.log(` Taxa de Acerto (WinRate): ${winRate.toFixed(1)}%`);
    console.log(` Lucro Total Acumulado   : $${aggPnl.toFixed(2)}`);
    console.log('------------------------------------------------------------------------------------\n');

  } catch (err) {
    console.error(err);
  } finally {
    closeStateDatabase(db);
  }
}

testV6Multiday();
