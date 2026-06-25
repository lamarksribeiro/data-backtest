import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glsToStrategyJs } from './glsToStrategyJs.js';
import { inferNativeDependencies } from './dependencies.js';
import { composeGammaLadderStrategyJs } from './composeGammaLadder.js';
import { inlineModelLibraryInStrategy } from './inlineModelLibrary.js';

export function composeStrategyJsFromGls(glsSource, options = {}) {
  const source = String(glsSource || '');
  if (/gamma\s+ladder/i.test(source)) {
    if (/gamma\s+ladder\s+v2/i.test(source)) {
      const enginePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/strategy-libraries/gamma-ladder-engine.v2.json');
      return composeGammaLadderStrategyJs(source, { ...options, enginePath });
    }
    return composeGammaLadderStrategyJs(source, options);
  }

  let js;
  if (/export\s+default\s+strategy\s*\(/.test(source)) {
    js = source.trim();
  } else {
    js = glsToStrategyJs(source);
  }
  if (inferNativeDependencies(js).length > 0) {
    js = inlineModelLibraryInStrategy(js, options);
  }
  return js;
}

export function composeStrategyJsFromSource(sourceCode, options = {}) {
  const code = String(sourceCode || '').trim();
  if (!code) return code;
  if (/^\s*strategy\s+"/.test(code) || /export\s+default\s+strategy\s*\(/.test(code)) {
    return composeStrategyJsFromGls(code, options);
  }
  if (/gammaLadderRunnerFactory/.test(code)) return code;
  if (inferNativeDependencies(code).length > 0 && !code.includes('function createLibrary')) {
    return inlineModelLibraryInStrategy(code, options);
  }
  if (/strategyLibrary\s*\(\s*["']edge-sniper-models/.test(code)) {
    return inlineModelLibraryInStrategy(code, options);
  }
  return code;
}