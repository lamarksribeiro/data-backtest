import { createHash } from 'node:crypto';

import { listPresets, resolvePresetParams } from '../../../labs/shared/presets.js';
import { renderPresetGls } from '../../../labs/shared/renderPresetGls.js';
import { buildCompiledArtifact } from './resolveVersion.js';
import { validateStrategySource } from './index.js';
import { composeStrategyJsFromGls } from './composeStrategyJs.js';

const JS_PROMOTE_FAMILIES = new Set(['edge', 'volatility', 'impulse']);

function checksumSource(sourceCode) {
  return createHash('sha256').update(String(sourceCode)).digest('hex');
}

function shouldCreateJsVersions(manifest) {
  const family = String(manifest.strategyFamily || manifest.family || '').toLowerCase();
  const id = String(manifest.strategyId || '').toLowerCase();
  if (JS_PROMOTE_FAMILIES.has(family)) return true;
  if (id.includes('edge-sniper') || id.includes('vsmr') || id.includes('volatility-spike') || id.includes('gamma-ladder')) return true;
  if (id.includes('impulse')) return true;
  return false;
}

export function seedJsVersionsForStrategy(db, {
  strategyId,
  manifest,
  resolvePresetGlsSource,
  resolvePresetVersion,
  resolveDisplayName,
  resolveVersionNotes,
}) {
  if (!shouldCreateJsVersions(manifest)) return { created: 0, skipped: 'not_eligible' };

  const presetList = listPresets({
    strategyFamily: manifest.strategyFamily,
    strategyId: manifest.strategyId,
    includeAliases: false,
  });

  const maxVersion = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS maxVersion
    FROM strategy_versions
    WHERE strategy_id = ?
  `).get(strategyId)?.maxVersion ?? 0;

  let created = 0;
  let versionOffset = 0;

  for (const preset of presetList) {
    const glsVersion = resolvePresetVersion(preset);
    const existingJs = db.prepare(`
      SELECT id FROM strategy_versions
      WHERE strategy_id = ? AND language = 'strategy-js-v1' AND notes LIKE ?
    `).get(strategyId, `%JS port · ${preset.id}%`);
    if (existingJs) continue;

    const baseSource = resolvePresetGlsSource(manifest, preset);
    const params = resolvePresetParams(preset, manifest.strategyRoot);
    const glsWithParams = renderPresetGls(baseSource, params, resolveDisplayName(manifest, preset));
    const jsSource = composeStrategyJsFromGls(glsWithParams);
    const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: jsSource, db });
    if (!validation.ok) {
      console.warn(`[seed-js] skip ${manifest.strategyId} preset ${preset.id}: ${validation.errors?.[0]?.message}`);
      continue;
    }
    const compiled = buildCompiledArtifact(jsSource);
    const versionNum = maxVersion + presetList.length + versionOffset + 1;
    versionOffset += 1;

    db.prepare(`
      INSERT INTO strategy_versions (
        strategy_id, version, language, source_code, params_schema_json, compiled_json, validation_json, checksum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId,
      versionNum,
      'strategy-js-v1',
      jsSource,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksumSource(jsSource),
      `JS port · ${preset.id} · ${resolveVersionNotes(preset)} (from GLS v${glsVersion})`,
    );
    created += 1;
    console.log(`[seed-js] strategy ${strategyId} v${versionNum} (${preset.id}) semeada.`);
  }

  return { created, skipped: created ? null : 'no_versions_created' };
}