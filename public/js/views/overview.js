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
    statCard('Status', health.status === 'ok' ? 'Operacional' : 'Alerta', health.status === 'ok' ? 'ok' : 'warn'),
    statCard('Partições', String(stats.partitions ?? 0), 'idle', `${byStatus.valid ?? 0} válidas`),
    statCard('Modo backtest', health.backtest_data_mode || '-', 'idle'),
    statCard('Lake root', (health.lake_root || '').split(/[/\\]/).pop() || '-', 'idle'),
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
    const table = el('table', { class: 'table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Dataset'), el('th', {}, 'Data'), el('th', {}, 'Status'), el('th', {}, 'Linhas'),
      ])),
      el('tbody', {}, partitions.map((p) => el('tr', {}, [
        el('td', {}, p.dataset),
        el('td', {}, p.dt),
        el('td', {}, el('span', { class: `badge badge--${statusTone(p.status)}` }, p.status)),
        el('td', {}, String(p.rows ?? 0)),
      ]))),
    ]);
    card.appendChild(table);
  }
  ctx.contentEl.appendChild(card);
}

function statCard(label, value, tone, hint) {
  return el('div', { class: `stat stat--${tone}` }, [
    el('span', { class: 'stat__label' }, label),
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
