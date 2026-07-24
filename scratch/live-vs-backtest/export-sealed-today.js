/**
 * One-shot: materializa backtest_ticks do dia corrente só com eventos já encerrados
 * (maxEventEnd = now - margin), contornando a ausência de parquet parcial no lake diário.
 */
import 'dotenv/config';

import { loadConfig } from '../../src/config.js';
import { createSourcePool, closeSourcePool } from '../../src/source/postgres.js';
import { exportBacktestTicksPartition, listBookPartitions } from '../../src/sync/bookDatasets.js';
import { exportBacktestTicksLitePartition } from '../../src/sync/backtestTicksLite.js';
import { closeStateDatabase, openStateDatabase } from '../../src/state/sqlite.js';

const from = process.argv[2] || '2026-07-24';
const to = process.argv[3] || '2026-07-25';
const marginMin = Number(process.argv[4] || '2');

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);
const pool = createSourcePool(config);

const maxEventEnd = new Date(Date.now() - marginMin * 60_000).toISOString();
const range = {
  from: `${from}T00:00:00.000Z`,
  to: `${to}T00:00:00.000Z`,
  maxEventEnd,
};

console.log(JSON.stringify({ range, bookDepth: config.backtestBookDepth }, null, 2));

try {
  const partitions = await listBookPartitions(pool, {
    ...range,
    underlying: 'BTC',
    interval: '5m',
  });
  console.log(JSON.stringify({ partitionsFound: partitions.length, partitions }, null, 2));

  const results = [];
  for (const partition of partitions) {
    const bookDepth = config.backtestBookDepth;
    const tickResult = await exportBacktestTicksPartition({
      config,
      db,
      pool,
      partition,
      dryRun: false,
      rebuild: true,
      allowNeedsReview: true,
      bookDepth,
    });
    results.push(tickResult);
    if (!tickResult?.skipped) {
      results.push(await exportBacktestTicksLitePartition({
        config,
        db,
        partition: { ...partition, bookDepth },
        dryRun: false,
        rebuild: true,
      }));
    }
  }
  console.log(JSON.stringify({ results }, null, 2));
} finally {
  await closeSourcePool(pool);
  closeStateDatabase(db);
}
