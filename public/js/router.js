let _config = null;
let routeToken = 0;

export function getRouteToken() {
  return routeToken;
}

export function initRouter(config) {
  _config = config;
  window.addEventListener('hashchange', resolve);
  resolve();
}

export function navigate(path) {
  const target = path.startsWith('#') ? path : `#/${path.replace(/^\/+/, '')}`;
  if (location.hash === target) {
    resolve();
  } else {
    location.hash = target;
  }
}

function currentPath() {
  const raw = location.hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  return raw || _config.fallback;
}

function matchRoute(path) {
  const pathWithoutQuery = path.split('?')[0];
  const segs = pathWithoutQuery.split('/');
  for (const [pattern, handler] of Object.entries(_config.routes)) {
    const pSegs = pattern.split('/');
    if (pSegs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i].startsWith(':')) {
        params[pSegs[i].slice(1)] = decodeURIComponent(segs[i]);
      } else if (pSegs[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { pattern, handler, params };
  }
  return null;
}

async function resolve() {
  const path = currentPath();
  const matched = matchRoute(path);
  const token = ++routeToken;
  if (_config.onLeave) _config.onLeave(path);
  if (_config.onChange) _config.onChange(path);
  if (matched) {
    try {
      await matched.handler(matched.params, { routeToken: token });
    } catch (err) {
      console.error('Route handler error:', err);
    }
  } else if (token === routeToken) {
    navigate(_config.fallback);
  }
}
