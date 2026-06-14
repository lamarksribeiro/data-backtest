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

export function listPresets({ strategyFamily = 'edge', strategyId = 'edge-sniper-v2', includeAliases = true } = {}) {
  const strategyRoot = resolveStrategyRoot(strategyFamily, strategyId);
  const presets = listPresetFiles(strategyRoot).map((file) => loadPresetFile(file));
  return includeAliases ? withLabVariantAliases(presets) : presets;
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

function withLabVariantAliases(presets) {
  const result = [...presets];
  const ids = new Set(result.map((preset) => preset.id));
  for (const preset of presets) {
    const aliasId = preset.labVariantId;
    if (!aliasId || aliasId === preset.id || ids.has(aliasId)) continue;
    result.push(toLabVariantAlias(preset, aliasId));
    ids.add(aliasId);
  }
  return result.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function toLabVariantAlias(preset, aliasId) {
  return {
    ...preset,
    id: aliasId,
    sourcePresetId: preset.id,
    studioSlug: aliasSlug(preset, aliasId),
    studioName: aliasName(preset, aliasId),
  };
}

function aliasSlug(preset, aliasId) {
  const slug = String(preset.studioSlug || '');
  if (slug.endsWith(`-${preset.id}`)) return `${slug.slice(0, -String(preset.id).length)}${aliasId}`;
  return `esv2-${aliasId}`;
}

function aliasName(preset, aliasId) {
  const name = String(preset.studioName || preset.name || '');
  if (!name) return aliasId;
  return name.replace(String(preset.id), aliasId);
}
