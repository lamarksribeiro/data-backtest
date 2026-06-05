export function parseCookie(header, name) {
  if (!header) return null;
  const pairs = header.split(';');
  for (const pair of pairs) {
    const parts = pair.split('=');
    if (parts.length < 2) continue;
    const k = parts[0].trim();
    if (k === name) {
      const v = parts.slice(1).join('=');
      return decodeURIComponent(v.trim());
    }
  }
  return null;
}

const PUBLIC_API = new Set(['/api/login', '/api/me']);

/**
 * @param {object} deps
 * @param {ReturnType<import('../auth/authService.js').createAuthService>} deps.authService
 * @param {object} deps.config
 */
export function createAuthMiddleware(deps) {
  const { authService, config } = deps;

  async function resolvePrincipal(req) {
    const cookie = parseCookie(req.headers.cookie, authService.cookieName);
    if (cookie) {
      const session = await authService.validateSession(cookie);
      if (session) return session;
    }
    return null;
  }

  function isPublicApi(pathname) {
    return PUBLIC_API.has(pathname);
  }

  function bypassAuth() {
    return config.TEST_MODE === true;
  }

  return {
    async attachPrincipal(req) {
      req.principal = bypassAuth()
        ? { kind: 'session', userId: 0, username: 'test' }
        : await resolvePrincipal(req);
    },

    async requireApiAuth(req, res, pathname) {
      if (bypassAuth()) {
        req.principal = { kind: 'session', userId: 0, username: 'test' };
        return true;
      }
      if (pathname === '/api/login') return true;
      const principal = await resolvePrincipal(req);
      if (!principal) {
        sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return false;
      }
      req.principal = principal;
      return true;
    },

    async requirePageAuth(req, res) {
      if (bypassAuth()) return true;
      const principal = await resolvePrincipal(req);
      if (!principal) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return false;
      }
      req.principal = principal;
      return true;
    },

    isPublicApi,
    bypassAuth,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
