import { openStateDatabase } from '../src/state/sqlite.js';

const db = openStateDatabase('./state/data-backtest.db', { readOnly: true });

const strategies = db.prepare('SELECT id, slug, name, default_version_id FROM strategy_definitions').all();
console.log('--- ESTRATÉGIAS ---');
console.log(JSON.stringify(strategies, null, 2));

for (const s of strategies) {
  const versions = db.prepare('SELECT id, version, checksum, notes, validation_json FROM strategy_versions WHERE strategy_id = ?').all(s.id);
  console.log(`\n--- VERSÕES DE ${s.slug} (ID: ${s.id}) ---`);
  console.log(JSON.stringify(versions.map(v => ({
    id: v.id,
    version: v.version,
    notes: v.notes,
    ok: JSON.parse(v.validation_json || '{}').ok
  })), null, 2));
}
