const DAY_EVENTS_CACHE_TTL_MS = 30_000;
const cache = new Map();

export function dayEventsCacheKey({ dt, underlying, interval, bookDepth }) {
	return `${dt}|${underlying}|${interval}|${bookDepth ?? ''}`;
}

export function getCachedDayEvents(key) {
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.at > DAY_EVENTS_CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}
	return entry.result;
}

export function setCachedDayEvents(key, result) {
	cache.set(key, { result, at: Date.now() });
}

export function invalidateDayEventsCache(match = null) {
	if (!match) {
		cache.clear();
		return;
	}
	const prefix = `${match.dt}|${match.underlying}|${match.interval}|`;
	for (const key of cache.keys()) {
		if (key.startsWith(prefix)) cache.delete(key);
	}
}
