/** Audita ticks brutos de um dia suspeito direto do Parquet ativo. */
import { loadConfig } from '../../src/config.js';
import { openStateDatabase } from '../../src/state/sqlite.js';
import { queryTicks } from '../../src/query/duckdbQuery.js';

const dt = process.argv[2] || '2026-06-11';
const db = openStateDatabase(loadConfig().stateDbPath, { readOnly: true });
const rows = await queryTicks(db, {
  dataset: 'backtest_ticks',
  underlying: 'BTC', interval: '5m', bookDepth: 25,
  from: `${dt}T${process.argv[3] || '03:50'}:00Z`, to: `${dt}T${process.argv[4] || '04:20'}:00Z`,
  validBacktestRows: true,
  select: 'condition_id, ts, event_end, underlying_price, price_to_beat, up_best_ask, down_best_ask, up_best_bid, down_best_bid',
  limit: 4000,
});
let last = null;
for (const r of rows) {
  const key = r.condition_id.slice(0, 10);
  const secs = Math.round((new Date(r.ts).getTime() % 300000) / 1000);
  if (key !== last || secs % 60 === 0) {
    console.log(`${r.ts} ev=${key} spot=${r.underlying_price?.toFixed(1)} ptb=${r.price_to_beat?.toFixed(1)} dist=${(r.underlying_price - r.price_to_beat).toFixed(1)} upAsk=${r.up_best_ask} dnAsk=${r.down_best_ask}`);
    last = key;
  }
}
console.log('rows:', rows.length);
