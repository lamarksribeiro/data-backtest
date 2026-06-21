#!/usr/bin/env node
/**
 * Porta runners do polymarket-test (read-only) para labs/legacy/strategy-runners/portable/
 * e gera data/strategy-libraries/*.json + labs/strategies/* manifests.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POLYMARKET_TEST_ROOT,
  allRunnerEntries,
  PORTFOLIO_RUNNERS,
  fullPortCatalog,
} from './port-catalog.js';
import { composeLibraryRunnerStrategyJs } from '../src/backtestStudio/strategyJs/composeLibraryRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORTABLE_DIR = path.join(ROOT, 'labs/legacy/strategy-runners/portable');
const LIB_DIR = path.join(ROOT, 'data/strategy-libraries');
const LABS_DIR = path.join(ROOT, 'labs/strategies');
const CATALOG_PATH = path.join(LABS_DIR, '_catalog/port-catalog.json');
const STOP_REVERSE_SRC = path.join(ROOT, 'src/backtestStudio/strategyLibrary/runtime/stopReverse.js');

function readStopReverseBundle() {
  return readFileSync(STOP_REVERSE_SRC, 'utf8')
    .replace(/^export /gm, '');
}

function stripModuleSyntax(source) {
  return source
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
    .replace(/export async function run\w+BacktestInBatches[\s\S]*$/m, '')
    .replace(/export function run\w+Backtest\([\s\S]*?(?=\n\n|$)/gm, '')
    .replace(/applyPolymarketFeesToBacktestResult\([^)]*\);?\n?/g, '')
    .replace(/^\s*const __dirname[\s\S]*?CALIBRATION_PATH[\s\S]*?;\n/gm, '')
    .replace(/let calibrationData = null;[\s\S]*?(?=const DEFAULT_PARAMS)/m, '');
}

function injectCalibration(source, calibrationPath) {
  if (!calibrationPath) return source;
  const abs = path.join(POLYMARKET_TEST_ROOT, calibrationPath);
  const data = JSON.parse(readFileSync(abs, 'utf8'));
  const cleaned = source
    .replace(/let calibrationData = null;[\s\S]*?(?=const DEFAULT_PARAMS)/m, '')
    .replace(/^const calibrationData = [\s\S]*?;\s*/m, '');
  return `const calibrationData = ${JSON.stringify(data)};\n\n${cleaned}`;
}

function transformRunnerSource(source, entry) {
  let code = stripModuleSyntax(source);
  code = injectCalibration(code, entry.calibrationFile);
  if (entry.createFn) {
    code = code.replace(
      new RegExp(`function ${entry.createFn}`, 'g'),
      'function createBacktestRunner',
    );
  }
  return code;
}

function transformPortfolioSource(source, entry) {
  let code = stripModuleSyntax(source);
  code = code
    .replace(/^import \{ create\w+BacktestRunner \} from .*$/gm, '')
    .replace(/,\s*createRunner: create\w+BacktestRunner/g, '')
    .replace(/function createFusionFiveBacktestRunner/g, 'function createBacktestRunner')
    .replace(/function createOmniEdgeBacktestRunner/g, 'function createBacktestRunner');

  const slugMap = Object.fromEntries(entry.modules.map((m) => [m.key, m.slug]));
  const slugMapLiteral = JSON.stringify(slugMap, null, 2);

  code = code.replace(
    /function createBacktestRunner\(rawParams = \{\}\)/,
    'function createBacktestRunner(rawParams = {}, loadChildRunner)',
  );

  const childLoaderBlock = `const __MODULE_SLUGS__ = ${slugMapLiteral};`;

  if (/const moduleRunners = MODULES\.map/.test(code)) {
    code = code.replace(
      /const moduleRunners = MODULES\.map\(\(module\) => \(\{[\s\S]*?\}\)\);/,
      `${childLoaderBlock}
  const moduleRunners = MODULES.map((module) => ({
    ...module,
    runner: loadChildRunner(__MODULE_SLUGS__[module.key], 1, params[module.paramsKey] || {}),
  }));`,
    );
  }

  if (/definition\.createRunner/.test(code)) {
    code = code.replace(
      /const runners = activeModules\.map\(\(definition\) => \(\{[\s\S]*?\}\)\);/,
      `${childLoaderBlock}
  const runners = activeModules.map((definition) => ({
    key: definition.key,
    name: definition.name,
    definition,
    runner: loadChildRunner(__MODULE_SLUGS__[definition.key], 1, params[definition.paramsKey] || {}),
  }));`,
    );
  }

  return code;
}

function extractDefaultParams(source) {
  const match = source.match(/const DEFAULT_PARAMS = (\{[\s\S]*?\n\});/);
  if (!match) return {};
  try {
    return new Function(`return ${match[1]}`)();
  } catch {
    return {};
  }
}

function buildLibraryEntry(entry, sourceCode, extraValidation = {}) {
  return {
    slug: entry.runnerSlug,
    name: entry.name,
    description: `Ported from polymarket-test ${entry.sourceFile} (read-only source)`,
    version: 1,
    source_code: sourceCode,
    validation: {
      ok: true,
      kind: extraValidation.kind || 'runner',
      ...extraValidation,
    },
  };
}

function ensureLabPackage(entry, defaults) {
  const strategyRoot = path.join(LABS_DIR, entry.family, entry.id);
  mkdirSync(strategyRoot, { recursive: true });

  const strategyJs = composeLibraryRunnerStrategyJs({
    name: entry.name,
    runnerSlug: entry.runnerSlug,
    params: defaults,
    strategyLabel: entry.strategyLabel,
  });

  const manifest = {
    id: entry.id,
    name: entry.name,
    family: entry.family,
    status: entry.promotedToStudio ? 'candidate' : 'draft',
    kind: entry.tier === 'C' ? 'portfolio-runner' : 'library-runner',
    assets: ['BTC'],
    intervals: ['5m'],
    requiresBook: true,
    defaultBookDepth: 25,
    source: {
      type: 'library-runner',
      runnerSlug: entry.runnerSlug,
      runnerVersion: 1,
    },
    portStatus: 'ported',
    sourceRepo: 'polymarket-test',
    sourceService: entry.sourceFile,
    promotedToStudio: Boolean(entry.promotedToStudio),
    studioSlug: entry.promotedToStudio ? entry.id : undefined,
    studio: entry.promotedToStudio ? {
      description: `${entry.name} portado do polymarket-test via library-runner.`,
      tags: [entry.id, 'ported', 'btc'],
      defaultVersion: 1,
    } : undefined,
    notes: `Runner: ${entry.runnerSlug}@1. Origem read-only: polymarket-test/${entry.sourceFile}`,
  };

  writeFileSync(path.join(strategyRoot, 'strategy.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(strategyRoot, 'defaults.json'), `${JSON.stringify(defaults, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(strategyRoot, 'strategy.js'), `${strategyJs}\n`, 'utf8');

  if (entry.promotedToStudio) {
    const presetsDir = path.join(strategyRoot, 'presets');
    mkdirSync(presetsDir, { recursive: true });
    writeFileSync(path.join(presetsDir, 'manifest.json'), `${JSON.stringify({ presets: ['v1'] }, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(presetsDir, 'v1.json'), `${JSON.stringify({
      id: 'v1',
      name: 'Default',
      studioVersion: 1,
      params: {},
    }, null, 2)}\n`, 'utf8');
  }
}

function buildPortfolioLibrary(entry, orchestratorCode) {
  const sourceCode = transformPortfolioSource(orchestratorCode, entry);
  return buildLibraryEntry(entry, sourceCode, {
    kind: 'portfolio',
    modules: entry.modules,
  });
}

function main() {
  mkdirSync(PORTABLE_DIR, { recursive: true });
  mkdirSync(LIB_DIR, { recursive: true });
  mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });

  const stopReverse = readStopReverseBundle();
  const built = [];

  for (const entry of allRunnerEntries()) {
    const srcPath = path.join(POLYMARKET_TEST_ROOT, 'src/services', entry.sourceFile);
    if (!existsSync(srcPath)) {
      console.warn(`[skip] missing source ${srcPath}`);
      continue;
    }
    const raw = readFileSync(srcPath, 'utf8');
    const defaults = extractDefaultParams(raw);
    let runnerBody = transformRunnerSource(raw, entry);
    const sourceCode = entry.usesStopReverse
      ? `${stopReverse}\n${runnerBody}`
      : runnerBody;

    const portablePath = path.join(PORTABLE_DIR, `${entry.runnerSlug}.js`);
    writeFileSync(portablePath, `${sourceCode}\n`, 'utf8');

    const lib = buildLibraryEntry(entry, sourceCode);
    writeFileSync(path.join(LIB_DIR, `${entry.runnerSlug}.v1.json`), `${JSON.stringify(lib, null, 2)}\n`, 'utf8');

    if (entry.promotedToStudio && entry.tier !== 'module') {
      ensureLabPackage(entry, defaults);
    }
    built.push(entry.runnerSlug);
  }

  for (const entry of PORTFOLIO_RUNNERS) {
    const srcPath = path.join(POLYMARKET_TEST_ROOT, 'src/services', entry.sourceFile);
    const raw = readFileSync(srcPath, 'utf8');
    const defaults = extractDefaultParams(raw);
    const lib = buildPortfolioLibrary(entry, raw);
    writeFileSync(path.join(LIB_DIR, `${entry.runnerSlug}.v1.json`), `${JSON.stringify(lib, null, 2)}\n`, 'utf8');
    ensureLabPackage(entry, defaults);
    built.push(entry.runnerSlug);
  }

  writeFileSync(CATALOG_PATH, `${JSON.stringify(fullPortCatalog(), null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    built,
    catalog: CATALOG_PATH,
    libraries: LIB_DIR,
    portable: PORTABLE_DIR,
  }, null, 2));
}

main();
