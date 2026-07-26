import { openStateDatabase, closeStateDatabase } from './src/state/sqlite.js';

const db = openStateDatabase();
try {
  const row = db.prepare(`
    SELECT sd.slug, sv.version, sv.notes
    FROM strategy_definitions sd
    JOIN strategy_versions sv ON sv.id = sd.default_version_id
    WHERE sd.slug = 'midas-carry-v1'
  `).get();
  console.log('default', row);
  const vs = db.prepare(`
    SELECT version, notes
    FROM strategy_versions
    WHERE strategy_id = (SELECT id FROM strategy_definitions WHERE slug = 'midas-carry-v1')
    ORDER BY version
  `).all();
  for (const v of vs) console.log(`v${v.version}: ${v.notes}`);
} finally {
  closeStateDatabase(db);
}
