import { getStrategyLibraryKind } from '../strategyLibrary/kind.js';

export const NATIVE_MODEL_FUNCTIONS = new Set([
  'directionProbability',
  'scoreSides',
  'scoreImpulseElasticitySides',
  'scoreTerminalSides',
]);

const NATIVE_MODEL_SLUG_BY_FUNCTION = {
  directionProbability: 'edge-sniper-models',
  scoreSides: 'edge-sniper-models',
  scoreImpulseElasticitySides: 'edge-sniper-models',
  scoreTerminalSides: 'terminal-convexity-models',
};

export function extractDependenciesObject(node) {
  if (node?.type !== 'ObjectExpression') return [];
  const deps = [];
  for (const prop of node.properties) {
    if (prop.type !== 'Property' || prop.kind !== 'init') continue;
    const alias = propertyKey(prop);
    if (!alias) continue;
    const parsed = parseNativeLibraryCall(prop.value);
    if (!parsed) continue;
    deps.push({
      alias,
      slug: parsed.slug,
      version: parsed.version,
      loc: prop.loc,
    });
  }
  return deps;
}

export function validateDependencies(dependencies, errors, db = null) {
  const seenSlugs = new Set();
  for (const dep of dependencies) {
    if (!dep.slug) {
      errors.push(depError(dep, 'INVALID_DEPENDENCY', 'dependency must call strategyLibrary("slug", version)'));
      continue;
    }
    if (db && !getStrategyLibraryKind(db, dep.slug, dep.version)) {
      errors.push(depError(dep, 'UNKNOWN_STRATEGY_LIBRARY', `strategy library not found: ${dep.slug}@${dep.version}`));
    }
    const key = `${dep.slug}:${dep.version}`;
    if (seenSlugs.has(key)) {
      errors.push(depError(dep, 'DUPLICATE_DEPENDENCY', `duplicate native library: ${dep.slug}@${dep.version}`));
    }
    seenSlugs.add(key);
  }
}

export function requiredNativeLibrariesForModelCall(path) {
  if (!path?.startsWith('model.')) return null;
  const fn = path.slice('model.'.length);
  if (!NATIVE_MODEL_FUNCTIONS.has(fn)) return null;
  return NATIVE_MODEL_SLUG_BY_FUNCTION[fn] ?? null;
}

export function isModelCallAllowed(path, dependencies) {
  const requiredSlug = requiredNativeLibrariesForModelCall(path);
  if (!requiredSlug) return true;
  return dependencies.some((dep) => dep.slug === requiredSlug);
}

export function dependenciesToExtensionLibraries(dependencies = []) {
  return dependencies.map((dep) => ({
    slug: dep.slug,
    version: dep.version,
    alias: dep.alias,
  }));
}

export function inferNativeDependencies(sourceCode) {
  const code = String(sourceCode || '');
  const deps = [];
  if (/model\.(directionProbability|scoreSides|scoreImpulseElasticitySides)\s*\(/.test(code)) {
    deps.push({ alias: 'edgeModels', slug: 'edge-sniper-models', version: 1 });
  }
  if (/model\.scoreTerminalSides\s*\(/.test(code)) {
    deps.push({ alias: 'tcModels', slug: 'terminal-convexity-models', version: 1 });
  }
  return deps;
}

export function inferNativeLibrariesFromAst(ast) {
  if (!ast) return [];
  const slugs = new Set();
  walkAstForModelCalls(ast, (fn) => {
    const slug = NATIVE_MODEL_SLUG_BY_FUNCTION[fn];
    if (slug) slugs.add(slug);
  });
  return [...slugs].map((slug) => ({
    slug,
    version: 1,
    alias: slug === 'terminal-convexity-models' ? 'tcModels' : 'edgeModels',
  }));
}

function walkAstForModelCalls(ast, onFn) {
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Call') {
      const path = glsCallPath(node.callee);
      const fn = path?.startsWith('model.') ? path.slice('model.'.length) : null;
      if (fn && NATIVE_MODEL_FUNCTIONS.has(fn)) onFn(fn);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
}

function astUsesHeavyModel(ast) {
  let found = false;
  function walk(node) {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'Call') {
      const path = glsCallPath(node.callee);
      if (requiredNativeLibrariesForModelCall(path)) found = true;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  return found;
}

function glsCallPath(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'Member' && callee.object?.type === 'Identifier') {
    return `${callee.object.name}.${callee.property}`;
  }
  return null;
}

export function injectDependenciesBlock(sourceCode, dependencies = inferNativeDependencies(sourceCode)) {
  const code = String(sourceCode || '');
  if (!dependencies.length || /dependencies\s*:/.test(code)) return code;
  const lines = dependencies.map((dep) => `    ${dep.alias}: strategyLibrary("${dep.slug}", ${dep.version}),`).join('\n');
  const block = `  dependencies: {\n${lines}\n  },\n\n`;
  return code.replace(/(export default strategy\(\{\s*\n)/, `$1${block}`);
}

export function injectRunnerDependencyBlock(sourceCode, slug = 'gamma-ladder-engine', version = 1, alias = 'runner') {
  const code = String(sourceCode || '');
  if (/dependencies\s*:/.test(code)) {
    if (!code.includes(`strategyLibrary("${slug}"`)) {
      return code.replace(
        /dependencies:\s*\{/,
        `dependencies: {\n    ${alias}: strategyLibrary("${slug}", ${version}),`,
      );
    }
    return code;
  }
  const block = `  dependencies: {\n    ${alias}: strategyLibrary("${slug}", ${version}),\n  },\n\n`;
  return code.replace(/(export default strategy\(\{\s*\n)/, `$1${block}`);
}

function parseNativeLibraryCall(node) {
  if (node?.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee?.type !== 'Identifier' || !['nativeLibrary', 'strategyLibrary'].includes(callee.name)) return null;
  const slugNode = node.arguments[0];
  const versionNode = node.arguments[1];
  const slug = slugNode?.type === 'Literal' && typeof slugNode.value === 'string' ? slugNode.value.trim() : null;
  const version = versionNode?.type === 'Literal' && Number.isFinite(Number(versionNode.value))
    ? Number(versionNode.value)
    : 1;
  if (!slug) return null;
  return { slug, version };
}

function propertyKey(prop) {
  if (prop.key?.type === 'Identifier') return prop.key.name;
  if (prop.key?.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}

function depError(dep, code, message) {
  return {
    line: dep.loc?.start?.line || dep.loc?.line || 1,
    column: dep.loc?.start?.column || dep.loc?.column || 1,
    code,
    message,
    fix_hint: 'Declare strategyLibrary("edge-sniper-models", 1) in dependencies.',
  };
}