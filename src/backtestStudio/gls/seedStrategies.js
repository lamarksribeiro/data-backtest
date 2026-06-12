import { createStrategy, createStrategyVersion, getStrategy } from '../state/strategies.js';
import { getEdgeSniperV2GlsSource } from './loadStrategySource.js';

export function seedEdgeSniperV2Strategy(db) {
  const source = getEdgeSniperV2GlsSource();
  const existing = db.prepare('SELECT id, deleted_at FROM strategy_definitions WHERE slug = ?').get('edge-sniper-v2-gls');
  if (existing?.deleted_at) {
    return null;
  }
  if (existing) {
    const latest = db.prepare(`
      SELECT source_code
      FROM strategy_versions
      WHERE strategy_id = ?
      ORDER BY version DESC, id DESC
      LIMIT 1
    `).get(existing.id);
    if (!latest || normalizeSource(latest.source_code) !== normalizeSource(source)) {
      createStrategyVersion(db, existing.id, {
        language: 'gls-v1',
        source_code: source,
      });
    }
    return getStrategy(db, existing.id);
  }

  const strategy = createStrategy(db, {
    slug: 'edge-sniper-v2-gls',
    name: 'Edge Sniper V2 GLS',
    description: 'Versao GLS do golden test edge-sniper-v2 (seed B7).',
    tags: ['btc', '5m', 'seed', 'golden-test'],
  });
  createStrategyVersion(db, strategy.id, {
    language: 'gls-v1',
    source_code: source,
  });
  return getStrategy(db, strategy.id);
}

function normalizeSource(sourceCode) {
  return String(sourceCode || '').replace(/\r\n/g, '\n').trim();
}
