import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { openStateDatabase } from '../src/state/sqlite.js';
import { validateStrategySource } from '../src/backtestStudio/strategyJs/index.js';
import { loadStrategyLibraryRunner, clearStrategyLibraryRunnerCache } from '../src/backtestStudio/strategyLibrary/loadRunner.js';
import { getStrategyLibraryKind } from '../src/backtestStudio/strategyLibrary/kind.js';
import { legacyTickFromAny } from '../src/backtestStudio/strategyLibrary/tickBridge.js';
import { loadBootstrapLibraryEntries } from '../src/backtestStudio/strategyLibrary/bootstrapEntries.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { fullPortCatalog } from '../scripts/port-catalog.js';

const ROOT = path.resolve('.');

function syntheticTick(i = 0) {
  const ts = new Date('2026-06-01T12:00:00.000Z');
  ts.setSeconds(ts.getSeconds() + i);
  return legacyTickFromAny({
    ts: ts.toISOString(),
    event_start: '2026-06-01T12:00:00.000Z',
    event_end: '2026-06-01T12:05:00.000Z',
    condition_id: 'cond-test-1',
    underlying_price: 105000 + i,
    price_to_beat: 104950,
    up_price: 0.55,
    down_price: 0.45,
    up_best_ask: 0.56,
    up_best_bid: 0.54,
    down_best_ask: 0.46,
    down_best_bid: 0.44,
    id: i,
  }, 5);
}

test('port catalog exists with runners portfolios rejected and backlog', () => {
  const catalogPath = path.join(ROOT, 'labs/strategies/_catalog/port-catalog.json');
  assert.ok(existsSync(catalogPath));
  const disk = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const expected = fullPortCatalog();
  assert.equal(disk.runners.length, expected.runners.length);
  assert.equal(disk.portfolios.length, expected.portfolios.length);
  assert.ok(disk.rejected.length >= 5);
  assert.ok(disk.backlog.length >= 5);
  assert.equal(disk.sourceMode, 'read-only');
});

test('every bootstrap library json compiles createBacktestRunner', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  clearStrategyLibraryRunnerCache();

  for (const entry of loadBootstrapLibraryEntries()) {
    const kind = entry.validation?.kind || 'runner';
    assert.ok(['runner', 'portfolio'].includes(kind), `${entry.slug} kind`);
    const runner = loadStrategyLibraryRunner(db, entry.slug, entry.version, {});
    assert.ok(runner, `missing runner ${entry.slug}`);
    assert.equal(typeof runner.processTick, 'function');
    assert.equal(typeof runner.finish, 'function');
    runner.processTick(syntheticTick(0));
    runner.processTick(syntheticTick(1));
    const result = runner.finish();
    assert.ok(result.summary, `${entry.slug} summary`);
    assert.ok(Array.isArray(result.events), `${entry.slug} events`);
  }
});

test('ported lab manifests validate as Strategy JS library or portfolio runners', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);

  for (const entry of loadBootstrapLibraryEntries()) {
    const kind = getStrategyLibraryKind(db, entry.slug, entry.version);
    assert.ok(kind, entry.slug);
  }

  const families = readdirSync(path.join(ROOT, 'labs/strategies'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'));

  let ported = 0;
  for (const family of families) {
    const familyDir = path.join(ROOT, 'labs/strategies', family.name);
    for (const strategy of readdirSync(familyDir, { withFileTypes: true })) {
      if (!strategy.isDirectory()) continue;
      const manifestPath = path.join(familyDir, strategy.name, 'strategy.json');
      const strategyJsPath = path.join(familyDir, strategy.name, 'strategy.js');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.portStatus !== 'ported') continue;
      ported += 1;
      assert.ok(existsSync(strategyJsPath), manifest.id);
      const source = readFileSync(strategyJsPath, 'utf8');
      const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: source, db });
      assert.equal(validation.ok, true, `${manifest.id}: ${validation.errors?.[0]?.message}`);
      assert.ok(
        ['library-runner', 'portfolio-runner'].includes(validation.execution_kind),
        `${manifest.id} execution_kind`,
      );
    }
  }
  assert.ok(ported >= 10, `expected >=10 ported strategies, got ${ported}`);
});

test('portfolio runners load child modules', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  clearStrategyLibraryRunnerCache();

  for (const entry of loadBootstrapLibraryEntries()) {
    if (entry.validation?.kind !== 'portfolio') continue;
    const runner = loadStrategyLibraryRunner(db, entry.slug, entry.version, {
      walletSize: 100,
      includeModules: entry.validation.modules?.map((m) => m.key) || [],
    });
    for (let i = 0; i < 5; i += 1) runner.processTick(syntheticTick(i));
    const result = runner.finish();
    assert.equal(result.strategy, entry.slug.includes('fusion') ? 'FUSION_FIVE_V1' : result.strategy);
    assert.ok(result.summary);
  }
});