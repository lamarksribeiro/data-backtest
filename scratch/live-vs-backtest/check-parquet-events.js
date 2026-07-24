import { loadConfig } from '../src/config.js';
import { closeStateDatabase, openStateDatabase } from '../src/state/sqlite.js';
import { queryTicks } from '../src/query/duckdbQuery.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath, { readOnly: true });

const ids = [
  '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533',
  '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5',
];

try {
  for (const conditionId of ids) {
    const rows = await queryTicks(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      from: '2026-07-24T00:00:00.000Z',
      to: '2026-07-25T00:00:00.000Z',
      conditionId,
      limit: 5,
    });
    console.log(conditionId, 'rows', rows.length, rows[0] ? {
      event_start: rows[0].event_start,
      ts: rows[0].ts,
      up_best_ask: rows[0].up_best_ask,
      down_best_ask: rows[0].down_best_ask,
    } : null);
  }

  // count events around 22:00-23:00
  const sample = await queryTicks(db, {
    dataset: 'backtest_ticks',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    from: '2026-07-24T22:00:00.000Z',
    to: '2026-07-24T23:00:00.000Z',
    limit: 100000,
  });
  const byStart = new Map();
  for (const r of sample) {
    const k = new Date(r.event_start).toISOString();
    byStart.set(k, (byStart.get(k) || 0) + 1);
  }
  console.log('events_22h', [...byStart.entries()].sort());
} finally {
  closeStateDatabase(db);
}
