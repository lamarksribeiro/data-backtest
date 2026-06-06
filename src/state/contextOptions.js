function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function sortNumericStrings(values) {
  return unique(values).sort((a, b) => Number(a) - Number(b));
}

export function emptyContextOptions() {
  return {
    underlyings: [],
    intervals: [],
    book_depths: [],
    combinations: [],
  };
}

export function sourceBookDepthOptions(config, sourceDepths = []) {
  return sortNumericStrings([
    ...sourceDepths,
    config?.backtestBookDepth != null ? String(config.backtestBookDepth) : '25',
  ]);
}

export function mergeContextOptions(lake, source, config) {
  const lakeOptions = lake || emptyContextOptions();
  const sourceOptions = source || emptyContextOptions();
  const hasSourceData = Boolean(
    sourceOptions.underlyings?.length
    || sourceOptions.intervals?.length
    || sourceOptions.combinations?.length,
  );
  const sourceBookDepths = sourceOptions.book_depths?.length
    ? sourceOptions.book_depths
    : (hasSourceData ? sourceBookDepthOptions(config, sourceOptions.book_depths) : []);

  const mergedBookDepths = sortNumericStrings([
    ...lakeOptions.book_depths,
    ...sourceBookDepths,
  ]);

  const combinations = lakeOptions.combinations.length
    ? lakeOptions.combinations
    : sourceOptions.combinations.map((item) => ({
      underlying: item.underlying,
      interval: item.interval,
      book_depth: item.book_depth ?? null,
      from: item.from,
      to: item.to,
      partitions: item.partitions ?? null,
      source: 'data_collector',
    }));

  return {
    source: {
      ...sourceOptions,
      book_depths: sourceBookDepths,
    },
    lake: lakeOptions,
    underlyings: unique([...lakeOptions.underlyings, ...sourceOptions.underlyings]),
    intervals: unique([...lakeOptions.intervals, ...sourceOptions.intervals]),
    book_depths: mergedBookDepths.length ? mergedBookDepths : sourceBookDepthOptions(config),
    combinations,
  };
}
