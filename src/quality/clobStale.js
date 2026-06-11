import { pricesEqual } from './tickUsable.js';

export function findClobStaleTickIndices(ticks, {
  minStaleSec = 30,
  underlyingEpsilon = 0.01,
} = {}) {
  const stale = new Set();
  if (ticks.length < 2) return stale;

  let streakStart = null;
  let streakUnderlyingMoved = false;

  const closeStreak = (endIndex) => {
    if (streakStart == null || !streakUnderlyingMoved || endIndex < streakStart) {
      streakStart = null;
      streakUnderlyingMoved = false;
      return;
    }
    const startTs = Date.parse(ticks[streakStart].ts);
    const endTs = Date.parse(ticks[endIndex].ts);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
      streakStart = null;
      streakUnderlyingMoved = false;
      return;
    }
    if ((endTs - startTs) / 1000 >= minStaleSec) {
      for (let index = streakStart; index <= endIndex; index += 1) stale.add(index);
    }
    streakStart = null;
    streakUnderlyingMoved = false;
  };

  for (let index = 1; index < ticks.length; index += 1) {
    const prev = ticks[index - 1];
    const tick = ticks[index];
    const quotesSame = pricesEqual(prev.upPrice, tick.upPrice)
      && pricesEqual(prev.downPrice, tick.downPrice)
      && tick.upPrice != null
      && tick.downPrice != null;
    const underlyingMoved = prev.underlyingPrice != null
      && tick.underlyingPrice != null
      && Math.abs(tick.underlyingPrice - prev.underlyingPrice) >= underlyingEpsilon;

    if (quotesSame) {
      if (streakStart == null) streakStart = index - 1;
      if (underlyingMoved) streakUnderlyingMoved = true;
      continue;
    }

    closeStreak(index - 1);
  }

  closeStreak(ticks.length - 1);
  return stale;
}
