import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });
const s = db
  .prepare(`SELECT id, slug, name, default_version_id FROM strategy_definitions WHERE slug='midas-carry-v1'`)
  .get();
console.log('strategy', s);
const vers = db
  .prepare(
    `SELECT id, version, notes FROM strategy_versions WHERE strategy_id=? ORDER BY version`,
  )
  .all(s.id);
console.log('versions', vers);
const v3 = db
  .prepare(`SELECT source_code FROM strategy_versions WHERE strategy_id=? AND version=3`)
  .get(s.id);
const match = v3.source_code.match(/maxDistAbs\s*=\s*([0-9.]+)/);
console.log('v3 maxDistAbs =', match?.[1]);
const tier = v3.source_code.match(/tierAskBudgetFactor\s*=\s*([0-9.]+)/);
console.log('v3 tierAskBudgetFactor =', tier?.[1]);
const name = v3.source_code.match(/MIDAS[^\n]{0,60}/);
console.log('name hint', name?.[0]);
