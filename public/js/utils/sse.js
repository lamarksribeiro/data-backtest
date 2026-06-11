const listeners = new Set();
let source = null;
let fallbackTimer = null;

export function connectSse(onEvent) {
  if (onEvent) listeners.add(onEvent);
  if (source) return source;
  if (typeof EventSource === 'undefined') return null;

  source = new EventSource('/api/stream', { withCredentials: true });
  source.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      for (const fn of listeners) fn(data);
    } catch { /* ignore */ }
  };
  for (const type of ['run:queued', 'run:progress', 'run:completed', 'run:failed', 'run:cancelled', 'job:progress', 'job:completed', 'job:failed']) {
    source.addEventListener(type, (ev) => {
      try {
        const data = JSON.parse(ev.data);
        for (const fn of listeners) fn({ type, ...data });
      } catch { /* ignore */ }
    });
  }
  source.onerror = () => {
    source?.close();
    source = null;
    if (!fallbackTimer) {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        connectSse();
      }, 3000);
    }
  };
  return source;
}

export function disconnectSse(onEvent) {
  if (onEvent) listeners.delete(onEvent);
  if (!listeners.size && source) {
    source.close();
    source = null;
  }
}
