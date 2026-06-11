import { TICK_PROP_ALIASES } from '../../backtest/columnStore.js';
import { analyzeStrategyColumns } from './compiler.js';

/**
 * Codegen GLS v2 — hot loop Struct-of-Arrays (V4 F2).
 * Lê colunas por índice; locals reais; calls estáticos da stdlib.
 */
export function compileStrategySoa(ast, bookDepth = 25) {
  const analysis = analyzeStrategyColumns(ast, bookDepth);
  const columnSet = new Set(analysis.scalarColumns);
  for (const side of ['up', 'down']) {
    for (const kind of ['ask', 'bid']) {
      for (let level = 1; level <= analysis.bookDepth; level += 1) {
        columnSet.add(`${side}_${kind}_px_${level}`);
        columnSet.add(`${side}_${kind}_sz_${level}`);
      }
    }
  }

  const bindings = [...columnSet].map((name) => {
    const storage = storageColumnName(name);
    return `const __c_${sanitize(name)} = cols.get(${JSON.stringify(storage)});`;
  }).join('\n');

  return {
    onEventStart: compileSoaHook(ast.hooks?.onEventStart, bindings),
    onTick: compileSoaHook(ast.hooks?.onTick, bindings),
    onEventEnd: compileSoaHook(ast.hooks?.onEventEnd, bindings),
  };
}

function compileSoaHook(hook, bindings) {
  if (!hook?.body?.length) return null;
  const localNames = collectLetNames(hook.body);
  const body = hook.body.map((stmt) => emitStatement(stmt, localNames, 0)).join('\n');
  const lets = localNames.map((n) => `let ${n};`).join('\n');
  const src = `
'use strict';
${bindings}
${lets}
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
${body}
`;
  // eslint-disable-next-line no-new-func
  return new Function('ctx', 'cols', 'lib', 'orders', 'debug', src);
}

function collectLetNames(body, names = new Set()) {
  for (const stmt of body || []) {
    if (stmt.type === 'Let') names.add(stmt.name);
    if (stmt.type === 'If') {
      collectLetNames(stmt.consequent, names);
      collectLetNames(stmt.alternate, names);
    }
  }
  return [...names];
}

function emitStatement(stmt, localNames, depth) {
  const pad = '  '.repeat(depth);
  switch (stmt.type) {
    case 'Let':
      return `${pad}${stmt.name} = ${emitExpr(stmt.value, localNames)};`;
    case 'Assign': {
      const target = stmt.target;
      if (target.type === 'Member') {
        const root = rootName(target);
        const path = memberPath(target);
        if (root === 'state') {
          return `${pad}__setPath(ctx.state, ${JSON.stringify(path.slice(1))}, ${emitExpr(stmt.value, localNames)});`;
        }
        if (root === 'runState') {
          return `${pad}__setPath(ctx.runState, ${JSON.stringify(path.slice(1))}, ${emitExpr(stmt.value, localNames)});`;
        }
      }
      throw new Error('Invalid assignment target in compiled-soa hook');
    }
    case 'If': {
      const consequent = stmt.consequent.map((s) => emitStatement(s, localNames, depth + 1)).join('\n');
      const alternate = stmt.alternate?.length
        ? ` else {\n${stmt.alternate.map((s) => emitStatement(s, localNames, depth + 1)).join('\n')}\n${pad}}`
        : '';
      return `${pad}if (__truthy(${emitExpr(stmt.test, localNames)})) {\n${consequent}\n${pad}}${alternate}`;
    }
    case 'ExprStmt':
      return `${pad}${emitExpr(stmt.expr, localNames)};`;
    default:
      return `${pad}/* unsupported stmt ${stmt.type} */`;
  }
}

function emitExpr(node, localNames) {
  if (!node) return 'null';
  switch (node.type) {
    case 'Literal':
      return JSON.stringify(node.value);
    case 'Identifier': {
      const n = node.name;
      if (localNames.includes(n)) return n;
      if (n === 'params') return 'ctx.params';
      if (n === 'state') return 'ctx.state';
      if (n === 'runState') return 'ctx.runState';
      if (n === 'position') return 'ctx.position';
      if (n === 'tick') return 'ctx.tick';
      if (n === 'event') return 'ctx.event';
      if (n === 'samples') return 'ctx.samples';
      return 'undefined';
    }
    case 'Unary':
      if (node.operator === '!') return `!__truthy(${emitExpr(node.argument, localNames)})`;
      return emitExpr(node.argument, localNames);
    case 'Binary': {
      const left = emitExpr(node.left, localNames);
      if (node.operator === '&&') return `(__truthy(${left}) ? ${emitExpr(node.right, localNames)} : ${left})`;
      if (node.operator === '||') return `(__truthy(${left}) ? ${left} : ${emitExpr(node.right, localNames)})`;
      const right = emitExpr(node.right, localNames);
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
      if (node.object?.type === 'Identifier' && node.object.name === 'tick') {
        const col = tickPropToColumnName(node.property);
        if (col) return readColumn(col);
      }
      const obj = emitExpr(node.object, localNames);
      return `${obj}[${JSON.stringify(node.property)}]`;
    }
    case 'ObjectLiteral': {
      const props = (node.properties || []).map(
        (p) => `${JSON.stringify(p.key)}: ${emitExpr(p.value, localNames)}`,
      ).join(', ');
      return `({ ${props} })`;
    }
    case 'Call': {
      const path = callPath(node.callee);
      const args = node.args.map((a) => emitExpr(a, localNames));
      return emitStaticCall(path, args);
    }
    default:
      return 'null';
  }
}

function emitStaticCall(path, args) {
  const joined = args.join(', ');
  if (path === 'enter') return `orders.enter(${args[0] || "''"}, __objectArg(${args[1] || '{}'}))`;
  if (path === 'exit') return `orders.exit(__objectArg(${args[0] || '{}'}))`;
  if (path === 'reverse') return `orders.reverse(${args[0] || "''"}, __objectArg(${args[1] || '{}'}))`;
  if (path === 'closeOpenPosition') return `orders.closeOpenPosition(__objectArg(${args[0] || '{}'}))`;
  if (path === 'log') return `debug.log(${joined})`;
  if (path === 'mark') return args.length > 1 ? `debug.mark(${joined})` : `debug.mark(${args[0]}, {})`;
  if (path === 'metric') return `debug.metric(${joined})`;

  const dot = path.indexOf('.');
  if (dot > 0) {
    const ns = path.slice(0, dot);
    const fn = path.slice(dot + 1);
    return `lib.${ns}.${fn}(${joined})`;
  }
  throw new Error(`Unknown function: ${path}`);
}

function readColumn(columnName) {
  const ref = `__c_${sanitize(columnName)}`;
  return `(Number.isNaN(${ref}[ctx.__i]) ? null : ${ref}[ctx.__i])`;
}

function storageColumnName(name) {
  if (name === 'ts') return '_ts_ms';
  if (name === 'event_start') return '_event_start_ms';
  if (name === 'event_end') return '_event_end_ms';
  return name;
}

function tickPropToColumnName(prop) {
  return TICK_PROP_ALIASES[prop] || prop;
}

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, '_');
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
