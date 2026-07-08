import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getEdgeSnipperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
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
	assert.deepEqual(ids, ['book-frontrunner', 'edge-snipper', 'gamma-ladder', 'lim-prime-v1', 'quantum-entropic-manifold', 'tfc', 'vsmr', 'whipsaw-lock']);
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
		assert.equal(results.length, 8);
		const slugs = results.map((row) => row.slug).sort();
		assert.deepEqual(slugs, ['book-frontrunner', 'edge-snipper', 'gamma-ladder', 'lim-prime-v1', 'quantum-entropic-manifold', 'tfc', 'vsmr', 'whipsaw-lock']);

    const edge = results.find((row) => row.slug === 'edge-snipper');
    const edgeVersions = db.prepare(`
      SELECT version, notes FROM strategy_versions
      WHERE strategy_id = ?
      ORDER BY version ASC
    `).all(edge.strategy.id);
    assert.equal(edgeVersions.length, 3);
    assert.equal(edgeVersions[0].notes, 'BTC · OBI');
    assert.equal(edgeVersions[1].notes, 'ETH · OBI');
    assert.equal(edgeVersions[2].notes, 'SOL · OBI');

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

    const tfc = results.find((row) => row.slug === 'tfc');
    const tfcVersions = db.prepare(`
      SELECT id, version, notes FROM strategy_versions
      WHERE strategy_id = ?
      ORDER BY version ASC
    `).all(tfc.strategy.id);
    assert.equal(tfcVersions.length, 8);
    assert.equal(tfcVersions.at(-1).version, 8);
    assert.equal(tfcVersions.at(-1).notes, 'TFC V7 Danger Floor');

    const staleDefault = tfcVersions.find((row) => row.version === 2);
    db.prepare('UPDATE strategy_definitions SET default_version_id = ? WHERE id = ?').run(staleDefault.id, tfc.strategy.id);
    seedPromotedStrategies(db);
    const defaultRow = db.prepare(`
      SELECT sv.version
      FROM strategy_definitions sd
      JOIN strategy_versions sv ON sv.id = sd.default_version_id
      WHERE sd.id = ?
    `).get(tfc.strategy.id);
    assert.equal(defaultRow.version, 8);

    const languages = db.prepare('SELECT DISTINCT language FROM strategy_versions').all().map((r) => r.language);
    assert.deepEqual(languages, ['strategy-js-v1']);
  } finally {
    closeStateDatabase(db);
  }
});

test('listPresets loads edge-snipper asset profiles', () => {
  const presets = listPresets({ strategyId: 'edge-snipper', includeAliases: false });
  assert.equal(presets.length, 3);
  assert.deepEqual(presets.map((item) => item.id), ['btc-obi', 'eth-obi', 'sol-obi']);
  assert.equal(presets[1].underlying, 'ETH');
  assert.equal(presets[2].underlying, 'SOL');
});

test('loadPreset merges defaults with overrides', () => {
  const { preset, params } = loadPreset('btc-obi', { strategyId: 'edge-snipper' });
  assert.equal(preset.studioSlug, 'es-btc-obi');
  assert.equal(params.entryWindowStart, 105);
  assert.equal(params.walletSize, 100);
  assert.equal(params.minDistanceAbs, 60);
});

test('loadPreset resolves legacy preset ids', () => {
  const { preset } = loadPreset('v2', { strategyId: 'edge-snipper' });
  assert.equal(preset.id, 'eth-obi');
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

test('loadPreset resolves tfc v6 hybrid stop params', () => {
  const { preset, params } = loadPreset('btc-champion-v6-hybrid', { strategyId: 'tfc', strategyFamily: 'terminal' });
  assert.equal(preset.studioSlug, 'tfc-btc-champion-v6-hybrid');
  assert.equal(preset.studioVersion, 7);
  assert.equal(params.hedgeStopEnabled, true);
  assert.equal(params.hedgeStopPrice, 0.55);
  assert.equal(params.hedgeStopPlaceSec, 8);
  assert.equal(params.lateFlipMinSec, 4);
  assert.equal(params.hedgeLimitEnabled, false);
});

test('renderPresetGls patches param defaults in source', () => {
  const source = getEdgeSnipperV2GlsSource();
  const rendered = renderPresetGls(source, {
    entryWindowStart: 180,
    minDistanceAbs: 40,
    minEdge: 0,
  }, 'Edge Snipper · Test');
  assert.match(rendered, /strategy "Edge Snipper · Test"/);
  assert.match(rendered, /param entryWindowStart = 180/);
  assert.match(rendered, /param minDistanceAbs = 40/);
  assert.match(rendered, /param minEdge = 0/);
});
