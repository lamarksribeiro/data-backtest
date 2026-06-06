import { el, mount } from '../utils/dom.js';
import { fetchHealthzCached } from '../utils/healthzCache.js';

export async function renderOverview(ctx) {
  ctx.setBreadcrumb('overview', null);
  ctx.renderContextBar?.();

  mount(ctx.contentEl, el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, 'Visão Geral'),
      el('p', { class: 'page-header__sub' }, 'Status do lakehouse, manifest e modo de dados.'),
    ]),
  ]));

  const grid = el('div', { class: 'grid grid--4', id: 'overview-stats' }, [
    el('div', { class: 'stat stat--idle' }, [el('span', { class: 'stat__label' }, 'Carregando'), el('span', { class: 'stat__value' }, '…')]),
  ]);
  ctx.contentEl.appendChild(grid);

  const [healthRes, manifestRes] = await Promise.all([
    fetchHealthzCached({ force: true }),
    ctx.api.get('/api/manifest?limit=5'),
  ]);

  const health = healthRes.body || {};
  const manifest = manifestRes.ok ? manifestRes.data : null;
  const stats = health.manifest || {};
  const byStatus = stats.by_status || {};

  mount(document.getElementById('overview-stats'), [
    statCard('Status', health.status === 'ok' ? 'Operacional' : 'Alerta', health.status === 'ok' ? 'fa-solid fa-circle-check' : 'fa-solid fa-triangle-exclamation', health.status === 'ok' ? 'ok' : 'warn'),
    statCard('Partições', String(stats.partitions ?? 0), 'fa-solid fa-cubes', 'idle', `${byStatus.valid ?? 0} válidas`),
    statCard('Modo backtest', health.backtest_data_mode || '-', 'fa-solid fa-bolt', 'idle'),
    statCard('Lake root', (health.lake_root || '').split(/[/\\]/).pop() || '-', 'fa-solid fa-folder-open', 'idle'),
  ]);

  const card = el('section', { class: 'card' }, [
    el('div', { class: 'card__header' }, [
      el('h2', { class: 'card__title' }, 'Últimas partições'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => ctx.navigate('data') }, 'Ver dados'),
    ]),
  ]);

  const partitions = manifest?.partitions || [];
  if (!partitions.length) {
    card.appendChild(el('p', { class: 'muted' }, 'Nenhuma partição registrada no manifest.'));
  } else {
    const table = el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Dataset'), el('th', {}, 'Data'), el('th', {}, 'Status'), el('th', {}, 'Linhas'),
        ])),
        el('tbody', {}, partitions.map((p) => el('tr', {}, [
          el('td', {}, p.dataset),
          el('td', {}, p.dt),
          el('td', {}, el('span', { class: `badge badge--${statusTone(p.status)}` }, p.status)),
          el('td', {}, String(p.rows ?? 0)),
        ]))),
      ]),
    ]);
    card.appendChild(table);
  }
  ctx.contentEl.appendChild(card);
}

function statCard(label, value, iconClass, tone, hint) {
  return el('div', { class: `stat stat--${tone}` }, [
    el('div', { class: 'stat__header', style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;' }, [
      el('span', { class: 'stat__label', style: 'margin: 0;' }, label),
      iconClass ? el('i', { class: `${iconClass} stat__icon`, style: 'font-size: var(--font-size-lg); opacity: 0.8;' }) : null,
    ]),
    el('span', { class: 'stat__value' }, value),
    hint ? el('span', { class: 'stat__hint' }, hint) : null,
  ]);
}

function statusTone(status) {
  if (status === 'valid') return 'ok';
  if (status === 'stale' || status === 'needs_review') return 'warn';
  if (status === 'invalid' || status === 'missing') return 'err';
  return 'idle';
}
