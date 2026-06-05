import { escapeHtml } from './format.js';

/**
 * Carrega estratégias salvas/versionadas e monta um <select>.
 * Valor: `gls:<strategyId>:<versionId>`
 */
export async function loadStrategyOptions(api) {
  const savedRes = await api.get('/api/strategies');
  const saved = savedRes.ok ? savedRes.data.strategies || [] : [];
  const options = [];

  for (const strategy of saved) {
    if (!strategy.latest_version_id) continue;
    options.push({
      value: `gls:${strategy.id}:${strategy.latest_version_id}`,
      label: `${strategy.name} · v${strategy.latest_version ?? '?'}`,
      kind: 'gls',
      strategyId: strategy.id,
      versionId: strategy.latest_version_id,
      slug: strategy.slug,
    });
  }

  return options;
}

export function renderStrategySelect(options, selectedValue = '') {
  const html = options.map((opt) => `
    <option value="${escapeHtml(opt.value)}" ${opt.value === selectedValue ? 'selected' : ''}>${escapeHtml(opt.label)}</option>
  `).join('');
  return `<select name="strategy_pick" class="field__input" ${options.length ? '' : 'disabled'}>${html || '<option value="">Nenhuma estratégia versionada</option>'}</select>`;
}

export function backtestPayloadFromPick(pick, ctx, extra = {}) {
  const base = {
    from: ctx.from,
    to: ctx.to,
    underlying: ctx.underlying,
    interval: ctx.interval,
    batch_size: Number(ctx.batch_size) || 5000,
    ...extra,
  };
  if (ctx.dataset === 'backtest_ticks') base.book_depth = Number(ctx.book_depth) || 10;

  const [, strategyId, versionId] = pick.split(':');
  return {
    ...base,
    strategy_id: Number(strategyId),
    strategy_version_id: Number(versionId),
  };
}
