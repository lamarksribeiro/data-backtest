const TTL_MS = 60_000;
/** @type {{ options: object, at: number } | null} */
let cache = null;
/** @type {Promise<object> | null} */
let inflight = null;

/**
 * Busca /api/context-options com cache e stale-while-revalidate.
 * @param {{ get: (path: string) => Promise<any> }} api
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<object>} options (objeto vazio em caso de falha)
 */
export async function fetchContextOptionsCached(api, opts = {}) {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < TTL_MS) {
    return cache.options;
  }

  if (!opts.force && cache?.options) {
    void refreshContextOptions(api);
    return cache.options;
  }

  return refreshContextOptions(api);
}

async function refreshContextOptions(api) {
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await api.get('/api/context-options');
      const options = res.ok ? (res.data.options || {}) : (cache?.options || {});
      if (res.ok) cache = { options, at: Date.now() };
      return options;
    } catch {
      return cache?.options || {};
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function invalidateContextOptionsCache() {
  cache = null;
}
