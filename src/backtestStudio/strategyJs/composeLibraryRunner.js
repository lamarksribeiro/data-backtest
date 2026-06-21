function formatParamsBlock(params = {}) {
  const lines = [];
  for (const [key, value] of Object.entries(params)) {
    lines.push(`    ${key}: ${JSON.stringify(value)},`);
  }
  if (!lines.length) lines.push('    walletSize: 100,');
  return lines.join('\n');
}

export function composeLibraryRunnerStrategyJs({
  name,
  runnerSlug,
  runnerVersion = 1,
  params = {},
  strategyLabel = null,
}) {
  const label = strategyLabel || name;
  return `export default strategy({
  name: ${JSON.stringify(name)},

  dependencies: {
    runner: strategyLibrary(${JSON.stringify(runnerSlug)}, ${runnerVersion}),
  },

  params: {
${formatParamsBlock(params)}
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});
`;
}