import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml } from '../utils/format.js';
import { delay } from '../utils/format.js';

let pollToken = 0;
let creepToken = 0;
let initialLoadDone = false;
let expandedJobId = null;
let jobsPanelBuilt = false;
let latestJobs = [];

const PHASE_LABELS = {
  starting: 'Iniciando',
  listing_events: 'Listando eventos',
  counting_ticks: 'Contando ticks',
  fetching_rows: 'Buscando dados',
  writing_parquet: 'Gravando parquet',
  skipped: 'Ignorado',
  done: 'Concluído',
};

/** Fração concluída dentro de uma partição (0–1). */
const PHASE_FRACTION = {
  starting: 0.02,
  listing_events: 0.08,
  counting_ticks: 0.14,
  fetching_rows: 0.2,
  writing_parquet: 0.9,
  done: 1,
  skipped: 1,
};

export async function renderJobs(ctx) {
  ctx.setBreadcrumb('jobs', null);
  ctx.renderContextBar?.();
  initialLoadDone = false;
  jobsPanelBuilt = false;
  expandedJobId = null;
  latestJobs = [];
  pollToken += 1;
  creepToken += 1;

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
  latestJobs = jobs;
  initialLoadDone = true;
  jobsPanelBuilt = true;

  if (!jobs.length) {
    mount(panel, emptyState('Nenhum job de preparação ainda.'));
    return;
  }

  const existingTbody = panel.querySelector('#jobs-table-body');
  if (existingTbody && !force) {
    syncJobsTable(existingTbody, jobs, ctx);
    refreshExpandedJobDetail(ctx, jobs);
  } else {
    renderJobsPanel(panel, jobs, ctx);
  }

  if (jobs.some((j) => j.status === 'queued' || j.status === 'running')) {
    startPolling(ctx);
    startProgressCreep(ctx);
  }
}

function renderJobsPanel(panel, jobs, ctx) {
  const tbody = el('tbody', { id: 'jobs-table-body' });
  for (const job of jobs) tbody.appendChild(jobRow(job, ctx));

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

  refreshExpandedJobDetail(ctx, jobs);
}

function syncJobsTable(tbody, jobs, ctx) {
  const byId = new Map(jobs.map((job) => [String(job.id), job]));
  for (const row of [...tbody.querySelectorAll('tr[data-job-id]')]) {
    const job = byId.get(row.dataset.jobId);
    if (!job) {
      row.remove();
      continue;
    }
    byId.delete(row.dataset.jobId);
    updateJobRow(row, job, ctx);
  }
  for (const job of byId.values()) {
    tbody.appendChild(jobRow(job, ctx));
  }
}

function updateJobRow(row, job, ctx) {
  const isActive = job.status === 'queued' || job.status === 'running';
  row.classList.toggle('jobs-row--active', isActive);

  const statusBadge = row.querySelector('[data-field="status"]');
  if (statusBadge) {
    statusBadge.className = `badge badge--${jobStatusTone(job.status)}`;
    statusBadge.textContent = job.status;
  }

  const progressCell = row.querySelector('[data-field="progress"]');
  if (progressCell) {
    mount(progressCell, isActive ? buildProgressBlock(job) : buildCompletedProgressLabel(job));
  }

  const actionsCell = row.querySelector('[data-field="actions"]');
  if (actionsCell) {
    mount(actionsCell, buildActionButtons(job, ctx));
  }
}

function jobRow(job, ctx) {
  const isActive = job.status === 'queued' || job.status === 'running';

  return el('tr', { class: isActive ? 'jobs-row--active' : '', 'data-job-id': String(job.id) }, [
    el('td', {}, `#${job.id}`),
    el('td', {}, el('span', { class: `badge badge--${jobStatusTone(job.status)}`, 'data-field': 'status' }, job.status)),
    el('td', { class: 'jobs-progress-cell', 'data-field': 'progress' }, isActive
      ? buildProgressBlock(job)
      : buildCompletedProgressLabel(job)),
    el('td', {}, job.dry_run ? 'dry-run' : 'execução'),
    el('td', {}, job.created_at || '-'),
    el('td', { 'data-field': 'actions' }, buildActionButtons(job, ctx)),
  ]);
}

function buildProgressBlock(job) {
  const progressPct = partitionProgressPct(job.progress);
  const progressLabel = progressLabelText(job);
  return el('div', { class: 'jobs-progress-block' }, [
    el('div', { class: 'jobs-progress-block__head' }, [
      el('span', { class: 'jobs-progress-pct' }, `${progressPct}%`),
      el('span', { class: 'jobs-progress-phase muted' }, progressLabel),
    ]),
    el('div', { class: 'live-card__progress-bar' }, [
      el('div', {
        class: 'live-card__progress-fill',
        style: `width:${progressPct}%`,
        'data-progress-fill': '1',
      }),
    ]),
  ]);
}

function buildCompletedProgressLabel(job) {
  const progress = job.progress;
  return el('span', { class: 'muted' }, progress?.files?.length ? `${progress.files.length} arquivo(s)` : '-');
}

function buildActionButtons(job, ctx) {
  const isActive = job.status === 'queued' || job.status === 'running';
  const isExpanded = expandedJobId === job.id;
  return [
    isActive ? el('button', {
      class: 'btn btn--ghost btn--sm bad',
      type: 'button',
      onclick: () => cancelJob(ctx, job.id),
    }, 'Cancelar') : null,
    el('button', {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      'aria-expanded': isExpanded ? 'true' : 'false',
      onclick: () => toggleJobDetail(ctx, job.id, job),
    }, isExpanded ? 'Fechar' : 'Detalhes'),
  ];
}

function partitionProgressPct(progress) {
  if (!progress) return 0;

  const phase = progress.current?.phase;
  const phaseFrac = PHASE_FRACTION[phase] ?? (phase ? 0.05 : 0);

  if (!progress.partitions_total) {
    if (phase === 'fetching_rows') return creepDuringFetch(phaseFrac * 100, progress);
    return Math.round(phaseFrac * 100);
  }

  const total = progress.partitions_total;
  const done = progress.partitions_done || 0;
  let fraction = (done + phaseFrac) / total;

  if (phase === 'fetching_rows') {
    const partitionSpan = 1 / total;
    const fetchStart = (done + PHASE_FRACTION.counting_ticks) / total;
    const fetchEnd = (done + PHASE_FRACTION.writing_parquet) / total;
    const creep = creepDuringFetch(0, progress) * partitionSpan;
    fraction = Math.min(fetchStart + creep, fetchEnd);
  }

  if (progress.status === 'completed' || (done >= total && !phase)) {
    return 100;
  }

  return Math.min(Math.round(fraction * 100), phase === 'done' && done >= total ? 100 : 99);
}

/** Avanço gradual durante fetching_rows (fase longa sem updates do servidor). */
function creepDuringFetch(basePct, progress) {
  const updatedAt = Date.parse(progress.updated_at || progress.started_at || '');
  if (!Number.isFinite(updatedAt)) return basePct;
  const elapsedMs = Date.now() - updatedAt;
  const creepSpan = Math.min(elapsedMs / (4 * 60 * 1000), 1);
  const creepBonus = creepSpan * 55;
  return Math.min(Math.round(basePct + creepBonus), 85);
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

function toggleJobDetail(ctx, id, job) {
  if (expandedJobId === id) {
    expandedJobId = null;
    clearJobDetail();
    const row = document.querySelector(`#jobs-table-body tr[data-job-id="${id}"]`);
    if (row) updateJobRow(row, job, ctx);
    return;
  }
  expandedJobId = id;
  showJobDetail(ctx, id, job);
}

function clearJobDetail() {
  const panel = document.getElementById('job-detail');
  if (panel) mount(panel, []);
}

function refreshExpandedJobDetail(ctx, jobs) {
  if (!expandedJobId) return;
  const job = jobs.find((j) => j.id === expandedJobId);
  if (!job) {
    expandedJobId = null;
    clearJobDetail();
    return;
  }
  const panel = document.getElementById('job-detail');
  const existing = panel?.querySelector(`.jobs-detail[data-job-id="${job.id}"]`);
  if (existing) {
    updateJobDetailInPlace(existing, job);
    return;
  }
  showJobDetail(ctx, job.id, job, { skipFetch: job.status !== 'running' });
}

function updateJobDetailInPlace(root, job) {
  const progress = job.progress;
  const progressPct = partitionProgressPct(progress);
  const pctEl = root.querySelector('.jobs-progress-pct');
  const phaseEl = root.querySelector('.jobs-progress-phase');
  const fill = root.querySelector('[data-progress-fill]');
  if (pctEl) pctEl.textContent = `${progressPct}%`;
  if (phaseEl) phaseEl.textContent = progressLabelText(job);
  if (fill) fill.style.width = `${progressPct}%`;

  const statusLine = root.querySelector('[data-field="status-line"]');
  if (statusLine) {
    statusLine.textContent = `Status: ${job.status} · ${job.dry_run ? 'dry-run' : 'execução real'} · ${formatElapsed(job.started_at, job.completed_at)}`;
  }

  const filesWrap = root.querySelector('[data-field="files"]');
  const files = progress?.files || [];
  if (filesWrap && files.length) {
    const tbody = filesWrap.querySelector('tbody');
    if (tbody) {
      mount(tbody, files.map((file) => el('tr', {}, [
        el('td', {}, escapeHtml(file.dt || '-')),
        el('td', {}, file.rows != null ? String(file.rows) : '-'),
        el('td', {}, escapeHtml(file.status || (file.skipped ? 'skipped' : '-'))),
        el('td', { class: 'mono truncate' }, escapeHtml(file.path || file.reason || '-')),
      ])));
    }
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
      latestJobs = jobs;
      const panel = document.getElementById('jobs-list');
      const tbody = panel?.querySelector('#jobs-table-body');
      if (tbody) {
        syncJobsTable(tbody, jobs, ctx);
        refreshExpandedJobDetail(ctx, jobs);
      }
      if (!jobs.some((j) => j.status === 'queued' || j.status === 'running')) return;
    }
  })();
}

/** Atualiza barras entre polls (fase fetching_rows demora minutos sem novo progress_json). */
function startProgressCreep(ctx) {
  const token = ++creepToken;
  (async () => {
    while (token === creepToken) {
      await delay(1000);
      if (token !== creepToken) return;
      const active = latestJobs.filter((j) => j.status === 'queued' || j.status === 'running');
      if (!active.length) return;

      const tbody = document.getElementById('jobs-table-body');
      for (const job of active) {
        const row = tbody?.querySelector(`tr[data-job-id="${job.id}"]`);
        if (!row) continue;
        const pct = partitionProgressPct(job.progress);
        const fill = row.querySelector('[data-progress-fill]');
        const pctEl = row.querySelector('.jobs-progress-pct');
        if (fill) fill.style.width = `${pct}%`;
        if (pctEl) pctEl.textContent = `${pct}%`;
      }

      if (expandedJobId) {
        const job = latestJobs.find((j) => j.id === expandedJobId);
        if (job?.status === 'running' || job?.status === 'queued') {
          const panel = document.getElementById('job-detail');
          const fill = panel?.querySelector('.jobs-detail__progress [data-progress-fill], .jobs-detail__progress .live-card__progress-fill');
          const pctEl = panel?.querySelector('.jobs-progress-pct');
          const pct = partitionProgressPct(job.progress);
          if (fill) fill.style.width = `${pct}%`;
          if (pctEl) pctEl.textContent = `${pct}%`;
        }
      }
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

async function showJobDetail(ctx, id, cachedJob = null, { skipFetch = false } = {}) {
  const panel = document.getElementById('job-detail');
  if (!panel) return;

  let job = cachedJob;
  if (!skipFetch && (!job || job.status === 'running')) {
    const res = await ctx.api.get(`/api/prepare/jobs/${id}`);
    if (!res.ok) {
      mount(panel, el('p', { class: 'bad' }, res.error?.message || 'Falha'));
      return;
    }
    job = res.data.job;
  }

  const progress = job.progress;
  const progressPct = partitionProgressPct(progress);
  const elapsed = formatElapsed(job.started_at, job.completed_at);
  const files = progress?.files || [];

  mount(panel, el('section', { class: 'card card--nested jobs-detail', 'data-job-id': String(job.id) }, [
    el('div', { class: 'jobs-detail__head' }, [
      el('h3', { class: 'card__title' }, `Job #${job.id}`),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => toggleJobDetail(ctx, job.id, job),
      }, 'Fechar'),
    ]),
    el('p', { 'data-field': 'status-line' }, `Status: ${escapeHtml(job.status)} · ${job.dry_run ? 'dry-run' : 'execução real'} · ${elapsed}`),
    progress ? el('div', { class: 'jobs-detail__progress' }, [
      el('div', { class: 'jobs-progress-block__head' }, [
        el('span', { class: 'jobs-progress-pct jobs-progress-pct--lg' }, `${progressPct}%`),
        el('span', { class: 'jobs-progress-phase muted' }, progressLabelText(job)),
      ]),
      el('div', { class: 'live-card__progress-bar' }, [
        el('div', {
          class: 'live-card__progress-fill',
          'data-progress-fill': '1',
          style: `width:${progressPct}%`,
        }),
      ]),
      progress.current ? el('p', { class: 'muted' }, [
        `Partição atual: dt=${escapeHtml(progress.current.dt || '-')} · `,
        `${PHASE_LABELS[progress.current.phase] || progress.current.phase || '-'}`,
        progress.current.partition_index && progress.partitions_total
          ? ` (${progress.current.partition_index}/${progress.partitions_total})`
          : '',
      ]) : null,
    ]) : null,
    files.length ? el('div', { class: 'jobs-detail__files', 'data-field': 'files' }, [
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
