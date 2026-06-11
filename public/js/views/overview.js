import { el, mount } from '../utils/dom.js';
import { fetchHealthzCached } from '../utils/healthzCache.js';

export async function renderOverview(ctx) {
  ctx.setBreadcrumb('overview', null);
  ctx.renderContextBar?.();

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Visão Geral'),
        el('p', { class: 'page-header__sub' }, 'Saúde do sistema e versões — cobertura de dados na aba Dados.'),
      ]),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => ctx.navigate('data') }, 'Abrir Dados'),
    ]),
    el('div', { class: 'grid grid--4', id: 'overview-stats' }, [
      el('div', { class: 'stat stat--idle' }, [el('span', { class: 'stat__label' }, 'Carregando'), el('span', { class: 'stat__value' }, '…')]),
    ]),
    el('section', { class: 'card', id: 'overview-health-detail' }),
  ]);

  const healthRes = await fetchHealthzCached({ force: true });
  const health = healthRes.body || {};
  const stats = health.manifest || {};

  mount(document.getElementById('overview-stats'), [
    statCard('Status', health.status === 'ok' ? 'Operacional' : 'Alerta', health.status === 'ok' ? 'ok' : 'warn'),
    statCard('Partições', String(stats.partitions ?? 0), 'idle', `${stats.usable ?? 0} utilizáveis`),
    statCard('Modo backtest', health.backtest_data_mode || '-', 'idle'),
    statCard('Versão app', health.app_version || '-', 'idle'),
  ]);

  mount(document.getElementById('overview-health-detail'), el('div', { class: 'health-detail-grid' }, [
    detailRow('Lake root', health.lake_root || '-'),
    detailRow('State DB', health.state_db_path || '-'),
    detailRow('Fingerprint lake', health.lake_fingerprint || '-'),
    detailRow('Uptime', formatUptime(health.uptime_sec)),
  ]));
}

function statCard(label, value, tone, hint) {
  return el('div', { class: `stat stat--${tone}` }, [
    el('span', { class: 'stat__label' }, label),
    el('span', { class: 'stat__value' }, value),
    hint ? el('span', { class: 'stat__hint' }, hint) : null,
  ]);
}

function formatUptime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '-';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function detailRow(label, value) {
  return el('div', { class: 'detail-row' }, [
    el('span', { class: 'detail-row__label muted' }, label),
    el('code', { class: 'detail-row__value' }, String(value)),
  ]);
}
