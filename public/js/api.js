const DEFAULT_TIMEOUT_MS = 30_000;

async function request(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const init = {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, error: { code: 'TIMEOUT', message: 'A requisição demorou demais. Tente novamente.' } };
    }
    return { ok: false, status: 0, error: { code: 'NETWORK_ERROR', message: err.message || 'Network error' } };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    if (!path.endsWith('/api/me') && !path.endsWith('/api/login')) {
      location.href = '/login';
    }
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Sessão expirada' } };
  }

  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { /* ignore */ }
  } else {
    try { data = await res.text(); } catch { /* ignore */ }
  }

  if (!res.ok) {
    const error = (data && data.error) || { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` };
    return { ok: false, status: res.status, data, error };
  }
  return { ok: true, status: res.status, data };
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  delete: (path) => request('DELETE', path),
};
