import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  createStrategy,
  createStrategyVersion,
} from '../src/backtestStudio/state/strategies.js';
import { compileStrategyJs } from '../src/backtestStudio/strategyJs/index.js';
import {
  buildCompiledArtifact,
  isCompiledArtifactValid,
  resolveCompiledStrategy,
  resolveVersionForBacktest,
} from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { createStandardLibrary } from '../src/backtestStudio/gls/standardLibrary.js';
import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { composeStrategyJsFromGls } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import {
  applyEmbeddedModelsToLib,
  detectEmbeddedModels,
} from '../src/backtestStudio/strategyJs/embeddedModels.js';

const MINIMAL = `export default strategy({
  name: "Cache Test",
  params: { budget: 10 },
  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    const dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat);
    if (!state.done && dist >= 10) {
      orders.enter("UP", { price: 0.5, budget: params.budget, reason: "x" });
      state.done = true;
    }
  },
});`;

test('compileStrategyJs persists ir_json and generated_source in compiled artifact', () => {
  const result = compileStrategyJs(MINIMAL);
  assert.equal(result.ok, true);
  assert.ok(result.compiled.ir_json);
  assert.equal(result.compiled.ir_json.type, 'Strategy');
  assert.ok(result.compiled.generated_source?.onTick);
  assert.equal(result.compiled.dependencies?.length ?? 0, 0);
});

test('resolveCompiledStrategy stores compile_book_depth in artifact', () => {
  const result = compileStrategyJs(MINIMAL);
  assert.equal(result.ok, true);
  assert.equal(result.compiled.compile_book_depth, 25);
});

test('resolveCompiledStrategy uses compiled_json cache without recompilation', () => {
  const dir = path.join(os.tmpdir(), `strategy-cache-${Date.now()}`);
  const db = openStateDatabase(path.join(dir, 'state.db'));
  try {
    const strategy = createStrategy(db, { slug: 'cache-hit', name: 'Cache Hit' });
    const version = createStrategyVersion(db, strategy.id, {
      language: 'strategy-js-v1',
      source_code: MINIMAL,
    });
    assert.ok(version.compiled?.ir_json);
    assert.ok(isCompiledArtifactValid(version.compiled, version.checksum));

    const resolved = resolveCompiledStrategy(version, { bookDepth: 25 });
    assert.equal(resolved.compileCacheHit, true);
    assert.equal(resolved.glsAst.name, 'Cache Test');
    assert.ok(version.compiled?.generated_source?.onTick);
    assert.ok(resolved.generatedSource?.onTick);

    const backtest = resolveVersionForBacktest(version, { bookDepth: 25 });
    assert.equal(backtest.strategyMeta.compileCacheHit, true);
  } finally {
    closeStateDatabase(db);
  }
});

test('compileStrategyJs rejects for loops', () => {
  const src = MINIMAL.replace(
    'if (!state.done && dist >= 10) {',
    'for (let i = 0; i < 3; i += 1) { if (!state.done && dist >= 10) {',
  ).replace('state.done = true;', 'state.done = true; }');
  const result = compileStrategyJs(src);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'FORBIDDEN_LOOP'));
});

test('model.scoreSides requires inlined createLibrary or dependencies', () => {
  const src = `export default strategy({
      name: "Needs Dep",
      params: {},
      onTick(ctx) {
        const { tick, event, samples } = ctx;
        model.scoreSides(samples, tick, event, {});
      },
    });`;
  const without = compileStrategyJs(src);
  assert.equal(without.ok, false);
  assert.ok(without.errors.some((e) => e.code === 'MISSING_DEPENDENCY'));

  const inlined = composeStrategyJsFromGls(src);
  const withModels = compileStrategyJs(inlined);
  assert.equal(withModels.ok, true, withModels.errors?.map((e) => e.message).join('; '));
  assert.ok(detectEmbeddedModels(inlined));
  assert.equal(withModels.editable_logic, true);
  assert.deepEqual(withModels.inlined_models, ['edge-sniper-models']);
});

test('applyEmbeddedModelsToLib wires heavy model.* from full editor source', () => {
  const src = `export default strategy({
    name: "Legacy",
    params: {},
    onTick(ctx) {
      const { tick, event, samples } = ctx;
      model.scoreSides(samples, tick, event, {});
    },
  });`;
  const fullSource = composeStrategyJsFromGls(src);
  const bare = createStandardLibrary();
  assert.equal(typeof bare.model.orderBookImbalance, 'function');
  assert.equal(bare.model.scoreSides, undefined);

  applyEmbeddedModelsToLib(fullSource, bare);
  assert.equal(typeof bare.model.scoreSides, 'function');
  assert.equal(typeof bare.model.directionProbability, 'function');
});

test('composeStrategyJsFromGls upgrades legacy Strategy JS without dependencies', () => {
  const legacy = `export default strategy({
    name: "Legacy",
    params: {},
    onTick(ctx) {
      const { tick, event, samples } = ctx;
      model.scoreSides(samples, tick, event, {});
    },
  });`;
  const upgraded = composeStrategyJsFromGls(legacy);
  assert.ok(upgraded.includes('function createLibrary'));
  assert.ok(!/dependencies\s*:/.test(upgraded));
  const result = compileStrategyJs(upgraded);
  assert.equal(result.ok, true, result.errors?.map((e) => e.message).join('; '));
  assert.ok(result.compiled.generated_source?.onTick);
  assert.equal(result.compiled.compile_book_depth, 25);
});

test('createStrategyVersion composes full editor source when saving GLS with model.*', () => {
  const dir = path.join(os.tmpdir(), `strategy-save-gls-${Date.now()}`);
  const db = openStateDatabase(path.join(dir, 'state.db'));
  try {
    const strategy = createStrategy(db, { slug: 'save-gls-compose', name: 'Save GLS Compose' });
    const gls = `strategy "Needs Models" {
      onTick(tick, event) {
        let scores = model.scoreSides(samples, tick, event, params)
      }
    }`;
    const version = createStrategyVersion(db, strategy.id, { source_code: gls });
    assert.equal(version.language, 'strategy-js-v1');
    assert.ok(version.source_code.includes('function createLibrary'));
    assert.ok(!/dependencies\s*:/.test(version.source_code));
    assert.equal(version.validation.ok, true);
    assert.deepEqual(version.validation.inlined_models, ['edge-sniper-models']);
  } finally {
    closeStateDatabase(db);
  }
});

test('edge sniper GLS port compiles with inlined models in editor source', () => {
  const converted = composeStrategyJsFromGls(getEdgeSniperV2GlsSource());
  const validation = compileStrategyJs(converted);
  assert.equal(validation.ok, true, validation.errors?.map((e) => e.message).join('; '));
  const artifact = buildCompiledArtifact(converted);
  assert.ok(artifact?.generated_source?.onTick);
  assert.ok(detectEmbeddedModels(converted));
  assert.equal(validation.editable_logic, true);
});

test('resolveVersionForBacktest exposes embedded models for composed edge sniper', () => {
  const source = composeStrategyJsFromGls(getEdgeSniperV2GlsSource());
  const resolved = resolveVersionForBacktest({
    language: 'strategy-js-v1',
    source_code: source,
  }, { bookDepth: 25 });
  assert.equal(resolved.embeddedModels, true);
  assert.ok(resolved.strategySourceCode?.includes('function createLibrary'));
  assert.ok(resolved.generatedSource?.onTick);
  const lib = createStandardLibrary();
  applyEmbeddedModelsToLib(resolved.strategySourceCode, lib);
  assert.equal(typeof lib.model.scoreSides, 'function');
});