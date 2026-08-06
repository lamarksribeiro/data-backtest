/**
 * Finds the first observable favorite-price crossing in event-time order.
 *
 * Ticks must be ordered from the start of the market to settlement, which in
 * 5-minute markets means monotonically non-increasing `tau` values.
 */
export function findFirstFavoriteCross(
  ticks,
  threshold,
  { minTau = 3, maxTau = 300 } = {},
) {
  if (!Array.isArray(ticks) || !ticks.length) return null;
  if (!(Number.isFinite(threshold) && threshold > 0 && threshold < 1)) {
    throw new TypeError('threshold must be between 0 and 1');
  }

  let previousFavoriteAsk = null;
  let previousTau = Infinity;

  for (let index = 0; index < ticks.length; index += 1) {
    const tick = ticks[index];
    const tau = Number(tick?.tau);
    if (!Number.isFinite(tau)) continue;
    if (tau > previousTau) {
      throw new Error('ticks must be ordered in event time (tau descending)');
    }
    previousTau = tau;

    const upAsk = Number(tick?.upAsk);
    const downAsk = Number(tick?.downAsk);
    const favoriteAsk = Math.max(upAsk, downAsk);
    if (!Number.isFinite(favoriteAsk)) continue;

    const crossed =
      favoriteAsk >= threshold &&
      favoriteAsk < 1 &&
      (previousFavoriteAsk == null || previousFavoriteAsk < threshold);
    previousFavoriteAsk = favoriteAsk;
    if (!crossed) continue;

    // The strategy is explicitly the first rush. A later recross must never
    // replace a first crossing that happened outside the entry window.
    if (!(tau >= minTau && tau < maxTau)) return null;

    return {
      index,
      tick,
      tau,
      side: upAsk >= downAsk ? 'UP' : 'DOWN',
      ask: favoriteAsk,
    };
  }

  return null;
}
