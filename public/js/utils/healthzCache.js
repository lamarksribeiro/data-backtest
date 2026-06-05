const TTL_MS = 5000;
/** @type {{ ok: boolean, body: object, at: number } | null} */
let cache = null;
/** @type {Promise<{ ok: boolean, body: object, fromCache: boolean }> | null} */
let inflight = null;

export async function fetchHealthzCached(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < TTL_MS) {
    return { ok: cache.ok, body: cache.body, fromCache: true };
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch('/healthz', { credentials: 'same-origin' });
      let body = {};
      try { body = await res.json(); } catch { /* ignore */ }
      cache = { ok: res.ok, body, at: Date.now() };
      return { ok: res.ok, body, fromCache: false };
    } catch {
      return { ok: false, body: {}, fromCache: false };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
