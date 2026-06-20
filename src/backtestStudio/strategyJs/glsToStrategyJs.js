import { parse as parseGls } from '../gls/parser.js';

export function glsToStrategyJs(sourceOrAst) {
  const ast = typeof sourceOrAst === 'string' ? parseGls(sourceOrAst) : sourceOrAst;
  const lines = [];
  lines.push('export default strategy({');
  lines.push(`  name: ${JSON.stringify(ast.name || 'Unnamed Strategy')},`);
  lines.push('');
  lines.push('  params: {');
  for (const param of ast.params || []) {
    lines.push(`    ${param.name}: ${formatLiteral(param.default)},`);
  }
  lines.push('  },');
  lines.push('');

  if (ast.hooks?.onEventStart) {
    lines.push('  onEventStart({ state }) {');
    lines.push(...emitHookBody(ast.hooks.onEventStart.body, '    '));
    lines.push('  },');
    lines.push('');
  }

  if (ast.hooks?.onTick) {
    lines.push('  onTick(ctx) {');
    lines.push('    const { tick, event, state, params, position, runState } = ctx;');
    lines.push(...emitHookBody(ast.hooks.onTick.body, '    '));
    lines.push('  },');
    lines.push('');
  }

  if (ast.hooks?.onEventEnd) {
    lines.push('  onEventEnd() {');
    lines.push(...emitHookBody(ast.hooks.onEventEnd.body, '    '));
    lines.push('  },');
    lines.push('');
  }

  lines.push('});');
  return lines.join('\n');
}

function emitHookBody(body, indent) {
  const out = [];
  for (const stmt of body || []) {
    out.push(...emitStatement(stmt, indent));
  }
  return out;
}

function emitStatement(stmt, indent) {
  switch (stmt.type) {
    case 'Let':
      return [`${indent}const ${stmt.name} = ${emitExpr(stmt.value)};`];
    case 'Assign':
      return [`${indent}${emitLValue(stmt.target)} = ${emitExpr(stmt.value)};`];
    case 'If': {
      const lines = [`${indent}if (${emitExpr(stmt.test)}) {`];
      for (const s of stmt.consequent) lines.push(...emitStatement(s, indent + '  '));
      if (stmt.alternate?.length) {
        lines.push(`${indent}} else {`);
        for (const s of stmt.alternate) lines.push(...emitStatement(s, indent + '  '));
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}}`);
      }
      return lines;
    }
    case 'ExprStmt':
      if (stmt.expr?.type === 'Identifier' && stmt.expr.name === 'return') {
        return [`${indent}return;`];
      }
      return [`${indent}${emitExpr(stmt.expr)};`];
    default:
      return [];
  }
}

function emitExpr(node) {
  if (!node) return 'null';
  switch (node.type) {
    case 'Literal':
      return formatLiteral(node.value);
    case 'Identifier':
      return node.name;
    case 'Unary':
      if (node.operator === '!') return `!${emitExpr(node.argument)}`;
      return emitExpr(node.argument);
    case 'Binary':
      return `(${emitExpr(node.left)} ${node.operator} ${emitExpr(node.right)})`;
    case 'Member':
      return `${emitExpr(node.object)}.${node.property}`;
    case 'ObjectLiteral':
      return `{ ${(node.properties || []).map((p) => `${JSON.stringify(p.key)}: ${emitExpr(p.value)}`).join(', ')} }`;
    case 'Call':
      return `${emitCallee(node.callee)}(${node.args.map(emitExpr).join(', ')})`;
    default:
      return 'null';
  }
}

function emitCallee(node) {
  const path = callPath(node);
  if (!path) return 'unknown';
  if (['enter', 'exit', 'reverse', 'closeOpenPosition'].includes(path)) {
    return `orders.${path}`;
  }
  if (['log', 'mark', 'metric'].includes(path)) {
    return `trace.${path}`;
  }
  return path;
}

function callPath(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member' && node.object.type === 'Identifier') {
    return `${node.object.name}.${node.property}`;
  }
  return null;
}

function emitLValue(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member') return `${emitLValue(node.object)}.${node.property}`;
  return 'state';
}

function formatLiteral(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}