export function finiteOrNull(value) {
  if (value == null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function levelsFromFlattened(row, prefix, depth) {
  const levels = [];
  for (let i = 1; i <= depth; i += 1) {
    const price = finiteOrNull(row[`${prefix}_px_${i}`]);
    const size = finiteOrNull(row[`${prefix}_sz_${i}`]);
    if (price == null || size == null || size <= 0) continue;
    levels.push({ price, size });
  }
  return levels;
}

export function bestPrice(levels, direction) {
  const prices = levels.map((level) => level.price).filter(Number.isFinite);
  if (!prices.length) return null;
  return direction === 'bid' ? Math.max(...prices) : Math.min(...prices);
}

export function buildSortedBookLevels(levels, direction = 'ask') {
  const parsed = levels
    .map((level) => ({ price: level.price, size: level.size, key: String(level.price) }));
  parsed.sort((left, right) => (direction === 'bid' ? right.price - left.price : left.price - right.price));
  Object.defineProperty(parsed, '_isParsed', { value: true, enumerable: false });
  return parsed;
}

/**
 * Fast path when tick bridge already attached sorted book arrays (_isParsed).
 */
export function parseBookLevels(rawLevels, direction = 'ask') {
  if (Array.isArray(rawLevels) && rawLevels._isParsed) {
    return rawLevels;
  }

  let levels = rawLevels;
  if (typeof rawLevels === 'string') {
    try {
      levels = JSON.parse(rawLevels);
    } catch {
      levels = [];
    }
  }
  if (!Array.isArray(levels)) return [];

  const parsed = levels
    .map((level) => ({
      price: finiteOrNull(level?.price),
      size: finiteOrNull(level?.size),
    }))
    .filter((level) => level.price != null && level.size != null && level.price > 0 && level.size > 0)
    .map((level) => ({ ...level, key: String(level.price) }));
  parsed.sort((left, right) => (direction === 'bid' ? right.price - left.price : left.price - right.price));
  Object.defineProperty(parsed, '_isParsed', { value: true, enumerable: false });
  return parsed;
}

export function bookLevelColumnNames(bookDepth = 25) {
  const names = [];
  for (const side of ['up', 'down']) {
    for (const kind of ['ask', 'bid']) {
      for (let level = 1; level <= bookDepth; level += 1) {
        names.push(`${side}_${kind}_px_${level}`);
        names.push(`${side}_${kind}_sz_${level}`);
      }
    }
  }
  return names;
}
