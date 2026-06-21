import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../data/strategy-libraries');
const SQLITE_LIBRARY_EXCLUDE = new Set(['gamma-ladder-engine', 'edge-sniper-models', 'terminal-convexity-models']);

export function loadBootstrapLibraryEntries() {
  let files = [];
  try {
    files = readdirSync(DATA_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }

  return files.flatMap((fileName) => {
    const raw = readFileSync(path.join(DATA_DIR, fileName), 'utf8');
    const entry = JSON.parse(raw);
    if (!entry?.slug || !entry?.source_code) {
      throw new Error(`invalid strategy library bootstrap file: ${fileName}`);
    }
    if (SQLITE_LIBRARY_EXCLUDE.has(entry.slug)) return [];
    return [{
      slug: entry.slug,
      name: entry.name || entry.slug,
      description: entry.description || '',
      version: Number(entry.version || 1),
      source_code: entry.source_code,
      validation: entry.validation || { ok: true },
      compiled: entry.compiled ?? null,
    }];
  });
}