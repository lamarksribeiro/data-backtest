import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  listStrategyLibraries,
  getStrategyLibraryBySlug,
} from '../src/backtestStudio/state/strategyLibrary.js';
import { createStandardLibrary } from '../src/backtestStudio/gls/standardLibrary.js';
import { composeStrategyJsFromGls } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import { applyEmbeddedModelsToLib } from '../src/backtestStudio/strategyJs/embeddedModels.js';

test('migrateStrategyV6 does not seed strategy-specific libraries in SQLite', () => {
  const dir = path.join(os.tmpdir(), `strategy-library-${Date.now()}`);
  const db = openStateDatabase(path.join(dir, 'state.db'));
  try {
    const libraries = listStrategyLibraries(db);
    const slugs = libraries.map((row) => row.slug);
    assert.ok(!slugs.includes('edge-sniper-models'));
    assert.ok(!slugs.includes('gamma-ladder-engine'));
    assert.equal(getStrategyLibraryBySlug(db, 'edge-sniper-models'), null);
  } finally {
    closeStateDatabase(db);
  }
});

test('embedded editor source provides heavy model.* without SQLite libraries', () => {
  const src = `export default strategy({
    name: "Edge Models",
    params: {},
    onTick(ctx) {
      const { tick, event, samples } = ctx;
      model.directionProbability(samples, tick, event, {});
    },
  });`;
  const fullSource = composeStrategyJsFromGls(src);
  const lib = createStandardLibrary();
  applyEmbeddedModelsToLib(fullSource, lib);

  assert.equal(typeof lib.model.directionProbability, 'function');
  assert.equal(typeof lib.model.scoreSides, 'function');
  assert.equal(typeof lib.model.scoreImpulseElasticitySides, 'function');

  const tick = {
    underlyingPrice: 100500,
    up_best_ask: 0.45,
    down_best_ask: 0.55,
    up_best_bid: 0.44,
    down_best_bid: 0.54,
    ts: '2026-05-31T00:01:00.000Z',
    event_end: '2026-05-31T00:05:00.000Z',
  };
  const event = { end: '2026-05-31T00:05:00.000Z', priceToBeat: 100400 };
  const prob = lib.model.directionProbability([], tick, event, {});
  assert.ok(Number.isFinite(prob));
  assert.ok(prob > 0 && prob < 1);
});

test('GET /api/strategy-library excludes strategy-specific libraries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strategy-library-api-'));
  let server = null;
  try {
    const { createApiServer } = await import('../src/api/server.js');
    const { createTestAuthService, testServerConfig } = await import('./testAuth.js');
    const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
    } catch (err) {
      closeStateDatabase(db);
      throw err;
    }
    const base = `http://127.0.0.1:${server.address().port}`;

    const list = await fetch(`${base}/api/strategy-library`).then((r) => r.json());
    const slugs = (list.libraries || []).map((row) => row.slug);
    assert.ok(!slugs.includes('edge-sniper-models'));
    assert.ok(!slugs.includes('gamma-ladder-engine'));

    const detail = await fetch(`${base}/api/strategy-library/edge-sniper-models`);
    assert.equal(detail.status, 404);
    closeStateDatabase(db);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});