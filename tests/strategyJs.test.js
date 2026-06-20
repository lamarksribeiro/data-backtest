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
  validateStrategySource,
} from '../src/backtestStudio/state/strategies.js';
import { compileStrategyJs, glsToStrategyJs, getRuntimeCapabilities } from '../src/backtestStudio/strategyJs/index.js';
import { composeStrategyJsFromGls } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import { parse as parseGls } from '../src/backtestStudio/gls/parser.js';
import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { createGlsRunnerFromSource } from '../src/backtestStudio/gls/runtime.js';

const MINIMAL_STRATEGY_JS = `export default strategy({
  name: "Distance Entry",
  params: { minDistanceAbs: 50, maxAsk: 0.58, budget: 15 },
  onEventStart({ state }) { state.entered = false; },
  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    const dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat);
    const side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat);
    const ask = book.ask(side, tick);
    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      orders.enter(side, { price: ask, budget: params.budget, reason: "entry" });
      state.entered = true;
      trace.mark("entry");
    }
  },
  onEventEnd() { orders.closeOpenPosition({ reason: "event_end" }); },
});`;

const GLS_EQUIVALENT = `strategy "Distance Entry" {
  param minDistanceAbs = 50
  param maxAsk = 0.58
  param budget = 15
  onEventStart(event) { state.entered = false }
  onTick(tick, event) {
    let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let ask = book.ask(side, tick)
    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      enter(side, { price: ask, budget: params.budget, reason: "entry" })
      state.entered = true
      mark("entry")
    }
  }
  onEventEnd(event) { closeOpenPosition({ reason: "event_end" }) }
}`;

test('compileStrategyJs accepts minimal export default strategy', () => {
  const result = compileStrategyJs(MINIMAL_STRATEGY_JS);
  assert.equal(result.ok, true);
  assert.equal(result.language, 'strategy-js-v1');
  assert.equal(result.compile.mode, 'compiled-soa');
  assert.ok(result.column_analysis.scalarColumns.includes('underlying_price'));
  assert.equal(result.parallelism.parallelSafe, true);
});

test('compileStrategyJs rejects import', () => {
  const result = compileStrategyJs(`import fs from "node:fs";\n${MINIMAL_STRATEGY_JS}`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'FORBIDDEN_IMPORT'));
});

test('compileStrategyJs rejects require eval async Date.now Math.random', () => {
  for (const snippet of [
    'require("fs");',
    'eval("1");',
    'async function onTick() {}',
    'Date.now();',
    'Math.random();',
  ]) {
    const src = MINIMAL_STRATEGY_JS.replace('onTick(ctx)', `onTick(ctx) { ${snippet} `);
    const result = compileStrategyJs(src);
    assert.equal(result.ok, false, `expected failure for: ${snippet}`);
  }
});

test('compileStrategyJs rejects dynamic tick access', () => {
  const src = MINIMAL_STRATEGY_JS.replace(
    'tick.underlyingPrice',
    'tick[field]',
  ).replace('const { tick, event, state, params } = ctx;', 'const { tick, event, state, params } = ctx; const field = "underlyingPrice";');
  const result = compileStrategyJs(src);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'FORBIDDEN_DYNAMIC_TICK_ACCESS'));
});

test('glsToStrategyJs converts simple GLS', () => {
  const converted = glsToStrategyJs(GLS_EQUIVALENT);
  assert.match(converted, /export default strategy\(/);
  assert.match(converted, /minDistanceAbs: 50/);
  const validation = compileStrategyJs(converted);
  assert.equal(validation.ok, true);
});

test('Strategy JS vs GLS equivalent interpreter parity on synthetic tick', () => {
  const ticks = [
    {
      condition_id: 'condition-1',
      event_start: '2026-05-31T00:00:00.000Z',
      event_end: '2026-05-31T00:05:00.000Z',
      ts: '2026-05-31T00:01:00.000Z',
      btc_price: 105000,
      price_to_beat: 104900,
      up_best_ask: 0.45,
      down_best_ask: 0.55,
      up_best_bid: 0.44,
      down_best_bid: 0.54,
    },
  ];

  const runOnce = (source) => {
    const runner = createGlsRunnerFromSource(source, {}, { executionMode: 'interpreter' });
    for (const tick of ticks) runner.processTick(tick);
    return runner.finish();
  };

  const jsOut = runOnce(MINIMAL_STRATEGY_JS);
  const glsOut = runOnce(GLS_EQUIVALENT);
  assert.equal(jsOut.events.length, glsOut.events.length);
  assert.equal(jsOut.events[0]?.orders?.length, glsOut.events[0]?.orders?.length);
});

test('createStrategyVersion persists compiled_json for Strategy JS', () => {
  const dir = path.join(os.tmpdir(), `strategy-js-db-${Date.now()}`);
  const db = openStateDatabase(path.join(dir, 'state.db'));
  try {
    const strategy = createStrategy(db, { slug: 'js-test', name: 'JS Test' });
    const version = createStrategyVersion(db, strategy.id, {
      language: 'strategy-js-v1',
      source_code: MINIMAL_STRATEGY_JS,
    });
    assert.equal(version.validation.ok, true);
    assert.ok(version.compiled);
    assert.equal(version.compiled.compiler_version, 'compiler-soa-v2');
    assert.ok(version.compiled.ir_json);
    assert.ok(version.compiled.generated_source?.onTick);
    assert.equal(version.language, 'strategy-js-v1');
  } finally {
    closeStateDatabase(db);
  }
});

test('auto-detect language for GLS source in validateStrategySource', () => {
  const result = validateStrategySource({ source_code: GLS_EQUIVALENT });
  assert.equal(result.ok, true);
  assert.equal(result.language, 'gls-v1');
});

test('API exposes strategy runtime capabilities and convert endpoint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strategy-js-api-'));
  let server = null;
  try {
    const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const base = `http://127.0.0.1:${server.address().port}`;

      const caps = await fetch(`${base}/api/strategy-runtime/capabilities`).then((r) => r.json());
      assert.ok(caps.languages.includes('strategy-js-v1'));
      assert.equal(caps.default_language, 'strategy-js-v1');
      assert.ok(caps.ai_contract);

      const converted = await fetch(`${base}/api/strategies/convert-to-strategy-js`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_code: GLS_EQUIVALENT }),
      }).then((r) => r.json());
      assert.equal(converted.language, 'strategy-js-v1');
      assert.match(converted.source_code, /export default strategy/);

      const validation = await fetch(`${base}/api/strategies/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_code: MINIMAL_STRATEGY_JS, language: 'strategy-js-v1' }),
      }).then((r) => r.json());
      assert.equal(validation.validation.ok, true);
      assert.ok(validation.validation.column_analysis);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('getRuntimeCapabilities matches architecture contract', () => {
  const caps = getRuntimeCapabilities();
  assert.deepEqual(caps.syntax.allowedHooks, ['onEventStart', 'onTick', 'onEventEnd']);
  assert.ok(caps.template.includes('export default strategy'));
});

test('glsToStrategyJs converts Edge Sniper V2 GLS header', () => {
  const source = getEdgeSniperV2GlsSource();
  const converted = composeStrategyJsFromGls(source);
  const validation = compileStrategyJs(converted);
  assert.equal(validation.ok, true, validation.errors?.map((e) => e.message).join('; '));
  const ast = parseGls(source);
  assert.ok(ast.params.length > 10);
});