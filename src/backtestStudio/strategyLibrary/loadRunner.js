import { createHash } from 'node:crypto';

import { patchRunnerSourceForSoaRuntime } from './runtime/runnerPreamble.js';
import { getStrategyLibraryValidation } from './kind.js';

const runnerCache = new Map();

export function loadStrategyLibraryRunner(db, slug, version = 1, params = {}, options = {}) {
  const key = `${slug}:${version}:${createHash('sha256').update(JSON.stringify(params || {})).digest('hex')}`;
  if (runnerCache.has(key)) return runnerCache.get(key);

  const row = db.prepare(`
    SELECT slv.source_code, slv.checksum, slv.validation_json
    FROM strategy_library_versions slv
    JOIN strategy_library_definitions sld ON sld.id = slv.library_id
    WHERE sld.slug = ? AND slv.version = ?
    ORDER BY slv.id DESC
    LIMIT 1
  `).get(slug, Number(version));

  if (!row?.source_code) return null;

  const checksum = createHash('sha256').update(String(row.source_code)).digest('hex');
  if (checksum !== row.checksum) {
    throw new Error(`strategy library runner checksum mismatch for ${slug}@${version}`);
  }

  let validation = null;
  try {
    validation = row.validation_json ? JSON.parse(row.validation_json) : getStrategyLibraryValidation(db, slug, version);
  } catch {
    validation = getStrategyLibraryValidation(db, slug, version);
  }

  const childLoader = options.loadChildRunner
    || ((childSlug, childVersion, childParams) => loadStrategyLibraryRunner(db, childSlug, childVersion, childParams));

  const runner = compileRunnerModule(patchRunnerSourceForSoaRuntime(row.source_code), params, `${slug}@${version}`, {
    portfolio: validation?.kind === 'portfolio',
    loadChildRunner: childLoader,
  });
  runnerCache.set(key, runner);
  return runner;
}

export function clearStrategyLibraryRunnerCache() {
  runnerCache.clear();
}

function compileRunnerModule(sourceCode, params, label, { portfolio = false, loadChildRunner = null } = {}) {
  const code = String(sourceCode || '').trim();
  let factory;
  try {
    if (portfolio) {
      factory = new Function(
        'params',
        'loadChildRunner',
        `"use strict";\n${code}\nif (typeof createBacktestRunner !== "function") throw new Error("missing createBacktestRunner"); return createBacktestRunner(params, loadChildRunner);`,
      );
    } else {
      factory = new Function(
        'params',
        `"use strict";\n${code}\nif (typeof createBacktestRunner !== "function") throw new Error("missing createBacktestRunner"); return createBacktestRunner(params);`,
      );
    }
  } catch (err) {
    throw new Error(`strategy runner compile failed (${label}): ${err.message}`);
  }
  const runner = portfolio ? factory(params, loadChildRunner) : factory(params);
  if (!runner || typeof runner.processTick !== 'function' || typeof runner.finish !== 'function') {
    throw new Error(`strategy runner ${label} must export processTick/finish`);
  }
  return runner;
}
