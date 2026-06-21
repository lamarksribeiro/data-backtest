import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { openStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { legacyTickFromAny } from '../src/backtestStudio/strategyLibrary/tickBridge.js';
import { discoverPortedManifests, seedPortedStrategies } from '../scripts/seed-ported-strategies.js';

function syntheticTick(i = 0) {
  return legacyTickFromAny({
    ts: new Date(`2026-06-01T12:00:${String(i % 60).padStart(2, '0')}.000Z`).toISOString(),
    event_start: '2026-06-01T12:00:00.000Z',
    event_end: '2026-06-01T12:05:00.000Z',
    condition_id: 'cond-ported-test',
    underlying_price: 105000 + i,
    price_to_beat: 104950,
    up_price: 0.55,
    down_price: 0.45,
    up_best_ask: 0.56,
    up_best_bid: 0.54,
    down_best_ask: 0.46,
    down_best_bid: 0.44,
    id: i,
  }, 25);
}

test('seedPortedStrategies seeds all promoted ported and compiled-native strategies', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  const result = seedPortedStrategies(db);
  assert.ok(result.libraries >= 15);
  assert.equal(result.strategies.length, discoverPortedManifests().length);

  for (const manifest of discoverPortedManifests()) {
    const slug = manifest.studioSlug || manifest.id;
    const strategy = getStrategyBySlug(db, slug);
    assert.ok(strategy, slug);
    const version = db.prepare(`
      SELECT source_code, validation_json FROM strategy_versions
      WHERE strategy_id = ? ORDER BY version DESC LIMIT 1
    `).get(strategy.id);
    const validation = JSON.parse(version.validation_json);
    assert.equal(validation.ok, true, `${slug}: ${validation.errors?.[0]?.message}`);

    if (manifest.portStatus === 'compiled-native') {
      assert.equal(validation.execution_kind, 'compiled-soa', `${slug} execution_kind`);
      assert.ok(version.source_code.includes('function createLibrary'), `${slug} missing embedded models`);
      assert.ok(!version.source_code.includes('strategyLibrary('), `${slug} should not depend on library runner`);
      continue;
    }

    assert.ok(version.source_code.includes('strategyLibrary('), `${slug} missing runner dependency in source`);
    assert.ok(
      ['library-runner', 'portfolio-runner'].includes(validation.execution_kind),
      `${slug} execution_kind=${validation.execution_kind}`,
    );
  }
});

test('terminal-convexity-v1 seeds lab presets as studio versions', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);

  const strategy = getStrategyBySlug(db, 'terminal-convexity-v1');
  assert.ok(strategy, 'terminal-convexity-v1');
  const versions = db.prepare(`
    SELECT version, notes FROM strategy_versions
    WHERE strategy_id = ?
    ORDER BY version ASC
  `).all(strategy.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].notes, 'Default (Legacy)');
  assert.equal(versions[1].notes, 'BTC · Champion');

  const defaultRow = db.prepare('SELECT default_version_id FROM strategy_definitions WHERE id = ?').get(strategy.id);
  const defaultVersion = db.prepare('SELECT version FROM strategy_versions WHERE id = ?').get(defaultRow.default_version_id);
  assert.equal(defaultVersion.version, 2);

  const champion = db.prepare(`
    SELECT validation_json FROM strategy_versions
    WHERE strategy_id = ? AND version = 2
  `).get(strategy.id);
  const validation = JSON.parse(champion.validation_json);
  assert.equal(validation.execution_kind, 'compiled-soa');
  assert.equal(validation.params_schema?.lateFlipExitEnabled?.default, true);
  assert.equal(validation.params_schema?.stopIfCrossed?.default, false);
});

test('every seeded ported strategy resolves book dataset and runs synthetic ticks', async () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);

  for (const manifest of discoverPortedManifests()) {
    const slug = manifest.studioSlug || manifest.id;
    const strategy = getStrategyBySlug(db, slug);
    const row = db.prepare(`
      SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1
    `).get(strategy.id);
    const version = {
      ...row,
      params_schema: JSON.parse(row.params_schema_json || '{}'),
      validation: JSON.parse(row.validation_json || '{}'),
      compiled: row.compiled_json ? JSON.parse(row.compiled_json) : null,
    };

    const resolved = resolveVersionForBacktest(version, { bookDepth: 25, db });
    if (manifest.portStatus === 'compiled-native') {
      assert.equal(resolved.runnerLibrary, null, `${slug} should not use runnerLibrary`);
      assert.equal(resolved.embeddedModels, true, `${slug} should use embedded models`);
    } else {
      assert.ok(resolved.runnerLibrary, `${slug} missing runnerLibrary`);
    }
    assert.equal(resolved.columnAnalysis.needsBookLevels, true, `${slug} should require book levels`);
    assert.equal(resolved.columnAnalysis.bookDepth, 25, `${slug} bookDepth`);

    const loaded = await loadStrategy({
      glsAst: resolved.glsAst,
      columnAnalysis: resolved.columnAnalysis,
      runnerLibrary: resolved.runnerLibrary,
      extensionLibraries: resolved.extensionLibraries,
      generatedSource: resolved.generatedSource,
      embeddedModels: resolved.embeddedModels,
      strategySourceCode: resolved.strategySourceCode,
      db,
      bookDepth: 25,
    });
    const runner = loaded.createRunner({}, { fastRun: true, bookDepth: 25 });
    for (let i = 0; i < 8; i += 1) runner.processTick(syntheticTick(i));
    const result = runner.finish();
    assert.ok(result.summary, `${slug} summary`);
    assert.ok(Array.isArray(result.events), `${slug} events`);
  }
});