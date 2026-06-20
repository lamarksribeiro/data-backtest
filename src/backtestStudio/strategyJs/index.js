export { LANGUAGE, LANGUAGE_VERSION, STDLIB_VERSION, COMPILER_VERSION } from './constants.js';
export { compileStrategyJs } from './compile.js';
export { glsToStrategyJs } from './glsToStrategyJs.js';
export { parseStrategyJs, extractStrategyConfig } from './parser.js';
export { lowerToGlsAst } from './lowerToGlsAst.js';

import { parse as parseGls } from '../gls/parser.js';
import { validate as validateGls } from '../gls/validator.js';
import { compileStrategyJs } from './compile.js';
import { LANGUAGE } from './constants.js';
import { listBlockSignatures } from '../gls/blocks.js';
import { resolveCompiledStrategy } from './resolveVersion.js';

export const STRATEGY_JS_TEMPLATE = `export default strategy({
  name: "Nova Estrategia",

  params: {
    minDistanceAbs: 50,
    maxAsk: 0.58,
    budget: 15,
  },

  onEventStart({ state }) {
    state.entered = false;
  },

  onTick(ctx) {
    const { tick, event, state, params, position } = ctx;

    const distance = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat);
    const side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat);
    const ask = book.ask(side, tick);

    if (!state.entered && distance >= params.minDistanceAbs && ask <= params.maxAsk) {
      const bought = orders.enter(side, {
        price: ask,
        budget: params.budget,
        reason: "distance_entry",
      });
      if (bought) {
        state.entered = true;
        trace.mark("entry", { side, ask });
      }
    }
  },

  onEventEnd() {
    orders.closeOpenPosition({ reason: "event_end" });
  },
});
`;

export function validateStrategySource({ language = LANGUAGE, source_code: sourceCode, bookDepth = 25, db = null } = {}) {
  const lang = String(language || LANGUAGE).trim();
  if (lang === LANGUAGE) {
    const result = compileStrategyJs(sourceCode, { bookDepth, db });
    const { ast, compiled, ...publicResult } = result;
    return publicResult;
  }
  if (lang === 'gls-v1') {
    const result = validateGls(sourceCode, { language: lang, bookDepth });
    const { ast, ...publicResult } = result;
    return publicResult;
  }
  return {
    ok: false,
    errors: [{ line: 1, column: 1, code: 'UNSUPPORTED_LANGUAGE', message: `Unsupported language: ${lang}` }],
    warnings: [],
    params_schema: {},
    language: lang,
  };
}

export function resolveStrategyAst(version, { bookDepth = 25 } = {}) {
  const lang = String(version.language || 'gls-v1').trim();
  if (lang === LANGUAGE) {
    const resolved = resolveCompiledStrategy(version, { bookDepth });
    return {
      glsAst: resolved.glsAst,
      columnAnalysis: resolved.columnAnalysis,
      parallelism: resolved.parallelism,
      compiled: resolved.compiled,
      compileCacheHit: resolved.compileCacheHit,
      extensionLibraries: resolved.extensionLibraries,
      cachedSoaHooks: resolved.cachedSoaHooks,
    };
  }
  const glsAst = parseGls(version.source_code);
  return { glsAst, columnAnalysis: null, parallelism: null, compiled: null, compileCacheHit: false };
}

export function getRuntimeCapabilities() {
  return {
    languages: [LANGUAGE],
    default_language: LANGUAGE,
    stdlib_version: 'stdlib-v3',
    compiler_version: 'compiler-soa-v2',
    blocks: listBlockSignatures(),
    syntax: {
      forbidden: ['import', 'require', 'eval', 'async', 'Date.now', 'Math.random'],
      allowedHooks: ['onEventStart', 'onTick', 'onEventEnd'],
    },
    template: STRATEGY_JS_TEMPLATE,
    ai_contract: buildAiContract(),
  };
}

function buildAiContract() {
  return [
    'Voce deve gerar Strategy JS v1 para o Backtest Studio.',
    'Use export default strategy({...}).',
    'Nao use imports, require, fetch, eval, async, Date.now ou Math.random.',
    'Use tick.ts e event.end para tempo.',
    'Use orders.enter/exit/reverse e trace.mark/log/metric.',
    'Use apenas as APIs listadas em /api/strategy-runtime/capabilities.',
    'Para model.directionProbability, model.scoreSides ou model.scoreImpulseElasticitySides declare dependencies: { edgeModels: nativeLibrary("edge-sniper-models", 1) }.',
    'O codigo deve ser deterministico e compilavel para compiled-soa.',
  ].join('\n');
}