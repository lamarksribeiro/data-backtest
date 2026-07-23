import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';

async function testV5Fix() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const version = db.prepare(`
      SELECT sv.* FROM strategy_versions sv
      JOIN strategy_definitions sd ON sd.id = sv.strategy_id
      WHERE sd.slug = 'abrupt-spike-scalper' AND sv.version = 5
    `).get();
    if (!version) {
      console.error('Version 123 not found');
      return;
    }

    const dt = '2026-06-01';
    const from = `${dt}T00:00:00.000Z`;
    const to = `${dt}T23:59:59.999Z`;

    console.log('Testing version 123 (Abrupt Spike Scalper v5) on real Lake data...');
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
      params: { minSpikeAbs: 2.5 },
    });

    console.log('--- RESULTADO V5 COM OVERRIDE MIN SPIKE = $2.5 ---');
    console.log('Ticks:', rawResult.ticks);
    console.log('Total Eventos:', rawResult.summary?.totalEvents);
    console.log('Total Entradas:', rawResult.summary?.totalEntries);
    console.log('Lucro Bruto:', rawResult.summary?.totalPnl);

  } catch (err) {
    console.error('Erro:', err);
  } finally {
    closeStateDatabase(db);
  }
}

testV5Fix();
