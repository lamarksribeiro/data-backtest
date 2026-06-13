export function formatGlsParamValue(value) {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function renderPresetGls(sourceCode, params, strategyName) {
  let result = String(sourceCode || '');
  if (strategyName) {
    result = result.replace(/^strategy\s+"[^"]*"/m, `strategy "${strategyName}"`);
  }
  for (const [key, value] of Object.entries(params || {})) {
    const regex = new RegExp(`^(\\s*param\\s+${key}\\s*=\\s*)(.+)$`, 'm');
    if (!regex.test(result)) continue;
    result = result.replace(regex, `$1${formatGlsParamValue(value)}`);
  }
  return result;
}
