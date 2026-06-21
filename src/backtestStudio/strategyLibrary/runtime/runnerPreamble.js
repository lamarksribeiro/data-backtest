const RUNNER_TIME_HELPERS = `
function __runnerTickTimeMs(tick) {
  const direct = tick?._tsMs;
  if (Number.isFinite(direct)) return direct;
  return new Date(tick.ts).getTime();
}

function __runnerDateFromTick(tick) {
  const direct = tick?._tsMs;
  if (Number.isFinite(direct)) return new Date(direct);
  const raw = tick?.ts;
  return raw instanceof Date ? raw : new Date(String(raw));
}
`.trim();

export function patchRunnerSourceForFastBooks(sourceCode) {
  const code = String(sourceCode || '');
  if (code.includes('rawLevels._isParsed')) return code;

  const patched = code.replace(
    /function parseBookLevels\(([^)]*)\)\s*\{/,
    'function parseBookLevels($1) {\n  if (Array.isArray(rawLevels) && rawLevels._isParsed) return rawLevels;\n',
  );
  return patched === code ? code : patched;
}

/** Facade SoA: fast books + tick timestamps. Sample arrays stay native []. */
export function patchRunnerSourceForSoaRuntime(sourceCode) {
  let code = patchRunnerSourceForFastBooks(sourceCode);
  if (code.includes('__runnerTickTimeMs')) return code;

  code = code.replace(/new Date\(tick\.ts\)\.getTime\(\)/g, '__runnerTickTimeMs(tick)');
  code = code.replace(/new Date\(tick\.ts\)/g, '__runnerDateFromTick(tick)');
  code = `${RUNNER_TIME_HELPERS}\n${code}`;
  return code;
}
