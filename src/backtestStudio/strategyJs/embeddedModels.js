import { createHash } from 'node:crypto';

import { stripStrategyExportWrapper } from './embeddedRunner.js';

const MODEL_CACHE = new Map();

export function detectEmbeddedModels(sourceCode) {
  const code = String(sourceCode || '');
  if (!code.includes('function createLibrary')) return null;
  if (/strategyLibrary\s*\(\s*["']edge-sniper-models/.test(code)) return null;
  const usesEdge = /model\.(directionProbability|scoreSides|scoreImpulseElasticitySides)\s*\(/.test(code);
  const usesTerminal = /model\.scoreTerminalSides\s*\(/.test(code);
  if (!usesEdge && !usesTerminal) return null;
  if (usesEdge && usesTerminal) return { library: 'edge-sniper-models' };
  if (usesTerminal) return { library: 'terminal-convexity-models' };
  return { library: 'edge-sniper-models' };
}

export function applyEmbeddedModelsToLib(sourceCode, lib) {
  const key = checksum(sourceCode);
  if (MODEL_CACHE.has(key)) {
    patchLibModel(lib, MODEL_CACHE.get(key));
    return lib;
  }

  const moduleBody = stripStrategyExportWrapper(sourceCode);
  if (!moduleBody.includes('function createLibrary')) {
    return lib;
  }

  let models;
  try {
    const factory = new Function(
      'lib',
      `"use strict";\n${moduleBody}\nif (typeof createLibrary !== "function") throw new Error("missing createLibrary"); return createLibrary(lib);`,
    );
    models = factory(lib);
  } catch (err) {
    throw new Error(`embedded models compile failed: ${err.message}`);
  }

  if (!models || typeof models !== 'object') {
    throw new Error('embedded createLibrary(lib) must return an object');
  }

  MODEL_CACHE.set(key, models);
  patchLibModel(lib, models);
  return lib;
}

export function clearEmbeddedModelsCache() {
  MODEL_CACHE.clear();
}

function patchLibModel(lib, models) {
  if (models.directionProbability) lib.model.directionProbability = models.directionProbability;
  if (models.scoreSides) lib.model.scoreSides = models.scoreSides;
  if (models.scoreImpulseElasticitySides) lib.model.scoreImpulseElasticitySides = models.scoreImpulseElasticitySides;
  if (models.scoreTerminalSides) lib.model.scoreTerminalSides = models.scoreTerminalSides;
}

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}