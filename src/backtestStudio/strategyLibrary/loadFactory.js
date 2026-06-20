import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryCache = new Map();

export function loadStrategyLibraryFactory(db, slug, version = 1) {
  const key = `${slug}:${version}`;
  if (factoryCache.has(key)) return factoryCache.get(key);

  const row = db.prepare(`
    SELECT slv.source_code, slv.checksum, sld.slug
    FROM strategy_library_versions slv
    JOIN strategy_library_definitions sld ON sld.id = slv.library_id
    WHERE sld.slug = ? AND slv.version = ?
    ORDER BY slv.id DESC
    LIMIT 1
  `).get(slug, Number(version));

  if (!row?.source_code) return null;

  const checksum = createHash('sha256').update(String(row.source_code)).digest('hex');
  if (checksum !== row.checksum) {
    throw new Error(`strategy library checksum mismatch for ${slug}@${version}`);
  }

  const factory = compileLibraryFactory(row.source_code, `${slug}@${version}`);
  factoryCache.set(key, factory);
  return factory;
}

export function clearStrategyLibraryFactoryCache() {
  factoryCache.clear();
}

function compileLibraryFactory(sourceCode, label) {
  const code = String(sourceCode || '').trim();
  if (!code) throw new Error(`empty strategy library source: ${label}`);

  let factory;
  try {
    factory = new Function('lib', `"use strict";\n${code}\nreturn typeof createLibrary === "function" ? createLibrary(lib) : null;`);
  } catch (err) {
    throw new Error(`strategy library compile failed (${label}): ${err.message}`);
  }

  return (lib) => {
    const api = factory(lib);
    if (!api || typeof api !== 'object') {
      throw new Error(`strategy library ${label} must export createLibrary(lib) object`);
    }
    return api;
  };
}

export function readRepoFileForEmbed(relPath) {
  return readFileSync(path.resolve(__dirname, '../../..', relPath), 'utf8');
}