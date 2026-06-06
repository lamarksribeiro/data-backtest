import { el, mount } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, contextQueryParams, selectField } from '../utils/context.js';
import { escapeHtml, shellQuote } from '../utils/format.js';
import { confirmDialog, promptDialog } from '../utils/confirm.js';

let lastPlan = null;

export async function renderLakehouse(ctx) {
  ctx.setBreadcrumb('data', null);
  ctx.renderContextBar?.();

  const optionsRes = await ctx.api.get('/api/context-options');
  const apiOptions = optionsRes.ok ? (optionsRes.data.options || {}) : {};
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(loadContext(), fieldOptions);
  const underlyingOptions = fieldOptions.underlyings?.length ? fieldOptions.underlyings : [formCtx.underlying];
  const intervalOptions = fieldOptions.intervals?.length ? fieldOptions.intervals : [formCtx.interval];
  const bookDepthOptions = fieldOptions.book_depths?.length ? fieldOptions.book_depths : [formCtx.book_depth];

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Dados'),
        el('p', { class: 'page-header__sub' }, 'Verifique disponibilidade e crie jobs de preparação.'),
      ]),
    ]),
    el('section', { class: 'card' }, [
      el('form', { id: 'lake-form', class: 'form-grid' }, [
        field('Dataset', selectField('dataset', ['backtest_ticks', 'scalars', 'books', 'ohlc'], formCtx.dataset)),
        field('De', el('input', { class: 'field__input', type: 'date', name: 'from', value: formCtx.from, required: true })),
        field('Até', el('input', { class: 'field__input', type: 'date', name: 'to', value: formCtx.to, required: true })),
        field('Ativo', selectField('underlying', underlyingOptions, formCtx.underlying)),
        field('Intervalo', selectField('interval', intervalOptions, formCtx.interval)),
        field('Book depth', selectField('book_depth', bookDepthOptions, formCtx.book_depth), 'field-book-depth'),
        field('Resolução', selectField('resolution', ['1m', '1s', '5s', '5m'], formCtx.resolution), 'field-resolution'),
        el('label', { class: 'switch-field' }, [
          el('input', { class: 'switch-field__input', type: 'checkbox', name: 'dry_run', checked: true }),
          el('span', { class: 'switch-field__slider' }),
          el('span', { class: 'switch-field__label' }, 'Dry-run'),
        ]),
        el('label', { class: 'switch-field' }, [
          el('input', { class: 'switch-field__input', type: 'checkbox', name: 'rebuild' }),
          el('span', { class: 'switch-field__slider' }),
          el('span', { class: 'switch-field__label' }, 'Reprocessar indisponíveis'),
        ]),
        el('div', { class: 'form-actions' }, [
          el('button', { class: 'btn btn--primary', type: 'submit' }, 'Verificar disponibilidade'),
        ]),
      ]),
    ]),
    el('div', { id: 'lake-result' }),
  ]);

  const form = document.getElementById('lake-form');
  const datasetSelect = form.querySelector('[name=dataset]');
  const toggleFields = () => {
    const ds = datasetSelect.value;
    form.querySelector('.field-book-depth').hidden = ds !== 'backtest_ticks';
    form.querySelector('.field-resolution').hidden = ds !== 'ohlc';
  };
  datasetSelect.addEventListener('change', toggleFields);
  toggleFields();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(form);
    const ctxSaved = saveContext({
      dataset: fd.get('dataset'),
      from: fd.get('from'),
      to: fd.get('to'),
      underlying: String(fd.get('underlying')).trim(),
      interval: String(fd.get('interval')).trim(),
      book_depth: fd.get('book_depth'),
      resolution: fd.get('resolution'),
    });
    const params = contextQueryParams(ctxSaved);
    if (fd.get('rebuild') === 'on') params.set('rebuild', 'true');

    const res = await ctx.api.get(`/api/prepare?${params}`);
    const panel = document.getElementById('lake-result');
    if (!res.ok) {
      mount(panel, errorCard(res.error?.message || 'Falha ao consultar'));
      return;
    }
    lastPlan = {
      request: Object.fromEntries(params.entries()),
      dryRun: fd.get('dry_run') === 'on',
      rebuild: fd.get('rebuild') === 'on',
      result: res.data.result,
    };
    renderPlan(panel, lastPlan, ctx);
  });
}

function renderPlan(panel, plan, ctx) {
  const { result } = plan;
  const availability = result.availability;
  mount(panel, [
    el('div', { class: 'grid grid--4' }, [
      stat('Status', result.ready ? 'Pronto' : 'Preparar'),
      stat('Dataset', availability.dataset),
      stat('Partições', availability.expected_partitions.length),
      stat('Válidas', availability.files.length),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Disponibilidade'),
      listBlock('Ausentes', availability.missing),
      listBlock('Indisponíveis', availability.unavailable.map((item) => `${item.dt}: ${item.status}`)),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Plano de preparação'),
      result.preparation.length
        ? el('ol', { class: 'mono-list' }, result.preparation.map((action) => el('li', {}, [
          el('code', {}, `node src/cli.js ${action.command} ${action.args.map(shellQuote).join(' ')}`),
          action.prerequisite ? el('span', { class: 'badge badge--warn' }, 'pré-requisito') : null,
        ])))
        : el('p', { class: 'muted' }, 'Nenhuma ação necessária.'),
      result.preparation.length ? el('button', {
        class: 'btn btn--primary',
        type: 'button',
        onclick: () => runPrepareJob(plan, ctx),
      }, 'Criar job de preparação') : null,
    ]),
  ]);
}

async function runPrepareJob(plan, ctx) {
  const { request, dryRun, rebuild } = plan;
  if (!dryRun) {
    const ok = await confirmDialog({
      title: 'Executar sync real',
      message: 'Executar sync real contra o Postgres do data-colector?',
      tone: 'danger',
      confirmLabel: 'Executar',
    });
    if (!ok) return;
  }
  let confirmRebuild = null;
  if (!dryRun && rebuild) {
    confirmRebuild = await promptDialog({
      title: 'Confirmar rebuild',
      message: 'Digite REBUILD_PARTITIONS para reprocessar partições.',
      placeholder: 'REBUILD_PARTITIONS',
    });
    if (confirmRebuild !== 'REBUILD_PARTITIONS') return;
  }

  const res = await ctx.api.post('/api/prepare/run', {
    request,
    dry_run: dryRun,
    confirm_rebuild: confirmRebuild,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao criar job');
    return;
  }
  ctx.toast.ok(`Job #${res.data.job.id} criado`);
  ctx.navigate('jobs');
}

function field(label, control, extraClass = '') {
  return el('label', { class: `field ${extraClass}`.trim() }, [
    el('span', { class: 'field__label' }, label),
    control,
  ]);
}

function stat(label, value) {
  return el('div', { class: 'stat stat--compact' }, [
    el('span', { class: 'stat__label' }, label),
    el('span', { class: 'stat__value' }, String(value)),
  ]);
}

function listBlock(title, items) {
  if (!items.length) return el('p', {}, [el('strong', {}, `${title}: `), el('span', { class: 'muted' }, 'nenhum')]);
  return el('div', {}, [
    el('strong', {}, title),
    el('ul', {}, items.map((item) => el('li', {}, el('code', {}, item)))),
  ]);
}

function errorCard(message) {
  return el('section', { class: 'card card--error' }, [
    el('h2', { class: 'card__title' }, 'Erro'),
    el('p', {}, escapeHtml(message)),
  ]);
}
