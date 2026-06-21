import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_LABS_ROOT = path.resolve('labs/strategies');

export function resolveStrategyRoot(strategyFamily, strategyId, labsRoot = DEFAULT_LABS_ROOT) {
  return path.join(labsRoot, strategyFamily, strategyId);
}

export function loadStrategyManifest(strategyRoot) {
  const filePath = path.join(strategyRoot, 'strategy.json');
  if (!existsSync(filePath)) {
    throw new Error(`strategy.json not found: ${filePath}`);
  }
  const manifest = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!manifest.id) throw new Error(`strategy.json missing id: ${filePath}`);
  if (!manifest.family) throw new Error(`strategy.json missing family: ${filePath}`);
  return {
    ...manifest,
    strategyRoot,
    strategyFamily: manifest.family,
    strategyId: manifest.id,
  };
}

export function discoverLabStrategies({ labsRoot = DEFAULT_LABS_ROOT } = {}) {
  if (!existsSync(labsRoot)) return [];

  const results = [];
  for (const familyEntry of readdirSync(labsRoot, { withFileTypes: true })) {
    if (!familyEntry.isDirectory()) continue;
    const familyDir = path.join(labsRoot, familyEntry.name);
    for (const strategyEntry of readdirSync(familyDir, { withFileTypes: true })) {
      if (!strategyEntry.isDirectory()) continue;
      const strategyRoot = path.join(familyDir, strategyEntry.name);
      const manifestPath = path.join(strategyRoot, 'strategy.json');
      if (!existsSync(manifestPath)) continue;
      results.push(loadStrategyManifest(strategyRoot));
    }
  }

  return results.sort((a, b) => String(a.studioSlug || a.id).localeCompare(String(b.studioSlug || b.id)));
}

export const PROMOTED_KIND_GLS = 'gls';
export const PROMOTED_KIND_LIBRARY = 'library';
export const PROMOTED_KIND_COMPILED = 'compiled-native';

export function resolveStrategyKind(manifest) {
  if (manifest.portStatus === 'compiled-native' || manifest.kind === 'compiled-soa') {
    return PROMOTED_KIND_COMPILED;
  }
  if (manifest.kind === 'library-runner' || manifest.kind === 'portfolio-runner') {
    return PROMOTED_KIND_LIBRARY;
  }
  if (manifest.source?.type === 'library-runner') {
    return PROMOTED_KIND_LIBRARY;
  }
  if (manifest.kind === 'gls' || manifest.source?.type === 'file') {
    return PROMOTED_KIND_GLS;
  }
  return manifest.kind || 'unknown';
}

export function isGlsStrategy(manifest) {
  return resolveStrategyKind(manifest) === PROMOTED_KIND_GLS;
}

export function isLibraryStrategy(manifest) {
  return resolveStrategyKind(manifest) === PROMOTED_KIND_LIBRARY;
}

export function isCompiledNativeStrategy(manifest) {
  return resolveStrategyKind(manifest) === PROMOTED_KIND_COMPILED;
}

export function listPromotedStrategies(options = {}) {
  const { kind = null, ...discoverOptions } = options;
  const promoted = discoverLabStrategies(discoverOptions).filter((manifest) => manifest.promotedToStudio === true);
  if (kind === PROMOTED_KIND_GLS) return promoted.filter(isGlsStrategy);
  if (kind === PROMOTED_KIND_LIBRARY) return promoted.filter(isLibraryStrategy);
  if (kind === PROMOTED_KIND_COMPILED) return promoted.filter(isCompiledNativeStrategy);
  return promoted;
}

export function listPromotedGlsStrategies(options = {}) {
  return listPromotedStrategies({ ...options, kind: PROMOTED_KIND_GLS });
}

export function listPromotedLibraryStrategies(options = {}) {
  return listPromotedStrategies({ ...options, kind: PROMOTED_KIND_LIBRARY });
}

export function listPromotedCompiledStrategies(options = {}) {
  return listPromotedStrategies({ ...options, kind: PROMOTED_KIND_COMPILED });
}
