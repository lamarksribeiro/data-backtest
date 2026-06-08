import { el, mount, emptyState } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, contextQueryParams, selectField } from '../utils/context.js';
import { escapeHtml, shellQuote } from '../utils/format.js';
import { confirmDialog, promptDialog } from '../utils/confirm.js';

let lastPlan = null;
let currentExplorerPath = '';

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
        el('p', { class: 'page-header__sub' }, 'Verifique disponibilidade, gerencie arquivos e reprocesse partições.'),
      ]),
    ]),
    
    // Tab Navigation bar
    el('div', { class: 'premium-tabs-nav', style: { marginBottom: '20px' } }, [
      el('button', { 
        class: 'premium-tab-link is-active', 
        id: 'lake-tab-link-avail', 
        type: 'button', 
        onclick: () => switchLakeTab('avail') 
      }, [
        el('i', { class: 'fa-solid fa-table-cells', style: { marginRight: '8px' } }),
        'Disponibilidade e Preparação'
      ]),
      el('button', { 
        class: 'premium-tab-link', 
        id: 'lake-tab-link-explorer', 
        type: 'button', 
        onclick: () => switchLakeTab('explorer') 
      }, [
        el('i', { class: 'fa-solid fa-folder-open', style: { marginRight: '8px' } }),
        'Explorador de Arquivos'
      ]),
    ]),

    // Tab 1: Availability Content
    el('div', { class: 'lake-tab-content is-active', id: 'lake-tab-content-avail' }, [
      el('section', { class: 'card' }, [
        el('form', { id: 'lake-form', class: 'form-grid form-grid--compact' }, [
          field('Dataset', selectField('dataset', ['backtest_ticks', 'scalars', 'books', 'ohlc'], formCtx.dataset)),
          field('Dia inicial', el('input', { class: 'field__input', type: 'date', name: 'from', value: formCtx.from, required: true })),
          field('Dia final', el('input', { class: 'field__input', type: 'date', name: 'to', value: formCtx.to, required: true })),
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
            el('span', { class: 'switch-field__label' }, 'Forçar reprocessamento'),
          ]),
          el('div', { class: 'form-actions' }, [
            el('button', { class: 'btn btn--ghost', type: 'button', id: 'lake-one-day-btn' }, '1 dia'),
            el('button', { class: 'btn btn--primary', type: 'submit' }, 'Verificar disponibilidade'),
          ]),
          el('p', { class: 'muted', style: { gridColumn: '1 / -1', margin: '-4px 0 0' } }, 'Selecione o mesmo dia nos dois campos para consultar ou refazer apenas uma partição diária.'),
        ]),
      ]),
      el('div', { id: 'lake-result' }),
    ]),

    // Tab 2: Explorer Content
    el('div', { class: 'lake-tab-content', id: 'lake-tab-content-explorer', style: { display: 'none' } }, [
      el('section', { class: 'card' }, [
        el('div', { class: 'explorer-breadcrumbs', id: 'explorer-breadcrumbs-wrap', style: { marginBottom: '14px', fontSize: '13px', fontWeight: 'bold' } }),
        el('div', { id: 'explorer-table-wrap' })
      ]),
    ]),
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

  document.getElementById('lake-one-day-btn')?.addEventListener('click', () => {
    const fromInput = form.querySelector('[name=from]');
    const toInput = form.querySelector('[name=to]');
    toInput.value = fromInput.value;
  });

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
    normalizeOneDayRange(params);
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

  function switchLakeTab(tabId) {
    const availTab = document.getElementById('lake-tab-content-avail');
    const explorerTab = document.getElementById('lake-tab-content-explorer');
    const availLink = document.getElementById('lake-tab-link-avail');
    const explorerLink = document.getElementById('lake-tab-link-explorer');

    if (tabId === 'avail') {
      availTab.style.display = 'block';
      explorerTab.style.display = 'none';
      availLink.classList.add('is-active');
      explorerLink.classList.remove('is-active');
    } else {
      availTab.style.display = 'none';
      explorerTab.style.display = 'block';
      availLink.classList.remove('is-active');
      explorerLink.classList.add('is-active');
      loadExplorerPath(ctx, currentExplorerPath || '');
    }
  }

  // Bind local tab switcher so buttons work
  const availBtn = document.getElementById('lake-tab-link-avail');
  const explorerBtn = document.getElementById('lake-tab-link-explorer');
  availBtn.onclick = () => switchLakeTab('avail');
  explorerBtn.onclick = () => switchLakeTab('explorer');
}

async function loadExplorerPath(ctx, relativePath) {
  currentExplorerPath = relativePath;
  const breadcrumbsWrap = document.getElementById('explorer-breadcrumbs-wrap');
  const tableWrap = document.getElementById('explorer-table-wrap');
  if (!tableWrap) return;
  
  mount(tableWrap, el('p', { class: 'muted' }, 'Carregando arquivos do lakehouse...'));
  
  const parts = relativePath.split('/').filter(Boolean);
  const breadcrumbElements = [
    el('a', { 
      href: 'javascript:void(0)', 
      style: { color: 'var(--accent)', marginRight: '4px' }, 
      onclick: () => loadExplorerPath(ctx, '') 
    }, 'lake')
  ];
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    breadcrumbElements.push(el('span', { class: 'muted', style: { margin: '0 6px' } }, '›'));
    accumulated += (accumulated ? '/' : '') + parts[i];
    const target = accumulated;
    breadcrumbElements.push(
      i === parts.length - 1
        ? el('span', { style: { marginLeft: '4px' } }, parts[i])
        : el('a', { 
            href: 'javascript:void(0)', 
            style: { color: 'var(--accent)', marginLeft: '4px', marginRight: '4px' }, 
            onclick: () => loadExplorerPath(ctx, target) 
          }, parts[i])
    );
  }
  if (breadcrumbsWrap) mount(breadcrumbsWrap, breadcrumbElements);

  const res = await ctx.api.get(`/api/lake/files?path=${encodeURIComponent(relativePath)}`);
  if (!res.ok) {
    mount(tableWrap, el('p', { class: 'bad' }, res.error?.message || 'Falha ao carregar diretório.'));
    return;
  }

  const files = res.data.files || [];
  if (!files.length && relativePath === '') {
    mount(tableWrap, emptyState('O diretório do lakehouse está vazio.'));
    return;
  }
  const obsoleteFiles = files.filter((file) => file.isObsolete);

  const table = el('div', { class: 'table-wrap' }, [
    obsoleteFiles.length ? el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', padding: '10px 12px' } }, [
      el('span', { class: 'muted' }, `${obsoleteFiles.length} Parquet obsoleto(s) nesta pasta · ${formatBytes(obsoleteFiles.reduce((sum, file) => sum + Number(file.size || 0), 0))}`),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => cleanupExplorerPath(ctx, relativePath),
      }, 'Limpar obsoletos'),
    ]) : null,
    el('table', { class: 'table table--compact' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Nome'),
        el('th', {}, 'Tipo'),
        el('th', {}, 'Uso'),
        el('th', {}, 'Tamanho'),
        el('th', {}, 'Modificado'),
        el('th', {}, 'Ações'),
      ])),
      el('tbody', {}, [
        relativePath !== '' ? el('tr', {}, [
          el('td', { colspan: '6', style: { padding: '8px 12px' } }, el('a', { 
            href: 'javascript:void(0)', 
            style: { fontWeight: 'bold', color: 'var(--accent)', display: 'block' },
            onclick: () => {
              const up = parts.slice(0, -1).join('/');
              loadExplorerPath(ctx, up);
            }
          }, [
            el('i', { class: 'fa-solid fa-arrow-left', style: { marginRight: '8px' } }),
            '.. (Voltar)'
          ]))
        ]) : null,
        
        ...(files.length ? files.map((file) => {
          return el('tr', {}, [
            el('td', {}, el('a', {
              href: 'javascript:void(0)',
              style: file.isDir ? { fontWeight: 'bold', color: 'var(--text-1)', display: 'block' } : { color: 'var(--text-2)', display: 'block' },
              onclick: () => {
                if (file.isDir) {
                  loadExplorerPath(ctx, file.path);
                }
              }
            }, [
              el('i', { 
                class: file.isDir ? 'fa-solid fa-folder' : 'fa-solid fa-file-code', 
                style: { marginRight: '8px', color: file.isDir ? 'var(--accent)' : 'var(--text-3)' } 
              }),
              file.name
            ])),
            el('td', {}, file.isDir ? 'Pasta' : 'Parquet'),
            el('td', {}, file.isDir ? '-' : file.isActive
              ? el('span', { class: 'badge badge--ok' }, 'ativo')
              : el('span', { class: 'badge badge--warn' }, 'obsoleto')),
            el('td', {}, file.isDir ? '-' : formatBytes(file.size)),
            el('td', {}, file.mtime ? new Date(file.mtime).toLocaleString() : '-'),
            el('td', {}, file.isDir ? null : el('a', {
              class: 'btn btn--ghost btn--sm',
              href: `/api/lake/download?path=${encodeURIComponent(file.path)}`,
              target: '_blank',
              download: file.name,
              style: { display: 'inline-flex', alignItems: 'center', gap: '4px' }
            }, [
              'Baixar ',
              el('i', { class: 'fa-solid fa-download' })
            ])),
          ]);
        }) : [el('tr', {}, el('td', { colspan: '6', class: 'muted', style: { textAlign: 'center', padding: '12px' } }, 'Diretório vazio.'))])
      ])
    ])
  ]);
  
  mount(tableWrap, table);
}

async function cleanupExplorerPath(ctx, relativePath) {
  const ok = await confirmDialog({
    title: 'Limpar Parquets obsoletos',
    message: 'Remover os arquivos Parquet desta pasta que não são active_path no manifest?',
    detail: 'O arquivo em uso pelo backtest será mantido. Apenas versões antigas da mesma partição serão removidas.',
    confirmLabel: 'Limpar',
    tone: 'danger',
  });
  if (!ok) return;

  const res = await ctx.api.post('/api/lake/cleanup', { path: relativePath });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao limpar arquivos obsoletos');
    return;
  }
  ctx.toast.ok(`${res.data.deleted.length} arquivo(s) removido(s) · ${formatBytes(res.data.bytesFreed || 0)} liberados`);
  await loadExplorerPath(ctx, relativePath);
}

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function renderPlan(panel, plan, ctx) {
  const { result } = plan;
  const availability = result.availability;
  const summary = availability.summary || {
    total: availability.expected_partitions.length,
    valid: availability.files.length,
    missing: availability.missing.length,
    unavailable: availability.unavailable.length,
  };
  const partitions = availability.partitions || buildPartitionsFallback(availability);

  const available = partitions.filter((p) => p.usable);
  const blocked = partitions.filter((p) => !p.usable && p.active_path);
  const gaps = partitions.filter((p) => !p.usable && !p.active_path);

  mount(panel, [
    el('div', { class: 'grid grid--5' }, [
      stat('Status', result.ready ? 'Pronto' : 'Preparar'),
      stat('Dataset', availability.dataset),
      stat('No intervalo', summary.total),
      stat('Prontas (strict)', summary.valid),
      stat('Pendentes', summary.missing + summary.unavailable),
    ]),
    el('p', { class: 'page-header__sub lake-context-line' }, [
      `${availability.underlying} · ${availability.interval}`,
      availability.book_depth != null ? ` · book depth ${availability.book_depth}` : '',
      availability.resolution ? ` · resolução ${availability.resolution}` : '',
      ` · ${formatDateRange(availability.from, availability.to)}`,
    ]),
    available.length ? el('section', { class: 'card lake-card--ok' }, [
      el('h2', { class: 'card__title' }, `Disponíveis (${available.length})`),
      availablePartitionsTable(available, ctx, availability),
    ]) : null,
    blocked.length ? el('section', { class: 'card lake-card--warn' }, [
      el('h2', { class: 'card__title' }, `Bloqueadas (${blocked.length})`),
      blockedPartitionsTable(blocked, ctx, availability),
    ]) : null,
    gaps.length ? el('section', { class: 'card lake-card--missing' }, [
      el('h2', { class: 'card__title' }, `Ausentes (${gaps.length})`),
      missingPartitionsBlock(gaps),
    ]) : null,
    !available.length && !blocked.length && !gaps.length ? el('p', { class: 'muted' }, 'Nenhuma partição no intervalo.') : null,
    preparationCard(result.preparation, plan, ctx),
  ]);
}

function preparationCard(preparation, plan, ctx) {
  return el('section', { class: 'card' }, [
    el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, 'Plano de preparação'),
        el('p', { class: 'muted', style: { margin: '4px 0 0' } }, preparation.length
          ? `${preparation.length} ação(ões) para deixar o intervalo pronto.`
          : 'Nenhuma ação necessária.'),
      ]),
      preparation.length ? el('button', {
        class: 'btn btn--primary',
        type: 'button',
        onclick: () => runPrepareJob(plan, ctx),
      }, 'Criar job') : null,
    ]),
    preparation.length ? el('details', { style: { marginTop: '14px' } }, [
      el('summary', { class: 'muted', style: { cursor: 'pointer' } }, 'Ver comandos CLI'),
      el('ol', { class: 'mono-list mono-list--dense', style: { marginTop: '10px' } }, preparation.map((action) => el('li', {}, [
        el('code', {}, `node src/cli.js ${action.command} ${action.args.map(shellQuote).join(' ')}`),
        action.prerequisite ? el('span', { class: 'badge badge--warn' }, 'pré-requisito') : null,
      ]))),
    ]) : null,
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

async function quickRebuildPartition(ctx, p, availability, confirmLabel = 'Reprocessar') {
  const ok = await confirmDialog({
    title: 'Reprocessar partição',
    message: `Deseja criar um job de preparação para reprocessar a partição de dt=${p.dt}?`,
    detail: `Isso relê este dia (${p.dt}) do banco coletor, reescreve o Parquet e grava os detalhes de qualidade no manifesto.`,
    confirmLabel,
    tone: 'danger'
  });
  if (!ok) return;

  const request = {
    dataset: availability.dataset,
    from: p.dt,
    to: nextDate(p.dt),
    underlying: availability.underlying,
    interval: availability.interval,
    book_depth: availability.book_depth,
    resolution: availability.resolution,
    rebuild: true
  };

  const res = await ctx.api.post('/api/prepare/run', {
    request,
    dry_run: false,
    confirm_rebuild: 'REBUILD_PARTITIONS'
  });
  
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao criar job de reprocessamento');
    return;
  }
  ctx.toast.ok(`Job #${res.data.job.id} de reprocessamento criado!`);
  ctx.navigate('jobs');
}

async function acceptPartition(ctx, p, availability) {
  const ok = await confirmDialog({
    title: 'Aceitar divergência',
    message: `Liberar dt=${p.dt} para uso em backtests mesmo com divergência de contagem?`,
    detail: 'Use isso quando a diferença for pequena ou aceitável. A partição continuará marcada como aceita com aviso e pode ser bloqueada novamente.',
    confirmLabel: 'Aceitar',
    tone: 'danger',
  });
  if (!ok) return;

  const res = await ctx.api.post('/api/manifest/accept', manifestPartitionPayload(p, availability, 'accepted from lakehouse UI'));
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao aceitar partição');
    return;
  }
  ctx.toast.ok(`Partição ${p.dt} aceita com aviso`);
  await refreshCurrentPlan(ctx);
}

async function revokeAcceptedPartition(ctx, p, availability) {
  const ok = await confirmDialog({
    title: 'Bloquear partição aceita',
    message: `Voltar dt=${p.dt} para needs_review?`,
    detail: 'Backtests em strict deixarão de usar essa partição até novo aceite ou reconstrução válida.',
    confirmLabel: 'Bloquear',
    tone: 'danger',
  });
  if (!ok) return;

  const res = await ctx.api.post('/api/manifest/revoke-acceptance', manifestPartitionPayload(p, availability, 'acceptance revoked from lakehouse UI'));
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao bloquear partição');
    return;
  }
  ctx.toast.ok(`Partição ${p.dt} bloqueada novamente`);
  await refreshCurrentPlan(ctx);
}

function manifestPartitionPayload(p, availability, reason) {
  return {
    dataset: availability.dataset,
    dt: p.dt,
    underlying: availability.underlying,
    interval: availability.interval,
    book_depth: availability.book_depth,
    resolution: availability.resolution,
    reason,
  };
}

async function refreshCurrentPlan(ctx) {
  if (!lastPlan?.request) return;
  const params = new URLSearchParams(lastPlan.request);
  const res = await ctx.api.get(`/api/prepare?${params}`);
  const panel = document.getElementById('lake-result');
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao atualizar disponibilidade');
    return;
  }
  lastPlan = { ...lastPlan, result: res.data.result };
  renderPlan(panel, lastPlan, ctx);
}

function normalizeOneDayRange(params) {
  const from = params.get('from');
  const to = params.get('to');
  if (from && to && from === to) params.set('to', nextDate(to));
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

function missingPartitionsBlock(partitions) {
  const dates = partitions.map((p) => p.dt).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const rangeLabel = dates.length > 1 ? `${first} → ${last}` : first;

  return el('div', { class: 'lake-missing-dates' }, [
    el('div', { class: 'lake-missing-dates__meta' }, [
      el('span', { class: 'lake-missing-dates__label' }, 'Datas'),
      el('span', { class: 'mono lake-missing-dates__range muted' }, rangeLabel),
      el('span', { class: 'badge badge--idle' }, `${dates.length} dia(s)`),
    ]),
    el('div', { class: 'lake-missing-dates__scroll' }, [
      el('div', { class: 'lake-missing-dates__grid' }, dates.map((dt) =>
        el('span', { class: 'lake-missing-dates__chip mono', title: dt }, dt))),
    ]),
  ]);
}

function buildPartitionsFallback(availability) {
  const byUnavailable = new Map((availability.unavailable || []).map((item) => [item.dt, item]));
  return (availability.expected_partitions || []).map((dt) => {
    if (availability.missing?.includes(dt)) {
      return { dt, status: 'missing', usable: false, rows: null, active_path: null, error: null, hint: 'Sem entrada no manifest.' };
    }
    const item = byUnavailable.get(dt);
    if (item) {
      return {
        dt,
        status: item.status,
        usable: false,
        rows: item.rows ?? null,
        active_path: item.active_path ?? null,
        error: item.error ?? null,
        hint: item.hint || null,
      };
    }
    return { dt, status: 'valid', usable: true, rows: null, active_path: null, error: null, hint: null };
  });
}

function availablePartitionsTable(partitions, ctx, availability) {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table table--compact lake-partitions-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'dt'), el('th', {}, 'Rows'), el('th', {}, 'Eventos'),
        el('th', {}, 'Cobertura mín.'), el('th', {}, 'Qualidade'), el('th', {}, 'Arquivo'), el('th', {}, 'Ações'),
      ])),
      el('tbody', {}, partitions.map((p) => el('tr', { class: 'lake-partition--ok' }, [
        el('td', {}, el('code', {}, p.dt)),
        el('td', {}, p.rows != null ? String(p.rows) : '-'),
        el('td', {}, p.events_count != null ? String(p.events_count) : '-'),
        el('td', {}, formatCoverage(p.coverage_min)),
        el('td', {}, qualityBadge(p)),
        el('td', { class: 'mono truncate', title: p.active_path || '' }, p.active_path || '-'),
        el('td', {}, el('div', { class: 'lake-partition-actions' }, [
          p.has_degraded ? el('button', {
            class: 'btn btn--ghost btn--sm btn--primary-hover',
            type: 'button',
            title: p.quality_details ? 'Reprocessar e atualizar detalhes de qualidade' : 'Reprocessar para gerar detalhes de qualidade',
            onclick: () => quickRebuildPartition(ctx, p, availability, p.quality_details ? 'Atualizar detalhes' : 'Gerar detalhes'),
          }, p.quality_details ? 'Atualizar detalhes' : 'Gerar detalhes') : null,
          p.status === 'accepted' ? el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            title: p.error || p.hint || 'Partição aceita com aviso',
            onclick: () => revokeAcceptedPartition(ctx, p, availability),
          }, 'Bloquear') : null,
        ])),
      ]))),
    ])
  ]);
}

function blockedPartitionsTable(partitions, ctx, availability) {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table table--compact lake-partitions-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'dt'), el('th', {}, 'Status'), el('th', {}, 'Rows'),
        el('th', {}, 'Degradado'), el('th', {}, 'Motivo'), el('th', {}, 'Ações'),
      ])),
      el('tbody', {}, partitions.map((p) => el('tr', { class: 'lake-partition--gap' }, [
        el('td', {}, el('code', {}, p.dt)),
        el('td', {}, el('span', { class: `badge badge--${partitionStatusTone(p.status)}` }, p.status)),
        el('td', {}, p.rows != null ? String(p.rows) : '-'),
        el('td', {}, p.has_degraded
          ? el('span', { class: 'badge badge--warn' }, 'sim')
          : el('span', { class: 'badge badge--ok' }, 'não')),
        el('td', { class: 'lake-partition__detail' }, p.error
          ? el('span', { class: 'lake-partition__error' }, escapeHtml(p.error))
          : el('span', { class: 'muted' }, '-')),
        el('td', {}, el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          el('button', {
            class: 'btn btn--ghost btn--sm btn--primary-hover',
            type: 'button',
            style: { color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: '4px' },
            onclick: () => quickRebuildPartition(ctx, p, availability)
          }, [
            'Refazer ',
            el('i', { class: 'fa-solid fa-rotate' })
          ]),
          p.status === 'needs_review' ? el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: () => acceptPartition(ctx, p, availability),
          }, 'Aceitar') : null,
        ])),
      ]))),
    ])
  ]);
}

function formatCoverage(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return `${Math.round(Number(value) * 100)}%`;
}

function qualityBadge(p) {
  if (p.status === 'accepted') {
    return qualityDetailsDisclosure(p, 'aviso', p.error || p.hint || 'Aceita com aviso');
  }
  if (p.has_degraded) return qualityDetailsDisclosure(p, 'degradado', 'Ver detalhes da degradação');
  return el('span', { class: 'badge badge--ok' }, 'ok');
}

function qualityDetailsDisclosure(p, label, title) {
  return el('details', { class: 'lake-quality-details' }, [
    el('summary', { title }, [
      el('span', { class: 'badge badge--warn' }, label),
      el('span', { class: 'lake-quality-details__hint' }, 'detalhes'),
    ]),
    qualityDetailsBody(p),
  ]);
}

function qualityDetailsBody(p) {
  const details = p.quality_details;
  if (!details) {
    return el('div', { class: 'lake-quality-details__body' }, [
      el('p', {}, 'Esta partição foi marcada como degradada, mas foi gerada antes do resumo detalhado existir.'),
      p.error ? el('p', { class: 'lake-quality-details__note' }, p.error) : null,
      el('p', { class: 'muted' }, 'Reprocesse a partição para gravar eventos afetados, cobertura e ticks faltantes.'),
    ]);
  }

  const issueItems = (details.issues || []).map((issue) => el('li', {}, formatQualityIssue(issue)));
  const samples = (details.samples || []).slice(0, 8);

  return el('div', { class: 'lake-quality-details__body' }, [
    el('div', { class: 'lake-quality-details__stats' }, [
      qualityMetric('Eventos degradados', `${details.events_degraded ?? 0}/${details.events_total ?? '-'}`),
      qualityMetric('Cobertura mín.', formatCoverage(details.coverage_min)),
      qualityMetric('Ticks faltantes', formatInteger(details.source_missing_ticks)),
      qualityMetric('Delta rows', formatSignedInteger(details.row_count_delta)),
    ]),
    issueItems.length ? el('ul', { class: 'lake-quality-details__issues' }, issueItems) : null,
    samples.length ? el('div', { class: 'lake-quality-details__samples' }, [
      el('div', { class: 'lake-quality-details__subtitle' }, 'Piores eventos'),
      ...samples.map((sample) => el('div', { class: 'lake-quality-details__sample' }, [
        el('code', { title: sample.condition_id || '' }, shortConditionId(sample.condition_id)),
        el('span', {}, sample.event_start ? sample.event_start.replace('T', ' ').slice(0, 16) : '-'),
        el('span', {}, formatCoverage(sample.coverage)),
        el('span', {}, `${formatInteger(sample.ticks_recorded)}/${formatInteger(sample.ticks_expected)} ticks`),
      ])),
    ]) : null,
    p.error ? el('p', { class: 'lake-quality-details__note' }, p.error) : null,
  ]);
}

function qualityMetric(label, value) {
  return el('div', { class: 'lake-quality-details__metric' }, [
    el('span', {}, label),
    el('strong', {}, value),
  ]);
}

function formatQualityIssue(issue) {
  if (issue.code === 'low_coverage') {
    return `${issue.label}: ${issue.events ?? 0} evento(s) abaixo de ${formatCoverage(issue.threshold)}`;
  }
  if (issue.code === 'missing_ticks') {
    return `${issue.label}: ${formatInteger(issue.missing_ticks)} faltantes de ${formatInteger(issue.expected_ticks)} esperados`;
  }
  if (issue.code === 'manifest_count_mismatch') {
    return `${issue.label}: exportado ${formatInteger(issue.actual_rows)}, event_quality ${formatInteger(issue.event_quality_rows)} (${formatSignedInteger(issue.delta)})`;
  }
  return issue.label || issue.code || 'Problema de qualidade';
}

function formatInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return Number(value).toLocaleString('pt-BR');
}

function formatSignedInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toLocaleString('pt-BR')}`;
}

function shortConditionId(value) {
  if (!value) return '-';
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function partitionStatusTone(status) {
  if (status === 'valid') return 'ok';
  if (status === 'accepted') return 'warn';
  if (status === 'missing') return 'idle';
  if (status === 'needs_review') return 'warn';
  if (status === 'writing' || status === 'rebuilding' || status === 'pending') return 'warn';
  return 'err';
}

function formatUnavailableLine(item) {
  const parts = [`${item.dt}: ${item.status}`];
  if (item.rows != null) parts.push(`${item.rows} rows`);
  if (item.error) parts.push(item.error);
  return parts.join(' · ');
}

function formatDateRange(from, to) {
  const fromDate = from?.slice(0, 10);
  const toDate = previousDate(to?.slice(0, 10));
  if (!fromDate || !toDate) return '';
  return fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`;
}

function nextDate(dt) {
  const date = new Date(`${dt}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function previousDate(dt) {
  if (!dt) return null;
  const date = new Date(`${dt}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function errorCard(message) {
  return el('section', { class: 'card card--error' }, [
    el('h2', { class: 'card__title' }, 'Erro'),
    el('p', {}, escapeHtml(message)),
  ]);
}
