function toNumber(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function parseBookLevels(rawLevels, side = 'ask') {
  let levels = rawLevels;
  if (typeof rawLevels === 'string') {
    try {
      levels = JSON.parse(rawLevels);
    } catch {
      levels = [];
    }
  }
  if (!Array.isArray(levels)) return [];

  const parsed = [];
  let sorted = true;
  let previousPrice = null;
  for (const level of levels) {
    const price = toNumber(level?.price);
    const size = toNumber(level?.size);
    if (price == null || size == null || size <= 0) continue;
    if (previousPrice != null) {
      sorted = sorted && (side === 'bid' ? previousPrice >= price : previousPrice <= price);
    }
    previousPrice = price;
    parsed.push({ price, size });
  }

  if (!sorted) parsed.sort((left, right) => side === 'bid' ? right.price - left.price : left.price - right.price);
  return parsed;
}

export function flattenBookTick(row, depth) {
  const output = { ...row, bookDepth: depth };
  delete output.upBookAsks;
  delete output.upBookBids;
  delete output.downBookAsks;
  delete output.downBookBids;

  assignLevels(output, 'up_ask', parseBookLevels(row.upBookAsks, 'ask'), depth);
  assignLevels(output, 'up_bid', parseBookLevels(row.upBookBids, 'bid'), depth);
  assignLevels(output, 'down_ask', parseBookLevels(row.downBookAsks, 'ask'), depth);
  assignLevels(output, 'down_bid', parseBookLevels(row.downBookBids, 'bid'), depth);
  return output;
}

function assignLevels(output, prefix, levels, depth) {
  for (let i = 0; i < depth; i += 1) {
    const level = levels[i];
    output[`${prefix}_px_${i + 1}`] = level?.price ?? null;
    output[`${prefix}_sz_${i + 1}`] = level?.size ?? null;
  }
}
