import { parse, extractParamsSchema, syntaxError } from './parser.js';
import { HOOKS, isKnownCall, ORDER_FUNCTIONS } from './blocks.js';
import { analyzeStrategyColumns } from './compiler.js';


const WRITABLE_ROOTS = new Set(['state', 'runState']);

const TICK_PROP_TO_COLUMN = {
  underlyingPrice: 'underlying_price',
  priceToBeat: 'price_to_beat',
  upPrice: 'up_price',
  downPrice: 'down_price',
  conditionId: 'condition_id',
  eventStart: 'event_start',
  eventEnd: 'event_end',
  marketId: 'market_id',
  ts: 'ts',
};
const MAX_BODY_STATEMENTS = 500;
const MAX_HOOKS = 10;

export function validate(source, { language = 'gls-v1', bookDepth = 25 } = {}) {
  const errors = [];
  const warnings = [];
  const code = String(source || '').trim();

  if (!code) {
    return fail([{ line: 1, column: 1, code: 'EMPTY_SOURCE', message: 'source_code is required' }], language);
  }
  if (String(language || '').trim() !== 'gls-v1') {
    errors.push({ line: 1, column: 1, code: 'UNSUPPORTED_LANGUAGE', message: `Unsupported language: ${language}` });
    return fail(errors, language);
  }

  let ast;
  try {
    ast = parse(code);
  } catch (err) {
    errors.push({
      line: err.line || 1,
      column: err.column || 1,
      code: err.code || 'SYNTAX_ERROR',
      message: err.message,
    });
    return fail(errors, language, warnings);
  }

  return validateAst(ast, { language, errors, warnings, bookDepth });
}

/** Valida um AST GLS já parseado (ex.: lowering Strategy JS). */
export function validateAst(ast, { language = 'gls-v1', errors: seedErrors = null, warnings: seedWarnings = null, bookDepth = 25 } = {}) {
  const errors = seedErrors ?? [];
  const warnings = seedWarnings ?? [];

  if (!ast.name) {
    errors.push({ line: ast.loc?.line || 1, column: 1, code: 'MISSING_NAME', message: 'Strategy name is required' });
  }

  const paramNames = new Set();
  for (const param of ast.params) {
    if (paramNames.has(param.name)) {
      errors.push({
        line: param.loc?.line || 1,
        column: 1,
        code: 'DUPLICATE_PARAM',
        message: `Duplicate param: ${param.name}`,
      });
    }
    paramNames.add(param.name);
  }

  const hookNames = Object.keys(ast.hooks);
  if (hookNames.length > MAX_HOOKS) {
    errors.push({ line: 1, column: 1, code: 'COMPLEXITY_LIMIT', message: 'Too many hooks' });
  }
  for (const hookName of hookNames) {
    if (!HOOKS.has(hookName)) {
      errors.push({
        line: ast.hooks[hookName].loc?.line || 1,
        column: 1,
        code: 'UNKNOWN_HOOK',
        message: `Unknown hook: ${hookName}`,
      });
    }
    validateBlock(ast.hooks[hookName].body, errors, new Set(['tick', 'event', 'params', 'state', 'runState', 'position', 'samples']));
  }

  if (!ast.hooks.onTick) {
    warnings.push({ line: 1, column: 1, code: 'MISSING_ON_TICK', message: 'onTick hook is absent; strategy will not react to ticks' });
  }

  if (errors.length === 0) {
    const columnAnalysis = analyzeStrategyColumns(ast, bookDepth);
    const columnErrors = validateColumnAnalysisComplete(ast, columnAnalysis);
    errors.push(...columnErrors);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    params_schema: extractParamsSchema(ast),
    ast,
    language: String(language || 'gls-v1'),
  };
}

function validateColumnAnalysisComplete(ast, analysis) {
  const errors = [];
  const usedTickProps = collectTickProps(ast);
  for (const prop of usedTickProps) {
    const col = TICK_PROP_TO_COLUMN[prop];
    if (col && !analysis.scalarColumns.includes(col)) {
      errors.push({
        line: 1,
        column: 1,
        code: 'COLUMN_ANALYSIS_INCOMPLETE',
        message: `Column analysis could not map tick.${prop}`,
        fix_hint: 'Use only known tick properties with static access.',
      });
    }
  }
  return errors;
}

function collectTickProps(ast) {
  const props = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Member' && node.object?.type === 'Identifier' && node.object.name === 'tick') {
      props.add(node.property);
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === 'object') walk(val);
    }
  }
  for (const hook of Object.values(ast.hooks || {})) {
    for (const stmt of hook?.body || []) walk(stmt);
  }
  return props;
}

function validateBlock(body, errors, outerScope) {
  if (!Array.isArray(body)) return;
  if (body.length > MAX_BODY_STATEMENTS) {
    errors.push({ line: 1, column: 1, code: 'COMPLEXITY_LIMIT', message: 'Block exceeds statement limit' });
    return;
  }
  const scope = new Set(outerScope);
  for (const stmt of body) validateStatement(stmt, errors, scope);
}

function validateStatement(stmt, errors, scope) {
  switch (stmt.type) {
    case 'Let':
      if (scope.has(stmt.name)) {
        pushError(errors, stmt, 'DUPLICATE_VAR', `Variable already declared: ${stmt.name}`);
      }
      scope.add(stmt.name);
      validateExpr(stmt.value, errors, scope);
      break;
    case 'Assign':
      validateAssignTarget(stmt.target, errors);
      validateExpr(stmt.value, errors, scope);
      break;
    case 'If':
      validateExpr(stmt.test, errors, scope);
      validateBlock(stmt.consequent, errors, scope);
      if (stmt.alternate) validateBlock(stmt.alternate, errors, scope);
      break;
    case 'ExprStmt':
      validateExpr(stmt.expr, errors, scope);
      break;
    default:
      break;
  }
}

function validateAssignTarget(node, errors) {
  if (node.type === 'Member') {
    const root = rootIdentifier(node);
    if (!WRITABLE_ROOTS.has(root)) {
      pushError(errors, node, 'FORBIDDEN_WRITE', `Cannot assign to ${root}; only state/runState are writable`);
    }
    return;
  }
  pushError(errors, node, 'FORBIDDEN_WRITE', 'Assignment must target state.* or runState.*');
}

function validateExpr(node, errors, scope) {
  if (!node) return;
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
      if (node.type === 'Identifier' && !isAllowedIdentifier(node.name, scope)) {
        pushError(errors, node, 'UNDEFINED_VAR', `Variable not declared: ${node.name}`);
      }
      break;
    case 'Unary':
      validateExpr(node.argument, errors, scope);
      break;
    case 'Binary':
      validateExpr(node.left, errors, scope);
      validateExpr(node.right, errors, scope);
      break;
    case 'Member':
      validateExpr(node.object, errors, scope);
      if (node.object?.type === 'Identifier' && node.object.name === 'tick') {
        const col = TICK_PROP_TO_COLUMN[node.property];
        if (!col) {
          pushError(errors, node, 'UNKNOWN_TICK_PROPERTY', `tick.${node.property} cannot be compiled to columns`, 'Use a known tick property with static access.');
        }
      }
      break;
    case 'ObjectLiteral':
      for (const prop of node.properties || []) validateExpr(prop.value, errors, scope);
      break;
    case 'Call': {
      const path = callPath(node.callee);
      if (!path) {
        pushError(errors, node, 'INVALID_CALL', 'Invalid function call');
      } else if (!isKnownCall(path)) {
        pushError(errors, node, 'UNKNOWN_FUNCTION', `${path} does not exist`);
      } else if (ORDER_FUNCTIONS.has(path)) {
        validateOrderCall(path, node, errors, scope);
      }
      for (const arg of node.args) validateExpr(arg, errors, scope);
      break;
    }
    default:
      break;
  }
}

function validateOrderCall(name, node, errors, scope) {
  if (name === 'enter' && node.args.length < 2) {
    pushError(errors, node, 'INVALID_ARGS', 'enter(side, { price, budget, reason }) requires side and options');
  }
  if ((name === 'exit' || name === 'closeOpenPosition') && name === 'exit' && node.args.length < 1) {
    pushError(errors, node, 'INVALID_ARGS', 'exit({ price, reason }) requires options object');
  }
}

function isAllowedIdentifier(name, scope) {
  if (scope.has(name)) return true;
  return ['params', 'state', 'runState', 'position', 'tick', 'event', 'samples', 'true', 'false', 'null'].includes(name);
}

function callPath(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member' && node.object.type === 'Identifier') {
    return `${node.object.name}.${node.property}`;
  }
  return null;
}

function rootIdentifier(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member') return rootIdentifier(node.object);
  return '';
}

function pushError(errors, node, code, message, fix_hint = null) {
  errors.push({
    line: node.loc?.line || 1,
    column: node.loc?.column || 1,
    code,
    message,
    ...(fix_hint ? { fix_hint } : {}),
  });
}

function fail(errors, language, warnings = []) {
  return {
    ok: false,
    errors,
    warnings,
    params_schema: {},
    language: String(language || 'gls-v1'),
  };
}

export { syntaxError };
