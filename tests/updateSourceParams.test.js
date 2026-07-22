import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  updateSourceParams,
  updateGlsParams,
} from '../src/backtestStudio/source/updateSourceParams.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  createStrategy,
  createStrategyVersion,
  trashStrategy,
  permanentlyDeleteStrategy,
} from '../src/backtestStudio/state/strategies.js';
import { createStrategyPreset, listStrategyPresets } from '../src/backtestStudio/state/strategyPresets.js';
import { renderPresetStrategyJs } from '../labs/shared/renderPresetStrategyJs.js';

const MINIMAL_JS = `export default strategy({
  name: "Preset Test",
  params: {
    budget: 10,
    minEdge: 0.05,
  },
  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    const dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat);
    if (!state.done && dist >= 1) {
      orders.enter("UP", { price: 0.5, budget: params.budget, reason: "t" });
      state.done = true;
    }
  },
});`;

const MINIMAL_GLS = `strategy "Gls Test"
  param budget = 10
  param minEdge = 0.05

  on tick
    enter "UP" price=0.5 budget=budget
`;

test('updateSourceParams rewrites Strategy JS params block', () => {
  const { source, changed, style } = updateSourceParams(MINIMAL_JS, {
    budget: 25,
    minEdge: 0.08,
  }, { language: 'strategy-js-v1' });

  assert.equal(style, 'strategy-js');
  assert.equal(changed, true);
  assert.match(source, /budget:\s*25/);
  assert.match(source, /minEdge:\s*0\.08/);
  assert.doesNotMatch(source, /budget:\s*10/);
});

test('updateSourceParams rewrites GLS param lines', () => {
  const { source, changed, style } = updateSourceParams(MINIMAL_GLS, {
    budget: 42,
    minEdge: 0.12,
  }, { language: 'gls-v1' });

  assert.equal(style, 'gls');
  assert.equal(changed, true);
  assert.match(source, /param budget = 42/);
  assert.match(source, /param minEdge = 0\.12/);
});

test('updateSourceParams reports unchanged when values match', () => {
  const { changed } = updateSourceParams(MINIMAL_JS, { budget: 10, minEdge: 0.05 });
  assert.equal(changed, false);
});

test('renderPresetStrategyJs uses brace-safe rewrite', () => {
  const nested = `export default strategy({
  name: "Nested",
  params: {
    label: "a { b }",
    budget: 10,
  },
  onTick() {},
});`;
  const out = renderPresetStrategyJs(nested, { label: 'x', budget: 99 }, 'Nested v2');
  assert.match(out, /name: "Nested v2"/);
  assert.match(out, /budget:\s*99/);
  assert.match(out, /label:\s*"x"/);
});

test('updateGlsParams leaves unknown keys untouched', () => {
  const out = updateGlsParams(MINIMAL_GLS, { budget: 7, unknown: 1 });
  assert.match(out, /param budget = 7/);
  assert.doesNotMatch(out, /param unknown/);
});

test('permanentlyDeleteStrategy removes presets before versions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'preset-delete-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const strategy = createStrategy(db, { slug: 'preset-del', name: 'Preset Del' });
      const version = createStrategyVersion(db, strategy.id, {
        language: 'strategy-js-v1',
        source_code: MINIMAL_JS,
      });
      createStrategyPreset(db, strategy.id, {
        strategy_version_id: version.id,
        name: 'keep-me',
        params: { budget: 20 },
      });
      assert.equal(listStrategyPresets(db, strategy.id).length, 1);

      trashStrategy(db, strategy.id);
      const deleted = permanentlyDeleteStrategy(db, strategy.id);
      assert.ok(deleted);
      assert.equal(listStrategyPresets(db, strategy.id).length, 0);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
