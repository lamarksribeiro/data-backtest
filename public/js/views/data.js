import { el, mount, emptyState } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { connectSse, disconnectSse } from '../utils/sse.js';

const UI_LABELS = { ready: 'Pronto', processing: 'Processando', attention: 'Atenção' };
const UI_CLASS = { ready: 'ok', processing: 'warn', attention: 'warn' };

let sseHandler = null;
let latestJobs = [];

export async function renderData(ctx) {
  ctx.setBreadcrumb('data', 'Dados');
  ctx.renderContextBar?.();

  const apiOptions = await fetchContextOptionsCached(ctx.api);
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(loadContext(), fieldOptions);

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Dados'),
        el('p', { class: 'page-header__sub' }, 'Cobertura do lakehouse, preparação e jobs em um só lugar.'),
      ]),
    ]),
    el('section', { class: 'card', id: 'data-coverage-section' }, el('p', { class: 'muted' }, 'Carregando cobertura…')),
    el('section', { class: 'card', id: 'data-actions-section' }),
    el('section', { class: 'card', id: 'data-jobs-section' }),
    el('div', { class: 'data-partition-drawer', id: 'data-partition-drawer', hidden: true }),
  ]);

  renderActions(ctx, formCtx, fieldOptions);
  bindJobsSse(ctx);
  await refreshCoverage(ctx, formCtx);
  await refreshJobs(ctx);
}

function renderActions(ctx, formCtx, fieldOptions) {
  const section = document.getElementById('data-actions-section');
  if (!section) return;
  mount(section, el('div', {}, [
    el('h2', { class: 'card__title' }, 'Preparar período'),
    el('form', { id: 'data-prepare-form', class: 'studio-form' }, [
      el('label', { class: 'field' }, ['De ', el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Até ', el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Ativo ', selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying)]),
      el('label', { class: 'field' }, ['Intervalo ', selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval)]),
      el('label', { class: 'field' }, ['Book ', selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth)]),
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Corrigir / Preparar'),
    ]),
  ]));
  document.getElementById('data-prepare-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const request = {
      dataset: 'backtest_ticks',
      from: fd.get('from'),
      to: fd.get('to'),
      underlying: fd.get('underlying'),
      interval: fd.get('interval'),
      book_depth: Number(fd.get('book_depth')),
    };
    saveContext(request);
    const preview = await ctx.api.post('/api/data/fix', { request, dry_run: true });
    if (!preview.ok) return ctx.toast.err(preview.error?.message || 'Falha no plano');
    const lines = preview.data.summary_lines || [];
    const msg = lines.join('\n') || 'Executar correção?';
    if (!confirm(`${msg}\n\nConfirmar?`)) return;
    const fix = await ctx.api.post('/api/data/fix', {
      request,
      confirm_rebuild: preview.data.needs_rebuild_confirm ? true : undefined,
    });
    if (!fix.ok) return ctx.toast.err(fix.error?.message || 'Falha');
    ctx.toast.ok(fix.data.ready ? 'Dados prontos' : `Job #${fix.data.job?.id} criado`);
    await refreshCoverage(ctx, applyContextOptions(loadContext(), fieldOptions));
    await refreshJobs(ctx);
  });
}

async function refreshCoverage(ctx, formCtx) {
  const q = new URLSearchParams({
    underlying: formCtx.underlying,
    interval: formCtx.interval,
    book_depth: formCtx.book_depth,
    from: formCtx.from,
    to: formCtx.to,
  });
  const res = await ctx.api.get(`/api/data/coverage?${q}`);
  const section = document.getElementById('data-coverage-section');
  if (!section) return;
  if (!res.ok) {
    mount(section, el('p', { class: 'bad' }, res.error?.message || 'Falha'));
    return;
  }
  const { coverage } = res.data;
  const days = coverage.days || [];
  mount(section, el('div', {}, [
    el('div', { class: 'card__header' }, [
      el('h2', { class: 'card__title' }, `Cobertura · ${coverage.underlying} ${coverage.interval}`),
      el('div', { class: 'row row--wrap' }, [
        legendChip('ready', coverage.summary?.ready ?? 0),
        legendChip('processing', coverage.summary?.processing ?? 0),
        legendChip('attention', coverage.summary?.attention ?? 0),
      ]),
    ]),
    days.length
      ? el('div', { class: 'coverage-heatmap' }, days.map((day) => el('button', {
        type: 'button',
        class: `coverage-day coverage-day--${day.ui_state}`,
        title: `${day.dt}: ${UI_LABELS[day.ui_state]} (${day.raw_status})`,
        onclick: () => openPartitionDrawer(ctx, day),
      }, day.dt.slice(8, 10))))
      : emptyState('Nenhuma partição no intervalo.'),
  ]));
}

function legendChip(state, count) {
  return el('span', { class: `badge badge--${UI_CLASS[state]}` }, `${UI_LABELS[state]}: ${count}`);
}

function openPartitionDrawer(ctx, day) {
  const drawer = document.getElementById('data-partition-drawer');
  if (!drawer) return;
  drawer.hidden = false;
  mount(drawer, el('div', { class: 'card' }, [
    el('header', { class: 'card__header' }, [
      el('h3', {}, day.dt),
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { drawer.hidden = true; } }, 'Fechar'),
    ]),
    el('p', {}, `Estado UI: ${UI_LABELS[day.ui_state]} · status bruto: ${day.raw_status}`),
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table table--compact' }, [
        el('thead', {}, el('tr', {}, [el('th', {}, 'Status'), el('th', {}, 'Linhas'), el('th', {}, 'Degradada')])),
        el('tbody', {}, (day.partitions || []).map((p) => el('tr', {}, [
          el('td', {}, p.status),
          el('td', {}, String(p.rows)),
          el('td', {}, p.has_degraded ? 'sim' : 'não'),
        ]))),
      ]),
    ]),
    day.ui_state === 'attention' ? el('button', {
      type: 'button',
      class: 'btn btn--primary btn--sm',
        onclick: async () => {
        const ctxSaved = loadContext();
        const fix = await ctx.api.post('/api/data/fix', {
          request: {
            dataset: 'backtest_ticks',
            from: day.dt,
            to: day.dt,
            underlying: ctxSaved.underlying,
            interval: ctxSaved.interval,
            book_depth: Number(ctxSaved.book_depth),
          },
        });
        ctx.toast.ok(fix.ok ? 'Correção enfileirada' : (fix.error?.message || 'Falha'));
      },
    }, 'Corrigir este dia') : null,
  ]));
}

async function refreshJobs(ctx) {
  const section = document.getElementById('data-jobs-section');
  if (!section) return;
  const res = await ctx.api.get('/api/prepare/jobs?limit=10');
  latestJobs = res.ok ? res.data.jobs || [] : [];
  const active = latestJobs.filter((j) => j.status === 'running' || j.status === 'queued');
  mount(section, el('div', {}, [
    el('h2', { class: 'card__title' }, 'Jobs ativos'),
    active.length
      ? el('div', { class: 'data-jobs-inline' }, active.map((job) => jobCard(job)))
      : el('p', { class: 'muted' }, 'Nenhum job em execução.'),
  ]));
}

function jobCard(job) {
  const pct = job.progress?.partitions_total
    ? Math.round((job.progress.partitions_done / job.progress.partitions_total) * 100)
    : (job.status === 'completed' ? 100 : 5);
  return el('div', { class: 'data-job-card', id: `data-job-${job.id}` }, [
    el('strong', {}, `Job #${job.id}`),
    el('span', { class: 'badge badge--warn' }, job.status),
    el('div', { class: 'studio-progress-bar' }, [
      el('span', { class: 'studio-progress-fill', style: { width: `${pct}%` } }),
    ]),
    el('span', { class: 'muted' }, job.progress?.current?.phase || 'aguardando'),
  ]);
}

function bindJobsSse(ctx) {
  if (sseHandler) disconnectSse(sseHandler);
  sseHandler = (event) => {
    if (!['job:progress', 'job:completed', 'job:failed'].includes(event.type)) return;
    refreshJobs(ctx);
    if (event.type === 'job:completed') {
      const formCtx = loadContext();
      refreshCoverage(ctx, formCtx);
      ctx.toast.ok('Job concluído — cobertura atualizada');
    }
  };
  connectSse(sseHandler);
}

export function redirectJobsToData() {
  location.hash = '#/data';
}
