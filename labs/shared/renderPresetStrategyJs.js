function formatJsValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function formatJsParams(params) {
  const lines = Object.entries(params).map(([key, value]) => `    ${key}: ${formatJsValue(value)},`);
  return `{\n${lines.join('\n')}\n  }`;
}

export function renderPresetStrategyJs(sourceCode, params, strategyName) {
  let result = String(sourceCode || '');
  if (strategyName) {
    result = result.replace(/name:\s*"[^"]*"/, `name: "${strategyName}"`);
  }
  const paramsBlock = formatJsParams(params || {});
  result = result.replace(
    /params:\s*\{[\s\S]*?\n  \},/,
    `params: ${paramsBlock},`,
  );
  return result;
}