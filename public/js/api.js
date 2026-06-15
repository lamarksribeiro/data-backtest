const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const DEFAULT_GET_RETRIES = 2;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function gatewayMessage(status) {
	if (status === 502) return 'Servidor temporariamente indisponível (502). Tente novamente em instantes.';
	if (status === 503) return 'Serviço ocupado (503). Aguarde um momento e tente de novo.';
	if (status === 504) return 'A requisição expirou no gateway (504). Tente novamente.';
	return `HTTP ${status}`;
}

async function requestOnce(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal } = {}) {
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
	const onExternalAbort = () => controller.abort();
	if (externalSignal) {
		if (externalSignal.aborted) {
			clearTimeout(timer);
			return { ok: false, status: 0, error: { code: 'ABORTED', message: 'Requisição cancelada.' } };
		}
		externalSignal.addEventListener('abort', onExternalAbort);
	}
	init.signal = controller.signal;

	let res;
	try {
		res = await fetch(path, init);
	} catch (err) {
		if (err.name === 'AbortError') {
			if (externalSignal?.aborted) {
				return { ok: false, status: 0, error: { code: 'ABORTED', message: 'Requisição cancelada.' } };
			}
			return { ok: false, status: 0, error: { code: 'TIMEOUT', message: 'A requisição demorou demais. Tente novamente.' } };
		}
		return { ok: false, status: 0, error: { code: 'NETWORK_ERROR', message: err.message || 'Network error' } };
	} finally {
		clearTimeout(timer);
		if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
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
		const error = (data && data.error) || {
			code: `HTTP_${res.status}`,
			message: RETRYABLE_STATUS.has(res.status) ? gatewayMessage(res.status) : `HTTP ${res.status}`,
		};
		return { ok: false, status: res.status, data, error };
	}
	return { ok: true, status: res.status, data };
}

async function request(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, retries } = {}) {
	const maxRetries = retries ?? (method === 'GET' ? DEFAULT_GET_RETRIES : 0);
	let lastResult;
	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		lastResult = await requestOnce(method, path, body, { timeoutMs, signal: attempt === 0 ? signal : undefined });
		if (lastResult.ok || lastResult.error?.code === 'ABORTED') return lastResult;
		if (!RETRYABLE_STATUS.has(lastResult.status) || attempt >= maxRetries) return lastResult;
		await sleep(300 * (attempt + 1));
	}
	return lastResult;
}

export const api = {
	get: (path, opts) => request('GET', path, undefined, opts),
	post: (path, body, opts) => request('POST', path, body, opts),
	put: (path, body, opts) => request('PUT', path, body, opts),
	patch: (path, body, opts) => request('PATCH', path, body, opts),
	delete: (path, opts) => request('DELETE', path, undefined, opts),
};
