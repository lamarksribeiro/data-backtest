import 'dotenv/config';

import { loadConfig } from '../../src/config.js';
import { createSourcePool, closeSourcePool } from '../../src/source/postgres.js';

const config = loadConfig();
const pool = createSourcePool(config);

try {
  const starts = ['2026-07-24T22:15:00.000Z', '2026-07-24T22:45:00.000Z'];
  const ev = await pool.query(`
    SELECT e.condition_id, e.event_start, e.event_end, e.price_to_beat, m.underlying, m.type,
           eq.ticks_recorded, eq.coverage, eq.degraded, eq.recorded_at
    FROM events e
    JOIN markets m ON m.id = e.market_id
    LEFT JOIN event_quality eq ON eq.market_id = e.market_id AND eq.condition_id = e.condition_id
    WHERE e.event_start = ANY($1::timestamptz[])
    ORDER BY e.event_start
  `, [starts]);
  console.log('events', JSON.stringify(ev.rows, null, 2));

  const day = await pool.query(`
    SELECT (eq.event_start AT TIME ZONE 'UTC')::date::text AS dt,
           COUNT(*)::int AS events,
           SUM(eq.ticks_recorded)::bigint AS ticks,
           MAX(eq.event_end) AS max_end
    FROM event_quality eq
    JOIN markets m ON m.id = eq.market_id
    WHERE m.underlying='BTC' AND m.type='5m'
      AND eq.event_start >= '2026-07-24'::timestamptz
      AND eq.event_start < '2026-07-25'::timestamptz
    GROUP BY 1
  `);
  console.log('day_quality', JSON.stringify(day.rows, null, 2));

  const recent = await pool.query(`
    SELECT MAX(eq.event_end) AS max_event_end, COUNT(*)::int AS n
    FROM event_quality eq
    JOIN markets m ON m.id = eq.market_id
    WHERE m.underlying='BTC' AND m.type='5m'
      AND eq.event_start >= now() - interval '2 days'
  `);
  console.log('recent', JSON.stringify(recent.rows, null, 2));

  const ticks = await pool.query(`
    SELECT e.event_start, COUNT(*)::int AS tick_rows
    FROM ticks t
    JOIN events e ON e.market_id = t.market_id AND e.condition_id = t.condition_id
    WHERE e.event_start = ANY($1::timestamptz[])
    GROUP BY e.event_start
    ORDER BY e.event_start
  `, [starts]);
  console.log('ticks', JSON.stringify(ticks.rows, null, 2));
} finally {
  await closeSourcePool(pool);
}
