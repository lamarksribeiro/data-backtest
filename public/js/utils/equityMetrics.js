function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function eventCloseMs(point) {
  const raw = point?.ts ?? point?.time ?? null;
  if (raw == null) return Number.POSITIVE_INFINITY;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function normalizeEquityPoints(equity = []) {
  return (equity || [])
    .map((point) => {
      const ts = point?.ts ?? point?.time ?? null;
      const pnl = toFiniteNumber(point?.pnl ?? point?.value);
      if (ts == null || pnl == null) return null;
      return { ts, pnl };
    })
    .filter(Boolean)
    .sort((left, right) => eventCloseMs(left) - eventCloseMs(right));
}

export function computeMaxDrawdown(equity = []) {
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equity) {
    const pnl = toFiniteNumber(point?.pnl ?? point?.value) ?? 0;
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
  }
  return maxDrawdown;
}

export function computeRecoveryFactor(totalPnl, maxDrawdown) {
  const pnl = toFiniteNumber(totalPnl);
  const drawdown = toFiniteNumber(maxDrawdown);
  if (pnl == null || drawdown == null || drawdown <= 0) return null;
  return pnl / drawdown;
}

export function enrichSummaryWithEquity(summary = {}, equity = []) {
  if (!equity?.length) return summary;
  const points = normalizeEquityPoints(equity);
  if (!points.length) return summary;
  const maxDrawdown = computeMaxDrawdown(points);
  const totalPnl = toFiniteNumber(summary.totalPnl ?? summary.pnl) ?? points[points.length - 1].pnl;
  return {
    ...summary,
    maxDrawdown,
    recoveryFactor: computeRecoveryFactor(totalPnl, maxDrawdown) ?? summary.recoveryFactor,
  };
}