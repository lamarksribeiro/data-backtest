export function expandParamGrid(grid, { maxVariants = Infinity } = {}) {
  if (Array.isArray(grid?.variants)) return grid.variants.slice(0, maxVariants).map((variant, index) => ({
    id: variant.id ?? variant.name ?? `v${String(index + 1).padStart(4, '0')}`,
    params: variant.params && typeof variant.params === 'object' ? variant.params : {},
  }));
  const sourceGrid = grid?.grid && typeof grid.grid === 'object' ? grid.grid : grid;
  if (!sourceGrid || typeof sourceGrid !== 'object') return [{ id: 'default', params: {} }];

  const entries = Object.entries(sourceGrid).filter(([, values]) => Array.isArray(values) && values.length > 0);
  if (!entries.length) return [{ id: 'default', params: {} }];

  const variants = [];

  function visit(index, params) {
    if (variants.length >= maxVariants) return;
    if (index >= entries.length) {
      variants.push({
        id: `v${String(variants.length + 1).padStart(4, '0')}`,
        params: { ...params },
      });
      return;
    }

    const [key, values] = entries[index];
    for (const value of values) {
      params[key] = value;
      visit(index + 1, params);
      if (variants.length >= maxVariants) break;
    }
    delete params[key];
  }

  visit(0, {});
  return variants;
}

export function countParamGridVariants(grid) {
  if (Array.isArray(grid?.variants)) return grid.variants.length;
  const sourceGrid = grid?.grid && typeof grid.grid === 'object' ? grid.grid : grid;
  if (!sourceGrid || typeof sourceGrid !== 'object') return 1;
  const counts = Object.values(sourceGrid)
    .filter((values) => Array.isArray(values) && values.length > 0)
    .map((values) => values.length);
  if (!counts.length) return 1;
  return counts.reduce((total, count) => total * count, 1);
}
