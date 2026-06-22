function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function eventCloseMs(event) {
  const raw = event?.closedAt || event?.eventEnd || event?.entryTime || null;
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

export function buildEquityCurveFromEvents(events = []) {
  const sorted = [...events].sort((left, right) => eventCloseMs(left) - eventCloseMs(right));
  let cumulative = 0;
  return sorted.map((event) => {
    cumulative += toFiniteNumber(event?.finalPnl) ?? 0;
    const ts = event?.closedAt || event?.eventEnd || event?.entryTime || null;
    return ts == null ? null : { ts, pnl: cumulative };
  }).filter(Boolean);
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

export function finalizeEquityMetrics(result) {
  if (!result || typeof result !== 'object') return result;

  const events = Array.isArray(result.events) ? result.events : [];
  const equity = Array.isArray(result.equity) && result.equity.length
    ? normalizeEquityPoints(result.equity)
    : buildEquityCurveFromEvents(events);

  result.equity = equity;
  if (!result.summary) result.summary = {};

  const maxDrawdown = computeMaxDrawdown(equity);
  const totalPnl = toFiniteNumber(result.summary.totalPnl ?? result.summary.pnl)
    ?? (equity.length ? equity[equity.length - 1].pnl : 0);

  result.summary.maxDrawdown = maxDrawdown;
  result.summary.recoveryFactor = computeRecoveryFactor(totalPnl, maxDrawdown);
  return result;
}