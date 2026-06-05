import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml } from '../utils/format.js';
import { delay } from '../utils/format.js';

let pollToken = 0;

export async function renderJobs(ctx) {
  ctx.setBreadcrumb('jobs', null);
  ctx.renderContextBar?.();

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Jobs'),
        el('p', { class: 'page-header__sub' }, 'Jobs de preparação enfileirados e concluídos.'),
      ]),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => loadJobs(ctx) }, 'Atualizar'),
    ]),
    el('div', { id: 'jobs-list' }),
  ]);

  await loadJobs(ctx);
}

async function loadJobs(ctx) {
  const panel = document.getElementById('jobs-list');
  if (!panel) return;
  mount(panel, el('p', { class: 'muted' }, 'Carregando jobs...'));

  const res = await ctx.api.get('/api/prepare/jobs?limit=30');
  if (!res.ok) {
    mount(panel, el('section', { class: 'card card--error' }, el('p', {}, res.error?.message || 'Falha')));
    return;
  }

  const jobs = res.data.jobs || [];
  if (!jobs.length) {
    mount(panel, emptyState('Nenhum job de preparação ainda.'));
    return;
  }

  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'ID'), el('th', {}, 'Status'), el('th', {}, 'Modo'), el('th', {}, 'Criado'), el('th', {}, ''),
    ])),
    el('tbody', {}, jobs.map((job) => el('tr', {}, [
      el('td', {}, `#${job.id}`),
      el('td', {}, el('span', { class: `badge badge--${jobStatusTone(job.status)}` }, job.status)),
      el('td', {}, job.dry_run ? 'dry-run' : 'execução'),
      el('td', {}, job.created_at || '-'),
      el('td', {}, el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => showJobDetail(ctx, job.id),
      }, 'Detalhes')),
    ]))),
  ]);
  mount(panel, el('section', { class: 'card' }, [table, el('div', { id: 'job-detail' })]));

  const hasActive = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  if (hasActive) startPolling(ctx);
}

function jobStatusTone(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'running') return 'warn';
  return 'idle';
}

function startPolling(ctx) {
  const token = ++pollToken;
  (async () => {
    while (token === pollToken) {
      await delay(2000);
      const res = await ctx.api.get('/api/prepare/jobs?limit=30');
      if (!res.ok || token !== pollToken) return;
      const jobs = res.data.jobs || [];
      const stillActive = jobs.some((j) => j.status === 'queued' || j.status === 'running');
      await loadJobs(ctx);
      if (!stillActive) return;
    }
  })();
}

async function showJobDetail(ctx, id) {
  const panel = document.getElementById('job-detail');
  if (!panel) return;
  const res = await ctx.api.get(`/api/prepare/jobs/${id}`);
  if (!res.ok) {
    mount(panel, el('p', { class: 'bad' }, res.error?.message || 'Falha'));
    return;
  }
  const job = res.data.job;
  mount(panel, el('section', { class: 'card card--nested' }, [
    el('h3', { class: 'card__title' }, `Job #${job.id}`),
    el('p', {}, `Status: ${escapeHtml(job.status)} · ${job.dry_run ? 'dry-run' : 'execução real'}`),
    job.error ? el('p', { class: 'bad' }, escapeHtml(job.error)) : null,
    job.result ? el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify(job.result, null, 2))) : null,
  ]));
}
