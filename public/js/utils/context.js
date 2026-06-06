const STORAGE_KEY = 'data-backtest-context';

const DEFAULTS = {
  dataset: 'backtest_ticks',
  from: isoDate(daysAgo(1)),
  to: isoDate(new Date()),
  underlying: 'BTC',
  interval: '5m',
  book_depth: '25',
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

export function renderContextBar(ctx, onChange, options = {}) {
  const current = normalizeContext({ ...DEFAULTS, ...(ctx || {}) });
  const underlyings = optionValues(options.underlyings, current.underlying);
  const intervals = optionValues(options.intervals, current.interval);
  const bookDepths = optionValues(options.book_depths, current.book_depth);
  const bar = document.createElement('div');
  bar.className = 'context-bar';
  bar.innerHTML = `
    <label class="context-bar__field">De <input type="date" name="from" value="${current.from || ''}"></label>
    <label class="context-bar__field">Até <input type="date" name="to" value="${current.to || ''}"></label>
    <label class="context-bar__field">Ativo ${selectHtml('underlying', underlyings, current.underlying, formatRaw)}</label>
    <label class="context-bar__field">Intervalo ${selectHtml('interval', intervals, current.interval, formatInterval)}</label>
    <label class="context-bar__field">Book ${selectHtml('book_depth', bookDepths, current.book_depth, (value) => `top ${value}`)}</label>
  `;
  bar.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('change', () => {
      const next = saveContext({
        from: bar.querySelector('[name=from]').value,
        to: bar.querySelector('[name=to]').value,
        underlying: bar.querySelector('[name=underlying]').value,
        interval: bar.querySelector('[name=interval]').value,
        book_depth: bar.querySelector('[name=book_depth]').value,
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

function optionValues(values, selected) {
  const list = [...new Set([...(values || []), selected].filter(Boolean).map(String))];
  return list.length ? list : [selected].filter(Boolean);
}

export function selectField(name, values, selected, { className = 'field__input', format = formatRaw } = {}) {
  const select = document.createElement('select');
  select.className = className;
  select.name = name;
  for (const value of optionValues(values, selected)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = format(value);
    if (String(value) === String(selected)) option.selected = true;
    select.appendChild(option);
  }
  return select;
}

export function contextBarOptions(apiOptions = {}) {
  const lake = apiOptions.lake || {};
  const source = apiOptions.source || {};
  const preferSource = !lake.underlyings?.length && !lake.intervals?.length;
  return {
    underlyings: preferSource
      ? (source.underlyings?.length ? source.underlyings : apiOptions.underlyings)
      : (apiOptions.underlyings?.length ? apiOptions.underlyings : source.underlyings),
    intervals: preferSource
      ? (source.intervals?.length ? source.intervals : apiOptions.intervals)
      : (apiOptions.intervals?.length ? apiOptions.intervals : source.intervals),
    book_depths: apiOptions.book_depths?.length
      ? apiOptions.book_depths
      : (source.book_depths?.length ? source.book_depths : lake.book_depths),
  };
}

function selectHtml(name, values, selected, format) {
  return `<select name="${name}" class="context-bar__select">${values.map((value) => (
    `<option value="${escapeAttr(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${escapeAttr(format(value))}</option>`
  )).join('')}</select>`;
}

function formatRaw(value) {
  return String(value);
}

function formatInterval(value) {
  const text = String(value);
  const match = text.match(/^(\d+)([mhd])$/);
  if (!match) return text;
  const amount = match[1];
  const unit = { m: 'min', h: 'h', d: 'd' }[match[2]];
  return `${amount} ${unit}`;
}

function escapeAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
