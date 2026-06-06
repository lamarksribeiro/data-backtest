import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml } from '../utils/format.js';
import { delay } from '../utils/format.js';

let pollToken = 0;
let initialLoadDone = false;
let expandedJobId = null;
let jobsPanelBuilt = false;

const PHASE_LABELS = {
  starting: 'Iniciando',
  listing_events: 'Listando eventos',
  counting_ticks: 'Contando ticks',
  fetching_rows: 'Buscando dados',
  writing_parquet: 'Gravando parquet',
  skipped: 'Ignorado',
  done: 'Concluído',
};

export async function renderJobs(ctx) {
  ctx.setBreadcrumb('jobs', null);
  ctx.renderContextBar?.();
  initialLoadDone = false;
  jobsPanelBuilt = false;
  expandedJobId = null;
  pollToken += 1;

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Jobs'),
        el('p', { class: 'page-header__sub' }, 'Jobs de preparação enfileirados e concluídos.'),
      ]),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => refreshJobs(ctx, { force: true }) }, 'Atualizar'),
    ]),
    el('div', { id: 'jobs-list' }),
  ]);

  await refreshJobs(ctx, { initial: true });
}

async function refreshJobs(ctx, { initial = false, force = false } = {}) {
  const panel = document.getElementById('jobs-list');
  if (!panel) return;

  if (initial || !jobsPanelBuilt) {
    mount(panel, el('p', { class: 'muted', id: 'jobs-loading' }, 'Carregando jobs...'));
  }

  const res = await ctx.api.get('/api/prepare/jobs?limit=30');
  if (!res.ok) {
    mount(panel, el('section', { class: 'card card--error' }, el('p', {}, res.error?.message || 'Falha')));
    jobsPanelBuilt = false;
    return;
  }

  const jobs = res.data.jobs || [];
  initialLoadDone = true;
  jobsPanelBuilt = true;

  if (!jobs.length) {
    mount(panel, emptyState('Nenhum job de preparação ainda.'));
    return;
  }

  const activeJob = jobs.find((j) => j.status === 'queued' || j.status === 'running');
  if (activeJob && expandedJobId == null) {
    expandedJobId = activeJob.id;
  }

  const existingTable = panel.querySelector('#jobs-table tbody');
  if (existingTable && !force) {
    updateJobsTable(existingTable, jobs, ctx);
    updateActiveJobDetail(ctx, jobs);
  } else {
    renderJobsPanel(panel, jobs, ctx);
  }

  if (jobs.some((j) => j.status === 'queued' || j.status === 'running')) {
    startPolling(ctx);
  }
}

function renderJobsPanel(panel, jobs, ctx) {
  const tbody = el('tbody', { id: 'jobs-table-body' });
  updateJobsTable(tbody, jobs, ctx);

  const table = el('table', { class: 'table', id: 'jobs-table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'ID'),
      el('th', {}, 'Status'),
      el('th', {}, 'Progresso'),
      el('th', {}, 'Modo'),
      el('th', {}, 'Criado'),
      el('th', {}, ''),
    ])),
    tbody,
  ]);

  mount(panel, el('section', { class: 'card' }, [
    table,
    el('div', { id: 'job-detail' }),
  ]));

  if (expandedJobId) {
    showJobDetail(ctx, expandedJobId, jobs.find((j) => j.id === expandedJobId));
  }
}

function updateJobsTable(tbodyOrParent, jobs, ctx) {
  const tbody = tbodyOrParent.tagName === 'TBODY' ? tbodyOrParent : tbodyOrParent;
  mount(tbody, jobs.map((job) => jobRow(job, ctx)));
}

function jobRow(job, ctx) {
  const isActive = job.status === 'queued' || job.status === 'running';
  const progress = job.progress;
  const progressPct = partitionProgressPct(progress);
  const progressLabel = progressLabelText(job);

  return el('tr', { class: isActive ? 'jobs-row--active' : '', 'data-job-id': String(job.id) }, [
    el('td', {}, `#${job.id}`),
    el('td', {}, el('span', { class: `badge badge--${jobStatusTone(job.status)}` }, job.status)),
    el('td', { class: 'jobs-progress-cell' }, isActive ? [
      el('div', { class: 'live-card__progress-bar' }, [
        el('div', {
          class: 'live-card__progress-fill',
          style: `width:${progressPct}%`,
        }),
      ]),
      el('div', { class: 'live-card__progress-label' }, progressLabel),
    ] : el('span', { class: 'muted' }, progress?.files?.length ? `${progress.files.length} arquivo(s)` : '-')),
    el('td', {}, job.dry_run ? 'dry-run' : 'execução'),
    el('td', {}, job.created_at || '-'),
    el('td', {}, [
      isActive ? el('button', {
        class: 'btn btn--ghost btn--sm bad',
        type: 'button',
        onclick: () => cancelJob(ctx, job.id),
      }, 'Cancelar') : null,
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => {
          expandedJobId = job.id;
          showJobDetail(ctx, job.id, job);
        },
      }, 'Detalhes'),
    ]),
  ]);
}

function partitionProgressPct(progress) {
  if (!progress?.partitions_total) return progress?.current?.phase ? 5 : 0;
  const done = progress.partitions_done || 0;
  const base = (done / progress.partitions_total) * 100;
  if (progress.current?.phase && progress.current.phase !== 'done') {
    return Math.min(base + (100 / progress.partitions_total) * 0.5, 99);
  }
  return Math.min(base, 100);
}

function progressLabelText(job) {
  const p = job.progress;
  if (!p) return job.status === 'running' ? 'Executando...' : job.status;
  const parts = [];
  if (p.partitions_total) {
    parts.push(`${p.partitions_done || 0}/${p.partitions_total} partições`);
  }
  if (p.current?.dt) {
    parts.push(`dt=${p.current.dt}`);
  }
  if (p.current?.phase) {
    parts.push(PHASE_LABELS[p.current.phase] || p.current.phase);
  }
  if (p.files?.length) {
    parts.push(`${p.files.length} arquivo(s)`);
  }
  return parts.join(' · ') || 'Executando...';
}

function updateActiveJobDetail(ctx, jobs) {
  if (!expandedJobId) return;
  const job = jobs.find((j) => j.id === expandedJobId);
  if (job && (job.status === 'queued' || job.status === 'running')) {
    showJobDetail(ctx, job.id, job);
  }
}

function startPolling(ctx) {
  const token = ++pollToken;
  (async () => {
    while (token === pollToken) {
      await delay(2000);
      if (token !== pollToken) return;
      const res = await ctx.api.get('/api/prepare/jobs?limit=30');
      if (!res.ok || token !== pollToken) return;
      const jobs = res.data.jobs || [];
      const panel = document.getElementById('jobs-list');
      const tbody = panel?.querySelector('#jobs-table-body');
      if (tbody) {
        updateJobsTable(tbody, jobs, ctx);
        updateActiveJobDetail(ctx, jobs);
      }
      if (!jobs.some((j) => j.status === 'queued' || j.status === 'running')) return;
    }
  })();
}

async function cancelJob(ctx, id) {
  const res = await ctx.api.post(`/api/prepare/jobs/${id}/cancel`, {});
  if (!res.ok) {
    window.alert(res.error?.message || 'Falha ao cancelar job');
    return;
  }
  await refreshJobs(ctx, { force: true });
}

async function showJobDetail(ctx, id, cachedJob = null) {
  const panel = document.getElementById('job-detail');
  if (!panel) return;

  let job = cachedJob;
  if (!job || job.status === 'running') {
    const res = await ctx.api.get(`/api/prepare/jobs/${id}`);
    if (!res.ok) {
      mount(panel, el('p', { class: 'bad' }, res.error?.message || 'Falha'));
      return;
    }
    job = res.data.job;
  }

  const progress = job.progress;
  const elapsed = formatElapsed(job.started_at, job.completed_at);
  const files = progress?.files || [];

  mount(panel, el('section', { class: 'card card--nested jobs-detail' }, [
    el('h3', { class: 'card__title' }, `Job #${job.id}`),
    el('p', {}, `Status: ${escapeHtml(job.status)} · ${job.dry_run ? 'dry-run' : 'execução real'} · ${elapsed}`),
    progress ? el('div', { class: 'jobs-detail__progress' }, [
      el('div', { class: 'live-card__progress-bar' }, [
        el('div', {
          class: 'live-card__progress-fill',
          style: `width:${partitionProgressPct(progress)}%`,
        }),
      ]),
      el('p', { class: 'live-card__progress-label' }, progressLabelText(job)),
      progress.current ? el('p', { class: 'muted' }, [
        `Partição atual: dt=${escapeHtml(progress.current.dt || '-')} · `,
        `${PHASE_LABELS[progress.current.phase] || progress.current.phase || '-'}`,
        progress.current.partition_index && progress.partitions_total
          ? ` (${progress.current.partition_index}/${progress.partitions_total})`
          : '',
      ]) : null,
    ]) : null,
    files.length ? el('div', { class: 'jobs-detail__files' }, [
      el('h4', {}, `Arquivos (${files.length})`),
      el('table', { class: 'table table--compact' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'dt'), el('th', {}, 'rows'), el('th', {}, 'status'), el('th', {}, 'path'),
        ])),
        el('tbody', {}, files.map((file) => el('tr', {}, [
          el('td', {}, escapeHtml(file.dt || '-')),
          el('td', {}, file.rows != null ? String(file.rows) : '-'),
          el('td', {}, escapeHtml(file.status || (file.skipped ? 'skipped' : '-'))),
          el('td', { class: 'mono truncate' }, escapeHtml(file.path || file.reason || '-')),
        ]))),
      ]),
    ]) : null,
    job.error ? el('p', { class: 'bad' }, escapeHtml(job.error)) : null,
    job.result ? el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify(job.result, null, 2))) : null,
    (job.status === 'queued' || job.status === 'running') ? el('button', {
      class: 'btn btn--ghost btn--sm bad',
      type: 'button',
      onclick: () => cancelJob(ctx, job.id),
    }, 'Cancelar job') : null,
  ]));
}

function formatElapsed(startedAt, completedAt) {
  if (!startedAt) return 'tempo: -';
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'tempo: -';
  const sec = Math.max(0, Math.round((end - start) / 1000));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return min > 0 ? `tempo: ${min}m ${rem}s` : `tempo: ${sec}s`;
}

function jobStatusTone(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'running') return 'warn';
  return 'idle';
}
