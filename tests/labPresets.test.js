import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getEdgeSniperV3V1GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { loadPreset, listPresets } from '../labs/shared/presets.js';
import { listPromotedStrategies } from '../labs/shared/discoverStrategies.js';
import { renderPresetGls } from '../labs/shared/renderPresetGls.js';
import { seedPromotedStrategies } from '../src/backtestStudio/gls/seedPromotedStrategies.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

test('listPromotedStrategies discovers edge-sniper-v3 from labs', () => {
  const promoted = listPromotedStrategies();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].id, 'edge-sniper-v3');
  assert.equal(promoted[0].studioSlug, 'edge-sniper-v3-gls');
});

test('seedPromotedStrategies seeds versions from lab manifests', () => {
  const dir = path.join(os.tmpdir(), `data-backtest-seed-promoted-${Date.now()}`);
  const dbPath = path.join(dir, 'state.db');
  const db = openStateDatabase(dbPath);
  try {
    const results = seedPromotedStrategies(db);
    assert.equal(results.length, 1);
    assert.equal(results[0].slug, 'edge-sniper-v3-gls');
    const versions = db.prepare(`
      SELECT version, notes FROM strategy_versions
      WHERE strategy_id = ?
      ORDER BY version ASC
    `).all(results[0].strategy.id);
    assert.equal(versions.length, 3);
    assert.equal(versions[0].notes, 'BTC · Classic');
    assert.equal(versions[2].notes, 'ETH · OBI');
  } finally {
    closeStateDatabase(db);
  }
});

test('listPresets loads edge-sniper-v3 asset profiles', () => {
  const presets = listPresets({ strategyId: 'edge-sniper-v3', includeAliases: false });
  assert.equal(presets.length, 3);
  assert.deepEqual(presets.map((item) => item.id), ['btc-classic', 'btc-obi', 'eth-obi']);
  assert.equal(presets[2].underlying, 'ETH');
});

test('loadPreset merges defaults with overrides', () => {
  const { preset, params } = loadPreset('btc-classic', { strategyId: 'edge-sniper-v3' });
  assert.equal(preset.studioSlug, 'esv3-btc-classic');
  assert.equal(params.entryWindowStart, 105);
  assert.equal(params.walletSize, 100);
  assert.equal(params.minDistanceAbs, 50);
});

test('loadPreset resolves legacy preset ids', () => {
  const { preset } = loadPreset('v2', { strategyId: 'edge-sniper-v3' });
  assert.equal(preset.id, 'btc-obi');
});

test('renderPresetGls patches param defaults in source', () => {
  const source = getEdgeSniperV3V1GlsSource();
  const rendered = renderPresetGls(source, {
    entryWindowStart: 180,
    minDistanceAbs: 40,
    minEdge: 0,
  }, 'Edge Sniper V3 · Test');
  assert.match(rendered, /strategy "Edge Sniper V3 · Test"/);
  assert.match(rendered, /param entryWindowStart = 180/);
  assert.match(rendered, /param minDistanceAbs = 40/);
  assert.match(rendered, /param minEdge = 0/);
});
