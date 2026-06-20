#!/usr/bin/env node
/**
 * Recompõe todas as versões Strategy JS com código completo no editor
 * (modelos inlined + gamma embedded-runner). Remove strategy libraries de estratégia do SQLite.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { composeStrategyJsFromSource } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import { validateStrategySource } from '../src/backtestStudio/strategyJs/index.js';
import { buildCompiledArtifact } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { detectEmbeddedModels } from '../src/backtestStudio/strategyJs/embeddedModels.js';
import { detectEmbeddedRunner } from '../src/backtestStudio/strategyJs/embeddedRunner.js';

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function shouldRewrite(row) {
  const source = String(row.source_code || '');
  if (row.language === 'gls-v1') return true;
  if (/strategyLibrary\s*\(\s*["'](edge-sniper-models|gamma-ladder-engine)/.test(source)) return true;
  if (detectEmbeddedRunner(source) || detectEmbeddedModels(source)) return false;
  return /\bmodel\.(directionProbability|scoreSides|scoreImpulseElasticitySides)\s*\(/.test(source);
}

function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  const rows = db.prepare(`
    SELECT sv.id, sv.version, sv.language, sv.source_code, sd.slug
    FROM strategy_versions sv
    JOIN strategy_definitions sd ON sd.id = sv.strategy_id
    WHERE sv.language IN ('strategy-js-v1', 'gls-v1')
    ORDER BY sd.slug, sv.version
  `).all();

  const updated = [];
  const skipped = [];
  for (const row of rows) {
    if (!shouldRewrite(row)) {
      skipped.push({ slug: row.slug, version: row.version, reason: 'already-full-source' });
      continue;
    }
    const sourceCode = composeStrategyJsFromSource(row.source_code);
    const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: sourceCode, db });
    if (!validation.ok) {
      throw new Error(`${row.slug} v${row.version}: ${validation.errors?.[0]?.message}`);
    }
    const compiled = buildCompiledArtifact(sourceCode);
    db.prepare(`
      UPDATE strategy_versions
      SET language = 'strategy-js-v1',
          source_code = ?,
          params_schema_json = ?,
          compiled_json = ?,
          validation_json = ?,
          checksum = ?
      WHERE id = ?
    `).run(
      sourceCode,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksum(sourceCode),
      row.id,
    );
    updated.push({
      slug: row.slug,
      version: row.version,
      bytes: sourceCode.length,
      execution_kind: validation.execution_kind,
      editable_logic: validation.editable_logic,
      inlined_models: validation.inlined_models || [],
    });
  }

  for (const slug of ['gamma-ladder-engine', 'edge-sniper-models']) {
    db.prepare(`
      DELETE FROM strategy_library_versions
      WHERE library_id = (SELECT id FROM strategy_library_definitions WHERE slug = ?)
    `).run(slug);
    db.prepare('DELETE FROM strategy_library_definitions WHERE slug = ?').run(slug);
  }

  console.log(JSON.stringify({ ok: true, updated, skipped }, null, 2));
  closeStateDatabase(db);
}

main();