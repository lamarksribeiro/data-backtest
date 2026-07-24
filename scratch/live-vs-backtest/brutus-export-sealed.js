import { loadConfig } from '../src/config.js';
import { createSourcePool, closeSourcePool, listSealedScalarPartitions } from '../src/source/postgres.js';
import { exportBacktestTicksPartition } from '../src/sync/bookDatasets.js';
import { exportBacktestTicksLitePartition } from '../src/sync/backtestTicksLite.js';
import { closeStateDatabase, openStateDatabase } from '../src/state/sqlite.js';

const mode = process.argv[2] || 'probe';
const config = loadConfig();
const pool = createSourcePool(config);

try {
  if (mode === 'probe') {
    const q = await pool.query(`
      SELECT m.underlying, m.type, m.slug_pattern, e.condition_id,
             e.event_start, e.event_end, eq.ticks_recorded, eq.coverage
      FROM events e
      JOIN markets m ON m.id = e.market_id
      LEFT JOIN event_quality eq ON eq.market_id = e.market_id AND eq.condition_id = e.condition_id
      WHERE m.underlying = 'BTC' AND m.type = 'crypto-updown-5m'
        AND e.event_start IN ('2026-07-24T22:15:00Z'::timestamptz, '2026-07-24T22:45:00Z'::timestamptz)
      ORDER BY e.event_start
    `);
    console.log('events', JSON.stringify(q.rows, null, 2));

    const maxEventEnd = new Date(Date.now() - 2 * 60_000).toISOString();
    const partitions = await listSealedScalarPartitions(pool, {
      from: '2026-07-24T00:00:00.000Z',
      to: '2026-07-25T00:00:00.000Z',
      maxEventEnd,
      underlying: 'BTC',
      interval: '5m',
    });
    console.log('partitions', JSON.stringify(partitions, null, 2));
  }

  if (mode === 'export') {
    const db = openStateDatabase(config.stateDbPath);
    const maxEventEnd = new Date(Date.now() - 2 * 60_000).toISOString();
    const partitions = await listSealedScalarPartitions(pool, {
      from: '2026-07-24T00:00:00.000Z',
      to: '2026-07-25T00:00:00.000Z',
      maxEventEnd,
      underlying: 'BTC',
      interval: '5m',
    });
    console.log(JSON.stringify({ maxEventEnd, partitionsFound: partitions.length, partitions }, null, 2));
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
    closeStateDatabase(db);
  }
} finally {
  await closeSourcePool(pool);
}
