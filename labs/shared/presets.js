import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function resolveStrategyRoot(strategyFamily, strategyId) {
  return path.resolve('labs/strategies', strategyFamily, strategyId);
}

export function listPresetFiles(strategyRoot) {
  const presetsDir = path.join(strategyRoot, 'presets');
  return readdirSync(presetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'manifest.json')
    .map((entry) => path.join(presetsDir, entry.name))
    .sort();
}

export function loadPresetFile(filePath) {
  const preset = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!preset.id) throw new Error(`preset missing id: ${filePath}`);
  return preset;
}

export function loadStrategyDefaults(strategyRoot) {
  const file = path.join(strategyRoot, 'defaults.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function resolvePresetParams(preset, strategyRoot) {
  const defaults = loadStrategyDefaults(strategyRoot);
  return { ...defaults, ...(preset.params || {}) };
}

export function listPresets({ strategyFamily = 'edge', strategyId = 'edge-sniper-v2' } = {}) {
  const strategyRoot = resolveStrategyRoot(strategyFamily, strategyId);
  return listPresetFiles(strategyRoot).map((file) => loadPresetFile(file));
}

export function loadPreset(presetId, { strategyFamily = 'edge', strategyId = 'edge-sniper-v2' } = {}) {
  const preset = listPresets({ strategyFamily, strategyId }).find((item) => item.id === presetId);
  if (!preset) throw new Error(`Unknown lab preset: ${presetId}`);
  const strategyRoot = resolveStrategyRoot(strategyFamily, strategyId);
  return {
    preset,
    strategyRoot,
    params: resolvePresetParams(preset, strategyRoot),
  };
}
