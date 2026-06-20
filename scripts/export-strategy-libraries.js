#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  const rows = db.prepare(`
    SELECT sld.slug, sld.name, sld.description, slv.version, slv.source_code, slv.validation_json
    FROM strategy_library_definitions sld
    JOIN strategy_library_versions slv ON slv.library_id = sld.id
    ORDER BY sld.slug, slv.version
  `).all();

  const outDir = path.join(root, 'data', 'strategy-libraries');
  mkdirSync(outDir, { recursive: true });
  const exported = [];
  for (const row of rows) {
    const entry = {
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: Number(row.version),
      source_code: row.source_code,
      validation: JSON.parse(row.validation_json),
    };
    const fileName = `${row.slug}.v${row.version}.json`;
    writeFileSync(path.join(outDir, fileName), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    exported.push(fileName);
  }

  console.log(JSON.stringify({ ok: true, exported, outDir }, null, 2));
  closeStateDatabase(db);
}

main();