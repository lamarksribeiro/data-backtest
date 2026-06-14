import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { getStrategy, getStrategyVersion } from '../src/backtestStudio/state/strategies.js';
import { parse } from '../src/backtestStudio/gls/parser.js';

async function main() {
  const versionId = Number(process.argv[2]);
  if (!versionId) {
    console.error("Uso: node scratch/run-backtest-slim.js <version_id_sqlite> [params_json]");
    process.exit(1);
  }

  const overrideParams = process.argv[3] ? JSON.parse(process.argv[3]) : {};

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const strategyId = 3; // Edge Sniper V2 GLS
    const strategy = getStrategy(db, strategyId);
    if (!strategy) throw new Error('Strategy not found');
    const version = getStrategyVersion(db, strategyId, versionId);
    if (!version) throw new Error(`Strategy version not found for ID ${versionId}`);

    console.log(`Rodando backtest para versão sequencial ${version.version} (SQLite ID ${versionId}) com overrides:`, JSON.stringify(overrideParams));

    const result = await runBacktest(db, {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-13T00:00:00.000Z',
      strategy: `gls:${strategy.slug}`,
      strategyLabel: version.source_code.match(/strategy\s+"([^"]+)"/)?.[1] || strategy.name,
      glsAst: parse(version.source_code),
      strategyMeta: {
        strategy_id: strategyId,
        strategy_version_id: versionId,
        slug: strategy.slug,
        name: strategy.name,
        version: version.version,
        language: version.language,
        source_code: version.source_code,
        params_schema: version.params_schema,
        checksum: version.checksum,
      },
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      batchSize: 5000,
      params: overrideParams,
    });

    console.log("\n=== RESULTADO SUMMARY ===");
    console.log(JSON.stringify(result.summary, null, 2));

  } finally {
    closeStateDatabase(db);
  }
}

main().catch(console.error);
