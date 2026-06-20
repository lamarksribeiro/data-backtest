#!/usr/bin/env node
/**
 * Recompõe versões Gamma Ladder com código completo no strategy_versions.source_code.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { composeGammaLadderStrategyJs } from '../src/backtestStudio/strategyJs/composeGammaLadder.js';
import { validateStrategySource } from '../src/backtestStudio/strategyJs/index.js';
import { buildCompiledArtifact } from '../src/backtestStudio/strategyJs/resolveVersion.js';

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function resolveGlsPath(manifest) {
  const studio = manifest.studio || {};
  const rel = manifest.source?.path
    || studio.glsSources?.[studio.defaultGlsSource]
    || 'labs/strategies/gamma/gamma-ladder-v1/strategy.gls';
  return path.resolve(rel);
}

function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  const manifest = JSON.parse(readFileSync('labs/strategies/gamma/gamma-ladder-v1/strategy.json', 'utf8'));
  const glsSource = readFileSync(resolveGlsPath(manifest), 'utf8');

  const strategy = db.prepare('SELECT id, slug FROM strategy_definitions WHERE slug = ?').get('gamma-ladder-v1');
  if (!strategy) {
    console.log(JSON.stringify({ ok: false, error: 'gamma-ladder-v1 not found' }, null, 2));
    closeStateDatabase(db);
    process.exit(1);
  }

  const versions = db.prepare(`
    SELECT id, version, notes, source_code
    FROM strategy_versions
    WHERE strategy_id = ? AND language = 'strategy-js-v1'
    ORDER BY version
  `).all(strategy.id);

  const updated = [];
  for (const row of versions) {
    const nameMatch = String(row.source_code || '').match(/name:\s*["']([^"']+)["']/);
    const sourceCode = composeGammaLadderStrategyJs(glsSource, { name: nameMatch?.[1] });
    const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: sourceCode, db });
    if (!validation.ok) {
      throw new Error(`gamma v${row.version} invalid: ${validation.errors?.[0]?.message}`);
    }
    const compiled = buildCompiledArtifact(sourceCode);
    db.prepare(`
      UPDATE strategy_versions
      SET source_code = ?, validation_json = ?, compiled_json = ?, checksum = ?
      WHERE id = ?
    `).run(
      sourceCode,
      JSON.stringify(validation),
      compiled ? JSON.stringify(compiled) : null,
      checksum(sourceCode),
      row.id,
    );
    updated.push({ version: row.version, bytes: sourceCode.length, execution_kind: validation.execution_kind });
  }

  db.prepare(`
    DELETE FROM strategy_library_versions
    WHERE library_id = (SELECT id FROM strategy_library_definitions WHERE slug = 'gamma-ladder-engine')
  `).run();
  db.prepare('DELETE FROM strategy_library_definitions WHERE slug = ?').run('gamma-ladder-engine');

  console.log(JSON.stringify({ ok: true, strategy: strategy.slug, updated }, null, 2));
  closeStateDatabase(db);
}

main();