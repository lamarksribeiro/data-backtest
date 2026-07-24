import { el } from './dom.js';
import { escapeHtml } from './format.js';
import { contextToApiRange } from './dateRange.js';

const PICKER_CACHE_TTL_MS = 30_000;
const STRATEGY_PICK_STORAGE_KEY = 'data-backtest-strategy-pick';
const STRATEGY_PICK_PREFIX = 'js:';

const STATUS_LABELS = {
  validated: 'Aprovadas',
  draft: 'Em Teste',
  failed: 'Falharam',
};

const STATUS_ORDER = ['validated', 'draft', 'failed'];

const STATUS_TONE = {
  validated: 'ok',
  draft: 'warn',
  failed: 'err',
};

function isStrategyPick(value) {
  const raw = String(value || '');
  return raw.startsWith(`${STRATEGY_PICK_PREFIX}`) || raw.startsWith('gls:');
}

function normalizeStrategyPick(value) {
  const raw = String(value || '');
  if (!isStrategyPick(raw)) return '';
  return raw.replace(/^gls:/, `${STRATEGY_PICK_PREFIX}`);
}

function buildStrategyPick(strategyId, versionId) {
  return `${STRATEGY_PICK_PREFIX}${strategyId}:${versionId}`;
}

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

function normalizePickerStatus(status) {
  return STATUS_ORDER.includes(status) ? status : 'draft';
}

function compareStrategies(a, b) {
  if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
  return (b.strategyId ?? 0) - (a.strategyId ?? 0);
}

function groupOptionsByStrategy(options) {
  const byStrategy = new Map();
  for (const opt of options) {
    const key = opt.strategyId;
    if (!byStrategy.has(key)) {
      byStrategy.set(key, {
        strategyId: key,
        label: opt.label.split(' · ')[0],
        slug: opt.slug || '',
        tags: opt.tags || [],
        status: normalizePickerStatus(opt.status),
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
  return [...byStrategy.values()].sort(compareStrategies);
}

function strategyMatchesQuery(strat, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const statusLabel = STATUS_LABELS[strat.status] || '';
  const haystack = [
    strat.label,
    strat.slug,
    statusLabel,
    ...(strat.tags || []),
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

function formatStrategyLabel(strat) {
  return strat.pinned ? `★ ${strat.label}` : strat.label;
}

function filterVisibleStrategies(strategies, { query = '', selectedId = '' } = {}) {
  const selected = strategies.find((s) => String(s.strategyId) === String(selectedId)) || null;
  const matching = strategies.filter((s) => strategyMatchesQuery(s, query));
  const visible = new Map(matching.map((s) => [String(s.strategyId), s]));
  if (selected && !visible.has(String(selected.strategyId))) {
    visible.set(String(selected.strategyId), selected);
  }
  const list = [...visible.values()].sort(compareStrategies);
  return { list, selected, total: strategies.length, visible: list.length };
}

function buildStrategyMenuItems(list, selectedId, onPick) {
  const grouped = new Map(STATUS_ORDER.map((status) => [status, []]));
  for (const strat of list) {
    grouped.get(strat.status)?.push(strat);
  }

  const nodes = [];
  for (const status of STATUS_ORDER) {
    const items = grouped.get(status) || [];
    if (!items.length) continue;
    const tone = STATUS_TONE[status] || 'idle';
    nodes.push(el('div', {
      class: `studio-strategy-picker__group-label studio-strategy-picker__group-label--${tone}`,
    }, STATUS_LABELS[status]));
    for (const strat of items) {
      const isSelected = String(strat.strategyId) === String(selectedId);
      nodes.push(el('button', {
        type: 'button',
        role: 'option',
        class: `studio-strategy-picker__option${isSelected ? ' is-selected' : ''}`,
        'aria-selected': isSelected ? 'true' : 'false',
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onPick(strat.strategyId);
        },
      }, formatStrategyLabel(strat)));
    }
  }

  if (!nodes.length) {
    nodes.push(el('div', { class: 'studio-strategy-picker__menu-empty muted' }, 'Nenhuma estratégia encontrada'));
  }
  return nodes;
}

export function loadLastStrategyPick() {
  try {
    const raw = localStorage.getItem(STRATEGY_PICK_STORAGE_KEY);
    return normalizeStrategyPick(raw);
  } catch {
    return '';
  }
}

export function saveLastStrategyPick(pick) {
  const normalized = normalizeStrategyPick(pick);
  if (!normalized) return;
  try {
    localStorage.setItem(STRATEGY_PICK_STORAGE_KEY, normalized);
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
    return buildStrategyPick(strategyId, versionId);
  }

  const saved = loadLastStrategyPick();
  if (saved && options.some((o) => o.value === saved)) return saved;

  const strategies = groupOptionsByStrategy(options);
  const first = strategies[0];
  if (!first) return options[0].value;

  const vid = resolveVersionIdForStrategy(first, first.versions);
  return buildStrategyPick(first.strategyId, vid);
}

function formatVersionLabel(version, strat) {
  if (version.notes) {
    const shortNotes = String(version.notes).replace(/^Preset\s+v\d+:\s*/i, '');
    return `v${version.versionNum} · ${shortNotes}`;
  }
  return `v${version.versionNum}`;
}

function mapPickerRows(rows, { includeArchived = false } = {}) {
  const options = [];
  for (const row of rows) {
    if (!includeArchived && row.status === 'archived') continue;
    options.push({
      value: buildStrategyPick(row.strategy_id, row.version_id),
      label: `${row.name} · v${row.version}${row.notes ? ` — ${row.notes}` : ''}`,
      kind: 'strategy-js',
      strategyId: row.strategy_id,
      versionId: row.version_id,
      versionNum: row.version,
      slug: row.slug,
      status: row.status,
      pinned: row.pinned,
      tags: row.tags || [],
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
          value: buildStrategyPick(strategy.id, version.id),
          label: `${strategy.name} · v${version.version}${meta ? ` · ${meta}` : ''}${notes}`,
          kind: 'strategy-js',
          strategyId: strategy.id,
          versionId: version.id,
          versionNum: version.version,
          slug: strategy.slug,
          status: strategy.status,
          pinned: strategy.pinned,
          tags: strategy.tags || [],
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

  const current = strategies.find((s) => String(s.strategyId) === String(selSid)) || strategies[0];
  let selectedStrategyId = String(selSid || current?.strategyId || '');
  let menuOpen = false;
  let dismissHandler = null;

  const searchInput = el('input', {
    type: 'search',
    class: 'field__input studio-strategy-picker__search',
    placeholder: 'Buscar por nome ou slug…',
    'aria-label': 'Buscar estratégia',
    autocomplete: 'off',
  });

  const searchHint = el('span', { class: 'studio-strategy-picker__hint muted' });

  const strategyIdHidden = el('input', {
    type: 'hidden',
    name: 'strategy_id_pick',
    value: selectedStrategyId,
  });

  const triggerLabel = el('span', { class: 'studio-strategy-picker__trigger-label' });
  const trigger = el('button', {
    type: 'button',
    class: 'field__input studio-strategy-picker__trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-label': 'Selecionar estratégia',
    disabled: !strategies.length,
    onclick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menuOpen) closeMenu();
      else openMenu({ focusSearch: false });
    },
  }, [
    triggerLabel,
    el('i', { class: 'fa-solid fa-chevron-down studio-strategy-picker__trigger-icon', 'aria-hidden': 'true' }),
  ]);

  const menu = el('div', {
    class: 'studio-strategy-picker__menu',
    role: 'listbox',
    hidden: true,
  });

  const comboWrap = el('div', { class: 'studio-strategy-picker__combo' }, [trigger, menu]);

  const initialVid = (selSid && selVid && current?.versions.some((v) => String(v.versionId) === String(selVid)))
    ? selVid
    : resolveVersionIdForStrategy(current, current?.versions);
  const hidden = el('input', {
    type: 'hidden',
    name: 'strategy_pick',
    value: current ? buildStrategyPick(current.strategyId, initialVid) : normalizeStrategyPick(selectedValue || options[0]?.value || ''),
  });

  const versionSelect = el('select', {
    name: 'strategy_version_pick',
    class: 'field__input studio-strategy-picker__version',
    'aria-label': 'Versão',
  });

  function updateSearchHint(counts) {
    if (!counts.visible) {
      searchHint.textContent = 'Nenhuma estratégia corresponde à busca';
      searchHint.hidden = false;
      return;
    }
    if (counts.visible === counts.total) {
      searchHint.textContent = '';
      searchHint.hidden = true;
      return;
    }
    searchHint.textContent = `${counts.visible} de ${counts.total} estratégias`;
    searchHint.hidden = false;
  }

  function updateTriggerLabel() {
    const strat = strategies.find((s) => String(s.strategyId) === String(selectedStrategyId));
    triggerLabel.textContent = strat ? formatStrategyLabel(strat) : 'Selecione uma estratégia';
    trigger.disabled = !strategies.length;
  }

  function renderMenu() {
    const counts = filterVisibleStrategies(strategies, {
      query: searchInput.value,
      selectedId: selectedStrategyId,
    });
    menu.replaceChildren(...buildStrategyMenuItems(counts.list, selectedStrategyId, selectStrategy));
    updateSearchHint(counts);
  }

  function bindDismiss() {
    if (dismissHandler) return;
    dismissHandler = (event) => {
      if (!comboWrap.contains(event.target) && event.target !== searchInput) {
        closeMenu();
      }
    };
    document.addEventListener('pointerdown', dismissHandler, true);
  }

  function unbindDismiss() {
    if (!dismissHandler) return;
    document.removeEventListener('pointerdown', dismissHandler, true);
    dismissHandler = null;
  }

  function openMenu({ focusSearch = false } = {}) {
    if (!strategies.length) return;
    menuOpen = true;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    comboWrap.classList.add('is-open');
    renderMenu();
    bindDismiss();
    if (focusSearch) searchInput.focus();
  }

  function closeMenu() {
    menuOpen = false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    comboWrap.classList.remove('is-open');
    unbindDismiss();
  }

  function selectStrategy(strategyId) {
    const prev = selectedStrategyId;
    selectedStrategyId = String(strategyId);
    strategyIdHidden.value = selectedStrategyId;
    updateTriggerLabel();
    closeMenu();
    syncValue({ strategyChanged: prev !== selectedStrategyId });
  }

  function syncValue({ strategyChanged = false } = {}) {
    const sid = selectedStrategyId;
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

    hidden.value = buildStrategyPick(strat.strategyId, vid);
    onChange?.(hidden.value);
  }

  updateTriggerLabel();
  renderMenu();
  syncValue();

  searchInput.addEventListener('input', () => {
    if (!menuOpen) openMenu();
    else renderMenu();
  });
  searchInput.addEventListener('focus', () => {
    if (!menuOpen) openMenu();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      searchInput.blur();
    }
  });

  versionSelect.addEventListener('change', () => syncValue({ strategyChanged: false }));

  wrap.addEventListener('studio-strategy-picker:destroy', unbindDismiss);

  const versionWrap = el('div', { class: 'studio-strategy-picker__version-wrap' }, [
    versionSelect,
    ...(pinButton ? [pinButton] : []),
  ]);

  wrap.append(
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Estratégia'),
      el('div', { class: 'studio-strategy-picker__search-wrap' }, [
        el('i', {
          class: 'fa-solid fa-magnifying-glass studio-strategy-picker__search-icon',
          'aria-hidden': 'true',
        }),
        searchInput,
      ]),
      comboWrap,
      searchHint,
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Versão'),
      versionWrap,
    ]),
    strategyIdHidden,
    hidden,
  );
  return wrap;
}

export function backtestPayloadFromPick(pick, ctx, extra = {}) {
  const range = contextToApiRange(ctx);
  const base = {
    from: range.from,
    to: range.to,
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