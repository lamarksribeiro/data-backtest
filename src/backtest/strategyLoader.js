import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { parse as parseGls } from '../backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../backtestStudio/gls/compiler.js';
import { bindStrategyLibraryDatabase } from '../backtestStudio/nativeLibrary/registry.js';
import { createLibraryRunnerAdapter, LIBRARY_RUNNER_COLUMN_ANALYSIS } from '../backtestStudio/strategyLibrary/runnerAdapter.js';
import { createPortfolioRunnerAdapter, PORTFOLIO_RUNNER_COLUMN_ANALYSIS } from '../backtestStudio/strategyLibrary/portfolioRunnerAdapter.js';
import { createEmbeddedRunnerAdapter, EMBEDDED_RUNNER_COLUMN_ANALYSIS } from '../backtestStudio/strategyJs/embeddedRunnerAdapter.js';
import { findRunnerDependency } from '../backtestStudio/strategyLibrary/kind.js';
import { ensureStrategyLibraryDatabase } from '../backtestStudio/nativeLibrary/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveRunnerDatabase(requestDb) {
  return requestDb?.prepare ? requestDb : ensureStrategyLibraryDatabase();
}

function buildGlsStrategyLoad(glsAst, request, config) {
  if (request.embeddedRunner && request.strategySourceCode) {
    const bookDepth = request.bookDepth ?? config.backtestBookDepth;
    return {
      kind: 'embedded-runner',
      glsAst,
      columnAnalysis: request.columnAnalysis ?? EMBEDDED_RUNNER_COLUMN_ANALYSIS,
      createRunner: (params, runnerOptions) => createEmbeddedRunnerAdapter(request.strategySourceCode, params, {
        ...runnerOptions,
        bookDepth,
      }),
    };
  }

  const runnerDep = request.runnerLibrary;
  if (runnerDep) {
    const runnerDb = resolveRunnerDatabase(request.db);
    bindStrategyLibraryDatabase(runnerDb);
    const isPortfolio = runnerDep.kind === 'portfolio';
    return {
      kind: isPortfolio ? 'portfolio-runner' : 'library-runner',
      glsAst,
      columnAnalysis: request.columnAnalysis ?? (isPortfolio ? PORTFOLIO_RUNNER_COLUMN_ANALYSIS : LIBRARY_RUNNER_COLUMN_ANALYSIS),
      createRunner: (params, runnerOptions) => {
        const adapterFactory = isPortfolio ? createPortfolioRunnerAdapter : createLibraryRunnerAdapter;
        return adapterFactory(runnerDb, runnerDep, params, {
          ...runnerOptions,
          bookDepth: request.bookDepth ?? config.backtestBookDepth,
        });
      },
    };
  }

  const executionMode = request.glsExecution ?? (config.backtestEngine === 'soa' ? 'compiled-soa' : config.glsExecution);
  const columnAnalysis = request.columnAnalysis ?? analyzeStrategyColumns(glsAst, request.bookDepth ?? 25);
  return {
    kind: 'gls',
    glsAst,
    columnAnalysis,
    createRunner: (params, runnerOptions) => createGlsBacktestRunner(glsAst, params, {
      ...runnerOptions,
      executionMode,
      extensionLibraries: request.embeddedModels ? [] : request.extensionLibraries,
      generatedSource: request.generatedSource,
      embeddedModels: request.embeddedModels ?? false,
      embeddedModelsSource: request.embeddedModels ? request.strategySourceCode : null,
      strategySourceCode: request.strategySourceCode ?? null,
      db: request.db,
    }),
  };
}

function resolveStrategyPath(strategyIdent) {
  if (strategyIdent.startsWith('file:///')) {
    return fileURLToPath(strategyIdent);
  }
  return path.resolve(strategyIdent);
}

export async function loadStrategy(request, config = {}) {
  if (request.glsAst) {
    return buildGlsStrategyLoad(request.glsAst, request, config);
  }

  const strategyIdent = request.strategy;
  if (!strategyIdent) {
    throw new Error('No strategy identifier specified in request');
  }

  if (strategyIdent.endsWith('.gls') || strategyIdent.startsWith('gls:')) {
    const allowFile = config.TEST_MODE || request.allowFileStrategy === true;
    if (!allowFile) {
      throw new Error('File-based GLS strategies are disabled in production. Use strategy_id and strategy_version_id from SQLite.');
    }
    const cleanIdent = strategyIdent.startsWith('gls:') ? strategyIdent.slice(4) : strategyIdent;
    let filePath;
    try {
      filePath = resolveStrategyPath(cleanIdent);
    } catch {
      filePath = path.resolve(__dirname, '../backtestStudio/gls/strategies', `${cleanIdent}.gls`);
    }

    const sourceCode = readFileSync(filePath, 'utf8');
    const glsAst = parseGls(sourceCode);
    return buildGlsStrategyLoad(glsAst, request, config);
  }

  const allowModule = config.TEST_MODE || request.allowFileStrategy === true;
  if (!allowModule) {
    throw new Error('File-based strategy modules are disabled in production. Use strategy_id and strategy_version_id from SQLite.');
  }

  const resolvedPath = resolveStrategyPath(strategyIdent);
  const fileUrl = pathToFileURL(resolvedPath).href;

  let module;
  try {
    module = await import(fileUrl);
  } catch (err) {
    throw new Error(`Failed to load strategy module from ${resolvedPath}: ${err.message}`);
  }

  let createRunner = null;
  if (typeof module.default === 'function') {
    createRunner = module.default;
  } else if (typeof module.createRunner === 'function') {
    createRunner = module.createRunner;
  } else {
    for (const key of Object.keys(module)) {
      if (key.startsWith('create') && typeof module[key] === 'function') {
        createRunner = module[key];
        break;
      }
    }
  }

  if (!createRunner) {
    throw new Error(`Strategy module at ${resolvedPath} does not export a runner factory function`);
  }

  const requiresBook = module.requiresBook ?? false;
  const defaultBookDepth = module.defaultBookDepth ?? 25;
  const columnAnalysis = module.columnAnalysis ?? {
    needsBookLevels: requiresBook,
    bookDepth: requiresBook ? defaultBookDepth : 0,
    scalarColumns: module.scalarColumns ?? null,
  };

  return {
    kind: 'javascript',
    columnAnalysis,
    createRunner,
  };
}

export function resolveRunnerLibraryFromDependencies(db, dependencies = []) {
  if (!db) return null;
  return findRunnerDependency(db, dependencies);
}