const STORAGE_KEY = 'data-backtest-context';

const DEFAULTS = {
  dataset: 'backtest_ticks',
  from: isoDate(daysAgo(1)),
  to: isoDate(new Date()),
  underlying: 'BTC',
  interval: '5m',
  book_depth: '10',
  resolution: '1m',
  batch_size: '5000',
};

export function loadContext() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeContext({ ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) });
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveContext(patch) {
  const next = normalizeContext({ ...loadContext(), ...patch });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function contextQueryParams(ctx = loadContext()) {
  const params = new URLSearchParams({
    dataset: ctx.dataset,
    from: ctx.from,
    to: ctx.to,
    underlying: ctx.underlying,
    interval: ctx.interval,
  });
  if (ctx.dataset === 'backtest_ticks' && ctx.book_depth) {
    params.set('book_depth', ctx.book_depth);
  }
  if (ctx.dataset === 'ohlc' && ctx.resolution) {
    params.set('resolution', ctx.resolution);
  }
  return params;
}

export function renderContextBar(ctx, onChange) {
  const current = normalizeContext({ ...DEFAULTS, ...(ctx || {}) });
  const bar = document.createElement('div');
  bar.className = 'context-bar';
  bar.innerHTML = `
    <label class="context-bar__field">De <input type="date" name="from" value="${current.from || ''}"></label>
    <label class="context-bar__field">Até <input type="date" name="to" value="${current.to || ''}"></label>
    <label class="context-bar__field">Ativo <input type="text" name="underlying" value="${current.underlying || DEFAULTS.underlying}" size="5"></label>
    <label class="context-bar__field">Intervalo <input type="text" name="interval" value="${current.interval || DEFAULTS.interval}" size="4"></label>
  `;
  bar.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', () => {
      const next = saveContext({
        from: bar.querySelector('[name=from]').value,
        to: bar.querySelector('[name=to]').value,
        underlying: bar.querySelector('[name=underlying]').value.trim(),
        interval: bar.querySelector('[name=interval]').value.trim(),
      });
      onChange?.(next);
    });
  });
  return bar;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function normalizeContext(ctx) {
  const normalized = { ...DEFAULTS, ...(ctx || {}) };
  for (const key of Object.keys(DEFAULTS)) {
    const value = normalized[key];
    if (value == null || value === '' || value === 'undefined' || value === 'null') {
      normalized[key] = DEFAULTS[key];
    }
  }
  return normalized;
}
