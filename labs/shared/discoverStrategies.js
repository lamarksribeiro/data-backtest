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

export function listPromotedStrategies(options = {}) {
  return discoverLabStrategies(options).filter((manifest) => manifest.promotedToStudio === true);
}
