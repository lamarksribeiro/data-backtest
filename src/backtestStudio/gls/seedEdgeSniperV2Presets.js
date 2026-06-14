import { createHash } from 'node:crypto';
import { getEdgeSniperV2GlsSource } from './loadStrategySource.js';
import {
  createStrategy,
  getStrategy,
  getStrategyBySlug,
  validateStrategySource,
} from '../state/strategies.js';
import { listPresets, resolvePresetParams, resolveStrategyRoot } from '../../../labs/shared/presets.js';
import { renderPresetGls } from '../../../labs/shared/renderPresetGls.js';

function normalizeSource(sourceCode) {
  return String(sourceCode || '').replace(/\r\n/g, '\n').trim();
}

function checksumSource(sourceCode) {
  return createHash('sha256').update(String(sourceCode)).digest('hex');
}

export function seedEdgeSniperV2Presets(db, {
  strategyFamily = 'edge',
  strategyId = 'edge-sniper-v2',
} = {}) {
  const baseSource = getEdgeSniperV2GlsSource();
  const presets = listPresets({ strategyFamily, strategyId, includeAliases: false });
  const strategyRoot = resolveStrategyRoot(strategyFamily, strategyId);
  const seeded = [];

  // 1. Garante a estratégia pai unificada com slug 'edge-sniper-v2-gls'
  const slug = 'edge-sniper-v2-gls';
  const name = 'Edge Sniper V2 GLS';
  const description = 'Estratégia Edge Sniper V2 GLS com presets de laboratório integrados como versões.';

  let strategy = getStrategyBySlug(db, slug);
  if (!strategy) {
    strategy = createStrategy(db, {
      slug,
      name,
      description,
      tags: ['edge-sniper-v2', 'lab-strategy'],
    });
  }

  // 2. Garante a versão 1 (código base original do backtest)
  const existingVersions = db.prepare(`
    SELECT id, version, source_code 
    FROM strategy_versions 
    WHERE strategy_id = ?
  `).all(strategy.id);

  const v1Exists = existingVersions.some((v) => v.version === 1);
  if (!v1Exists) {
    const validation = validateStrategySource({ language: 'gls-v1', source_code: baseSource });
    db.prepare(`
      INSERT INTO strategy_versions (
        strategy_id, version, language, source_code, params_schema_json, validation_json, checksum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategy.id,
      1,
      'gls-v1',
      baseSource,
      JSON.stringify(validation.params_schema || {}),
      JSON.stringify(validation),
      checksumSource(baseSource),
      'Versão base original'
    );
  }

  // 3. Garante cada preset como uma versão específica
  for (const preset of presets) {
    // Extrai o número do ID do preset. Ex: "v2" -> 2, "v3" -> 3, "v4" -> 4
    const versionNum = parseInt(preset.id.replace(/\D/g, ''), 10);
    if (!versionNum || isNaN(versionNum)) {
      throw new Error(`ID de preset inválido para mapear versão: ${preset.id}. Precisa conter um número.`);
    }

    const params = resolvePresetParams(preset, strategyRoot);
    const sourceCode = renderPresetGls(
      baseSource,
      params,
      `Edge Sniper V2 · ${preset.name || preset.id}`,
    );

    const validation = validateStrategySource({ language: 'gls-v1', source_code: sourceCode });
    const checksum = checksumSource(sourceCode);

    const existingVersion = existingVersions.find((v) => v.version === versionNum);
    
    if (!existingVersion) {
      db.prepare(`
        INSERT INTO strategy_versions (
          strategy_id, version, language, source_code, params_schema_json, validation_json, checksum, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        strategy.id,
        versionNum,
        'gls-v1',
        sourceCode,
        JSON.stringify(validation.params_schema || {}),
        JSON.stringify(validation),
        checksum,
        `Preset ${preset.id}: ${preset.name || preset.role || ''}`
      );
    } else if (normalizeSource(existingVersion.source_code) !== normalizeSource(sourceCode)) {
      db.prepare(`
        UPDATE strategy_versions
        SET source_code = ?, params_schema_json = ?, validation_json = ?, checksum = ?, notes = ?
        WHERE strategy_id = ? AND version = ?
      `).run(
        sourceCode,
        JSON.stringify(validation.params_schema || {}),
        JSON.stringify(validation),
        checksum,
        `Preset ${preset.id}: ${preset.name || preset.role || ''}`,
        strategy.id,
        versionNum
      );
    }

    seeded.push({
      presetId: preset.id,
      slug: strategy.slug,
      strategyId: strategy.id,
      latestVersion: versionNum,
    });
  }

  // Atualiza updated_at da estratégia pai
  db.prepare(`
    UPDATE strategy_definitions
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(strategy.id);

  const currentDefault = db.prepare('SELECT default_version_id FROM strategy_definitions WHERE id = ?').get(strategy.id);
  if (currentDefault?.default_version_id == null) {
    const champion = db.prepare(`
      SELECT id FROM strategy_versions
      WHERE strategy_id = ? AND version = 3
      ORDER BY id DESC
      LIMIT 1
    `).get(strategy.id);
    if (champion) {
      db.prepare(`
        UPDATE strategy_definitions
        SET default_version_id = ?
        WHERE id = ?
      `).run(champion.id, strategy.id);
    }
  }

  return seeded;
}
