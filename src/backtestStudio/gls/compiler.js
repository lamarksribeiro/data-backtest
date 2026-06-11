import { DEBUG_FUNCTIONS, ORDER_FUNCTIONS } from './blocks.js';

/**
 * Compila AST GLS validado em funções JS nativas (uma vez por run).
 * Semântica espelha createInterpreter() em runtime.js.
 */
export function compileStrategy(ast) {
  return {
    onEventStart: compileHook(ast.hooks?.onEventStart),
    onTick: compileHook(ast.hooks?.onTick),
    onEventEnd: compileHook(ast.hooks?.onEventEnd),
  };
}

function compileHook(hook) {
  if (!hook?.body?.length) return null;
  const body = hook.body.map((stmt) => emitStatement(stmt, 0)).join('\n');
  const src = `
'use strict';
const __locals = Object.create(null);
function __getLocal(n) { return Object.prototype.hasOwnProperty.call(__locals, n) ? __locals[n] : undefined; }
function __setLocal(n, v) { __locals[n] = v; }
function __truthy(v) { return Boolean(v); }
function __setPath(obj, path, value) {
  if (!path.length) return;
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}
function __objectArg(v) { return v && typeof v === 'object' ? v : {}; }
function __call(path, args) {
  if (path === 'enter') return orders.enter(args[0], __objectArg(args[1]));
  if (path === 'exit') return orders.exit(__objectArg(args[0]));
  if (path === 'reverse') return orders.reverse(args[0], __objectArg(args[1]));
  if (path === 'closeOpenPosition') return orders.closeOpenPosition(__objectArg(args[0]));
  if (path === 'log') return debug.log(args[0], args[1]);
  if (path === 'mark') return args.length > 1 ? debug.mark(args[0], args[1]) : debug.mark(args[0], {});
  if (path === 'metric') return debug.metric(args[0], args[1]);
  const dot = path.indexOf('.');
  if (dot > 0) {
    const ns = path.slice(0, dot);
    const fn = path.slice(dot + 1);
    const target = lib[ns];
    if (target && target[fn]) return target[fn](...args);
  }
  throw new Error('Unknown function: ' + path);
}
${body}
`;
  // eslint-disable-next-line no-new-func
  return new Function('ctx', 'lib', 'orders', 'debug', src);
}

function emitStatement(stmt, depth) {
  const pad = '  '.repeat(depth);
  switch (stmt.type) {
    case 'Let':
      return `${pad}__setLocal(${JSON.stringify(stmt.name)}, ${emitExpr(stmt.value)});`;
    case 'Assign': {
      const target = stmt.target;
      if (target.type === 'Member') {
        const root = rootName(target);
        const path = memberPath(target);
        if (root === 'state') {
          return `${pad}__setPath(ctx.state, ${JSON.stringify(path.slice(1))}, ${emitExpr(stmt.value)});`;
        }
        if (root === 'runState') {
          return `${pad}__setPath(ctx.runState, ${JSON.stringify(path.slice(1))}, ${emitExpr(stmt.value)});`;
        }
      }
      throw new Error('Invalid assignment target in compiled hook');
    }
    case 'If': {
      const consequent = stmt.consequent.map((s) => emitStatement(s, depth + 1)).join('\n');
      const alternate = stmt.alternate?.length
        ? ` else {\n${stmt.alternate.map((s) => emitStatement(s, depth + 1)).join('\n')}\n${pad}}`
        : '';
      return `${pad}if (__truthy(${emitExpr(stmt.test)})) {\n${consequent}\n${pad}}${alternate}`;
    }
    case 'ExprStmt':
      return `${pad}${emitExpr(stmt.expr)};`;
    default:
      return `${pad}/* unsupported stmt ${stmt.type} */`;
  }
}

function emitExpr(node) {
  if (!node) return 'null';
  switch (node.type) {
    case 'Literal':
      return JSON.stringify(node.value);
    case 'Identifier': {
      const n = node.name;
      if (n === 'params') return 'ctx.params';
      if (n === 'state') return 'ctx.state';
      if (n === 'runState') return 'ctx.runState';
      if (n === 'position') return 'ctx.position';
      if (n === 'tick') return 'ctx.tick';
      if (n === 'event') return 'ctx.event';
      if (n === 'samples') return 'ctx.samples';
      return `__getLocal(${JSON.stringify(n)})`;
    }
    case 'Unary':
      if (node.operator === '!') return `!__truthy(${emitExpr(node.argument)})`;
      return emitExpr(node.argument);
    case 'Binary': {
      const left = emitExpr(node.left);
      if (node.operator === '&&') return `(__truthy(${left}) ? ${emitExpr(node.right)} : ${left})`;
      if (node.operator === '||') return `(__truthy(${left}) ? ${left} : ${emitExpr(node.right)})`;
      const right = emitExpr(node.right);
      switch (node.operator) {
        case '+': return `(Number(${left}) + Number(${right}))`;
        case '-': return `(Number(${left}) - Number(${right}))`;
        case '*': return `(Number(${left}) * Number(${right}))`;
        case '/': return `(Number(${right}) === 0 ? 0 : Number(${left}) / Number(${right}))`;
        case '==': return `(${left} == ${right})`;
        case '!=': return `(${left} != ${right})`;
        case '<': return `(Number(${left}) < Number(${right}))`;
        case '<=': return `(Number(${left}) <= Number(${right}))`;
        case '>': return `(Number(${left}) > Number(${right}))`;
        case '>=': return `(Number(${left}) >= Number(${right}))`;
        default: return 'null';
      }
    }
    case 'Member': {
      const obj = emitExpr(node.object);
      return `(${obj} && typeof ${obj} === 'object' ? ${obj}[${JSON.stringify(node.property)}] : undefined)`;
    }
    case 'ObjectLiteral': {
      const props = (node.properties || []).map(
        (p) => `${JSON.stringify(p.key)}: ${emitExpr(p.value)}`,
      ).join(', ');
      return `({ ${props} })`;
    }
    case 'Call': {
      const path = callPath(node.callee);
      const args = node.args.map((a) => emitExpr(a)).join(', ');
      return `__call(${JSON.stringify(path)}, [${args}])`;
    }
    default:
      return 'null';
  }
}

function callPath(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member' && node.object.type === 'Identifier') {
    return `${node.object.name}.${node.property}`;
  }
  return '';
}

function rootName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member') return rootName(node.object);
  return '';
}

function memberPath(node) {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'Member') return [...memberPath(node.object), node.property];
  return [];
}

/** Análise estática de colunas usadas pela estratégia (para column pruning). */
export function analyzeStrategyColumns(ast, defaultBookDepth = 25) {
  let bookDepth = 1;
  const scalarCols = new Set([
    'market_id', 'underlying', 'interval', 'condition_id', 'event_start', 'event_end', 'ts',
    'underlying_price', 'price_to_beat', 'up_price', 'down_price',
    'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
    'coverage', 'degraded', 'book_depth',
  ]);
  let needsBookLevels = false;

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Call') {
      const path = callPath(node.callee);
      if (path.startsWith('book.')) {
        needsBookLevels = true;
        const fn = path.slice(5);
        if (['ask', 'bid', 'spread', 'availableQty', 'liquidityRatio'].includes(fn)) {
          bookDepth = Math.max(bookDepth, defaultBookDepth);
        }
      }
      for (const arg of node.args || []) walk(arg);
      walk(node.callee);
      return;
    }
    if (node.type === 'Member' && node.object?.type === 'Identifier' && node.object.name === 'tick') {
      const prop = tickPropToColumn(node.property);
      if (prop) scalarCols.add(prop);
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

  return {
    bookDepth: needsBookLevels ? Math.min(bookDepth, defaultBookDepth) : 0,
    scalarColumns: [...scalarCols],
    needsBookLevels,
  };
}

function tickPropToColumn(prop) {
  const map = {
    underlyingPrice: 'underlying_price',
    priceToBeat: 'price_to_beat',
    upPrice: 'up_price',
    downPrice: 'down_price',
    conditionId: 'condition_id',
    eventStart: 'event_start',
    eventEnd: 'event_end',
    marketId: 'market_id',
  };
  return map[prop] || null;
}

/**
 * Estratégias que leem ou escrevem runState entre eventos não podem rodar em paralelo (F4).
 */
export function analyzeStrategyParallelism(ast) {
  let usesRunState = false;

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && node.name === 'runState') {
      usesRunState = true;
      return;
    }
    if (node.type === 'Member') {
      const root = rootName(node);
      if (root === 'runState') usesRunState = true;
    }
    if (node.type === 'Assign') {
      const root = rootName(node.target);
      if (root === 'runState') usesRunState = true;
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

  return {
    parallelSafe: !usesRunState,
    usesRunState,
  };
}

export { ORDER_FUNCTIONS, DEBUG_FUNCTIONS };
