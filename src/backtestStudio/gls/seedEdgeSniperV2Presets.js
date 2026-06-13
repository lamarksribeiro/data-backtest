import { getEdgeSniperV2GlsSource } from './loadStrategySource.js';
import {
  createStrategy,
  createStrategyVersion,
  getStrategy,
  getStrategyBySlug,
} from '../state/strategies.js';
import { listPresets, resolvePresetParams, resolveStrategyRoot } from '../../../labs/shared/presets.js';
import { renderPresetGls } from '../../../labs/shared/renderPresetGls.js';

function normalizeSource(sourceCode) {
  return String(sourceCode || '').replace(/\r\n/g, '\n').trim();
}

function latestSourceCode(db, strategyId) {
  const row = db.prepare(`
    SELECT source_code
    FROM strategy_versions
    WHERE strategy_id = ?
    ORDER BY version DESC, id DESC
    LIMIT 1
  `).get(strategyId);
  return row?.source_code || null;
}

function ensurePresetStrategy(db, preset, params, sourceCode) {
  const slug = preset.studioSlug || `esv2-${preset.id}`;
  const name = preset.studioName || `Edge Sniper V2 · ${preset.name || preset.id}`;
  const description = [
    preset.description || `Preset do lab Edge Sniper V2 (${preset.id}).`,
    preset.labSummary ? `Lab: PnL ${preset.labSummary.totalPnl}, dias+ ${preset.labSummary.positiveDays}/${preset.labSummary.totalDays}.` : null,
  ].filter(Boolean).join(' ');

  let strategy = getStrategyBySlug(db, slug);
  if (!strategy) {
    strategy = createStrategy(db, {
      slug,
      name,
      description,
      tags: ['edge-sniper-v2', 'lab-preset', preset.role || 'candidate', ...(preset.tags || [])],
    });
    createStrategyVersion(db, strategy.id, {
      language: 'gls-v1',
      source_code: sourceCode,
      notes: JSON.stringify({ presetId: preset.id, params }),
    });
    return getStrategy(db, strategy.id);
  }

  const latest = latestSourceCode(db, strategy.id);
  if (normalizeSource(latest) !== normalizeSource(sourceCode)) {
    createStrategyVersion(db, strategy.id, {
      language: 'gls-v1',
      source_code: sourceCode,
      notes: JSON.stringify({ presetId: preset.id, params }),
    });
  }

  return getStrategy(db, strategy.id);
}

export function seedEdgeSniperV2Presets(db, {
  strategyFamily = 'edge',
  strategyId = 'edge-sniper-v2',
} = {}) {
  const baseSource = getEdgeSniperV2GlsSource();
  const presets = listPresets({ strategyFamily, strategyId });
  const strategyRoot = resolveStrategyRoot(strategyFamily, strategyId);
  const seeded = [];

  for (const preset of presets) {
    const params = resolvePresetParams(preset, strategyRoot);
    const sourceCode = renderPresetGls(
      baseSource,
      params,
      `Edge Sniper V2 · ${preset.name || preset.id}`,
    );
    const strategy = ensurePresetStrategy(db, preset, params, sourceCode);
    seeded.push({
      presetId: preset.id,
      slug: strategy.slug,
      strategyId: strategy.id,
      latestVersion: strategy.latest_version ?? null,
    });
  }

  return seeded;
}
