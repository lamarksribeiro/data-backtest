import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

async function testMultidayChampion() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];

    console.log('====================================================================================');
    console.log(` AVALIAÇÃO DE LUCRO EM MULTI-DIAS REAL DO LAKE (5 DIAS: ${days.join(', ')})`);
    console.log('====================================================================================\n');

    const runStrategyDays = async (slug, versionNum) => {
      const version = db.prepare(`
        SELECT sv.*, sd.slug
        FROM strategy_versions sv
        JOIN strategy_definitions sd ON sd.id = sv.strategy_id
        WHERE sd.slug = ? AND sv.version = ?
      `).get(slug, versionNum);

      if (!version) return;

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
      }

      const winRate = aggEntries > 0 ? (aggWins / aggEntries) * 100 : 0;
      console.log(` Estratégia [${slug.toUpperCase()} v${versionNum}] (5 Dias de Mercado Real):`);
      console.log(`   - Total Eventos: ${aggEvents}`);
      console.log(`   - Total Operações: ${aggEntries}`);
      console.log(`   - Operações Vencedoras: ${aggWins} | Perdedoras: ${aggLosses}`);
      console.log(`   - Taxa de Acerto (Win Rate): ${winRate.toFixed(1)}%`);
      console.log(`   - Lucro Total Acumulado (5 Dias): $${aggPnl.toFixed(2)}\n`);
    };

    await runStrategyDays('tfc', 7);
    await runStrategyDays('tfc', 4);
    await runStrategyDays('tfc', 2);

  } catch (err) {
    console.error(err);
  } finally {
    closeStateDatabase(db);
  }
}

testMultidayChampion();
