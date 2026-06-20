import { createHash } from 'node:crypto';

import { hydrateSoaHooksFromGeneratedSource } from '../gls/compilerSoa.js';

const soaHookCache = new Map();

export function cacheKeyForGeneratedSource(generatedSource) {
  return createHash('sha256').update(JSON.stringify(generatedSource || {})).digest('hex');
}

export function getCachedSoaHooks(generatedSource) {
  if (!generatedSource || typeof generatedSource !== 'object') return null;
  const key = cacheKeyForGeneratedSource(generatedSource);
  const cached = soaHookCache.get(key);
  if (cached) return cached;
  const hooks = hydrateSoaHooksFromGeneratedSource(generatedSource);
  if (!hooks) return null;
  soaHookCache.set(key, hooks);
  return hooks;
}

export function clearCompiledCache() {
  soaHookCache.clear();
}