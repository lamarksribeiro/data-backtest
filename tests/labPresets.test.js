import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getEdgeSniperV3V1GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { loadPreset, listPresets } from '../labs/shared/presets.js';
import {
  listPromotedStrategies,
  listPromotedGlsStrategies,
  listPromotedLibraryStrategies,
  listPromotedCompiledStrategies,
} from '../labs/shared/discoverStrategies.js';
import { renderPresetGls } from '../labs/shared/renderPresetGls.js';
import { seedPromotedStrategies } from '../src/backtestStudio/gls/seedPromotedStrategies.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

test('listPromotedGlsStrategies discovers GLS lab strategies', () => {
	const promoted = listPromotedGlsStrategies();
	const ids = promoted.map((item) => item.id).sort();
	assert.deepEqual(ids, ['book-frontrunner', 'edge-sniper-v3', 'gamma-ladder', 'quantum-entropic-manifold', 'vsmr', 'whipsaw-lock']);
	assert.equal(promoted.find((item) => item.id === 'gamma-ladder').studioSlug, 'gamma-ladder');
});

test('listPromotedLibraryStrategies discovers ported library runners', () => {
  const promoted = listPromotedLibraryStrategies();
  assert.ok(promoted.length >= 10);
  for (const manifest of promoted) {
    assert.equal(manifest.portStatus, 'ported');
    assert.ok(['library-runner', 'portfolio-runner'].includes(manifest.kind));
  }
  const compiled = listPromotedCompiledStrategies();
  assert.deepEqual(compiled.map((item) => item.id), ['terminal-convexity-v1']);
  assert.equal(compiled[0].kind, 'compiled-soa');
  assert.equal(compiled[0].portStatus, 'compiled-native');

  const allPromoted = listPromotedStrategies();
  assert.equal(
    allPromoted.length,
    listPromotedGlsStrategies().length + promoted.length + compiled.length,
  );
});

test('seedPromotedStrategies seeds versions from lab manifests', () => {
  const dir = path.join(os.tmpdir(), `data-backtest-seed-promoted-${Date.now()}`);
  const dbPath = path.join(dir, 'state.db');
  const db = openStateDatabase(dbPath);
	try {
		const results = seedPromotedStrategies(db);
		assert.equal(results.length, 6);
		const slugs = results.map((row) => row.slug).sort();
		assert.deepEqual(slugs, ['book-frontrunner', 'edge-sniper-v3', 'gamma-ladder', 'quantum-entropic-manifold', 'vsmr', 'whipsaw-lock']);

    const edge = results.find((row) => row.slug === 'edge-sniper-v3');
    const edgeVersions = db.prepare(`
      SELECT version, notes FROM strategy_versions
      WHERE strategy_id = ?
      ORDER BY version ASC
    `).all(edge.strategy.id);
    assert.equal(edgeVersions.length, 3);
    assert.equal(edgeVersions[0].notes, 'BTC · Classic');
    assert.equal(edgeVersions[2].notes, 'ETH · OBI');

    const gamma = results.find((row) => row.slug === 'gamma-ladder');
    const gammaVersions = db.prepare(`
      SELECT version, notes FROM strategy_versions
      WHERE strategy_id = ?
      ORDER BY version ASC
    `).all(gamma.strategy.id);
    assert.equal(gammaVersions.length, 3);
    assert.equal(gammaVersions[0].notes, 'BTC · V1');
    assert.equal(gammaVersions[2].notes, 'BTC · Quantum Entropic Hybrid Champion');

    const qem = results.find((row) => row.slug === 'quantum-entropic-manifold');
    const qemVersions = db.prepare(`
      SELECT version, notes, validation_json FROM strategy_versions
      WHERE strategy_id = ?
      ORDER BY version ASC
    `).all(qem.strategy.id);
    assert.equal(qemVersions.length, 1);
    assert.equal(qemVersions[0].notes, 'BTC · Quantum Entropic Champion');
    assert.equal(JSON.parse(qemVersions[0].validation_json).ok, true);
    const languages = db.prepare('SELECT DISTINCT language FROM strategy_versions').all().map((r) => r.language);
    assert.deepEqual(languages, ['strategy-js-v1']);
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

test('loadPreset resolves whipsaw-lock champion params', () => {
  const { preset, params } = loadPreset('btc-champion', { strategyId: 'whipsaw-lock', strategyFamily: 'microstructure' });
  assert.equal(preset.studioSlug, 'whipsaw-lock-btc-champion');
  assert.equal(params.minFlips, 3);
  assert.equal(params.maxSpread, 0.025);
  assert.equal(params.flipWindowSecs, 60);
});

test('loadPreset resolves quantum-entropic-manifold champion params', () => {
  const { preset, params } = loadPreset('btc-qem-june-champion', { strategyId: 'quantum-entropic-manifold' });
  assert.equal(preset.studioSlug, 'qem-btc-june-champion');
  assert.equal(params.minEdge, 0.06);
  assert.equal(params.quantumSizingHighFactor, 1.65);
  assert.equal(params.entropyCompressionCap, 0.94);
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
