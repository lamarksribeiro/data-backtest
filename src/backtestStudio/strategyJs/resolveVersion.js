import { createHash } from 'node:crypto';

import { COMPILER_VERSION, LANGUAGE, STDLIB_VERSION } from './constants.js';
import { compileStrategyJs } from './compile.js';
import { getCachedSoaHooks } from './compiledCache.js';
import { dependenciesToExtensionLibraries } from './dependencies.js';
import { findRunnerDependency } from '../strategyLibrary/kind.js';
import { LIBRARY_RUNNER_COLUMN_ANALYSIS } from '../strategyLibrary/runnerAdapter.js';
import { PORTFOLIO_RUNNER_COLUMN_ANALYSIS } from '../strategyLibrary/portfolioRunnerAdapter.js';
import { analyzeStrategyColumns } from '../gls/compiler.js';
import { detectEmbeddedRunner } from './embeddedRunner.js';
import { detectEmbeddedModels } from './embeddedModels.js';
import { parseStrategyJs, extractStrategyConfig } from './parser.js';

function normalizeBuildOptions(options = 25) {
  if (typeof options === 'number') {
    return { bookDepth: options, db: null };
  }
  return {
    bookDepth: options.bookDepth ?? 25,
    db: options.db ?? null,
  };
}

export function buildCompiledArtifact(sourceCode, options = 25) {
  const { bookDepth, db } = normalizeBuildOptions(options);
  const result = compileStrategyJs(sourceCode, { bookDepth, db });
  if (!result.ok) return null;
  return result.compiled;
}

export function resolveRunnerColumnAnalysis(runnerLibrary, bookDepth = 25) {
  if (!runnerLibrary) return null;
  const base = runnerLibrary.kind === 'portfolio'
    ? PORTFOLIO_RUNNER_COLUMN_ANALYSIS
    : LIBRARY_RUNNER_COLUMN_ANALYSIS;
  return { ...base, bookDepth };
}

function resolveStrategyDependencies(version, compiled) {
  const stored = compiled?.dependencies ?? [];
  if (stored.length) return stored;
  try {
    const parsed = parseStrategyJs(version.source_code);
    return extractStrategyConfig(parsed.strategyCall).dependencies ?? [];
  } catch {
    return [];
  }
}

export function isCompiledArtifactValid(compiled, sourceChecksum) {
  if (!compiled || typeof compiled !== 'object') return false;
  if (compiled.source_checksum !== sourceChecksum) return false;
  if (compiled.compiler_version !== COMPILER_VERSION) return false;
  if (compiled.stdlib_version !== STDLIB_VERSION) return false;
  if (!compiled.ir_json) return false;
  if (compiled.compile?.mode === 'embedded-runner') {
    return compiled.compile?.ok === true;
  }
  if (!compiled.generated_source) return false;
  return compiled.compile?.ok === true;
}

export function resolveCompiledStrategy(version, { bookDepth = 25 } = {}) {
  const lang = String(version.language || 'gls-v1').trim();
  if (lang !== LANGUAGE) return null;

  const compiledJson = version.compiled_json
    ? parseJson(version.compiled_json)
    : (version.compiled || null);
  const checksum = version.checksum || checksumSource(version.source_code);

  if (compiledJson && isCompiledArtifactValid(compiledJson, checksum)) {
    const { useGeneratedSource, columnAnalysis } = resolveCachedCodegen(
      compiledJson,
      bookDepth,
    );
    return {
      glsAst: compiledJson.ir_json,
      columnAnalysis,
      parallelism: compiledJson.parallelism,
      compiled: compiledJson,
      compileCacheHit: true,
      extensionLibraries: dependenciesToExtensionLibraries(compiledJson.dependencies || []),
      generatedSource: useGeneratedSource,
      cachedSoaHooks: getCachedSoaHooks(useGeneratedSource),
    };
  }

  const result = compileStrategyJs(version.source_code, { bookDepth });
  if (!result.ok) {
    throw new Error(result.errors[0]?.message || 'Strategy JS compilation failed');
  }

  const { useGeneratedSource, columnAnalysis } = resolveCachedCodegen(
    result.compiled,
    bookDepth,
    result.column_analysis,
  );
  return {
    glsAst: result.ast,
    columnAnalysis,
    parallelism: result.parallelism,
    compiled: result.compiled,
    compileCacheHit: false,
    extensionLibraries: dependenciesToExtensionLibraries(result.compiled?.dependencies || []),
    generatedSource: useGeneratedSource,
    cachedSoaHooks: getCachedSoaHooks(useGeneratedSource),
  };
}

export function resolveVersionForBacktest(version, { bookDepth = 25, db = null } = {}) {
  const lang = String(version.language || 'gls-v1').trim();
  const resolved = resolveCompiledStrategy(version, { bookDepth });
  const dependencies = resolveStrategyDependencies(version, resolved.compiled);
  const embeddedRunner = detectEmbeddedRunner(version.source_code);
  const embeddedModels = embeddedRunner ? null : detectEmbeddedModels(version.source_code);
  const runnerLibrary = (embeddedRunner || embeddedModels) ? null : (db ? findRunnerDependency(db, dependencies) : null);
  const executionKind = embeddedRunner
    ? 'embedded-runner'
    : (runnerLibrary
      ? (runnerLibrary.kind === 'portfolio' ? 'portfolio-runner' : 'library-runner')
      : 'compiled-soa');
  const columnAnalysis = runnerLibrary
    ? resolveRunnerColumnAnalysis(runnerLibrary, bookDepth)
    : resolved.columnAnalysis;
  const strategyLabel = lang === LANGUAGE
    ? (version.source_code.match(/name:\s*["']([^"']+)["']/)?.[1] || version.source_code.match(/name:\s*([^,\n]+)/)?.[1]?.trim())
    : (version.source_code.match(/strategy\s+"([^"]+)"/)?.[1]);

  return {
    glsAst: resolved.glsAst,
    columnAnalysis,
    parallelism: resolved.parallelism,
    extensionLibraries: embeddedModels ? [] : resolved.extensionLibraries,
    compiled: resolved.compiled,
    generatedSource: resolved.generatedSource ?? null,
    runnerLibrary,
    embeddedRunner: Boolean(embeddedRunner),
    embeddedModels: Boolean(embeddedModels),
    strategySourceCode: (embeddedRunner || embeddedModels) ? version.source_code : null,
    strategyMeta: {
      language: lang,
      compilerMode: executionKind,
      execution_kind: executionKind,
      editable_logic: (embeddedRunner || embeddedModels) ? true : !runnerLibrary,
      inlined_models: embeddedModels ? [embeddedModels.library] : [],
      compileCacheHit: resolved.compileCacheHit,
      compileMs: resolved.compiled?.compile?.compileMs ?? null,
      columnsUsed: columnAnalysis?.scalarColumns ?? [],
      bookDepthUsed: columnAnalysis?.bookDepth ?? 0,
      parallelSafe: (embeddedRunner || runnerLibrary) ? false : (resolved.parallelism?.parallelSafe ?? false),
      strategyLabel: strategyLabel || null,
      dependencies,
    },
  };
}

function resolveCachedCodegen(compiled, bookDepth, fallbackColumnAnalysis = null) {
  const needsBook = compiled?.column_analysis?.needsBookLevels === true;
  const compiledAtDepth = compiled?.compile_book_depth
    ?? compiled?.column_analysis?.bookDepth
    ?? bookDepth;
  const depthMatches = !needsBook || compiledAtDepth === bookDepth;
  return {
    useGeneratedSource: depthMatches ? compiled?.generated_source ?? null : null,
    columnAnalysis: depthMatches
      ? (compiled?.column_analysis ?? fallbackColumnAnalysis)
      : analyzeStrategyColumns(compiled?.ir_json, bookDepth),
  };
}

function checksumSource(source) {
  return createHash('sha256').update(String(source)).digest('hex');
}

function parseJson(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}