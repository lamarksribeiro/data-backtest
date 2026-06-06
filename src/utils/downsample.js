/** Mantém pontos obrigatórios (ex.: marks) e reduz o restante para no máximo maxPoints. */
export function downsamplePoints(points, { maxPoints = 400, keepTs = [] } = {}) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];

  const indices = new Set([0, points.length - 1]);
  for (const ts of keepTs) {
    const idx = findNearestIndex(points, ts);
    if (idx >= 0) indices.add(idx);
  }

  const stride = Math.max(1, Math.ceil(points.length / Math.max(maxPoints - indices.size, 1)));
  for (let i = 0; i < points.length; i += stride) indices.add(i);

  const sorted = [...indices].sort((a, b) => a - b);
  if (sorted.length > maxPoints) {
    const trimmed = new Set([sorted[0], sorted.at(-1)]);
    const innerStride = Math.ceil((sorted.length - 2) / Math.max(maxPoints - 2, 1));
    for (let i = 1; i < sorted.length - 1; i += innerStride) trimmed.add(sorted[i]);
    return [...trimmed].sort((a, b) => a - b).slice(0, maxPoints).map((idx) => points[idx]);
  }

  return sorted.map((idx) => points[idx]);
}

function findNearestIndex(points, targetTs) {
  const target = Date.parse(targetTs);
  if (!Number.isFinite(target) || !points.length) return -1;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const diff = Math.abs(Date.parse(points[i].ts) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}
