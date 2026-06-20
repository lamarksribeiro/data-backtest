import {
  ALLOWED_HOOKS,
  CTX_BINDINGS,
  FORBIDDEN_IDENTIFIERS,
  FORBIDDEN_MEMBER_ROOTS,
  MATH_WHITELIST,
  MAX_BODY_STATEMENTS,
  MAX_HOOKS,
  TICK_PROP_TO_COLUMN,
} from './constants.js';
import { isKnownCall } from '../gls/blocks.js';
import { isModelCallAllowed, validateDependencies } from './dependencies.js';

const FORBIDDEN_NODE_TYPES = new Set([
  'ForStatement',
  'ImportDeclaration',
  'ImportExpression',
  'AwaitExpression',
  'ClassDeclaration',
  'ClassExpression',
  'NewExpression',
  'WithStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'YieldExpression',
  'MetaProperty',
  'TaggedTemplateExpression',
  'TemplateLiteral',
  'FunctionDeclaration',
]);

export function validateSecurity(program, config, { inOnTick = false, helperNames = [], db = null, embeddedRunner = false, embeddedModels = false } = {}) {
  const allowedHelpers = new Set(helperNames);
  const dependencies = config.dependencies || [];
  const errors = [];
  const warnings = [];

  if (!config.name) {
    errors.push(errorAt(config.loc, 'MISSING_NAME', 'Strategy name is required (name: "...")'));
  }

  if (!embeddedModels) validateDependencies(dependencies, errors, db);

  const hookNames = Object.keys(config.hooks);
  if (hookNames.length > MAX_HOOKS) {
    errors.push(errorAt({ line: 1, column: 1 }, 'COMPLEXITY_LIMIT', 'Too many hooks'));
  }

  for (const hookName of hookNames) {
    if (!ALLOWED_HOOKS.has(hookName)) {
      errors.push(errorAt(config.hooks[hookName]?.loc, 'UNKNOWN_HOOK', `Unknown hook: ${hookName}`));
    }
  }

  if (!config.hooks.onTick) {
    warnings.push(errorAt({ line: 1, column: 1 }, 'MISSING_ON_TICK', 'onTick hook is absent; strategy will not react to ticks'));
  }

  if (!embeddedRunner && !embeddedModels) walkNode(program, (node, ctx) => {
    if (node.type === 'FunctionDeclaration' && ctx.atProgramTopLevel) {
      return;
    }
    if (FORBIDDEN_NODE_TYPES.has(node.type)) {
      errors.push(forbiddenNodeError(node));
      return;
    }

    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ImportDeclaration') {
      errors.push(errorAt(node.loc, 'FORBIDDEN_IMPORT', 'imports are not allowed in Strategy JS', 'Remove import statements.'));
    }

    if (node.type === 'CallExpression') {
      checkForbiddenCalls(node, errors);
    }

    if (node.type === 'Identifier' && FORBIDDEN_IDENTIFIERS.has(node.name)) {
      errors.push(errorAt(node.loc, 'FORBIDDEN_IDENTIFIER', `${node.name} is not allowed in Strategy JS`));
    }

    if (node.type === 'Identifier' && (node.name === 'nativeLibrary' || node.name === 'strategyLibrary') && !ctx.inDependencies) {
      errors.push(errorAt(node.loc, 'FORBIDDEN_LIBRARY_CALL', 'strategyLibrary() is only allowed inside dependencies', 'Move the call to dependencies: { alias: strategyLibrary("slug", version) }.'));
    }

    if (node.type === 'MemberExpression' && !node.computed) {
      const root = memberRoot(node);
      if (FORBIDDEN_MEMBER_ROOTS.has(root)) {
        if (root === 'Math') {
          const prop = node.property?.name;
          if (prop === 'random') {
            errors.push(errorAt(node.loc, 'FORBIDDEN_MATH', 'Math.random() is not deterministic', 'Use tick.ts or time.secondsUntil() for time.'));
          } else if (!MATH_WHITELIST.has(prop)) {
            errors.push(errorAt(node.loc, 'FORBIDDEN_MATH', `Math.${prop} is not allowed`, 'Use an allowed Math.* function or math.* stdlib primitive.'));
          }
        } else if (root === 'Date') {
          errors.push(errorAt(node.loc, 'FORBIDDEN_DATE', 'Date.now() is not deterministic', 'Use tick.ts or time.secondsUntil().'));
        } else {
          errors.push(errorAt(node.loc, 'FORBIDDEN_API', `${root}.* is not allowed in Strategy JS`));
        }
      }
    }

    if (node.type === 'MemberExpression' && node.computed) {
      const root = memberRoot(node);
      if (root === 'tick') {
        errors.push(errorAt(node.loc, 'FORBIDDEN_DYNAMIC_TICK_ACCESS', 'tick[field] cannot be compiled. Use tick.underlyingPrice or another fixed property.', 'Replace dynamic property access with a fixed tick property.'));
      }
    }

    if (ctx.inOnTick) {
      if (node.type === 'ArrayExpression') {
        errors.push(errorAt(node.loc, 'FORBIDDEN_ARRAY_IN_ON_TICK', 'Array literals are not allowed inside onTick', 'Move array constants to top-level or params.'));
      }
      if (node.type === 'CallExpression' && isArrayMethodCall(node)) {
        errors.push(errorAt(node.loc, 'FORBIDDEN_ARRAY_METHOD', 'Array methods are not allowed inside onTick', 'Avoid .map/.filter/.reduce in the hot path.'));
      }
    }

    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      checkWriteTarget(node, errors);
    }
  }, { inOnTick: false, hookStack: [], atProgramTopLevel: true });

  for (const [hookName, hook] of Object.entries(config.hooks)) {
    if (!hook) continue;
    const scope = new Set([...CTX_BINDINGS, ...hook.bindings]);
    validateHookBody(hook, hookName === 'onTick', errors, scope, allowedHelpers, dependencies, embeddedModels);
  }

  return { errors, warnings };
}

function validateHookBody(hook, isOnTick, errors, outerScope, allowedHelpers = new Set(), dependencies = [], embeddedModels = false) {
  if (!hook) return;
  if (hook.isExpressionBody) {
    errors.push(errorAt(hook.loc, 'INVALID_HOOK_BODY', 'Hook body must use a block { ... }'));
    return;
  }
  const body = hook.body?.body || [];
  if (body.length > MAX_BODY_STATEMENTS) {
    errors.push(errorAt(hook.loc, 'COMPLEXITY_LIMIT', 'Block exceeds statement limit'));
  }
  walkStatements(body, errors, outerScope, isOnTick, allowedHelpers, dependencies, embeddedModels);
}

function walkStatements(stmts, errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels = false) {
  const localScope = new Set(scope);
  for (const stmt of stmts) {
    walkStatement(stmt, errors, localScope, inOnTick, allowedHelpers, dependencies, embeddedModels);
  }
}

function walkStatement(stmt, errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels = false) {
  if (!stmt) return;
  walkNode(stmt, () => {}, { inOnTick, hookStack: [] });

  switch (stmt.type) {
    case 'VariableDeclaration':
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'Identifier') scope.add(decl.id.name);
        validateExprCalls(decl.init, errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels);
      }
      break;
    case 'ExpressionStatement':
      validateExprCalls(stmt.expression, errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels);
      break;
    case 'IfStatement':
      validateExprCalls(stmt.test, errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels);
      walkStatements(asBlock(stmt.consequent), errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels);
      if (stmt.alternate) {
        walkStatements(asBlock(stmt.alternate), errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels);
      }
      break;
    case 'ReturnStatement':
      validateExprCalls(stmt.argument, errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels);
      break;
    case 'BlockStatement':
      walkStatements(stmt.body, errors, scope, inOnTick, allowedHelpers, dependencies, embeddedModels);
      break;
    default:
      break;
  }
}

function validateExprCalls(node, errors, scope, inOnTick, allowedHelpers = new Set(), dependencies = [], embeddedModels = false) {
  walkNode(node, (child) => {
    if (child.type === 'CallExpression') {
      const path = callPath(child.callee);
      if (path && !allowedHelpers.has(path) && !isKnownCall(normalizeCallPath(path))) {
        errors.push(errorAt(child.loc, 'UNKNOWN_FUNCTION', `${path} does not exist`));
      }
      if (!embeddedModels && path && !isModelCallAllowed(path, dependencies)) {
        errors.push(errorAt(child.loc, 'MISSING_DEPENDENCY', `${path} requires a native library dependency`, 'Add dependencies: { edgeModels: nativeLibrary("edge-sniper-models", 1) }.'));
      }
    }
    if (child.type === 'MemberExpression' && !child.computed && child.object?.type === 'Identifier' && child.object.name === 'tick') {
      const prop = child.property?.name;
      if (prop && !TICK_PROP_TO_COLUMN[prop] && prop !== 'ts') {
        errors.push(errorAt(child.loc, 'UNKNOWN_TICK_PROPERTY', `tick.${prop} is not a known column`, `Use one of: ${Object.keys(TICK_PROP_TO_COLUMN).join(', ')}`));
      }
    }
  }, { inOnTick, hookStack: [] });
}

function normalizeCallPath(path) {
  if (path.startsWith('orders.')) return path.slice('orders.'.length);
  if (path.startsWith('trace.')) return path.slice('trace.'.length);
  if (path.startsWith('Math.')) return `math.${path.slice('Math.'.length)}`;
  return path;
}

function asBlock(node) {
  if (!node) return [];
  if (node.type === 'BlockStatement') return node.body;
  return [node];
}

function checkForbiddenCalls(node, errors) {
  const path = callPath(node.callee);
  if (!path) return;
  if (path === 'require' || path === 'eval' || path === 'Function') {
    errors.push(errorAt(node.loc, 'FORBIDDEN_CALL', `${path}() is not allowed in Strategy JS`));
  }
  if (path === 'fetch') {
    errors.push(errorAt(node.loc, 'FORBIDDEN_NETWORK', 'fetch() is not allowed in Strategy JS'));
  }
  if (path === 'setTimeout' || path === 'setInterval') {
    errors.push(errorAt(node.loc, 'FORBIDDEN_TIMER', `${path}() is not allowed in Strategy JS`));
  }
}

function checkWriteTarget(node, errors) {
  const target = node.type === 'UpdateExpression' ? node.argument : node.left;
  if (!target) return;
  const root = memberRoot(target);
  if (target.type === 'Identifier') {
    if (!['state', 'runState'].includes(target.name)) {
      errors.push(errorAt(node.loc, 'FORBIDDEN_WRITE', `Cannot assign to ${target.name}; only state/runState are writable`));
    }
    return;
  }
  if (target.type === 'MemberExpression') {
    if (!['state', 'runState'].includes(root)) {
      errors.push(errorAt(node.loc, 'FORBIDDEN_WRITE', `Cannot assign to ${root}; only state/runState are writable`));
    }
  }
}

function isArrayMethodCall(node) {
  if (node.callee?.type !== 'MemberExpression') return false;
  const prop = node.callee.property?.name;
  return ['map', 'filter', 'reduce', 'sort', 'forEach', 'find', 'some', 'every'].includes(prop);
}

function callPath(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

function memberRoot(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return memberRoot(node.object);
  return '';
}

function walkNode(node, visitor, ctx) {
  if (!node || typeof node !== 'object') return;
  visitor(node, ctx);
  const childCtx = node.type === 'Program'
    ? { ...ctx, atProgramTopLevel: true }
    : { ...ctx, atProgramTopLevel: false };
  for (const key of Object.keys(node)) {
    const val = node[key];
    const nextCtx = dependencyChildCtx(node, key, childCtx);
    if (Array.isArray(val)) {
      for (const child of val) walkNode(child, visitor, nextCtx);
    } else if (val && typeof val.type === 'string') {
      walkNode(val, visitor, nextCtx);
    }
  }
}

function dependencyChildCtx(node, key, ctx) {
  if (ctx.inDependencies) return ctx;
  if (node.type === 'Property' && key === 'value' && propertyName(node) === 'dependencies') {
    return { ...ctx, inDependencies: true };
  }
  return ctx;
}

function propertyName(prop) {
  if (prop.key?.type === 'Identifier') return prop.key.name;
  if (prop.key?.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}

function forbiddenNodeError(node) {
  const hints = {
    ImportDeclaration: { code: 'FORBIDDEN_IMPORT', msg: 'imports are not allowed in Strategy JS', fix: 'Remove import statements.' },
    AwaitExpression: { code: 'FORBIDDEN_ASYNC', msg: 'async/await is not allowed in Strategy JS', fix: 'Use synchronous hooks only.' },
    NewExpression: { code: 'FORBIDDEN_NEW', msg: 'new expressions are not allowed in Strategy JS', fix: 'Use literals and stdlib calls.' },
    WhileStatement: { code: 'FORBIDDEN_LOOP', msg: 'while loops are not allowed', fix: 'Use for with a fixed limit.' },
    DoWhileStatement: { code: 'FORBIDDEN_LOOP', msg: 'do/while loops are not allowed', fix: 'Use for with a fixed limit.' },
    ForInStatement: { code: 'FORBIDDEN_LOOP', msg: 'for-in loops are not allowed', fix: 'Use for with a fixed limit.' },
    ForOfStatement: { code: 'FORBIDDEN_LOOP', msg: 'for-of loops are not allowed', fix: 'Use for with a fixed limit.' },
    ForStatement: { code: 'FORBIDDEN_LOOP', msg: 'for loops are not supported in Strategy JS v1', fix: 'Unroll the loop or use stdlib primitives.' },
    ClassDeclaration: { code: 'FORBIDDEN_CLASS', msg: 'class declarations are not allowed in Strategy JS v1', fix: 'Use plain hooks and stdlib calls.' },
  };
  const hint = hints[node.type] || { code: 'FORBIDDEN_CONSTRUCT', msg: `${node.type} is not allowed in Strategy JS`, fix: 'Simplify to supported Strategy JS v1 constructs.' };
  return errorAt(node.loc, hint.code, hint.msg, hint.fix);
}

function errorAt(loc, code, message, fix_hint = null) {
  const err = {
    line: loc?.start?.line || loc?.line || 1,
    column: loc?.start?.column || loc?.column || 1,
    code,
    message,
  };
  if (fix_hint) err.fix_hint = fix_hint;
  return err;
}