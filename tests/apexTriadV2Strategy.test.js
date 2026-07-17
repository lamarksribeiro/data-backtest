import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { validateAst } from '../src/backtestStudio/gls/validator.js';

const STRATEGY_FILE = 'labs/strategies/portfolio/apex-triad-v2/strategy.gls';
const DEFAULTS_FILE = 'labs/strategies/portfolio/apex-triad-v2/defaults.json';

test('Apex Triad V2 GLS parses and validates', () => {
  const ast = parse(readFileSync(STRATEGY_FILE, 'utf8'));
  const validation = validateAst(ast);
  assert.equal(validation.ok, true, validation.errors?.map((error) => error.message).join('\n'));
  assert.equal(ast.name, 'Apex Triad V2');
});

test('Apex Triad V2 has relative stop parameters in defaults', () => {
  const defaults = JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8'));
  assert.equal(defaults.edgeStopRelative, true);
  assert.equal(defaults.edgeStopDelta, 0.12);
  assert.equal(defaults.makerFillPolicy, 'level-capped');
  assert.equal(defaults.profitLockEnabled, false);
});
