import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createApiServer } from '../src/api/server.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createTestAuthService, testServerConfig } from './testAuth.js';
import {
  createStrategy,
  createStrategyVersion,
} from '../src/backtestStudio/state/strategies.js';
import {
  createStrategyPreset,
  listStrategyPresets,
  mergePresetParams,
  extractDefaultParamsFromSchema,
} from '../src/backtestStudio/state/strategyPresets.js';

const MINIMAL_JS = `export default strategy({
  name: "Preset Test",
  params: { budget: 10, minEdge: 0.05 },
  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    const dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat);
    if (!state.done && dist >= 1) {
      orders.enter("UP", { price: 0.5, budget: params.budget, reason: "t" });
      state.done = true;
    }
  },
});`;

test('strategy_presets CRUD and mergePresetParams', () => {
  const dir = path.join(os.tmpdir(), `strategy-presets-${Date.now()}`);
  const db = openStateDatabase(path.join(dir, 'state.db'));
  try {
    const strategy = createStrategy(db, { slug: 'preset-test', name: 'Preset Test' });
    const version = createStrategyVersion(db, strategy.id, {
      language: 'strategy-js-v1',
      source_code: MINIMAL_JS,
    });

    const preset = createStrategyPreset(db, strategy.id, {
      strategy_version_id: version.id,
      name: 'aggressive',
      params: { budget: 25, minEdge: 0.08 },
      tags: ['smoke'],
    });
    assert.equal(preset.name, 'aggressive');
    assert.equal(preset.params.budget, 25);

    const listed = listStrategyPresets(db, strategy.id, { strategyVersionId: version.id });
    assert.equal(listed.length, 1);

    const defaults = extractDefaultParamsFromSchema(version.params_schema);
    const merged = mergePresetParams(defaults, preset.params, { budget: 30 });
    assert.equal(merged.budget, 30);
    assert.equal(merged.minEdge, 0.08);
  } finally {
    closeStateDatabase(db);
  }
});

test('backtestRequestFromBody merges preset_id params', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strategy-presets-api-'));
  let server = null;
  try {
    const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      const strategy = createStrategy(db, { slug: 'preset-api', name: 'Preset API' });
      const version = createStrategyVersion(db, strategy.id, {
        language: 'strategy-js-v1',
        source_code: MINIMAL_JS,
      });
      const preset = createStrategyPreset(db, strategy.id, {
        strategy_version_id: version.id,
        name: 'base',
        params: { budget: 42 },
      });

      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const base = `http://127.0.0.1:${server.address().port}`;

      const listRes = await fetch(`${base}/api/strategies/${strategy.id}/presets?strategy_version_id=${version.id}`).then((r) => r.json());
      assert.equal(listRes.presets.length, 1);

      const createRes = await fetch(`${base}/api/strategies/${strategy.id}/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy_version_id: version.id,
          name: 'via-api',
          params: { minEdge: 0.11 },
        }),
      }).then((r) => r.json());
      assert.equal(createRes.preset.name, 'via-api');

      const patchRes = await fetch(`${base}/api/strategies/${strategy.id}/presets/${preset.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'base-updated' }),
      }).then((r) => r.json());
      assert.equal(patchRes.preset.name, 'base-updated');

      const delRes = await fetch(`${base}/api/strategies/${strategy.id}/presets/${createRes.preset.id}`, {
        method: 'DELETE',
      }).then((r) => r.json());
      assert.equal(delRes.deleted, true);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});