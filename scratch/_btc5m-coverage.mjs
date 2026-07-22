import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });
const row = db
  .prepare(
    `SELECT min(dt) AS min_dt, max(dt) AS max_dt, count(*) AS n
     FROM lake_manifest
     WHERE underlying = 'BTC'
       AND interval = '5m'
       AND book_depth = 25
       AND status IN ('valid', 'accepted')
       AND dataset = 'backtest_ticks'`
  )
  .get();
console.log(JSON.stringify(row, null, 2));
