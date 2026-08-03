import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { validate } from '../src/backtestStudio/gls/validator.js';
import { runHyperionStrategy, mergeHyperionParams } from '../src/strategies/hyperionV1.js';

test('hyperion-v1 GLS source validates and parses clean AST', () => {
  const glsPath = path.resolve('src/backtestStudio/gls/strategies/hyperionV1.gls');
  const source = readFileSync(glsPath, 'utf8');

  const validation = validate(source);
  assert.equal(validation.ok, true, validation.errors?.map((e) => e.message).join('; '));

  const ast = parse(source);
  assert.equal(ast.name, 'Hyperion V1 GLS');
  assert.ok(ast.params.length >= 10);
});

test('hyperion-v1 JS strategy merges params and runs on synthetic ticks', () => {
  const params = mergeHyperionParams({ minEdge: 0.05 });
  assert.equal(params.minEdge, 0.05);

  const event = {
    start: 1000,
    end: 301000,
    priceToBeat: 70000,
  };

  const ticks = [
    {
      ts: 50000,
      underlyingPrice: 70150,
      up_best_ask: 0.45,
      up_best_bid: 0.44,
      up_ask_sz_1: 100,
      up_bid_sz_1: 50,
      down_best_ask: 0.54,
      down_best_bid: 0.53,
    },
  ];

  const result = runHyperionStrategy(event, ticks, params);
  assert.ok(result);
  assert.ok(Array.isArray(result.traces));
});
