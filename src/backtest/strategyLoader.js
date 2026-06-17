import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { parse as parseGls } from '../backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../backtestStudio/gls/compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveStrategyPath(strategyIdent) {
  if (strategyIdent.startsWith('file:///')) {
    return fileURLToPath(strategyIdent);
  }
  return path.resolve(strategyIdent);
}

/**
 * Carrega metadados e factory de uma estratégia para execução de backtest.
 * Runtime não usa registry fixo em código — estratégias vivem no SQLite (GLS) ou path explícito.
 */
export async function loadStrategy(request, config = {}) {
  if (request.glsAst) {
    const glsAst = request.glsAst;
    const executionMode = request.glsExecution ?? (config.backtestEngine === 'soa' ? 'compiled-soa' : config.glsExecution);
    const columnAnalysis = request.columnAnalysis ?? analyzeStrategyColumns(glsAst, request.bookDepth ?? 25);

    return {
      kind: 'gls',
      glsAst,
      columnAnalysis,
      createRunner: (params, options) => createGlsBacktestRunner(glsAst, params, {
        ...options,
        executionMode,
        extensionLibraries: request.extensionLibraries,
      }),
    };
  }

  const strategyIdent = request.strategy;
  if (!strategyIdent) {
    throw new Error('No strategy identifier specified in request');
  }

  if (strategyIdent.endsWith('.gls') || strategyIdent.startsWith('gls:')) {
    const cleanIdent = strategyIdent.startsWith('gls:') ? strategyIdent.slice(4) : strategyIdent;
    let filePath;
    try {
      filePath = resolveStrategyPath(cleanIdent);
    } catch {
      filePath = path.resolve(__dirname, '../backtestStudio/gls/strategies', `${cleanIdent}.gls`);
    }

    const sourceCode = readFileSync(filePath, 'utf8');
    const glsAst = parseGls(sourceCode);
    const executionMode = request.glsExecution ?? (config.backtestEngine === 'soa' ? 'compiled-soa' : config.glsExecution);
    const columnAnalysis = request.columnAnalysis ?? analyzeStrategyColumns(glsAst, request.bookDepth ?? 25);

    return {
      kind: 'gls',
      glsAst,
      columnAnalysis,
      createRunner: (params, options) => createGlsBacktestRunner(glsAst, params, {
        ...options,
        executionMode,
      }),
    };
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
