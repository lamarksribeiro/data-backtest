import {
  CTX_BINDINGS,
  MATH_TO_STDLIB,
  ORDER_ALIASES,
  TRACE_ALIASES,
  TOP_LEVEL_ORDER,
  TOP_LEVEL_TRACE,
} from './constants.js';

export function lowerToGlsAst(config) {
  const hooks = {};
  for (const [name, hook] of Object.entries(config.hooks)) {
    if (!hook) continue;
    const scope = new Set([...CTX_BINDINGS, ...hook.bindings]);
    const body = lowerBlock(hook.body, scope);
    hooks[name] = {
      name,
      args: hookArgsForName(name),
      body,
      loc: loc(hook.loc),
    };
  }

  return {
    type: 'Strategy',
    name: config.name || 'Unnamed Strategy',
    params: (config.params || []).map((p) => ({
      name: p.name,
      default: p.default,
      loc: loc(p.loc),
    })),
    hooks,
    loc: loc(config.loc),
  };
}

function hookArgsForName(name) {
  if (name === 'onTick') return ['tick', 'event'];
  if (name === 'onEventStart' || name === 'onEventEnd') return ['event'];
  return [];
}

function lowerBlock(fnNode, scope) {
  if (!fnNode) return [];
  if (fnNode.type !== 'BlockStatement') {
    return [];
  }
  const body = [];
  for (const stmt of fnNode.body) {
    const lowered = lowerStatement(stmt, scope);
    if (Array.isArray(lowered)) body.push(...lowered);
    else if (lowered) body.push(lowered);
  }
  return body;
}

function lowerStatement(stmt, scope) {
  switch (stmt.type) {
    case 'VariableDeclaration': {
      const out = [];
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'ObjectPattern') {
          const names = destructuringNames(decl.id);
          if (names.every((name) => scope.has(name) || CTX_BINDINGS.has(name))) {
            for (const name of names) scope.add(name);
            continue;
          }
          throw loweringError(stmt, 'Destructuring is only supported for ctx bindings (tick, event, state, params, position, runState)');
        }
        if (decl.id.type !== 'Identifier') {
          throw loweringError(stmt, 'Only simple const/let declarations are supported');
        }
        scope.add(decl.id.name);
        out.push({
          type: 'Let',
          name: decl.id.name,
          value: lowerExpr(decl.init, scope),
          loc: loc(decl.loc),
        });
      }
      return out;
    }
    case 'ExpressionStatement': {
      const expr = stmt.expression;
      if (expr.type === 'AssignmentExpression') {
        return {
          type: 'Assign',
          target: lowerLValue(expr.left),
          value: lowerExpr(expr.right, scope),
          loc: loc(stmt.loc),
        };
      }
      return { type: 'ExprStmt', expr: lowerExpr(expr, scope), loc: loc(stmt.loc) };
    }
    case 'IfStatement':
      return {
        type: 'If',
        test: lowerExpr(stmt.test, scope),
        consequent: lowerBlockOrStmt(stmt.consequent, scope),
        alternate: stmt.alternate ? lowerBlockOrStmt(stmt.alternate, scope) : null,
        loc: loc(stmt.loc),
      };
    case 'ReturnStatement':
      return { type: 'ExprStmt', expr: { type: 'Identifier', name: 'return', loc: loc(stmt.loc) }, loc: loc(stmt.loc) };
    case 'BlockStatement':
      return lowerBlock(stmt, scope);
    default:
      throw loweringError(stmt, `Unsupported statement: ${stmt.type}`);
  }
}

function lowerBlockOrStmt(node, scope) {
  if (!node) return [];
  if (node.type === 'BlockStatement') return lowerBlock(node, scope);
  const single = lowerStatement(node, scope);
  return Array.isArray(single) ? single : [single];
}

function lowerLValue(node) {
  if (node.type === 'Identifier') {
    return { type: 'Identifier', name: node.name, loc: loc(node.loc) };
  }
  if (node.type === 'MemberExpression' && !node.computed) {
    return {
      type: 'Member',
      object: lowerLValue(node.object),
      property: node.property.name,
      loc: loc(node.loc),
    };
  }
  throw loweringError(node, 'Invalid assignment target');
}

function lowerExpr(node, scope) {
  if (!node) return { type: 'Literal', value: null, loc: { line: 1, column: 1 } };

  switch (node.type) {
    case 'Literal':
      return { type: 'Literal', value: node.value, loc: loc(node.loc) };
    case 'Identifier':
      return { type: 'Identifier', name: node.name, loc: loc(node.loc) };
    case 'UnaryExpression':
      if (node.operator === '!') {
        return { type: 'Unary', operator: '!', argument: lowerExpr(node.argument, scope), loc: loc(node.loc) };
      }
      if (node.operator === '-') {
        return {
          type: 'Binary',
          operator: '-',
          left: { type: 'Literal', value: 0, loc: loc(node.loc) },
          right: lowerExpr(node.argument, scope),
          loc: loc(node.loc),
        };
      }
      throw loweringError(node, `Unsupported unary operator: ${node.operator}`);
    case 'BinaryExpression':
      return {
        type: 'Binary',
        operator: node.operator,
        left: lowerExpr(node.left, scope),
        right: lowerExpr(node.right, scope),
        loc: loc(node.loc),
      };
    case 'LogicalExpression':
      return {
        type: 'Binary',
        operator: node.operator,
        left: lowerExpr(node.left, scope),
        right: lowerExpr(node.right, scope),
        loc: loc(node.loc),
      };
    case 'ConditionalExpression':
      return lowerTernary(node, scope);
    case 'MemberExpression':
      if (node.computed) throw loweringError(node, 'Computed member access is not supported');
      return {
        type: 'Member',
        object: lowerExpr(node.object, scope),
        property: node.property.name,
        loc: loc(node.loc),
      };
    case 'ObjectExpression':
      return {
        type: 'ObjectLiteral',
        properties: node.properties.map((prop) => ({
          key: propertyKey(prop),
          value: lowerExpr(prop.value, scope),
        })),
        loc: loc(node.loc),
      };
    case 'CallExpression':
      return lowerCall(node, scope);
    case 'AssignmentExpression':
      throw loweringError(node, 'Use a statement assignment (state.x = y), not expression assignment');
    default:
      throw loweringError(node, `Unsupported expression: ${node.type}`);
  }
}

function lowerTernary(node, scope) {
  const test = lowerExpr(node.test, scope);
  const cons = lowerExpr(node.consequent, scope);
  const alt = lowerExpr(node.alternate, scope);
  return {
    type: 'Binary',
    operator: '||',
    left: {
      type: 'Binary',
      operator: '&&',
      left: test,
      right: cons,
      loc: loc(node.loc),
    },
    right: alt,
    loc: loc(node.loc),
  };
}

function lowerCall(node, scope) {
  const path = normalizeCallPath(callPath(node.callee));
  if (!path) throw loweringError(node, 'Invalid function call');
  const args = node.arguments.map((arg) => lowerExpr(arg, scope));
  const callee = pathToCallee(path);
  return { type: 'Call', callee, args, loc: loc(node.loc) };
}

function pathToCallee(path) {
  const dot = path.indexOf('.');
  if (dot <= 0) {
    return { type: 'Identifier', name: path, loc: { line: 1, column: 1 } };
  }
  const ns = path.slice(0, dot);
  const fn = path.slice(dot + 1);
  return {
    type: 'Member',
    object: { type: 'Identifier', name: ns, loc: { line: 1, column: 1 } },
    property: fn,
    loc: { line: 1, column: 1 },
  };
}

function normalizeCallPath(path) {
  if (!path) return null;
  if (ORDER_ALIASES[path]) return ORDER_ALIASES[path];
  if (TRACE_ALIASES[path]) return TRACE_ALIASES[path];
  if (TOP_LEVEL_ORDER.has(path) || TOP_LEVEL_TRACE.has(path)) return path;
  if (path.startsWith('Math.')) {
    const fn = path.slice('Math.'.length);
    const mapped = MATH_TO_STDLIB[fn];
    if (mapped) return `math.${mapped}`;
  }
  return path;
}

function callPath(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

function propertyKey(prop) {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return 'key';
}

function loc(acornLoc) {
  return {
    line: acornLoc?.start?.line || acornLoc?.line || 1,
    column: acornLoc?.start?.column || acornLoc?.column || 1,
  };
}

function destructuringNames(pattern) {
  const names = [];
  for (const prop of pattern.properties || []) {
    if (prop.type === 'Property' && prop.key.type === 'Identifier') {
      names.push(prop.key.name);
    }
  }
  return names;
}

function loweringError(node, message) {
  const err = new Error(message);
  err.line = node?.loc?.start?.line || 1;
  err.column = node?.loc?.start?.column || 1;
  err.code = 'LOWERING_ERROR';
  throw err;
}