import { createHash } from 'node:crypto';

export const EMBEDDED_RUNNER_FACTORY = 'gammaLadderRunnerFactory';

const RUNNER_CACHE = new Map();

export function detectEmbeddedRunner(sourceCode) {
  const code = String(sourceCode || '');
  if (!code.includes(`function ${EMBEDDED_RUNNER_FACTORY}`)) return null;
  return { factoryName: EMBEDDED_RUNNER_FACTORY };
}

export function stripStrategyExportWrapper(sourceCode) {
  const code = String(sourceCode || '').trim();
  const marker = code.search(/\bexport\s+default\s+strategy\s*\(/);
  if (marker < 0) return code;
  return code.slice(0, marker).trim();
}

export function loadEmbeddedRunner(sourceCode, params = {}, label = 'embedded-runner') {
  const key = `${checksum(sourceCode)}:${checksum(JSON.stringify(params || {}))}`;
  if (RUNNER_CACHE.has(key)) return RUNNER_CACHE.get(key);

  const moduleBody = stripStrategyExportWrapper(sourceCode);
  if (!moduleBody.includes(`function ${EMBEDDED_RUNNER_FACTORY}`)) {
    throw new Error(`embedded runner factory ${EMBEDDED_RUNNER_FACTORY} not found in strategy source`);
  }

  let factory;
  try {
    factory = new Function(
      'params',
      `"use strict";\n${moduleBody}\nif (typeof ${EMBEDDED_RUNNER_FACTORY} !== "function") throw new Error("missing ${EMBEDDED_RUNNER_FACTORY}"); return ${EMBEDDED_RUNNER_FACTORY}(params);`,
    );
  } catch (err) {
    throw new Error(`embedded runner compile failed (${label}): ${err.message}`);
  }

  const runner = factory(params);
  if (!runner || typeof runner.processTick !== 'function' || typeof runner.finish !== 'function') {
    throw new Error(`embedded runner ${label} must expose processTick/finish`);
  }

  RUNNER_CACHE.set(key, runner);
  return runner;
}

export function clearEmbeddedRunnerCache() {
  RUNNER_CACHE.clear();
}

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}