import { createHash } from 'node:crypto';

import { validateAst } from '../gls/validator.js';
import { analyzeStrategyColumns, analyzeStrategyParallelism } from '../gls/compiler.js';
import { extractParamsSchema } from '../gls/parser.js';

import {
  COMPILER_VERSION,
  LANGUAGE,
  LANGUAGE_VERSION,
  STDLIB_VERSION,
} from './constants.js';
import { parseStrategyJs, extractStrategyConfig } from './parser.js';
import { validateSecurity } from './validator.js';
import { lowerToGlsAst } from './lowerToGlsAst.js';
import { extractHelperFunctions, inlineHelpersInConfig } from './inlineHelpers.js';
import { buildSoaGeneratedSource } from '../gls/compilerSoa.js';
import { findRunnerDependency } from '../strategyLibrary/kind.js';
import { detectEmbeddedRunner } from './embeddedRunner.js';
import { detectEmbeddedModels } from './embeddedModels.js';
import { EMBEDDED_RUNNER_COLUMN_ANALYSIS } from './embeddedRunnerAdapter.js';

export function compileStrategyJs(source, { bookDepth = 25, db = null } = {}) {
  const started = Date.now();
  const code = String(source || '').trim();

  if (!code) {
    return fail([{ line: 1, column: 1, code: 'EMPTY_SOURCE', message: 'source_code is required' }]);
  }

  let parsed;
  try {
    parsed = parseStrategyJs(code);
  } catch (err) {
    return fail([{
      line: err.line || 1,
      column: err.column || 1,
      code: err.code || 'SYNTAX_ERROR',
      message: err.message,
    }]);
  }

  const config = extractStrategyConfig(parsed.strategyCall);
  const helpers = extractHelperFunctions(parsed.program);
  const embeddedEarly = detectEmbeddedRunner(code);
  const embeddedModelsEarly = embeddedEarly ? null : detectEmbeddedModels(code);
  const { errors: securityErrors, warnings } = validateSecurity(parsed.program, config, {
    helperNames: [...helpers.keys()],
    db,
    embeddedRunner: Boolean(embeddedEarly),
    embeddedModels: Boolean(embeddedModelsEarly),
  });

  if (securityErrors.length > 0) {
    return fail(securityErrors, warnings);
  }

  const embedded = detectEmbeddedRunner(code);
  if (embedded) {
    return compileEmbeddedStrategyJs(code, config, embedded, { warnings, bookDepth, started });
  }

  const inlinedConfig = inlineHelpersInConfig(config, helpers);

  let glsAst;
  try {
    glsAst = lowerToGlsAst(inlinedConfig);
  } catch (err) {
    return fail([{
      line: err.line || 1,
      column: err.column || 1,
      code: err.code || 'LOWERING_ERROR',
      message: err.message,
    }], warnings);
  }

  const glsValidation = validateAst(glsAst, { language: 'gls-v1' });
  if (!glsValidation.ok) {
    return {
      ok: false,
      errors: glsValidation.errors,
      warnings: [...warnings, ...glsValidation.warnings],
      language: LANGUAGE,
    };
  }

  const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);
  const parallelism = analyzeStrategyParallelism(glsAst);
  const columnCheck = validateColumnAnalysisComplete(glsAst, columnAnalysis);
  if (!columnCheck.ok) {
    return fail(columnCheck.errors, warnings);
  }

  const compileMs = Date.now() - started;
  const sourceChecksum = checksum(code);
  const irChecksum = checksum(JSON.stringify(glsAst));
  const generated_source = buildSoaGeneratedSource(glsAst, bookDepth);

  const compiled = {
    language: LANGUAGE,
    source_checksum: sourceChecksum,
    language_version: LANGUAGE_VERSION,
    stdlib_version: STDLIB_VERSION,
    compiler_version: COMPILER_VERSION,
    ir_checksum: irChecksum,
    ir_json: glsAst,
    generated_source,
    compile_book_depth: bookDepth,
    dependencies: config.dependencies || [],
    column_analysis: columnAnalysis,
    parallelism,
    compile: {
      ok: true,
      mode: 'compiled-soa',
      compileMs,
    },
  };

  const dependencies = config.dependencies || [];
  const runnerLibrary = db ? findRunnerDependency(db, dependencies) : null;
  const embeddedModels = detectEmbeddedModels(code);
  const executionKind = runnerLibrary ? 'library-runner' : 'compiled-soa';

  return {
    ok: true,
    errors: [],
    warnings,
    params_schema: extractParamsSchema(glsAst),
    dependencies,
    column_analysis: columnAnalysis,
    parallelism,
    compile: compiled.compile,
    execution_kind: executionKind,
    editable_logic: embeddedModels ? true : !runnerLibrary,
    inlined_models: embeddedModels ? [embeddedModels.library] : [],
    runner_library: runnerLibrary,
    ast: glsAst,
    compiled,
    language: LANGUAGE,
  };
}

function validateColumnAnalysisComplete(ast, analysis) {
  const errors = [];
  const usedTickProps = collectTickProps(ast);
  for (const prop of usedTickProps) {
    const col = tickPropToColumn(prop);
    if (col && !analysis.scalarColumns.includes(col)) {
      errors.push({
        line: 1,
        column: 1,
        code: 'COLUMN_ANALYSIS_INCOMPLETE',
        message: `Column analysis could not map tick.${prop}`,
        fix_hint: 'Use only known tick properties with static access.',
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function collectTickProps(ast) {
  const props = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Member' && node.object?.type === 'Identifier' && node.object.name === 'tick') {
      props.add(node.property);
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === 'object') walk(val);
    }
  }
  for (const hook of Object.values(ast.hooks || {})) {
    for (const stmt of hook?.body || []) walk(stmt);
  }
  return props;
}

function tickPropToColumn(prop) {
  const map = {
    underlyingPrice: 'underlying_price',
    priceToBeat: 'price_to_beat',
    upPrice: 'up_price',
    downPrice: 'down_price',
    conditionId: 'condition_id',
    eventStart: 'event_start',
    eventEnd: 'event_end',
    marketId: 'market_id',
    ts: 'ts',
  };
  return map[prop] || null;
}

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function compileEmbeddedStrategyJs(code, config, embedded, { warnings, bookDepth, started }) {
  const glsAst = buildStubGlsAst(config);
  const columnAnalysis = { ...EMBEDDED_RUNNER_COLUMN_ANALYSIS, bookDepth };
  const compileMs = Date.now() - started;
  const sourceChecksum = checksum(code);
  const dependencies = config.dependencies || [];

  const compiled = {
    language: LANGUAGE,
    source_checksum: sourceChecksum,
    language_version: LANGUAGE_VERSION,
    stdlib_version: STDLIB_VERSION,
    compiler_version: COMPILER_VERSION,
    ir_checksum: checksum(JSON.stringify(glsAst)),
    ir_json: glsAst,
    generated_source: null,
    compile_book_depth: bookDepth,
    dependencies,
    column_analysis: columnAnalysis,
    parallelism: { parallelSafe: false, usesRunState: false },
    execution_mode: 'embedded-runner',
    compile: {
      ok: true,
      mode: 'embedded-runner',
      compileMs,
    },
  };

  return {
    ok: true,
    errors: [],
    warnings,
    params_schema: paramsSchemaFromConfig(config),
    dependencies,
    column_analysis: columnAnalysis,
    parallelism: compiled.parallelism,
    compile: compiled.compile,
    execution_kind: 'embedded-runner',
    editable_logic: true,
    embedded_runner: { factoryName: embedded.factoryName },
    ast: glsAst,
    compiled,
    language: LANGUAGE,
  };
}

function buildStubGlsAst(config) {
  return {
    type: 'Strategy',
    name: config.name || 'Embedded Runner Strategy',
    params: config.params || [],
    hooks: {
      onEventStart: { body: [] },
      onTick: { body: [] },
      onEventEnd: { body: [] },
    },
  };
}

function paramsSchemaFromConfig(config) {
  const schema = {};
  for (const param of config.params || []) {
    schema[param.name] = { default: param.default };
  }
  return schema;
}

function fail(errors, warnings = []) {
  return {
    ok: false,
    errors,
    warnings,
    params_schema: {},
    language: LANGUAGE,
  };
}