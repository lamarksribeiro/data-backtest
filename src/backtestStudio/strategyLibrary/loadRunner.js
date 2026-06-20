import { createHash } from 'node:crypto';

const runnerCache = new Map();

export function loadStrategyLibraryRunner(db, slug, version = 1, params = {}) {
  const key = `${slug}:${version}:${createHash('sha256').update(JSON.stringify(params || {})).digest('hex')}`;
  if (runnerCache.has(key)) return runnerCache.get(key);

  const row = db.prepare(`
    SELECT slv.source_code, slv.checksum
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

  const runner = compileRunnerModule(row.source_code, params, `${slug}@${version}`);
  runnerCache.set(key, runner);
  return runner;
}

export function clearStrategyLibraryRunnerCache() {
  runnerCache.clear();
}

function compileRunnerModule(sourceCode, params, label) {
  const code = String(sourceCode || '').trim();
  let factory;
  try {
    factory = new Function('params', `"use strict";\n${code}\nif (typeof createBacktestRunner !== "function") throw new Error("missing createBacktestRunner"); return createBacktestRunner(params);`);
  } catch (err) {
    throw new Error(`strategy runner compile failed (${label}): ${err.message}`);
  }
  const runner = factory(params);
  if (!runner || typeof runner.processTick !== 'function' || typeof runner.finish !== 'function') {
    throw new Error(`strategy runner ${label} must export processTick/finish`);
  }
  return runner;
}