import { el, mount, emptyState } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { connectSse, disconnectSse } from '../utils/sse.js';

const UI_LABELS = { ready: 'Pronto', processing: 'Processando', attention: 'Atenção' };
const UI_CLASS = { ready: 'ok', processing: 'warn', attention: 'warn' };

const dataStyles = `
  .coverage-years-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-top: 16px;
  }

  .coverage-year-group {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: rgba(22, 28, 45, 0.15);
    overflow: hidden;
  }

  .coverage-year-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: rgba(255, 255, 255, 0.02);
    border: none;
    border-bottom: 1px solid var(--border);
    padding: 12px 18px;
    color: var(--text-0);
    font-weight: 700;
    font-size: 13.5px;
    cursor: pointer;
    transition: background-color 0.2s ease;
    outline: none;
    text-align: left;
  }
  .coverage-year-header:hover {
    background: var(--bg-hover);
  }
  
  .coverage-year-header.is-collapsed {
    border-bottom: none;
  }

  .coverage-year-header__chevron {
    font-size: 11px;
    transition: transform 0.2s ease;
    color: var(--text-3);
  }
  
  .coverage-year-header.is-collapsed .coverage-year-header__chevron {
    transform: rotate(-90deg);
  }

  .coverage-year-content {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 16px;
  }

  .coverage-month {
    background: rgba(22, 28, 45, 0.4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    min-width: 196px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: var(--shadow-1);
  }

  .coverage-month__header {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-0);
    margin-bottom: 8px;
    text-align: center;
    text-transform: capitalize;
  }

  .coverage-month__weekdays {
    display: grid;
    grid-template-columns: repeat(7, 22px);
    gap: 4px;
    margin-bottom: 6px;
    text-align: center;
    font-size: 9px;
    font-weight: 700;
    color: var(--text-3);
    text-transform: uppercase;
  }

  .coverage-month__days {
    display: grid;
    grid-template-columns: repeat(7, 22px);
    grid-auto-rows: 22px;
    gap: 4px;
  }

  .coverage-day {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 10px;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
    cursor: pointer;
    transition: transform 0.1s ease, border-color 0.1s ease, background-color 0.1s ease;
    user-select: none;
    padding: 0;
  }

  .coverage-day--empty {
    background: rgba(255, 255, 255, 0.015);
    border-color: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.15);
    cursor: default;
  }
  .coverage-day--empty:hover {
    transform: none;
    border-color: rgba(255, 255, 255, 0.03);
  }

  .quality-hours {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 12px 0;
  }

  .quality-hour {
    min-width: 42px;
    padding: 4px 6px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.03);
    font-size: 11px;
    cursor: pointer;
    text-align: center;
  }

  .quality-hour--kept { border-color: rgba(80, 200, 120, 0.35); }
  .quality-hour--trim { border-color: rgba(240, 180, 60, 0.45); }
  .quality-hour--omit { border-color: rgba(240, 90, 90, 0.5); }
  .quality-hour--manual { border-color: rgba(140, 160, 255, 0.55); }
  .quality-hour.is-active { outline: 2px solid var(--accent); }

  .data-event-row--excluded { opacity: 0.72; }

  .coverage-day--ready {
    background: rgba(16, 185, 129, 0.2);
    border-color: rgba(16, 185, 129, 0.35);
    color: var(--ok);
  }
  .coverage-day--ready:hover {
    background: rgba(16, 185, 129, 0.3);
    border-color: var(--ok);
    transform: translateY(-1px);
  }

  .coverage-day--processing {
    background: rgba(245, 158, 11, 0.15);
    border-color: rgba(245, 158, 11, 0.3);
    color: var(--warn);
  }
  .coverage-day--processing:hover {
    background: rgba(245, 158, 11, 0.25);
    border-color: var(--warn);
    transform: translateY(-1px);
  }

  .coverage-day--attention {
    background: rgba(239, 68, 68, 0.15);
    border-color: rgba(239, 68, 68, 0.3);
    color: var(--err);
  }
  .coverage-day--attention:hover {
    background: rgba(239, 68, 68, 0.25);
    border-color: var(--err);
    transform: translateY(-1px);
  }

  .coverage-day__pad {
    width: 22px;
    height: 22px;
  }

  .coverage-day.is-out-of-range {
    opacity: 0.35;
    border-style: dotted;
    filter: saturate(0.6);
  }
  .coverage-day.is-out-of-range:hover {
    opacity: 0.75;
    filter: none;
  }
  .coverage-day.is-selected {
    box-shadow: 0 0 0 1px var(--accent);
  }
`;

let sseHandler = null;
let latestJobs = [];

export async function renderData(ctx) {
  ctx.setBreadcrumb('data', 'Dados');
  ctx.renderContextBar?.();

  // Injetar a tag de estilos para os mini-calendários se ainda não foi criada
  if (!document.getElementById('data-custom-styles')) {
    const styleEl = el('style', { id: 'data-custom-styles' }, dataStyles);
    document.head.appendChild(styleEl);
  }

  const fallbackCtx = loadContext();
  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Dados'),
        el('p', { class: 'page-header__sub' }, 'Cobertura do lakehouse, preparação e jobs em um só lugar.'),
      ]),
    ]),
    el('section', { class: 'card', id: 'data-coverage-section' }, el('p', { class: 'muted' }, 'Carregando cobertura…')),
    el('section', { class: 'card', id: 'data-actions-section' }),
    el('section', { class: 'card', id: 'data-jobs-section' }, el('p', { class: 'muted' }, 'Carregando jobs…')),
    el('div', { class: 'data-partition-drawer', id: 'data-partition-drawer', hidden: true }),
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
    el('h2', { class: 'card__title' }, 'Preparar período'),
    el('form', { id: 'data-prepare-form', class: 'studio-form' }, [
      el('label', { class: 'field' }, ['De ', el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Até ', el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Ativo ', selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying)]),
      el('label', { class: 'field' }, ['Intervalo ', selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval)]),
      el('label', { class: 'field' }, ['Book ', selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth)]),
      el('label', { class: 'field field--checkbox' }, [
        el('input', { type: 'checkbox', name: 'rebuild', value: '1' }),
        ' Incluir dias já prontos (reprocessar inteiro)',
      ]),
      el('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 8px' } },
        'Sempre reprocessa dias inteiros. Para um evento específico, use Excluir/Restaurar no calendário.'
      ),
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Preparar período'),
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
          'Exibindo todas as partições do banco de dados para a configuração selecionada. Os dias fora do período ativo do formulário abaixo aparecem esmaecidos.'
        ),
      ]),
      el('div', { class: 'row row--wrap' }, [
        legendChip('ready', coverage.summary?.ready ?? 0),
        legendChip('processing', coverage.summary?.processing ?? 0),
        legendChip('attention', coverage.summary?.attention ?? 0),
      ]),
    ]),
    renderMonthlyHeatmap(ctx, coverage)
  ]));
}

function legendChip(state, count) {
  return el('span', { class: `badge badge--${UI_CLASS[state]}` }, `${UI_LABELS[state]}: ${count}`);
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

  const selectedFrom = new Date(coverage.from);
  const selectedTo = new Date(coverage.to);

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
          const isSelected = dtDate >= selectedFrom && dtDate < selectedTo;
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
  const hourButtons = (eventPayload.hours || []).map((bucket) => el('button', {
    type: 'button',
    class: `quality-hour quality-hour--${hourTone(bucket)}${selectedHour === bucket.hour ? ' is-active' : ''}`,
    title: `${bucket.total} evento(s) · omit: ${bucket.omitted} · trim: ${bucket.trimmed} · manual: ${bucket.manual}`,
    onclick: () => {
      const drawer = document.getElementById('data-partition-drawer');
      mount(drawer, buildPartitionDrawer(ctx, day, eventPayload, ctxSaved, selectedHour === bucket.hour ? null : bucket.hour, fieldOptions));
    },
  }, `${bucket.hour}h`));

  return el('div', { class: 'card' }, [
    el('header', { class: 'card__header' }, [
      el('h3', {}, day.dt),
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { document.getElementById('data-partition-drawer').hidden = true; } }, 'Fechar'),
    ]),
    el('p', {}, `Estado UI: ${UI_LABELS[day.ui_state]} · status bruto: ${day.raw_status}`),
    el('p', { class: 'muted', style: { fontSize: '12px' } },
      `Configuração: ${ctxSaved.underlying} · ${ctxSaved.interval} · book ${ctxSaved.book_depth} · reprocessamento sempre do dia inteiro`
    ),
    ...(day.partitions || []).flatMap((p) => {
      const norm = p.quality_details?.normalization;
      if (!norm?.applied && !(eventPayload.exclusions || []).length) return [];
      const hours = (norm?.hours_affected || []).map((entry) => `${entry.hour}h (${entry.events})`).join(', ');
      return [el('p', { class: 'data-normalization-summary' },
        `Normalização: ${norm?.events_omitted ?? 0} omitido(s), ${norm?.events_trimmed ?? 0} aparado(s), ${norm?.events_manual_omitted ?? 0} manual(is)${hours ? ` · horas: ${hours}` : ''}`)];
    }),
    hourButtons.length ? el('div', { class: 'quality-hours' }, [
      el('span', { class: 'muted', style: { fontSize: '11px', alignSelf: 'center', marginRight: '4px' } }, 'Filtrar hora:'),
      el('button', {
        type: 'button',
        class: `quality-hour${selectedHour == null ? ' is-active' : ''}`,
        onclick: () => {
          const drawer = document.getElementById('data-partition-drawer');
          mount(drawer, buildPartitionDrawer(ctx, day, eventPayload, ctxSaved, null, fieldOptions));
        },
      }, 'Todas'),
      ...hourButtons,
    ]) : null,
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'table table--compact' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Hora'),
          el('th', {}, 'Status'),
          el('th', {}, 'Cobertura'),
          el('th', {}, 'Evento'),
          el('th', {}, ''),
        ])),
        el('tbody', {}, events.map((event) => {
          const excluded = event.manually_excluded;
          return el('tr', { class: excluded ? 'data-event-row--excluded' : '' }, [
            el('td', {}, formatEventTime(event.event_start)),
            el('td', {}, eventStatusLabel(event)),
            el('td', {}, event.coverage != null ? `${Math.round(event.coverage * 100)}%` : '—'),
            el('td', { title: event.condition_id }, shortConditionId(event.condition_id)),
            el('td', {}, el('button', {
              type: 'button',
              class: `btn btn--ghost btn--sm${excluded ? '' : ' btn--danger'}`,
              onclick: async () => {
                const ok = await setEventExclusion(ctx, day, event, eventPayload.market_id, excluded);
                if (!ok) return;
                await openPartitionDrawer(ctx, day);
                refreshJobs(ctx);
              },
            }, excluded ? 'Restaurar' : 'Excluir')),
          ]);
        })),
      ]),
    ]),
    el('div', { class: 'row row--wrap', style: { gap: '8px', marginTop: '12px' } }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        disabled: day.ui_state === 'processing',
        onclick: async () => {
          const ok = await reprocessDay(ctx, day, ctxSaved, { fieldOptions });
          if (ok) await openPartitionDrawer(ctx, day, fieldOptions);
        },
      }, day.ui_state === 'processing' ? 'Processando…' : 'Reprocessar dia'),
    ]),
  ]);
}

async function openPartitionDrawer(ctx, day, fieldOptions = null) {
  const drawer = document.getElementById('data-partition-drawer');
  if (!drawer) return;
  drawer.hidden = false;
  const ctxSaved = loadContext();
  applyDayToPrepareForm(day, ctxSaved);
  mount(drawer, el('div', { class: 'card' }, [el('p', { class: 'muted' }, 'Carregando eventos do dia…')]));

  const query = new URLSearchParams({
    dt: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
  });
  const res = await ctx.api.get(`/api/quality/day-events?${query.toString()}`);
  if (!res.ok) {
    mount(drawer, el('div', { class: 'card' }, [
      el('p', {}, `Falha ao carregar eventos: ${res.error?.message || 'erro desconhecido'}`),
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
