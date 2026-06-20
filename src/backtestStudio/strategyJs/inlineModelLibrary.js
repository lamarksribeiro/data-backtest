import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_BOOTSTRAP = path.resolve(__dirname, '../../../data/strategy-libraries/edge-sniper-models.v1.json');

export function loadEdgeSniperModelsSource(modelsPath = MODELS_BOOTSTRAP) {
  const raw = JSON.parse(readFileSync(modelsPath, 'utf8')).source_code;
  return String(raw || '')
    .replace(/Math\.SQRT2/g, '1.4142135623730951')
    .trim();
}

export function removeDependenciesBlock(sourceCode) {
  return String(sourceCode || '').replace(/\n\s*dependencies:\s*\{[\s\S]*?\},\s*\n/m, '\n');
}

export function inlineModelLibraryInStrategy(sourceCode, { modelsPath = MODELS_BOOTSTRAP } = {}) {
  const strategy = removeDependenciesBlock(String(sourceCode || '').trim());
  const models = loadEdgeSniperModelsSource(modelsPath);
  return `${models}\n\n${strategy}`;
}