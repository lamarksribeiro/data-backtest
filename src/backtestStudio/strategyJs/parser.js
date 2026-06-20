import * as acorn from 'acorn';

import {
  MAX_AST_DEPTH,
  MAX_AST_NODES,
  MAX_SOURCE_BYTES,
} from './constants.js';
import { extractDependenciesObject } from './dependencies.js';

export function parseStrategyJs(source) {
  const code = String(source || '');
  if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_BYTES) {
    const err = new Error(`Source exceeds maximum size of ${MAX_SOURCE_BYTES} bytes`);
    err.line = 1;
    err.column = 1;
    err.code = 'SOURCE_TOO_LARGE';
    throw err;
  }

  let program;
  try {
    program = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'module',
      locations: true,
    });
  } catch (err) {
    const wrapped = new Error(err.message);
    wrapped.line = err.loc?.line || 1;
    wrapped.column = err.loc?.column || 1;
    wrapped.code = 'SYNTAX_ERROR';
    throw wrapped;
  }

  const stats = countAstNodes(program);
  if (stats.nodes > MAX_AST_NODES) {
    const err = new Error(`AST exceeds maximum node count of ${MAX_AST_NODES}`);
    err.line = 1;
    err.column = 1;
    err.code = 'COMPLEXITY_LIMIT';
    throw err;
  }
  if (stats.depth > MAX_AST_DEPTH) {
    const err = new Error(`AST exceeds maximum depth of ${MAX_AST_DEPTH}`);
    err.line = 1;
    err.column = 1;
    err.code = 'COMPLEXITY_LIMIT';
    throw err;
  }

  const strategyCall = extractStrategyCall(program);
  if (!strategyCall) {
    const err = new Error('Expected export default strategy({...}) or strategy({...})');
    err.line = 1;
    err.column = 1;
    err.code = 'MISSING_STRATEGY_WRAPPER';
    throw err;
  }

  return {
    program,
    strategyCall,
    loc: strategyCall.loc,
  };
}

function countAstNodes(node, depth = 0, acc = { nodes: 0, depth: 0 }) {
  if (!node || typeof node !== 'object') return acc;
  acc.nodes += 1;
  acc.depth = Math.max(acc.depth, depth);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) countAstNodes(child, depth + 1, acc);
    } else if (val && typeof val.type === 'string') {
      countAstNodes(val, depth + 1, acc);
    }
  }
  return acc;
}

function extractStrategyCall(program) {
  for (const stmt of program.body) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      const call = asStrategyCall(stmt.declaration);
      if (call) return call;
    }
    const call = asStrategyCall(stmt);
    if (call) return call;
  }
  return null;
}

function asStrategyCall(node) {
  if (!node) return null;
  if (node.type === 'ExpressionStatement') {
    return asStrategyCall(node.expression);
  }
  if (node.type === 'CallExpression' && isStrategyCallee(node.callee)) {
    if (node.arguments.length !== 1 || node.arguments[0].type !== 'ObjectExpression') {
      return null;
    }
    return node;
  }
  return null;
}

function isStrategyCallee(callee) {
  if (callee.type === 'Identifier' && callee.name === 'strategy') return true;
  return false;
}

export function extractStrategyConfig(strategyCall) {
  const obj = strategyCall.arguments[0];
  const config = {
    name: null,
    params: [],
    hooks: {},
    dependencies: [],
    loc: obj.loc,
  };

  for (const prop of obj.properties) {
    if (prop.type !== 'Property' || prop.kind !== 'init') continue;
    const key = propertyKey(prop);
    if (!key) continue;

    if (key === 'name') {
      config.name = literalString(prop.value);
      continue;
    }
    if (key === 'params') {
      config.params = extractParamsObject(prop.value);
      continue;
    }
    if (key === 'dependencies') {
      config.dependencies = extractDependenciesObject(prop.value);
      continue;
    }
    if (key === 'onEventStart' || key === 'onTick' || key === 'onEventEnd') {
      config.hooks[key] = extractHook(prop.value, key);
    }
  }

  return config;
}

function propertyKey(prop) {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}

function literalString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function extractParamsObject(node) {
  if (node?.type !== 'ObjectExpression') return [];
  const params = [];
  for (const prop of node.properties) {
    if (prop.type !== 'Property' || prop.kind !== 'init') continue;
    const key = propertyKey(prop);
    if (!key) continue;
    const value = extractLiteralValue(prop.value);
    if (value === undefined) continue;
    params.push({
      name: key,
      default: value,
      loc: prop.loc,
    });
  }
  return params;
}

function extractLiteralValue(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal') {
    return -node.argument.value;
  }
  return undefined;
}

function extractHook(node, name) {
  const fn = unwrapFunction(node);
  if (!fn) return null;
  const bindings = extractParamBindings(fn.params);
  return {
    name,
    bindings,
    body: fn.body,
    loc: fn.loc,
    isExpressionBody: fn.body.type !== 'BlockStatement',
  };
}

function unwrapFunction(node) {
  if (!node) return null;
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return node;
  return null;
}

export function extractParamBindings(params) {
  const bindings = new Set();
  for (const param of params) {
    if (param.type === 'Identifier') {
      bindings.add(param.name);
      continue;
    }
    if (param.type === 'ObjectPattern') {
      for (const prop of param.properties) {
        if (prop.type === 'Property' && prop.key.type === 'Identifier') {
          bindings.add(prop.key.name);
        }
      }
    }
  }
  return bindings;
}