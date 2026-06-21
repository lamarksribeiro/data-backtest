/**
 * Terminal Convexity scoring (ported from terminal-convexity-runner hot path).
 * Slug: terminal-convexity-models @ version 1
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_PATH = fileURLToPath(new URL('./terminalConvexityModels.source.js', import.meta.url));

export function loadTerminalConvexityModelsSource() {
  return readFileSync(SOURCE_PATH, 'utf8').trim();
}

export function createTerminalConvexityModels(lib) {
  const factory = new Function(
    'lib',
    `"use strict";\n${loadTerminalConvexityModelsSource()}\nif (typeof createLibrary !== "function") throw new Error("missing createLibrary"); return createLibrary(lib);`,
  );
  return factory(lib);
}