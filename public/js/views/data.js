import { el, mount, emptyState } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { connectSse, disconnectSse } from '../utils/sse.js';

const UI_LABELS = { ready: 'Pronto', processing: 'Processando', attention: 'Atenção' };
const UI_CLASS = { ready: 'ok', processing: 'warn', attention: 'err' };

const dataStyles = `
  .data-dashboard-grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 24px;
    align-items: start;
    margin-top: 16px;
  }
  @media (max-width: 1100px) {
    .data-dashboard-grid {
      grid-template-columns: 1fr;
    }
  }

  .data-sidebar-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    position: sticky;
    top: 80px;
  }

  .studio-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .studio-form label.field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-weight: 500;
    font-size: 12.5px;
    color: var(--text-2);
  }

  .data-prepare-footer {
    margin-top: 10px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .data-jobs-inline {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 8px;
  }

  .data-job-card {
    background: rgba(30, 41, 59, 0.45);
    border: 1px solid rgba(245, 158, 11, 0.2);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
    overflow: hidden;
    transition: all 0.25s ease;
  }

  .data-job-card::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--warn);
  }

  .data-job-card:hover {
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(30, 41, 59, 0.6);
  }

  .studio-progress-bar {
    height: 6px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 99px;
    overflow: hidden;
    position: relative;
  }

  .studio-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--warn), #fbbf24);
    border-radius: 99px;
    display: block;
    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    box-shadow: 0 0 8px var(--warn-glow);
  }

  .studio-progress-fill::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.25),
      transparent
    );
    animation: progress-shine 1.5s infinite linear;
  }

  @keyframes progress-shine {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  .coverage-years-container {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-top: 12px;
  }

  .coverage-year-group {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: rgba(13, 19, 32, 0.35);
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.02);
    overflow: hidden;
    transition: border-color 0.2s ease;
  }

  .coverage-year-group:hover {
    border-color: rgba(249, 115, 22, 0.2);
  }

  .coverage-year-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: rgba(255, 255, 255, 0.015);
    border: none;
    border-bottom: 1px solid var(--border);
    padding: 14px 20px;
    color: var(--text-0);
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    transition: background-color 0.2s ease;
    outline: none;
    text-align: left;
  }

  .coverage-year-header:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .coverage-year-header.is-collapsed {
    border-bottom: none;
  }

  .coverage-year-header__chevron {
    font-size: 11px;
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    color: var(--text-3);
  }

  .coverage-year-header.is-collapsed .coverage-year-header__chevron {
    transform: rotate(-90deg);
  }

  .coverage-year-content {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 20px;
    padding: 20px;
    background: rgba(7, 10, 16, 0.2);
  }

  .coverage-month {
    background: rgba(17, 24, 39, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.03);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(4px);
    display: flex;
    flex-direction: column;
    align-items: center;
    transition: border-color 0.2s ease, transform 0.2s ease;
  }

  .coverage-month:hover {
    border-color: rgba(255, 255, 255, 0.08);
    transform: translateY(-1px);
  }

  .coverage-month__header {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text-0);
    margin-bottom: 12px;
    text-align: center;
    text-transform: capitalize;
    letter-spacing: 0.02em;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    width: 100%;
    padding-bottom: 6px;
  }

  .coverage-month__weekdays {
    display: grid;
    grid-template-columns: repeat(7, 22px);
    gap: 6px;
    margin-bottom: 8px;
    text-align: center;
    font-size: 9.5px;
    font-weight: 800;
    color: var(--text-3);
    opacity: 0.6;
    text-transform: uppercase;
  }

  .coverage-month__days {
    display: grid;
    grid-template-columns: repeat(7, 22px);
    grid-auto-rows: 22px;
    gap: 6px;
  }

  .coverage-day {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.04);
    font-size: 10px;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    user-select: none;
    padding: 0;
  }

  .coverage-day--empty {
    background: rgba(255, 255, 255, 0.01);
    border-color: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.12);
    cursor: default;
  }

  .coverage-day--empty:hover {
    transform: none;
  }

  .coverage-day--ready {
    background: rgba(16, 185, 129, 0.12);
    border-color: rgba(16, 185, 129, 0.35);
    color: #34d399;
  }

  .coverage-day--ready:hover {
    background: rgba(16, 185, 129, 0.25);
    border-color: #10b981;
    box-shadow: 0 0 10px rgba(16, 185, 129, 0.35);
    transform: scale(1.15) translateY(-1px);
    z-index: 2;
  }

  .coverage-day--processing {
    background: rgba(245, 158, 11, 0.12);
    border-color: rgba(245, 158, 11, 0.35);
    color: #fbbf24;
    animation: day-pulse 2s infinite ease-in-out;
  }

  .coverage-day--processing:hover {
    background: rgba(245, 158, 11, 0.25);
    border-color: #f59e0b;
    box-shadow: 0 0 10px rgba(245, 158, 11, 0.35);
    transform: scale(1.15) translateY(-1px);
    z-index: 2;
  }

  .coverage-day--attention {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.35);
    color: #f87171;
  }

  .coverage-day--attention:hover {
    background: rgba(239, 68, 68, 0.25);
    border-color: #ef4444;
    box-shadow: 0 0 10px rgba(239, 68, 68, 0.35);
    transform: scale(1.15) translateY(-1px);
    z-index: 2;
  }

  @keyframes day-pulse {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 0.5; }
  }

  .coverage-day__pad {
    width: 22px;
    height: 22px;
  }

  .coverage-day.is-out-of-range {
    opacity: 0.25;
    border-style: dotted;
    filter: saturate(0.4);
  }

  .coverage-day.is-out-of-range:hover {
    opacity: 0.65;
    filter: none;
  }

  .coverage-day.is-selected {
    box-shadow: 0 0 0 2px var(--accent);
    border-color: var(--accent) !important;
    transform: scale(1.1) translateY(-1px);
    z-index: 2;
  }

  /* Overlay de fundo */
  .drawer-overlay {
    position: fixed;
    inset: 0;
    background: rgba(7, 10, 16, 0.5);
    backdrop-filter: blur(4px);
    z-index: 1000;
    opacity: 0;
    transition: opacity 0.3s ease;
    pointer-events: none;
  }
  .drawer-overlay.is-active {
    opacity: 1;
    pointer-events: auto;
  }

  /* Drawer Lateral Deslizante */
  .data-partition-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 480px;
    max-width: 90vw;
    background: rgba(15, 23, 42, 0.82);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: -10px 0 40px rgba(0, 0, 0, 0.6);
    z-index: 1001;
    display: flex !important;
    flex-direction: column;
    transform: translateX(100%);
    visibility: hidden;
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), visibility 0.3s;
    padding: 0;
    overflow: hidden;
  }
  .data-partition-drawer.is-open {
    transform: translateX(0);
    visibility: visible;
  }
  .data-partition-drawer__panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
  }
  .data-partition-drawer__header {
    padding: 20px 24px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(255, 255, 255, 0.01);
  }
  .data-partition-drawer__title {
    font-size: 18px;
    font-weight: 800;
    color: var(--text-0);
    margin: 0;
    letter-spacing: -0.01em;
  }
  .data-partition-drawer__body {
    padding: 24px;
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .data-partition-drawer__footer {
    padding: 20px 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(7, 10, 16, 0.3);
    display: flex;
    gap: 12px;
  }

  /* Normalização em Grid de mini cards */
  .normalization-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 4px;
  }
  .normalization-item {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: var(--radius-sm);
    padding: 10px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .normalization-item__value {
    font-size: 16px;
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .normalization-item__value--omit { color: var(--err); }
  .normalization-item__value--trim { color: var(--warn); }
  .normalization-item__value--manual { color: #818cf8; }
  .normalization-item__label {
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    font-weight: 600;
  }

  /* Timeline Horizontal para horas */
  .quality-hours-timeline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(255, 255, 255, 0.01);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: var(--radius-sm);
    padding: 12px;
  }
  .quality-hours-timeline__title {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .quality-hours-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .quality-hour-chip {
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    font-size: 11px;
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-2);
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    gap: 5px;
    border-style: solid;
  }
  .quality-hour-chip:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .quality-hour-chip.is-active {
    background: rgba(249, 115, 22, 0.15);
    border-color: var(--accent);
    color: var(--accent);
  }
  .quality-hour-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .quality-hour-indicator--kept { background: var(--ok); }
  .quality-hour-indicator--trim { background: var(--warn); }
  .quality-hour-indicator--omit { background: var(--err); }
  .quality-hour-indicator--manual { background: #818cf8; }

  /* Detalhes de Eventos com Visual Glassmorphic */
  .events-timeline {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .event-timeline-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    transition: all 0.2s ease;
  }
  .event-timeline-card:hover {
    border-color: rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
  }
  .event-timeline-card--excluded {
    opacity: 0.45;
    border-style: dashed;
    background: rgba(0, 0, 0, 0.1);
  }
  .event-info-left {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .event-time-badge {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent);
    font-family: var(--font-mono);
  }
  .event-desc {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-1);
    word-break: break-all;
  }
  .event-meta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 2px;
  }
  .event-badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .event-badge--ok { background: rgba(16, 185, 129, 0.1); color: var(--ok); }
  .event-badge--omit { background: rgba(239, 68, 68, 0.1); color: var(--err); }
  .event-badge--trim { background: rgba(245, 158, 11, 0.1); color: var(--warn); }
  .event-badge--manual { background: rgba(129, 140, 248, 0.1); color: #818cf8; }
  .event-coverage-text {
    font-size: 11px;
    color: var(--text-3);
    font-family: var(--font-mono);
  }
`;

let sseHandler = null;
let latestJobs = [];

export function closeDrawer() {
  const drawer = document.getElementById('data-partition-drawer');
  const overlay = document.getElementById('data-drawer-overlay');
  if (drawer) drawer.classList.remove('is-open');
  if (overlay) overlay.classList.remove('is-active');
  document.querySelectorAll('.coverage-day.is-selected').forEach(el => el.classList.remove('is-selected'));
}

export function buildPartitionDrawerLoading(day) {
  return el('div', { class: 'data-partition-drawer__panel' }, [
    el('header', { class: 'data-partition-drawer__header' }, [
      el('div', {}, [
        el('h3', { class: 'data-partition-drawer__title' }, day.dt),
        el('p', { class: 'muted', style: { fontSize: '11px', margin: '4px 0 0' } }, 'Carregando…')
      ]),
      el('button', { type: 'button', class: 'btn btn--ghost btn--sm btn--icon', onclick: closeDrawer }, [
        el('i', { class: 'fa-solid fa-xmark' })
      ]),
    ]),
    el('div', { class: 'data-partition-drawer__body', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px' } }, [
      el('span', { class: 'muted' }, 'Carregando eventos do dia…')
    ])
  ]);
}

export async function renderData(ctx) {
  ctx.setBreadcrumb('data', 'Dados');
  ctx.renderContextBar?.();

  // Injetar a tag de estilos para os mini-calendários se ainda não foi criada
  if (!document.getElementById('data-custom-styles')) {
    const styleEl = el('style', { id: 'data-custom-styles' }, dataStyles);
    document.head.appendChild(styleEl);
  }

  // Criar overlay do drawer se não existir no body
  let overlay = document.getElementById('data-drawer-overlay');
  if (!overlay) {
    overlay = el('div', { id: 'data-drawer-overlay', class: 'drawer-overlay', onclick: closeDrawer });
    document.body.appendChild(overlay);
  }

  const fallbackCtx = loadContext();
  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Dados'),
        el('p', { class: 'page-header__sub' }, 'Cobertura do lakehouse, preparação e jobs em um só lugar.'),
      ]),
    ]),
    
    // Grid de duas colunas
    el('div', { class: 'data-dashboard-grid' }, [
      // Coluna lateral esquerda (Ações e Jobs)
      el('div', { class: 'data-sidebar-panel' }, [
        el('section', { class: 'card', id: 'data-actions-section' }),
        el('section', { class: 'card', id: 'data-jobs-section' }, el('p', { class: 'muted' }, 'Carregando jobs…')),
      ]),
      // Coluna principal direita (Heatmap / Cobertura)
      el('div', { class: 'data-main-panel' }, [
        el('section', { class: 'card', id: 'data-coverage-section', style: { margin: '0' } }, el('p', { class: 'muted' }, 'Carregando cobertura…')),
      ])
    ]),
    
    // Drawer deslizante lateral
    el('div', { class: 'data-partition-drawer', id: 'data-partition-drawer' }),
  ]);

  renderActions(ctx, fallbackCtx, contextBarOptions({}));
  bindJobsSse(ctx);
  void refreshJobs(ctx);

  const apiOptions = await fetchContextOptionsCached(ctx.api);
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(fallbackCtx, fieldOptions);
  renderActions(ctx, formCtx, fieldOptions);
  await refreshCoverage(ctx, formCtx);
}

function dataFormFromDom() {
  const form = document.getElementById('data-prepare-form');
  if (!form) return loadContext();
  const fd = new FormData(form);
  return {
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: fd.get('book_depth'),
  };
}

function applyDayToPrepareForm(day, ctxSaved) {
  const form = document.getElementById('data-prepare-form');
  if (!form) return;
  form.querySelector('[name="from"]').value = day.dt;
  form.querySelector('[name="to"]').value = day.dt;
  saveContext({ ...ctxSaved, from: day.dt, to: day.dt });
}

async function reprocessDay(ctx, day, ctxSaved, { fieldOptions = null } = {}) {
  if (day.ui_state === 'processing') {
    ctx.toast.warn('Este dia já está em processamento — aguarde o job atual.');
    return false;
  }
  const request = {
    from: day.dt,
    to: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
    book_depth: ctxSaved.book_depth,
  };
  const rebuild = day.ui_state === 'ready';
  return submitDataFix(ctx, request, { rebuild, fieldOptions });
}

async function submitDataFix(ctx, request, { rebuild = false, fieldOptions = null } = {}) {
  const payload = {
    ...request,
    dataset: 'backtest_ticks',
    book_depth: Number(request.book_depth),
    ...(rebuild ? { rebuild: true } : {}),
  };
  saveContext(payload);
  const preview = await ctx.api.post('/api/data/fix', { request: payload, dry_run: true });
  if (!preview.ok) {
    ctx.toast.err(preview.error?.message || 'Falha no plano');
    return false;
  }
  const lines = preview.data.summary_lines || [];
  const intro = rebuild
    ? 'Reprocessar dia(s) inteiro(s), incluindo partições já prontas.'
    : 'Preparar / corrigir dia(s) com dados faltando ou inválidos.';
  const msg = lines.length ? lines.join('\n') : (preview.data.summary || intro);
  const confirmMsg = `${intro}\n\n${msg}\n\nConfirmar?`;
  if (!confirm(confirmMsg)) return false;
  const fix = await ctx.api.post('/api/data/fix', {
    request: payload,
    confirm_rebuild: preview.data.needs_rebuild_confirm || rebuild ? true : undefined,
  });
  if (!fix.ok) {
    ctx.toast.err(fix.error?.message || 'Falha');
    return false;
  }
  ctx.toast.ok(fix.data.ready ? 'Dados prontos' : `Job #${fix.data.job?.id} criado`);
  const options = fieldOptions || contextBarOptions(await fetchContextOptionsCached(ctx.api));
  await refreshCoverage(ctx, applyContextOptions(loadContext(), options));
  await refreshJobs(ctx);
  return true;
}

function renderActions(ctx, formCtx, fieldOptions) {
  const section = document.getElementById('data-actions-section');
  if (!section) return;
  mount(section, el('div', {}, [
    el('h2', { class: 'card__title' }, 'Reprocessar período'),
    el('form', { id: 'data-prepare-form', class: 'studio-form' }, [
      el('label', { class: 'field' }, ['De ', el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Até (incluso) ', el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Ativo ', selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying)]),
      el('label', { class: 'field' }, ['Intervalo ', selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval)]),
      el('label', { class: 'field' }, ['Book ', selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth)]),
      el('div', { class: 'data-prepare-footer' }, [
        el('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 8px' } },
          'Prepara o período selecionado, dia a dia.'
        ),
        el('label', { class: 'field field--checkbox' }, [
          el('input', { type: 'checkbox', name: 'rebuild', value: '1' }),
          ' Incluir dias já prontos',
        ]),
        el('button', { class: 'btn btn--primary', type: 'submit' }, 'Executar'),
      ]),
    ]),
  ]));

  const form = document.getElementById('data-prepare-form');
  form?.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('change', () => {
      const current = dataFormFromDom();
      saveContext(current);
      refreshCoverage(ctx, current);
    });
  });

  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const request = {
      from: fd.get('from'),
      to: fd.get('to'),
      underlying: fd.get('underlying'),
      interval: fd.get('interval'),
      book_depth: fd.get('book_depth'),
    };
    await submitDataFix(ctx, request, {
      rebuild: fd.get('rebuild') === '1',
      fieldOptions,
    });
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
  mount(section, el('div', {}, [
    el('div', { class: 'card__header' }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, `Cobertura · ${coverage.underlying} ${coverage.interval}`),
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-3)', marginTop: '4px', maxWidth: '600px', lineHeight: '1.4' } },
          'Exibindo todas as partições do banco de dados para a configuração selecionada. Os dias fora do período ativo do formulário lateral aparecem esmaecidos.'
        ),
      ]),
      el('div', { class: 'row row--wrap', style: { gap: '8px' } }, [
        legendChip('ready', coverage.summary?.ready ?? 0),
        legendChip('processing', coverage.summary?.processing ?? 0),
        legendChip('attention', coverage.summary?.attention ?? 0),
      ]),
    ]),
    renderMonthlyHeatmap(ctx, coverage)
  ]));
}

function legendChip(state, count) {
  const iconClass = state === 'ready' 
    ? 'fa-solid fa-circle-check' 
    : state === 'processing' 
      ? 'fa-solid fa-spinner fa-spin' 
      : 'fa-solid fa-circle-exclamation';
  return el('span', { class: `badge badge--${UI_CLASS[state]}`, style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '30px' } }, [
    el('i', { class: iconClass }),
    `${UI_LABELS[state]}: `,
    el('strong', { style: { marginLeft: '2px', fontFamily: 'var(--font-mono)' } }, String(count))
  ]);
}

// Determina o intervalo de meses que aparecem nas partições de cobertura de dados
function getMonthsRange(days) {
  if (days.length === 0) return [];

  const sortedDts = days.map(d => d.dt).sort();
  const firstDt = sortedDts[0];
  const lastDt = sortedDts[sortedDts.length - 1];

  const minYear = parseInt(firstDt.slice(0, 4), 10);
  const minMonth = parseInt(firstDt.slice(5, 7), 10);
  const maxYear = parseInt(lastDt.slice(0, 4), 10);
  const maxMonth = parseInt(lastDt.slice(5, 7), 10);

  const months = [];
  let currentYear = minYear;
  let currentMonth = minMonth;

  while (currentYear < maxYear || (currentYear === maxYear && currentMonth <= maxMonth)) {
    months.push({ year: currentYear, month: currentMonth });
    currentMonth++;
    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear++;
    }
  }
  return months;
}

// Renderiza a cobertura de dados no formato de mini-calendários agrupados por mês e ano (colapsável)
function renderMonthlyHeatmap(ctx, coverage) {
  const days = coverage.days || [];
  if (days.length === 0) {
    return emptyState('Nenhuma partição no intervalo.');
  }

  const selectedFrom = coverage.from_date || String(coverage.from || '').slice(0, 10);
  const selectedTo = coverage.to_date || String(coverage.from || '').slice(0, 10);

  const monthsRange = getMonthsRange(days);
  
  // Agrupar meses por ano
  const yearsMap = {};
  for (const item of monthsRange) {
    if (!yearsMap[item.year]) {
      yearsMap[item.year] = [];
    }
    yearsMap[item.year].push(item.month);
  }

  // Ordenar os anos de forma decrescente (mais recente primeiro)
  const sortedYears = Object.keys(yearsMap).map(Number).sort((a, b) => b - a);

  const MONTH_NAMES = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];

  return el('div', { class: 'coverage-years-container' }, sortedYears.map((year, yearIndex) => {
    const months = yearsMap[year];
    
    // O primeiro ano (mais recente) inicia aberto, os demais iniciam fechados
    const isOpen = yearIndex === 0;

    const headerChevron = el('span', { class: 'coverage-year-header__chevron' }, '▼');
    const contentEl = el('div', { 
      class: 'coverage-year-content', 
      style: { display: isOpen ? 'flex' : 'none' } 
    }, months.map((month) => {
      // 0 = Domingo, 1 = Segunda, etc.
      const firstDayOfWeek = new Date(year, month - 1, 1).getDay();
      const daysInMonth = new Date(year, month, 0).getDate();
      
      const dayElements = [];
      
      // Adicionar células vazias de alinhamento antes do primeiro dia
      for (let i = 0; i < firstDayOfWeek; i++) {
        dayElements.push(el('div', { class: 'coverage-day__pad' }));
      }
      
      // Adicionar os quadradinhos dos dias
      for (let d = 1; d <= daysInMonth; d++) {
        const dayStr = String(d).padStart(2, '0');
        const monthStr = String(month).padStart(2, '0');
        const dateKey = `${year}-${monthStr}-${dayStr}`;
        
        const dayData = days.find(x => x.dt === dateKey);
        if (dayData) {
          const dtDate = new Date(`${dateKey}T00:00:00.000Z`);
          const isSelected = dateKey >= selectedFrom && dateKey <= selectedTo;
          const rangeClass = isSelected ? 'is-selected' : 'is-out-of-range';
          const titleSuffix = isSelected ? '' : ' (Fora do período selecionado)';

          dayElements.push(el('button', {
            type: 'button',
            class: `coverage-day coverage-day--${dayData.ui_state} ${rangeClass}`,
            title: `${dateKey}: ${UI_LABELS[dayData.ui_state]} (${dayData.raw_status})${titleSuffix}`,
            onclick: () => openPartitionDrawer(ctx, dayData),
          }, String(d)));
        } else {
          dayElements.push(el('div', {
            class: 'coverage-day coverage-day--empty',
            title: `${dateKey}: Sem cobertura de dados`,
          }, String(d)));
        }
      }

      return el('div', { class: 'coverage-month' }, [
        el('div', { class: 'coverage-month__header' }, `${MONTH_NAMES[month]}`),
        el('div', { class: 'coverage-month__weekdays' }, WEEKDAYS.map(w => el('span', {}, w))),
        el('div', { class: 'coverage-month__days' }, dayElements)
      ]);
    }));

    const headerEl = el('button', {
      type: 'button',
      class: `coverage-year-header${isOpen ? '' : ' is-collapsed'}`,
      onclick: (e) => {
        const btn = e.currentTarget;
        const collapsed = btn.classList.toggle('is-collapsed');
        contentEl.style.display = collapsed ? 'none' : 'flex';
      }
    }, [
      el('span', { class: 'coverage-year-header__title' }, `Ano de ${year} (${months.length} ${months.length === 1 ? 'mês' : 'meses'} com cobertura)`),
      headerChevron
    ]);

    return el('div', { class: 'coverage-year-group' }, [
      headerEl,
      contentEl
    ]);
  }));
}

function formatEventTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function shortConditionId(value) {
  const text = String(value || '');
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

function hourTone(bucket) {
  if (bucket.manual > 0) return 'manual';
  if (bucket.omitted > 0) return 'omit';
  if (bucket.trimmed > 0) return 'trim';
  return 'kept';
}

function eventStatusLabel(event) {
  if (event.manually_excluded) return 'manual';
  if (event.normalization_action === 'omit') return 'auto omit';
  if (event.normalization_action === 'trim') return 'auto trim';
  return 'ok';
}

async function setEventExclusion(ctx, day, eventData, marketId, excluded) {
  const ctxSaved = loadContext();
  const endpoint = excluded ? '/api/quality/restore' : '/api/quality/exclude';
  const body = {
    dt: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
    book_depth: Number(ctxSaved.book_depth),
    market_id: marketId,
    condition_id: eventData.condition_id,
    event_start: eventData.event_start,
  };
  const res = await ctx.api.post(endpoint, body);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao atualizar exclusão');
    return false;
  }
  ctx.toast.ok(excluded ? 'Evento restaurado — re-sync enfileirado' : 'Evento excluído — re-sync enfileirado');
  return true;
}

function buildPartitionDrawer(ctx, day, eventPayload, ctxSaved, selectedHour = null, fieldOptions = null) {
  const events = (eventPayload.events || []).filter((event) => selectedHour == null || event.hour_utc === selectedHour);
  
  // Calcular totais de normalização para os mini cards
  const norm = day.partitions?.[0]?.quality_details?.normalization;
  const countOmitted = norm?.events_omitted ?? 0;
  const countTrimmed = norm?.events_trimmed ?? 0;
  const countManual = norm?.events_manual_omitted ?? (eventPayload.exclusions || []).length;

  const hourButtons = (eventPayload.hours || []).map((bucket) => {
    return el('button', {
      type: 'button',
      class: `quality-hour-chip${selectedHour === bucket.hour ? ' is-active' : ''}`,
      title: `${bucket.total} evento(s) · omit: ${bucket.omitted} · trim: ${bucket.trimmed} · manual: ${bucket.manual}`,
      onclick: () => {
        const drawer = document.getElementById('data-partition-drawer');
        mount(drawer, buildPartitionDrawer(ctx, day, eventPayload, ctxSaved, selectedHour === bucket.hour ? null : bucket.hour, fieldOptions));
      },
    }, [
      el('span', { class: `quality-hour-indicator quality-hour-indicator--${hourTone(bucket)}` }),
      `${bucket.hour}h`
    ]);
  });

  return el('div', { class: 'data-partition-drawer__panel' }, [
    // Header
    el('header', { class: 'data-partition-drawer__header' }, [
      el('div', {}, [
        el('h3', { class: 'data-partition-drawer__title' }, day.dt),
        el('p', { class: 'muted', style: { fontSize: '11px', margin: '4px 0 0' } }, `Status: ${day.raw_status}`)
      ]),
      el('button', { type: 'button', class: 'btn btn--ghost btn--sm btn--icon', onclick: closeDrawer }, [
        el('i', { class: 'fa-solid fa-xmark' })
      ]),
    ]),
    
    // Body
    el('div', { class: 'data-partition-drawer__body' }, [
      // Configuração rápida
      el('div', { style: { background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)', fontSize: '12.5px' } }, [
        el('strong', { style: { color: 'var(--text-0)' } }, 'Configuração ativa: '),
        el('span', { class: 'muted' }, `${ctxSaved.underlying} · ${ctxSaved.interval} · book depth ${ctxSaved.book_depth}`)
      ]),

      // Cards de resumo de normalização
      el('div', { class: 'normalization-grid' }, [
        el('div', { class: 'normalization-item' }, [
          el('span', { class: 'normalization-item__value normalization-item__value--omit' }, String(countOmitted)),
          el('span', { class: 'normalization-item__label' }, 'Omitidos')
        ]),
        el('div', { class: 'normalization-item' }, [
          el('span', { class: 'normalization-item__value normalization-item__value--trim' }, String(countTrimmed)),
          el('span', { class: 'normalization-item__label' }, 'Aparados')
        ]),
        el('div', { class: 'normalization-item' }, [
          el('span', { class: 'normalization-item__value normalization-item__value--manual' }, String(countManual)),
          el('span', { class: 'normalization-item__label' }, 'Manuais')
        ]),
      ]),

      // Timeline de Horas
      hourButtons.length ? el('div', { class: 'quality-hours-timeline' }, [
        el('div', { class: 'quality-hours-timeline__title' }, 'Filtrar por Hora'),
        el('div', { class: 'quality-hours-grid' }, [
          el('button', {
            type: 'button',
            class: `quality-hour-chip${selectedHour == null ? ' is-active' : ''}`,
            onclick: () => {
              const drawer = document.getElementById('data-partition-drawer');
              mount(drawer, buildPartitionDrawer(ctx, day, eventPayload, ctxSaved, null, fieldOptions));
            },
          }, 'Todas'),
          ...hourButtons,
        ])
      ]) : null,

      // Lista de eventos
      el('div', { class: 'events-timeline' }, [
        el('h4', { style: { fontSize: '13px', fontWeight: '700', color: 'var(--text-0)', margin: '8px 0 4px' } }, `Eventos (${events.length})`),
        events.length ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, events.map((event) => {
          const excluded = event.manually_excluded;
          const tone = eventStatusLabel(event);
          return el('div', { class: `event-timeline-card${excluded ? ' event-timeline-card--excluded' : ''}` }, [
            el('div', { class: 'event-info-left' }, [
              el('span', { class: 'event-time-badge' }, formatEventTime(event.event_start)),
              el('span', { class: 'event-desc' }, shortConditionId(event.condition_id)),
              el('div', { class: 'event-meta-row' }, [
                el('span', { class: `event-badge event-badge--${tone}` }, eventStatusLabel(event)),
                event.coverage != null ? el('span', { class: 'event-coverage-text' }, `Cob: ${Math.round(event.coverage * 100)}%`) : null
              ])
            ]),
            el('button', {
              type: 'button',
              class: `btn btn--ghost btn--sm${excluded ? '' : ' btn--danger'}`,
              style: { padding: '6px 10px', fontSize: '11px' },
              onclick: async () => {
                const ok = await setEventExclusion(ctx, day, event, eventPayload.market_id, excluded);
                if (!ok) return;
                await openPartitionDrawer(ctx, day);
                refreshJobs(ctx);
              },
            }, excluded ? 'Restaurar' : 'Excluir')
          ]);
        })) : el('p', { class: 'muted', style: { textAlign: 'center', padding: '20px 0' } }, 'Nenhum evento registrado nesta hora.')
      ])
    ]),
    
    // Footer
    el('footer', { class: 'data-partition-drawer__footer' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        style: { flex: '1' },
        disabled: day.ui_state === 'processing',
        onclick: async () => {
          const ok = await reprocessDay(ctx, day, ctxSaved, { fieldOptions });
          if (ok) await openPartitionDrawer(ctx, day, fieldOptions);
        },
      }, day.ui_state === 'processing' ? 'Processando…' : 'Reprocessar Dia'),
    ]),
  ]);
}

async function openPartitionDrawer(ctx, day, fieldOptions = null) {
  const drawer = document.getElementById('data-partition-drawer');
  const overlay = document.getElementById('data-drawer-overlay');
  if (!drawer) return;
  
  // Destacar o dia selecionado no calendário
  document.querySelectorAll('.coverage-day.is-selected').forEach(el => el.classList.remove('is-selected'));
  const targetDayEl = document.querySelector(`.coverage-day[title*="${day.dt}:"]`);
  if (targetDayEl) targetDayEl.classList.add('is-selected');

  drawer.classList.add('is-open');
  if (overlay) overlay.classList.add('is-active');
  
  const ctxSaved = loadContext();
  applyDayToPrepareForm(day, ctxSaved);
  mount(drawer, buildPartitionDrawerLoading(day));

  const query = new URLSearchParams({
    dt: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
  });
  const res = await ctx.api.get(`/api/quality/day-events?${query.toString()}`);
  if (!res.ok) {
    mount(drawer, el('div', { class: 'data-partition-drawer__panel' }, [
      el('header', { class: 'data-partition-drawer__header' }, [
        el('h3', { class: 'data-partition-drawer__title' }, day.dt),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm btn--icon', onclick: closeDrawer }, [
          el('i', { class: 'fa-solid fa-xmark' })
        ]),
      ]),
      el('div', { class: 'data-partition-drawer__body' }, [
        el('p', { class: 'bad' }, `Falha ao carregar eventos: ${res.error?.message || 'erro desconhecido'}`)
      ])
    ]));
    return;
  }
  mount(drawer, buildPartitionDrawer(ctx, day, res.data, ctxSaved, null, fieldOptions));
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
      ctx.toast.ok('Job concluído — cobertura updated');
    }
  };
  connectSse(sseHandler);
}

export function redirectJobsToData() {
  location.hash = '#/data';
}
