import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  createStrategy,
  createStrategyVersion,
} from '../src/backtestStudio/state/strategies.js';
import {
  createStrategyPreset,
  mergePresetParams,
  extractDefaultParamsFromSchema,
} from '../src/backtestStudio/state/strategyPresets.js';
import { validateStrategySource, compileStrategyJs } from '../src/backtestStudio/strategyJs/index.js';
import { glsToStrategyJs } from '../src/backtestStudio/strategyJs/glsToStrategyJs.js';
import { composeGammaLadderStrategyJs } from '../src/backtestStudio/strategyJs/composeGammaLadder.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { inlineHelpersInConfig, extractHelperFunctions } from '../src/backtestStudio/strategyJs/inlineHelpers.js';
import { parseStrategyJs, extractStrategyConfig } from '../src/backtestStudio/strategyJs/parser.js';

const HELPER_STRATEGY = `function edgeFor(side, probUp, ask) {
  return (side === "DOWN" ? 1 - probUp : probUp) - ask;
}

export default strategy({
  name: "Helper Inline",
  params: { minEdge: 0.05 },
  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    const probUp = prices.marketProbUp(tick);
    const ask = book.ask("UP", tick);
    const edge = edgeFor("UP", probUp, ask);
    if (!state.done && edge >= params.minEdge) {
      orders.enter("UP", { price: ask, budget: 10, reason: "helper" });
      state.done = true;
    }
  },
});`;

const GAMMA_GLS = `strategy "Gamma Ladder V1" {
  param walletSize = 100
  onTick(tick, event) {
    let x = tick.underlyingPrice
  }
}`;

test('strategyLoader blocks .gls file path when not TEST_MODE', async () => {
  const config = loadConfig({ TEST_MODE: 'false', NODE_ENV: 'production' });
  await assert.rejects(
    () => loadStrategy({ strategy: 'labs/foo.gls' }, config),
    /disabled in production/,
  );
});

test('strategyLoader allows .gls file path in TEST_MODE', async () => {
  const config = loadConfig({ TEST_MODE: 'true', NODE_ENV: 'test' });
  const glsFile = path.resolve('src/backtestStudio/gls/strategies/edgeSniperV2.gls');
  const loaded = await loadStrategy({ strategy: glsFile }, config);
  assert.ok(loaded.createRunner);
});

test('gamma ladder Strategy JS resolves embedded-runner from full source', () => {
  const db = openStateDatabase(path.join(os.tmpdir(), `gamma-kind-${Date.now()}.db`));
  try {
    const js = composeGammaLadderStrategyJs(GAMMA_GLS);
    const compiled = compileStrategyJs(js, { db });
    assert.equal(compiled.ok, true, compiled.errors?.map((e) => e.message).join('; '));
    const resolved = resolveVersionForBacktest({
      language: 'strategy-js-v1',
      source_code: js,
      compiled_json: JSON.stringify(compiled.compiled),
      checksum: compiled.compiled.source_checksum,
    }, { db });
    assert.equal(resolved.strategyMeta.execution_kind, 'embedded-runner');
    assert.equal(resolved.strategyMeta.editable_logic, true);
    assert.equal(resolved.embeddedRunner, true);
    assert.ok(resolved.strategySourceCode?.includes('gammaLadderRunnerFactory'));
  } finally {
    closeStateDatabase(db);
  }
});

test('inlineHelpers extracts and inlines pure helper', () => {
  const parsed = parseStrategyJs(HELPER_STRATEGY);
  const config = extractStrategyConfig(parsed.strategyCall);
  const helpers = extractHelperFunctions(parsed.program);
  assert.equal(helpers.size, 1);
  const inlined = inlineHelpersInConfig(config, helpers);
  assert.ok(inlined.hooks.onTick.body.body.length >= 1);
  const compiled = compileStrategyJs(HELPER_STRATEGY);
  assert.equal(compiled.ok, true, compiled.errors?.map((e) => e.message).join('; '));
});

test('preset params merge for backtest request shape', () => {
  const dir = path.join(os.tmpdir(), `preset-merge-${Date.now()}`);
  const db = openStateDatabase(path.join(dir, 'state.db'));
  try {
    const strategy = createStrategy(db, { slug: 'merge-test', name: 'Merge' });
    const version = createStrategyVersion(db, strategy.id, {
      language: 'strategy-js-v1',
      source_code: HELPER_STRATEGY,
    });
    const preset = createStrategyPreset(db, strategy.id, {
      strategy_version_id: version.id,
      name: 'tuned',
      params: { minEdge: 0.09 },
    });
    const defaults = extractDefaultParamsFromSchema(version.params_schema);
    const merged = mergePresetParams(defaults, preset.params, {});
    assert.equal(merged.minEdge, 0.09);
    assert.equal(preset.strategy_version_id, version.id);
  } finally {
    closeStateDatabase(db);
  }
});

test('gls validator fail-hard on unmapped tick columns', () => {
  const badGls = `strategy "Bad Columns" {
  onTick(tick, event) {
    let x = tick.unknownField
  }
}`;
  const result = validateStrategySource({ language: 'gls-v1', source_code: badGls });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_TICK_PROPERTY' || e.code === 'COLUMN_ANALYSIS_INCOMPLETE'));
});

