import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

async function testTopPromotedStrategies() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const dt = '2026-06-01';
    const from = `${dt}T00:00:00.000Z`;
    const to = `${dt}T23:59:59.999Z`;

    console.log(`====================================================================================`);
    console.log(` BENCHMARK DAS ESTRATÉGIAS OFICIAIS DO CATALOGO NO LAKE REAL (${dt})`);
    console.log(`====================================================================================\n`);

    const testStrategy = async (slug, versionNum) => {
      const version = db.prepare(`
        SELECT sv.*, sd.slug
        FROM strategy_versions sv
        JOIN strategy_definitions sd ON sd.id = sv.strategy_id
        WHERE sd.slug = ? AND sv.version = ?
      `).get(slug, versionNum);

      if (!version) {
        console.log(`Estratégia ${slug} v${versionNum} não encontrada.`);
        return;
      }

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

      const withFees = applyPolymarketFeesToBacktestResult(rawResult, { category: 'crypto', feeRate: 0.07 });
      const feesPaid = Math.abs(rawResult.summary.totalPnl - withFees.summary.totalPnl);

      console.log(` [${slug.toUpperCase()} v${versionNum}]`);
      console.log(`   - Eventos Processados    : ${rawResult.summary?.totalEvents}`);
      console.log(`   - Operações Entradas     : ${rawResult.summary?.totalEntries}`);
      console.log(`   - Operações Vencedoras   : ${rawResult.summary?.totalWins}`);
      console.log(`   - Operações Perdedoras   : ${rawResult.summary?.totalLosses}`);
      console.log(`   - Win Rate (Taxa Acerto) : ${rawResult.summary?.winRate}%`);
      console.log(`   - Lucro Bruto            : $${rawResult.summary?.totalPnl?.toFixed(2)}`);
      console.log(`   - Taxas Polymarket (7%)  : $${feesPaid.toFixed(2)}`);
      console.log(`   - Lucro Líquido          : $${withFees.summary?.totalPnl?.toFixed(2)}\n`);
    };

    await testStrategy('edge-snipper', 1);
    await testStrategy('edge-snipper', 2);
    await testStrategy('tfc', 2);
    await testStrategy('tfc', 4);
    await testStrategy('tfc', 7);
    await testStrategy('hopper-3', 1);
    await testStrategy('hopper-4', 1);
    await testStrategy('cofre-sete', 2);
    await testStrategy('terminal-convexity-v1', 3);

  } catch (err) {
    console.error('Erro no benchmark:', err);
  } finally {
    closeStateDatabase(db);
  }
}

testTopPromotedStrategies();
