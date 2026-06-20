/**
 * Inline pure helper functions before lowering / column analysis (V6 §8.1.1).
 */

export function extractHelperFunctions(program) {
  const helpers = new Map();
  for (const stmt of program.body || []) {
    if (stmt.type !== 'FunctionDeclaration' || !stmt.id?.name) continue;
    const params = (stmt.params || [])
      .filter((p) => p.type === 'Identifier')
      .map((p) => p.name);
    helpers.set(stmt.id.name, {
      name: stmt.id.name,
      params,
      body: stmt.body,
    });
  }
  return helpers;
}

export function inlineHelpersInConfig(config, helpers) {
  if (!helpers?.size) return config;
  const next = {
    ...config,
    hooks: {},
  };
  for (const [hookName, hook] of Object.entries(config.hooks || {})) {
    if (!hook) {
      next.hooks[hookName] = hook;
      continue;
    }
    next.hooks[hookName] = {
      ...hook,
      body: inlineBlock(hook.body, helpers, new Set()),
    };
  }
  return next;
}

function inlineBlock(blockNode, helpers, visiting) {
  if (!blockNode || blockNode.type !== 'BlockStatement') return blockNode;
  const body = [];
  for (const stmt of blockNode.body) {
    const expanded = inlineStatement(stmt, helpers, visiting);
    if (Array.isArray(expanded)) body.push(...expanded);
    else if (expanded) body.push(expanded);
  }
  return { ...blockNode, body };
}

function inlineStatement(stmt, helpers, visiting) {
  if (!stmt) return stmt;

  switch (stmt.type) {
    case 'BlockStatement':
      return inlineBlock(stmt, helpers, visiting);
    case 'IfStatement':
      return {
        ...stmt,
        consequent: inlineBlockOrStmt(stmt.consequent, helpers, visiting),
        alternate: stmt.alternate ? inlineBlockOrStmt(stmt.alternate, helpers, visiting) : null,
      };
    case 'ReturnStatement':
      return {
        ...stmt,
        argument: stmt.argument ? inlineExpr(stmt.argument, helpers, visiting) : null,
      };
    case 'VariableDeclaration':
      return {
        ...stmt,
        declarations: stmt.declarations.map((decl) => ({
          ...decl,
          init: decl.init ? inlineExpr(decl.init, helpers, visiting) : null,
        })),
      };
    case 'ExpressionStatement': {
      const inlined = inlineExpr(stmt.expression, helpers, visiting);
      if (inlined?.type === '__InlineBlock__') {
        return inlined.body;
      }
      return { ...stmt, expression: inlined };
    }
    default:
      return stmt;
  }
}

function inlineBlockOrStmt(node, helpers, visiting) {
  if (!node) return node;
  if (node.type === 'BlockStatement') return inlineBlock(node, helpers, visiting);
  return inlineStatement(node, helpers, visiting);
}

function inlineExpr(node, helpers, visiting) {
  if (!node) return node;

  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
    const helper = helpers.get(node.callee.name);
    if (helper && !visiting.has(helper.name)) {
      const nextVisiting = new Set(visiting);
      nextVisiting.add(helper.name);
      const substituted = substituteParams(helper.body, helper.params, node.arguments, helpers, nextVisiting);
      if (substituted.type === 'BlockStatement') {
        const returnStmt = substituted.body.find((stmt) => stmt.type === 'ReturnStatement');
        if (returnStmt?.argument) {
          return inlineExpr(returnStmt.argument, helpers, nextVisiting);
        }
        return { type: '__InlineBlock__', body: substituted.body };
      }
      return substituted;
    }
  }

  const copy = { ...node };
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      copy[key] = val.map((child) => (child && typeof child.type === 'string' ? inlineExpr(child, helpers, visiting) : child));
    } else if (val && typeof val.type === 'string') {
      copy[key] = inlineExpr(val, helpers, visiting);
    }
  }
  return copy;
}

function substituteParams(blockNode, paramNames, argNodes, helpers, visiting) {
  const replacements = new Map();
  for (let i = 0; i < paramNames.length; i += 1) {
    replacements.set(paramNames[i], argNodes[i] || { type: 'Identifier', name: 'undefined' });
  }
  const cloned = cloneNode(blockNode);
  return replaceIdentifiers(cloneNode(inlineBlock(cloned, helpers, visiting)), replacements);
}

function replaceIdentifiers(node, replacements) {
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'Identifier' && replacements.has(node.name)) {
    return cloneNode(replacements.get(node.name));
  }
  const out = Array.isArray(node) ? [] : { ...node };
  if (Array.isArray(node)) {
    return node.map((child) => replaceIdentifiers(child, replacements));
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      out[key] = val.map((child) => replaceIdentifiers(child, replacements));
    } else if (val && typeof val.type === 'string') {
      out[key] = replaceIdentifiers(val, replacements);
    }
  }
  return out;
}

function cloneNode(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(cloneNode);
  const out = { ...node };
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) out[key] = val.map(cloneNode);
    else if (val && typeof val === 'object') out[key] = cloneNode(val);
  }
  return out;
}