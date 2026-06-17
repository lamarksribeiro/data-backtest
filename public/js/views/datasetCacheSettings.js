import { el, mount, emptyState } from '../utils/dom.js';
import { confirmDialog } from '../utils/confirm.js';
import { renderSettingsPage } from './settingsTabs.js';

export async function renderDatasetCacheSettings(ctx) {
  ctx.setBreadcrumb('settings', 'Cache de backtest');
  ctx.renderContextBar?.();

  mount(ctx.contentEl, renderSettingsPage('cache', el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Carregando cache…'))));
  await refreshDatasetCacheSettings(ctx);
}

async function refreshDatasetCacheSettings(ctx) {
  const cacheRes = await ctx.api.get('/api/settings/dataset-cache');
  if (!cacheRes.ok) {
    mount(ctx.contentEl, el('p', { class: 'bad' }, cacheRes.error?.message || 'Falha ao carregar cache'));
    return;
  }
  renderDatasetCachePage(ctx, cacheRes.data);
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function renderDatasetCachePage(ctx, cacheStats) {
  const groups = cacheStats?.groups || [];
  mount(ctx.contentEl, renderSettingsPage('cache', [
    el('section', { class: 'card' }, [
      el('div', { class: 'settings-card__head settings-card__head--row' }, [
        el('div', {}, [
          el('h2', { class: 'card__title' }, 'Materialização em disco'),
          el('p', { class: 'card__sub' }, `Diretório: ${cacheStats?.cache_dir || '—'}. Cada dia ausente é gravado no primeiro backtest que precisar dele.`),
        ]),
        el('span', { class: `badge badge--${cacheStats?.enabled ? 'ok' : 'warn'}` }, cacheStats?.enabled ? 'Ativo' : 'Desligado'),
      ]),
      el('div', { class: 'settings-stat-grid' }, [
        stat('Espaço total', formatBytes(cacheStats?.total_bytes)),
        stat('Arquivos', String(cacheStats?.total_files ?? 0)),
        stat('Grupos', String(groups.length)),
      ]),
      groups.length
        ? el('div', { class: 'settings-list', style: { marginTop: '16px' } }, groups.map((g) => el('div', { class: 'settings-list-row' }, [
          el('span', {}, [
            el('strong', {}, g.underlying),
            ` · ${g.interval} · book ${g.book_depth ?? 'lite'} · ${g.days_count ?? 0} dias`,
            g.oldest_dt && g.newest_dt ? ` (${g.oldest_dt} → ${g.newest_dt})` : '',
          ]),
          el('span', { class: 'mono' }, formatBytes(g.bytes)),
        ])))
        : emptyState('Nenhum dado materializado ainda. Rode um backtest para preencher o cache automaticamente.'),
      el('div', { class: 'settings-form__actions', style: { marginTop: '16px' } }, [
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm btn--danger',
          disabled: !groups.length && !cacheStats?.total_bytes,
          onclick: () => clearDatasetCache(ctx),
        }, 'Limpar tudo'),
      ]),
    ]),
  ]));
}

async function clearDatasetCache(ctx) {
  const ok = await confirmDialog({
    title: 'Limpar cache em disco',
    message: 'Remover todos os arquivos materializados? Os próximos backtests voltarão a ler Parquet e regravar o cache conforme necessário.',
    confirmLabel: 'Limpar tudo',
    danger: true,
  });
  if (!ok) return;
  const res = await ctx.api.delete('/api/settings/dataset-cache');
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao limpar cache');
    return;
  }
  ctx.toast.ok(`Removidos ${res.data.removed_files ?? 0} arquivos (${formatBytes(res.data.removed_bytes)})`);
  await refreshDatasetCacheSettings(ctx);
}

function stat(label, value) {
  return el('div', { class: 'settings-stat' }, [
    el('span', { class: 'settings-stat__label' }, label),
    el('span', { class: 'settings-stat__value' }, value),
  ]);
}
