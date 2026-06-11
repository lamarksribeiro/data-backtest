import { el } from './dom.js';
import { escapeHtml } from './format.js';

const PICKER_CACHE_TTL_MS = 30_000;
/** @type {{ options: object[], at: number } | null} */
let pickerCache = null;
/** @type {Promise<object[]> | null} */
let pickerInflight = null;

function mapPickerRows(rows, { includeArchived = false } = {}) {
  const options = [];
  for (const row of rows) {
    if (!includeArchived && row.status === 'archived') continue;
    options.push({
      value: `gls:${row.strategy_id}:${row.version_id}`,
      label: `${row.name} · v${row.version}${row.notes ? ` — ${row.notes}` : ''}`,
      kind: 'gls',
      strategyId: row.strategy_id,
      versionId: row.version_id,
      versionNum: row.version,
      slug: row.slug,
      status: row.status,
      pinned: row.pinned,
      notes: row.notes,
    });
  }
  options.sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
    return (b.versionNum ?? 0) - (a.versionNum ?? 0);
  });
  return options;
}

/**
 * Carrega estratégias com todas as versões (uma requisição via ?picker=1).
 */
export async function loadStrategyOptions(api, { includeArchived = false, stats = false, force = false } = {}) {
  const now = Date.now();
  if (!force && !stats && pickerCache && now - pickerCache.at < PICKER_CACHE_TTL_MS) {
    return filterPickerCache(pickerCache.options, includeArchived);
  }

  if (!force && !stats && pickerInflight) {
    const rows = await pickerInflight;
    return filterPickerCache(rows, includeArchived);
  }

  const fetchPromise = (async () => {
    const pickerRes = await api.get('/api/strategies?picker=1');
    if (pickerRes.ok && Array.isArray(pickerRes.data.options)) {
      const options = mapPickerRows(pickerRes.data.options, { includeArchived: true });
      pickerCache = { options, at: Date.now() };
      return options;
    }

    const url = stats ? '/api/strategies?stats=1' : '/api/strategies';
    const savedRes = await api.get(url);
    const saved = savedRes.ok ? savedRes.data.strategies || [] : [];
    const versionLists = await Promise.all(
      saved.map((strategy) => api.get(`/api/strategies/${strategy.id}/versions`).then((res) => ({
        strategy,
        versions: res.ok ? res.data.versions || [] : [],
      }))),
    );

    const options = [];
    for (const { strategy, versions } of versionLists) {
      if (!includeArchived && strategy.status === 'archived') continue;
      const versionStats = strategy.stats?.by_version || [];
      const statByVid = Object.fromEntries(versionStats.map((v) => [v.version_id, v]));
      for (const version of versions) {
        const st = statByVid[version.id];
        const wr = st ? `${Math.round(st.win_rate * 100)}% WR` : '';
        const runs = st ? `${st.runs} runs` : '';
        const meta = [wr, runs].filter(Boolean).join(' · ');
        const notes = version.notes ? ` — ${version.notes}` : '';
        options.push({
          value: `gls:${strategy.id}:${version.id}`,
          label: `${strategy.name} · v${version.version}${meta ? ` · ${meta}` : ''}${notes}`,
          kind: 'gls',
          strategyId: strategy.id,
          versionId: version.id,
          versionNum: version.version,
          slug: strategy.slug,
          status: strategy.status,
          pinned: strategy.pinned,
          notes: version.notes,
        });
      }
    }
    options.sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
      return (b.versionNum ?? 0) - (a.versionNum ?? 0);
    });
    if (!stats) pickerCache = { options, at: Date.now() };
    return options;
  })();

  if (!stats) pickerInflight = fetchPromise;
  try {
    const options = await fetchPromise;
    return filterPickerCache(options, includeArchived);
  } finally {
    if (!stats) pickerInflight = null;
  }
}

function filterPickerCache(options, includeArchived) {
  if (includeArchived) return options;
  return options.filter((opt) => opt.status !== 'archived');
}

export function invalidateStrategyPickerCache() {
  pickerCache = null;
}

export function renderStrategySelect(options, selectedValue = '') {
  const html = options.map((opt) => `
    <option value="${escapeHtml(opt.value)}" ${opt.value === selectedValue ? 'selected' : ''}>${escapeHtml(opt.label)}</option>
  `).join('');
  return `<select name="strategy_pick" class="field__input" ${options.length ? '' : 'disabled'}>${html || '<option value="">Nenhuma estratégia</option>'}</select>`;
}

export function renderStrategyPicker(options, selectedValue = '', onChange = null) {
  const wrap = el('div', { class: 'strategy-picker' });
  const byStrategy = new Map();
  for (const opt of options) {
    const key = opt.strategyId;
    if (!byStrategy.has(key)) byStrategy.set(key, { strategyId: key, label: opt.label.split(' · ')[0], versions: [] });
    byStrategy.get(key).versions.push(opt);
  }

  const strategies = [...byStrategy.values()];
  const [, selSid, selVid] = String(selectedValue || '').split(':');
  const strategySelect = el('select', { name: 'strategy_id_pick', class: 'field__input' },
    strategies.map((s) => el('option', { value: String(s.strategyId), selected: String(s.strategyId) === String(selSid) }, s.label)));

  const current = strategies.find((s) => String(s.strategyId) === String(selSid)) || strategies[0];
  const versionSelect = el('select', { name: 'strategy_version_pick', class: 'field__input' },
    (current?.versions || options).map((v) => el('option', {
      value: String(v.versionId),
      selected: String(v.versionId) === String(selVid) || v.value === selectedValue,
    }, `v${v.versionNum}${v.notes ? ` — ${v.notes}` : ''}`)));

  const hidden = el('input', { type: 'hidden', name: 'strategy_pick', value: selectedValue || options[0]?.value || '' });

  function syncValue() {
    const sid = strategySelect.value;
    const strat = strategies.find((s) => String(s.strategyId) === sid);
    versionSelect.replaceChildren(...(strat?.versions || []).map((v) => el('option', { value: String(v.versionId) }, `v${v.versionNum}${v.notes ? ` — ${v.notes}` : ''}`)));
    const vid = versionSelect.value || strat?.versions[0]?.versionId;
    hidden.value = `gls:${sid}:${vid}`;
    onChange?.(hidden.value);
  }

  strategySelect.addEventListener('change', syncValue);
  versionSelect.addEventListener('change', syncValue);
  wrap.append(strategySelect, versionSelect, hidden);
  return wrap;
}

export function backtestPayloadFromPick(pick, ctx, extra = {}) {
  const base = {
    from: ctx.from,
    to: ctx.to,
    underlying: ctx.underlying,
    interval: ctx.interval,
    book_depth: Number(ctx.book_depth) || 25,
    batch_size: Number(ctx.batch_size) || 5000,
    ...extra,
  };

  const [, strategyId, versionId] = String(pick || '').split(':');
  return {
    ...base,
    strategy_id: Number(strategyId),
    strategy_version_id: Number(versionId),
  };
}
