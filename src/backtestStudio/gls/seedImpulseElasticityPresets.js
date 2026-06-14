import { createHash } from 'node:crypto';
import { loadGlsStrategySource } from './loadStrategySource.js';
import {
  createStrategy,
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

export function seedImpulseElasticityPresets(db, {
  strategyFamily = 'impulse',
  strategyId = 'impulse-elasticity',
} = {}) {
  const baseSource = loadGlsStrategySource('impulseElasticity');
  const presets = listPresets({ strategyFamily, strategyId });
  const strategyRoot = resolveStrategyRoot(strategyFamily, strategyId);
  const seeded = [];

  const slug = 'impulse-elasticity-gls';
  const name = 'Impulse Elasticity GLS';
  const description = 'Estratégia Impulse Elasticity GLS com presets de laboratório integrados como versões.';

  let strategy = getStrategyBySlug(db, slug);
  if (!strategy) {
    strategy = createStrategy(db, {
      slug,
      name,
      description,
      tags: ['impulse-elasticity', 'lab-strategy'],
    });
  }

  const existingVersions = db.prepare(`
    SELECT id, version, source_code 
    FROM strategy_versions 
    WHERE strategy_id = ?
  `).all(strategy.id);

  for (const preset of presets) {
    const versionNum = parseInt(preset.id.replace(/\D/g, ''), 10);
    if (!versionNum || isNaN(versionNum)) {
      throw new Error(`ID de preset inválido para mapear versão: ${preset.id}. Precisa conter um número.`);
    }

    const params = resolvePresetParams(preset, strategyRoot);
    const sourceCode = renderPresetGls(
      baseSource,
      params,
      `Impulse Elasticity · ${preset.name || preset.id}`,
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

  // Define a versão default para a v1 (a nossa campeã)
  const currentDefault = db.prepare('SELECT default_version_id FROM strategy_definitions WHERE id = ?').get(strategy.id);
  if (currentDefault?.default_version_id == null) {
    const champion = db.prepare(`
      SELECT id FROM strategy_versions
      WHERE strategy_id = ? AND version = 1
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
