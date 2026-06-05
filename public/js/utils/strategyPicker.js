import { escapeHtml } from './format.js';

/**
 * Carrega estratégias nativas + GLS salvas e monta um <select>.
 * Valor: `native:edge-sniper-v2` ou `gls:<strategyId>:<versionId>`
 */
export async function loadStrategyOptions(api) {
  const [nativeRes, savedRes] = await Promise.all([
    api.get('/api/backtest/strategies'),
    api.get('/api/strategies'),
  ]);
  const native = nativeRes.ok ? nativeRes.data.strategies || [] : [];
  const saved = savedRes.ok ? savedRes.data.strategies || [] : [];
  const options = [];

  for (const slug of native) {
    options.push({
      value: `native:${slug}`,
      label: `${slug} (nativa)`,
      kind: 'native',
      slug,
    });
  }

  for (const strategy of saved) {
    if (!strategy.latest_version_id) continue;
    options.push({
      value: `gls:${strategy.id}:${strategy.latest_version_id}`,
      label: `${strategy.name} (GLS v${strategy.latest_version ?? '?'})`,
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
  return `<select name="strategy_pick" class="field__input">${html || '<option value="">Nenhuma estratégia</option>'}</select>`;
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

  if (!pick || pick.startsWith('native:')) {
    return { ...base, strategy: pick?.replace('native:', '') || 'edge-sniper-v2' };
  }
  const [, strategyId, versionId] = pick.split(':');
  return {
    ...base,
    strategy_id: Number(strategyId),
    strategy_version_id: Number(versionId),
  };
}
