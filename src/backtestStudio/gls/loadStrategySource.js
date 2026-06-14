import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STRATEGIES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'strategies');

export function loadGlsStrategySource(name) {
  const filePath = path.join(STRATEGIES_DIR, `${name}.gls`);
  return readFileSync(filePath, 'utf8');
}

export function getEdgeSniperV2GlsSource() {
  return loadGlsStrategySource('edgeSniperV2');
}

export function getEdgeSniperV3V1GlsSource() {
  return loadGlsStrategySource('edgeSniperV3_v1');
}

export function getEdgeSniperV3V2GlsSource() {
  return loadGlsStrategySource('edgeSniperV3_v2');
}

