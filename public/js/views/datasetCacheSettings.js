import { el, mount, emptyState } from '../utils/dom.js';
import { confirmDialog } from '../utils/confirm.js';
import { renderSettingsTabs } from './settingsTabs.js';

const cacheStyles = `
  .cache-page {
    margin-top: 20px;
  }

  .cache-hint {
    margin: 2px 0 0;
    color: var(--text-3);
    font-size: 11.5px;
    line-height: 1.45;
  }

  .cache-group-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
  }

  .cache-group-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    color: var(--text-2);
    font-size: 12.5px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: var(--radius-sm);
    background: rgba(13, 19, 32, 0.4);
    transition: background-color 0.2s, border-color 0.2s;
  }

  .cache-group-row:hover {
    background: rgba(13, 19, 32, 0.6);
    border-color: rgba(255, 255, 255, 0.08);
  }

  .schedule-card__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    margin: 14px 0;
  }

  .schedule-stat {
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: var(--radius-sm);
    background: rgba(13, 19, 32, 0.4);
    transition: background-color 0.2s, border-color 0.2s;
  }

  .schedule-stat:hover {
    background: rgba(13, 19, 32, 0.65);
    border-color: rgba(255, 255, 255, 0.08);
  }

  .schedule-stat__label {
    display: block;
    color: var(--text-3);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .schedule-stat__value {
    color: var(--text-1);
    font-size: 12.5px;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
  }

  .schedule-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
`;

export async function renderDatasetCacheSettings(ctx) {
  ctx.setBreadcrumb('settings', 'Cache de backtest');
  ctx.renderContextBar?.();

  if (!document.getElementById('dataset-cache-settings-styles')) {
    document.head.appendChild(el('style', { id: 'dataset-cache-settings-styles' }, cacheStyles));
  }

  mount(ctx.contentEl, el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Carregando cache…')));
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
  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Configurações'),
        el('p', { class: 'page-header__sub' }, 'Cache em disco gerado automaticamente no primeiro backtest de cada janela — use esta tela só para consultar uso e limpar.'),
      ]),
    ]),
    renderSettingsTabs('cache'),
    el('section', { class: 'card cache-page' }, [
      el('div', { class: 'card__header' }, [
        el('div', {}, [
          el('h2', { class: 'card__title' }, 'Materialização em disco'),
          el('p', { class: 'cache-hint' }, `Diretório: ${cacheStats?.cache_dir || '—'}. Cada dia ausente é gravado no primeiro backtest que precisar dele.`),
        ]),
        el('span', { class: `badge badge--${cacheStats?.enabled ? 'ok' : 'warn'}` }, cacheStats?.enabled ? 'Ativo' : 'Desligado'),
      ]),
      el('div', { class: 'schedule-card__grid' }, [
        stat('Espaço total', formatBytes(cacheStats?.total_bytes)),
        stat('Arquivos', String(cacheStats?.total_files ?? 0)),
        stat('Grupos', String(groups.length)),
      ]),
      groups.length
        ? el('div', { class: 'cache-group-list' }, groups.map((g) => el('div', { class: 'cache-group-row' }, [
          el('span', {}, [
            el('strong', { style: { color: 'var(--text-0)' } }, g.underlying),
            ` · ${g.interval} · book ${g.book_depth ?? 'lite'} · ${g.days_count ?? 0} dias`,
            g.oldest_dt && g.newest_dt ? ` (${g.oldest_dt} → ${g.newest_dt})` : '',
          ]),
          el('span', {}, formatBytes(g.bytes)),
        ])))
        : emptyState('Nenhum dado materializado ainda. Rode um backtest para preencher o cache automaticamente.'),
      el('div', { class: 'schedule-card__actions', style: { marginTop: '16px' } }, [
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm btn--danger',
          disabled: !groups.length && !cacheStats?.total_bytes,
          onclick: () => clearDatasetCache(ctx),
        }, 'Limpar tudo'),
      ]),
    ]),
  ]);
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
  return el('div', { class: 'schedule-stat' }, [
    el('span', { class: 'schedule-stat__label' }, label),
    el('span', { class: 'schedule-stat__value' }, value),
  ]);
}
