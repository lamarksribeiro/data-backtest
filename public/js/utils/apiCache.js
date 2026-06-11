const store = new Map();
const DEFAULT_TTL_MS = 60_000;

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function cacheInvalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export async function cachedFetch(key, fetcher, ttlMs) {
  const hit = cacheGet(key);
  if (hit) return hit;
  const value = await fetcher();
  cacheSet(key, value, ttlMs);
  return value;
}
