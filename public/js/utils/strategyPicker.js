import { el } from './dom.js';
import { escapeHtml } from './format.js';

/**
 * Carrega estratégias com todas as versões (exceto archived por padrão).
 */
export async function loadStrategyOptions(api, { includeArchived = false, stats = false } = {}) {
  const url = stats ? '/api/strategies?stats=1' : '/api/strategies';
  const savedRes = await api.get(url);
  const saved = savedRes.ok ? savedRes.data.strategies || [] : [];
  const options = [];

  for (const strategy of saved) {
    if (!includeArchived && strategy.status === 'archived') continue;
    const versionsRes = await api.get(`/api/strategies/${strategy.id}/versions`);
    const versions = versionsRes.ok ? versionsRes.data.versions || [] : [];
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

  return options;
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
