import { createHash } from 'node:crypto';
import { getEdgeSniperV3V1GlsSource, getEdgeSniperV3V2GlsSource } from './loadStrategySource.js';
import {
  createStrategy,
  getStrategyBySlug,
  validateStrategySource,
} from '../state/strategies.js';
import { listPresets, resolvePresetParams, resolveStrategyRoot } from '../../../labs/shared/presets.js';
import { renderPresetGls } from '../../../labs/shared/renderPresetGls.js';

function checksumSource(sourceCode) {
  return createHash('sha256').update(String(sourceCode)).digest('hex');
}

export function seedEdgeSniperV3Presets(db) {
  const strategyFamily = 'edge';
  const strategyId = 'edge-sniper-v3';
  const presets = listPresets({ strategyFamily, strategyId, includeAliases: false });
  const strategyRoot = resolveStrategyRoot(strategyFamily, strategyId);

  // 1. Garante a estratégia pai no banco
  const slug = 'edge-sniper-v3-gls';
  const name = 'Edge Sniper V3';
  const description = 'Nova geração da estratégia Edge Sniper com suporte a regimes e Order Book Imbalance (OBI) integrado.';

  let strategy = getStrategyBySlug(db, slug);
  if (!strategy) {
    strategy = createStrategy(db, {
      slug,
      name,
      description,
      tags: ['edge-sniper-v3', 'lab-strategy'],
    });
  }

  // 2. Coleta versões existentes
  const existingVersions = db.prepare(`
    SELECT id, version, source_code 
    FROM strategy_versions 
    WHERE strategy_id = ?
  `).all(strategy.id);

  // 3. Cadastra cada preset correspondente à sua fonte GLS física correta
  for (const preset of presets) {
    // Extrai o número do ID do preset. Ex: "v1" -> 1, "v2" -> 2
    const versionNum = parseInt(preset.id.replace(/\D/g, ''), 10);
    if (!versionNum || isNaN(versionNum)) {
      throw new Error(`ID de preset inválido para mapear versão na V3: ${preset.id}`);
    }

    // Seleciona a fonte base correta para a versão
    const baseSource = versionNum === 1 ? getEdgeSniperV3V1GlsSource() : getEdgeSniperV3V2GlsSource();
    const params = resolvePresetParams(preset, strategyRoot);
    const sourceCode = renderPresetGls(
      baseSource,
      params,
      `Edge Sniper V3 · ${preset.name || preset.id}`,
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
        versionNum === 1 ? 'v1 (Classic Champion - antiga v7)' : 'v2 (OBI Champion - antiga v10)'
      );
      console.log(`Versão ${versionNum} para a estratégia Edge Sniper V3 semeada com sucesso no SQLite.`);
    } else if (checksumSource(existingVersion.source_code) !== checksum) {
      db.prepare(`
        UPDATE strategy_versions
        SET source_code = ?, params_schema_json = ?, validation_json = ?, checksum = ?,
            notes = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || ' - auto updated preset'
        WHERE id = ?
      `).run(
        sourceCode,
        JSON.stringify(validation.params_schema || {}),
        JSON.stringify(validation),
        checksum,
        existingVersion.id
      );
      console.log(`Versão ${versionNum} (ID ${existingVersion.id}) para Edge Sniper V3 atualizada com novo preset.`);
    }
  }
}
