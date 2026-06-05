import { createStrategy, createStrategyVersion, getStrategy } from '../state/strategies.js';
import { getEdgeSniperV2GlsSource } from './loadStrategySource.js';

export function seedEdgeSniperV2Strategy(db) {
  const existing = db.prepare('SELECT id FROM strategy_definitions WHERE slug = ?').get('edge-sniper-v2-gls');
  if (existing) return getStrategy(db, existing.id);

  const strategy = createStrategy(db, {
    slug: 'edge-sniper-v2-gls',
    name: 'Edge Sniper V2 GLS',
    description: 'Versao GLS do golden test edge-sniper-v2 (seed B7).',
    tags: ['btc', '5m', 'seed', 'golden-test'],
  });
  createStrategyVersion(db, strategy.id, {
    language: 'gls-v1',
    source_code: getEdgeSniperV2GlsSource(),
  });
  return getStrategy(db, strategy.id);
}
