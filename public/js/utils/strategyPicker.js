import { el } from './dom.js';
import { escapeHtml } from './format.js';

const PICKER_CACHE_TTL_MS = 30_000;
const STRATEGY_PICK_STORAGE_KEY = 'data-backtest-strategy-pick';

/** @type {{ options: object[], at: number } | null} */
let pickerCache = null;
/** @type {Promise<object[]> | null} */
let pickerInflight = null;

function sortVersions(versions) {
  return [...versions].sort((a, b) => {
    if ((b.versionNum ?? 0) !== (a.versionNum ?? 0)) return (b.versionNum ?? 0) - (a.versionNum ?? 0);
    return (b.versionId ?? 0) - (a.versionId ?? 0);
  });
}

function groupOptionsByStrategy(options) {
  const byStrategy = new Map();
  for (const opt of options) {
    const key = opt.strategyId;
    if (!byStrategy.has(key)) {
      byStrategy.set(key, {
        strategyId: key,
        label: opt.label.split(' · ')[0],
        versions: [],
        defaultVersionId: opt.defaultVersionId ?? null,
        pinned: Boolean(opt.pinned),
      });
    }
    byStrategy.get(key).versions.push(opt);
  }
  for (const strat of byStrategy.values()) {
    strat.versions = sortVersions(strat.versions);
  }
  return [...byStrategy.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
    return (b.strategyId ?? 0) - (a.strategyId ?? 0);
  });
}

export function loadLastStrategyPick() {
  try {
    const raw = localStorage.getItem(STRATEGY_PICK_STORAGE_KEY);
    return raw && String(raw).startsWith('gls:') ? String(raw) : '';
  } catch {
    return '';
  }
}

export function saveLastStrategyPick(pick) {
  if (!pick || !String(pick).startsWith('gls:')) return;
  try {
    localStorage.setItem(STRATEGY_PICK_STORAGE_KEY, String(pick));
  } catch {
    // ignore quota / private mode
  }
}

export function resolveVersionIdForStrategy(strat, versions = strat?.versions) {
  const list = sortVersions(versions || []);
  if (!list.length) return null;

  const savedPick = loadLastStrategyPick();
  const [, savedSid, savedVid] = String(savedPick || '').split(':');
  if (String(savedSid) === String(strat.strategyId) && list.some((v) => String(v.versionId) === String(savedVid))) {
    return Number(savedVid);
  }

  if (strat.defaultVersionId && list.some((v) => String(v.versionId) === String(strat.defaultVersionId))) {
    return Number(strat.defaultVersionId);
  }

  return list[list.length - 1]?.versionId ?? list[0]?.versionId ?? null;
}

export function resolveInitialStrategyPick(options, { strategyId = null, versionId = null } = {}) {
  if (!options.length) return '';

  if (strategyId && versionId) {
    const exact = options.find((o) => o.strategyId === strategyId && o.versionId === versionId);
    if (exact) return exact.value;
  }

  const saved = loadLastStrategyPick();
  if (saved && options.some((o) => o.value === saved)) return saved;

  const strategies = groupOptionsByStrategy(options);
  const first = strategies[0];
  if (!first) return options[0].value;

  const vid = resolveVersionIdForStrategy(first, first.versions);
  return `gls:${first.strategyId}:${vid}`;
}

function formatVersionLabel(version, strat) {
  const isDefault = String(version.versionId) === String(strat?.defaultVersionId);
  const prefix = isDefault ? '★ ' : '';
  if (version.notes) {
    const shortNotes = String(version.notes).replace(/^Preset\s+v\d+:\s*/i, '');
    return `${prefix}v${version.versionNum} · ${shortNotes}`;
  }
  return `${prefix}v${version.versionNum}`;
}

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
      defaultVersionId: row.default_version_id ?? null,
      notes: row.notes,
    });
  }
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
          defaultVersionId: strategy.default_version_id ?? null,
          notes: version.notes,
        });
      }
    }
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

export function getStrategyGroupFromPick(options, pick) {
  const [, sid] = String(pick || '').split(':');
  return groupOptionsByStrategy(options).find((s) => String(s.strategyId) === String(sid)) || null;
}

export function renderStrategySelect(options, selectedValue = '') {
  const html = options.map((opt) => `
    <option value="${escapeHtml(opt.value)}" ${opt.value === selectedValue ? 'selected' : ''}>${escapeHtml(opt.label)}</option>
  `).join('');
  return `<select name="strategy_pick" class="field__input" ${options.length ? '' : 'disabled'}>${html || '<option value="">Nenhuma estratégia</option>'}</select>`;
}

export function renderStrategyPicker(options, selectedValue = '', onChange = null, pinButton = null) {
  const wrap = el('div', { class: 'studio-strategy-picker' });
  const strategies = groupOptionsByStrategy(options);
  const [, selSid, selVid] = String(selectedValue || '').split(':');

  const strategySelect = el('select', {
    name: 'strategy_id_pick',
    class: 'field__input studio-strategy-picker__strategy',
    'aria-label': 'Estratégia',
  }, strategies.map((s) => el('option', {
    value: String(s.strategyId),
    selected: String(s.strategyId) === String(selSid),
  }, s.label)));

  const current = strategies.find((s) => String(s.strategyId) === String(selSid)) || strategies[0];
  const initialVid = (selSid && selVid && current?.versions.some((v) => String(v.versionId) === String(selVid)))
    ? selVid
    : resolveVersionIdForStrategy(current, current?.versions);
  const hidden = el('input', {
    type: 'hidden',
    name: 'strategy_pick',
    value: current ? `gls:${current.strategyId}:${initialVid}` : (selectedValue || options[0]?.value || ''),
  });

  const versionSelect = el('select', {
    name: 'strategy_version_pick',
    class: 'field__input studio-strategy-picker__version',
    'aria-label': 'Versão',
  });
  const versionRow = el('div', { class: 'studio-strategy-picker__version-row' });

  function syncValue({ strategyChanged = false } = {}) {
    const sid = strategySelect.value;
    const strat = strategies.find((s) => String(s.strategyId) === sid) || strategies[0];
    if (!strat) return;

    const sortedVersions = sortVersions(strat.versions);
    let vid;
    if (strategyChanged) {
      vid = resolveVersionIdForStrategy(strat, sortedVersions);
    } else {
      const currentVid = versionSelect.value;
      vid = sortedVersions.some((v) => String(v.versionId) === String(currentVid))
        ? currentVid
        : resolveVersionIdForStrategy(strat, sortedVersions);
    }

    versionSelect.replaceChildren(...sortedVersions.map((v) => el('option', {
      value: String(v.versionId),
      selected: String(v.versionId) === String(vid),
    }, formatVersionLabel(v, strat))));

    hidden.value = `gls:${strat.strategyId}:${vid}`;
    onChange?.(hidden.value);
  }

  syncValue();
  strategySelect.addEventListener('change', () => syncValue({ strategyChanged: true }));
  versionSelect.addEventListener('change', () => syncValue({ strategyChanged: false }));
  versionRow.append(versionSelect);
  if (pinButton) versionRow.append(pinButton);
  wrap.append(strategySelect, versionRow, hidden);
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
