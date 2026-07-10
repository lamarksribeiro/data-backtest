import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { validateAst } from '../src/backtestStudio/gls/validator.js';

const STRATEGY_FILE = 'labs/strategies/portfolio/apex-triad-v1/strategy.gls';
const DEFAULTS_FILE = 'labs/strategies/portfolio/apex-triad-v1/defaults.json';
const PRESET_FILE = 'labs/strategies/portfolio/apex-triad-v1/presets/btc-candidate-v1.json';

test('Apex Triad GLS parses and validates', () => {
  const ast = parse(readFileSync(STRATEGY_FILE, 'utf8'));
  const validation = validateAst(ast);
  assert.equal(validation.ok, true, validation.errors?.map((error) => error.message).join('\n'));
  assert.equal(ast.name, 'Apex Triad V1');
});

test('Apex Triad candidate freezes honest execution and disabled maker lock', () => {
  const defaults = JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8'));
  const preset = JSON.parse(readFileSync(PRESET_FILE, 'utf8'));
  assert.equal(defaults.edgeBudgetFactor, 0.75);
  assert.equal(defaults.makerFillPolicy, 'level-capped');
  assert.equal(defaults.profitLockEnabled, false);
  assert.equal(preset.role, 'candidate');
  assert.equal(preset.params.profitLockEnabled, false);
  assert.equal(preset.labSummary.status, 'candidate_not_champion');
});
