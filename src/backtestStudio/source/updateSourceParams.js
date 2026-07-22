function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatParamLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return JSON.stringify(String(value));
}

function formatJsParamsObject(params) {
  const lines = Object.entries(params).map(([key, value]) => `    ${key}: ${formatParamLiteral(value)},`);
  return `{\n${lines.join('\n')}\n  }`;
}

/** Localiza o bloco `params: { ... }` com contagem de chaves (ignora strings). */
function findJsParamsBlockRange(source) {
  const text = String(source || '');
  const match = /params:\s*\{/.exec(text);
  if (!match) return null;
  const start = match.index;
  const braceStart = text.indexOf('{', start);
  if (braceStart < 0) return null;

  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

export function updateGlsParams(source, params) {
  let result = String(source || '');
  for (const [key, value] of Object.entries(params || {})) {
    const regex = new RegExp(`^(\\s*param\\s+${escapeRegExp(key)}\\s*=\\s*)(.+)$`, 'm');
    if (!regex.test(result)) continue;
    result = result.replace(regex, `$1${formatParamLiteral(value)}`);
  }
  return result;
}

export function updateStrategyJsParams(source, params) {
  const text = String(source || '');
  const range = findJsParamsBlockRange(text);
  if (!range) return text;

  const entries = Object.entries(params || {});
  if (!entries.length) return text;

  let block = text.slice(range.start, range.end + 1);
  const missing = [];
  for (const [key, value] of entries) {
    const literal = formatParamLiteral(value);
    const re = new RegExp(
      `(${escapeRegExp(key)}\\s*:\\s*)(?:"(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|true|false|null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
    );
    if (!re.test(block)) {
      missing.push(key);
      continue;
    }
    block = block.replace(re, `$1${literal}`);
  }

  if (missing.length) {
    const paramsBlock = formatJsParamsObject(params);
    return `${text.slice(0, range.start)}params: ${paramsBlock}${text.slice(range.end + 1)}`;
  }

  return `${text.slice(0, range.start)}${block}${text.slice(range.end + 1)}`;
}

export function detectSourceParamStyle(source, language = '') {
  const lang = String(language || '').toLowerCase();
  if (lang.includes('gls')) return 'gls';
  if (lang.includes('strategy-js') || lang === 'js' || lang.includes('javascript')) return 'strategy-js';
  const text = String(source || '');
  if (/params:\s*\{/.test(text)) return 'strategy-js';
  if (/^\s*param\s+\w+/m.test(text)) return 'gls';
  return 'strategy-js';
}

/**
 * Reescreve defaults de parâmetros no source (GLS `param x =` ou Strategy JS `params: { }`).
 * @returns {{ source: string, changed: boolean, style: string }}
 */
export function updateSourceParams(source, params, { language } = {}) {
  const previous = String(source || '');
  const style = detectSourceParamStyle(previous, language);
  const next = style === 'gls'
    ? updateGlsParams(previous, params)
    : updateStrategyJsParams(previous, params);
  return {
    source: next,
    changed: next !== previous,
    style,
  };
}
