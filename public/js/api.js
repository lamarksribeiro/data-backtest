async function request(method, path, body) {
  const init = {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    return { ok: false, status: 0, error: { code: 'NETWORK_ERROR', message: err.message || 'Network error' } };
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
};
