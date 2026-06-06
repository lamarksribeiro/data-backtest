import { el, mount, emptyState } from '../utils/dom.js';
import { loadContext } from '../utils/context.js';
import { backtestPayloadFromPick } from '../utils/strategyPicker.js';
import { promptDialog, confirmDialog } from '../utils/confirm.js';

const GLS_TEMPLATE = `strategy "Nova Estrategia" {
  param minDistanceAbs = 50
  param maxAsk = 0.58
  param budget = 15

  onEventStart(event) {
    state.entered = false
  }

  onTick(tick, event) {
    let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let ask = book.ask(side, tick)
    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      enter(side, { price: ask, budget: params.budget, reason: "entry" })
      state.entered = true
      mark("entry")
    }
  }

  onEventEnd(event) {
    closeOpenPosition({ reason: "event_end" })
  }
}`;

/** @type {{ list: object[], selectedId: number|null, selectedVersionId: number|null, focusedEditor: object|null, sourceCode: string, validation: object|null, blocks: object[], currentStrategy: object|null, currentVersion: object|null, strategyQuery: string, statusFilter: string }} */
const state = {
  list: [],
  selectedId: null,
  selectedVersionId: null,
  focusedEditor: null,
  sourceCode: '',
  validation: null,
  blocks: [],
  currentStrategy: null,
  currentVersion: null,
  strategyQuery: '',
  statusFilter: 'all'
};

export async function renderStrategies(ctx, params = {}) {
  const strategyId = params.id ? Number(params.id) : null;
  if (strategyId) state.selectedId = strategyId;
  ctx.setBreadcrumb('strategies', null);

  // Clean up any old editor before loading
  if (state.focusedEditor) {
    try {
      state.focusedEditor.toTextArea();
    } catch { /* ignore */ }
    state.focusedEditor = null;
  }

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Estratégias'),
        el('p', { class: 'page-header__sub' }, 'Editor GLS, validação e parâmetros integrados.'),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => createStrategyFlow(ctx) }, 'Nova'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => renderStrategies(ctx) }, 'Recarregar'),
      ]),
    ]),
    el('div', { class: 'editor-layout editor-layout--two-cols', id: 'strategies-root' }, el('p', { class: 'muted' }, 'Carregando...')),
  ]);

  const res = await ctx.api.get('/api/strategies');
  if (!res.ok) {
    mount(document.getElementById('strategies-root'), el('p', { class: 'bad' }, res.error?.message || 'Falha ao carregar estratégias'));
    return;
  }
  state.list = res.data.strategies || [];
  if (state.selectedId && !state.list.some((strategy) => strategy.id === state.selectedId)) {
    state.selectedId = null;
    state.selectedVersionId = null;
  }
  if (!state.selectedId && state.list.length) state.selectedId = state.list[0].id;
  const selected = state.list.find((strategy) => strategy.id === state.selectedId);
  ctx.setBreadcrumb('strategies', selected?.name || null);

  mount(document.getElementById('strategies-root'), [
    el('aside', { class: 'editor-sidebar card', id: 'strategy-list-panel' }, renderStrategyList(ctx)),
    el('div', { class: 'editor-main card', id: 'strategy-editor' }, el('p', { class: 'muted' }, 'Selecione uma estratégia.')),
  ]);

  if (state.selectedId) {
    await openStrategyEditor(ctx, state.selectedId, params.versionId ? Number(params.versionId) : null);
  }
}

function renderStrategyList(ctx) {
  const filtered = state.list.filter((s) => {
    const q = state.strategyQuery.toLowerCase();
    const matchesQuery = s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q);
    const matchesStatus = state.statusFilter === 'all' || s.status === state.statusFilter;
    return matchesQuery && matchesStatus;
  });
  const counts = countByStatus(state.list);

  const listItems = filtered.map((strategy) => el('li', { dataset: { status: strategy.status } }, [
    el('button', {
      type: 'button',
      class: state.selectedId === strategy.id ? 'is-active' : '',
      onclick: async () => {
        state.selectedId = strategy.id;
        state.selectedVersionId = null;
        ctx.navigate(`strategies/${strategy.id}`);
        await renderStrategies(ctx, { id: strategy.id });
      },
    }, [
      el('div', { style: { fontWeight: '700' } }, strategy.name),
      el('div', { class: 'muted mono', style: { fontSize: '11px', marginTop: '2px' } }, `${strategy.slug} · v${strategy.latest_version ?? '-'} · ${strategy.status}`),
    ]),
  ]));

  return [
    el('div', { class: 'strategy-status-tabs' }, [
      statusTab(ctx, 'all', `Todas ${state.list.length}`),
      statusTab(ctx, 'draft', `Draft ${counts.draft || 0}`),
      statusTab(ctx, 'validated', `Validated ${counts.validated || 0}`),
      statusTab(ctx, 'archived', `Archived ${counts.archived || 0}`),
    ]),
    el('div', { class: 'strategy-search-wrap' }, [
      el('input', {
        class: 'strategy-search-input',
        type: 'text',
        placeholder: '🔍 Buscar estratégia...',
        value: state.strategyQuery,
        oninput: (e) => {
          state.strategyQuery = e.target.value;
          const panel = document.getElementById('strategy-list-panel');
          if (panel) {
            // Re-render list reactive content
            const nextList = renderStrategyList(ctx);
            mount(panel, nextList);
            const input = panel.querySelector('.strategy-search-input');
            if (input) {
              input.focus();
              input.selectionStart = input.selectionEnd = input.value.length;
            }
          }
        }
      })
    ]),
    el('ul', { class: 'strategy-list' }, listItems.length ? listItems : emptyState('Nenhuma estratégia encontrada.'))
  ];
}

function countByStatus(strategies) {
  return strategies.reduce((acc, strategy) => {
    acc[strategy.status] = (acc[strategy.status] || 0) + 1;
    return acc;
  }, {});
}

function statusTab(ctx, status, label) {
  return el('button', {
    class: `strategy-status-tab ${state.statusFilter === status ? 'is-active' : ''}`,
    type: 'button',
    onclick: () => {
      state.statusFilter = status;
      const panel = document.getElementById('strategy-list-panel');
      if (panel) mount(panel, renderStrategyList(ctx));
    },
  }, label);
}

async function openStrategyEditor(ctx, strategyId, versionId = null) {
  const editorPanel = document.getElementById('strategy-editor');
  if (!editorPanel) return;

  // Clean up any old editor before loading next one
  if (state.focusedEditor) {
    try {
      state.focusedEditor.toTextArea();
    } catch { /* ignore */ }
    state.focusedEditor = null;
  }

  mount(editorPanel, el('p', { class: 'muted' }, 'Carregando detalhes do editor...'));

  const [strategyRes, versionsRes, blocksRes] = await Promise.all([
    ctx.api.get(`/api/strategies/${strategyId}`),
    ctx.api.get(`/api/strategies/${strategyId}/versions`),
    ctx.api.get('/api/strategy-blocks'),
  ]);
  if (!strategyRes.ok) {
    mount(editorPanel, el('p', { class: 'bad' }, strategyRes.error?.message || 'Falha ao abrir estratégia'));
    return;
  }

  const strategy = strategyRes.data.strategy;
  state.currentStrategy = strategy;
  ctx.setBreadcrumb('strategies', strategy.name);
  const versions = versionsRes.ok ? versionsRes.data.versions || [] : [];
  const version = versionId
    ? versions.find((item) => item.id === versionId) || versions[0]
    : versions[0];
  state.selectedVersionId = version?.id ?? null;
  state.currentVersion = version ?? null;

  state.sourceCode = version?.source_code || GLS_TEMPLATE;
  state.validation = version?.validation || null;
  state.blocks = blocksRes.data?.blocks || [];
  
  const schema = state.validation?.params_schema || version?.params_schema || {};
  const hasParams = Object.keys(schema).length > 0;

  mount(editorPanel, [
    // Header Row with status, version selector and main execution controls
    el('div', { class: 'strategy-header-row' }, [
      el('div', { class: 'editor-title-block' }, [
        el('h2', { class: 'card__title', id: 'strategy-title' }, strategy.name),
        el('p', { class: 'muted mono editor-title-block__meta', id: 'strategy-title-meta' }, `${strategy.slug} · status: ${strategy.status} · versão atual: v${strategy.latest_version ?? '-'}`),
      ]),
      el('div', { class: 'strategy-header-version-picker' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label' }, 'Versão:'),
          el('select', {
            class: 'field__input',
            id: 'strategy-version-select',
            onchange: async (e) => {
              const nextVersionId = Number(e.target.value);
              if (!Number.isFinite(nextVersionId)) return;
              state.selectedVersionId = nextVersionId;
              ctx.navigate(`strategies/${strategyId}/${nextVersionId}`);
              await openStrategyEditor(ctx, strategyId, nextVersionId);
            },
          }, versions.length
            ? versions.map((item) => el('option', { value: item.id, selected: item.id === version?.id }, `v${item.version} (${item.created_at ? item.created_at.slice(0,10) : ''})`))
            : [el('option', { value: '' }, 'Sem versões')]),
        ]),
        el('button', {
          class: 'btn btn--danger btn--sm',
          type: 'button',
          title: 'Excluir esta versão',
          disabled: !version || versions.length <= 1,
          onclick: () => deleteVersionFlow(ctx, strategy, version),
        }, '✕'),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--danger btn--sm btn--ghost', type: 'button', onclick: () => deleteStrategyFlow(ctx, strategy) }, 'Apagar'),
      ]),
    ]),

    // Tab Navigation bar
    el('div', { class: 'premium-tabs-nav' }, [
      el('button', { class: 'premium-tab-link is-active', id: 'tab-link-code', type: 'button', onclick: () => switchTab('code') }, '⚡ Editor de Código'),
      el('button', { class: 'premium-tab-link', id: 'tab-link-params', type: 'button', onclick: () => switchTab('params') }, '⚙ Parâmetros'),
      el('button', { class: 'premium-tab-link', id: 'tab-link-config', type: 'button', onclick: () => switchTab('config') }, '📝 Ficha Técnica'),
    ]),

    // 1. Tab Código Content
    el('div', { class: 'premium-tab-content is-active', id: 'tab-content-code' }, [
      el('div', { class: 'strategy-code-tab-layout strategy-code-tab-layout--single' }, [
        el('div', { class: 'strategy-code-editor-area' }, [
          el('div', { class: 'row row--between' }, [
            el('span', { class: 'eyebrow' }, 'Linguagem GLS'),
            el('div', { class: 'row' }, [
              el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => toggleGlsDrawer(true) }, 'Ajuda GLS 🛟'),
              el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => validateTabCode(ctx) }, 'Validar Código'),
              el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => saveTabCodeVersion(ctx, strategy.id) }, 'Salvar Versão (Ctrl+S)'),
            ]),
          ]),
          el('textarea', { id: `gls-editor-textarea-${strategyId}` }, state.sourceCode),
          el('div', { class: 'validation-console-card' }, [
            el('div', { class: 'validation-console-card__header' }, [
              el('span', {}, 'Console de Validação'),
              renderValidationBadge(state.validation),
            ]),
            el('div', { id: 'strategy-validation' }, renderValidationDetails(state.validation)),
          ]),
        ]),
      ]),
    ]),

    // 2. Tab Parâmetros Content
    el('div', { class: 'premium-tab-content', id: 'tab-content-params' }, [
      el('div', { class: 'row row--between', style: { marginBottom: '14px' } }, [
        el('div', {}, [
          el('h3', { class: 'card__title' }, 'Parâmetros Declarados'),
          el('p', { class: 'muted', style: { fontSize: '12px' } }, 'Edite os valores numéricos ou booleanos diretamente na estrutura do código.'),
        ]),
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: !hasParams, onclick: () => saveParamsVersion(ctx, strategy.id) }, 'Salvar parâmetros e recriar versão'),
      ]),
      el('div', { class: 'strategy-workbench', id: 'strategy-workbench-root' }, [
        hasParams ? renderParamsForm(schema) : emptyState('Esta versão de estratégia não declara parâmetros editáveis no cabeçalho param.'),
      ]),
    ]),

    // 3. Tab Ficha Técnica / Metadados Content
    el('div', { class: 'premium-tab-content', id: 'tab-content-config' }, [
      el('div', { style: { maxWidth: '600px' } }, [
        el('h3', { class: 'card__title', style: { marginBottom: '14px' } }, 'Metadados da Estratégia'),
        renderStrategyMetaForm(ctx, strategy),
      ]),
    ]),
  ]);

  // Initialize CodeMirror editor
  const editorId = `gls-editor-textarea-${strategyId}`;
  const textarea = document.getElementById(editorId);
  if (textarea) {
    const editor = window.CodeMirror.fromTextArea(textarea, {
      mode: 'javascript',
      theme: 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      autofocus: true,
      extraKeys: {
        'Ctrl-Space': (cm) => showGlsHint(cm),
        'Ctrl-S': async (cm) => {
          state.sourceCode = cm.getValue();
          await saveTabCodeVersion(ctx, strategy.id);
        },
        Tab: (cm) => cm.execCommand('indentMore'),
      },
    });
    state.focusedEditor = editor;
    editor.on('inputRead', (cm, change) => {
      if (!change.text?.[0] || /\s/.test(change.text[0])) return;
      if (/[A-Za-z_.]/.test(change.text[0])) showGlsHint(cm, true);
    });
    editor.on('change', (cm) => {
      state.sourceCode = cm.getValue();
    });
    window.setTimeout(() => editor.refresh(), 50);
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.premium-tab-link').forEach((link) => {
    link.classList.toggle('is-active', link.id === `tab-link-${tabId}`);
  });
  document.querySelectorAll('.premium-tab-content').forEach((content) => {
    content.classList.toggle('is-active', content.id === `tab-content-${tabId}`);
  });
  if (tabId === 'code' && state.focusedEditor) {
    window.setTimeout(() => state.focusedEditor.refresh(), 50);
  }
}

function shortcut(keys, label) {
  return el('div', { class: 'shortcut-row' }, [el('kbd', {}, keys), el('span', {}, label)]);
}

function renderParamsForm(schema) {
  return el('form', { class: 'strategy-params-form', id: 'strategy-params-form' }, Object.entries(schema).map(([key, def]) => {
    const value = def?.default;
    const type = typeof value;
    const inputAttrs = {
      class: 'field__input param-input',
      name: key,
      value: String(value ?? ''),
      dataset: { paramType: type },
    };
    return el('label', { class: 'param-card' }, [
      el('span', { class: 'param-card__name', title: key }, key),
      el('span', { class: 'param-card__type' }, type),
      type === 'boolean'
        ? el('select', { ...inputAttrs, value: undefined }, [
          el('option', { value: 'true', selected: value === true }, 'true'),
          el('option', { value: 'false', selected: value === false }, 'false'),
        ])
        : el('input', { ...inputAttrs, type: type === 'number' ? 'number' : 'text', step: type === 'number' ? 'any' : undefined }),
    ]);
  }));
}

async function validateStrategySource(ctx, source = state.sourceCode) {
  const res = await ctx.api.post('/api/strategies/validate', { source_code: source });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao validar');
    return null;
  }
  state.validation = res.data.validation;
  renderValidation(state.validation);
  return state.validation;
}

function renderValidation(validation) {
  state.validation = validation;
  const panel = document.getElementById('strategy-validation');
  if (panel) mount(panel, renderValidationDetails(validation));

  const badgeWrap = document.querySelector('.validation-console-card__header .badge');
  if (badgeWrap) {
    mount(badgeWrap.parentElement, [
      el('span', {}, 'Console de Validação'),
      renderValidationBadge(validation),
    ]);
  }
}

function renderValidationBadge(validation) {
  if (!validation) return el('span', { class: 'badge badge--idle' }, 'Não validado');
  return el('span', { class: `badge ${validation.ok ? 'badge--ok' : 'badge--err'}` }, validation.ok ? 'Válido' : 'Inválido');
}

function renderValidationDetails(validation) {
  if (!validation) return el('p', { class: 'muted', style: { margin: 0 } }, 'Pronto para validar.');
  const errors = validation.errors || [];
  const warnings = validation.warnings || [];
  if (!errors.length && !warnings.length) {
    return el('p', { style: { color: 'var(--ok)', fontWeight: '600', margin: 0 } }, '✓ Estratégia válida. Nenhum erro ou aviso encontrado.');
  }
  return el('div', { class: 'validation-panel' }, [
    errors.length ? el('ul', { class: 'validation-list', style: { margin: 0 } }, errors.map((item) => el('li', { class: 'is-error' }, `L${item.line}:${item.column} · ${item.message}`))) : null,
    warnings.length ? el('ul', { class: 'validation-list', style: { margin: 0 } }, warnings.map((item) => el('li', { class: 'is-warn' }, item.message))) : null,
  ]);
}

function renderStrategyMetaForm(ctx, strategy) {
  return el('form', {
    class: 'strategy-meta-form',
    id: 'strategy-meta-form',
    onsubmit: (event) => updateStrategyMeta(event, ctx, strategy.id),
  }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Nome'),
      el('input', { class: 'field__input', name: 'name', value: strategy.name }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Descrição'),
      el('textarea', { class: 'field__input', name: 'description', rows: '3' }, strategy.description || ''),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Status'),
      el('select', { class: 'field__input', name: 'status' }, ['draft', 'validated', 'archived'].map((status) => (
        el('option', { value: status, selected: status === strategy.status }, status)
      ))),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Tags'),
      el('input', { class: 'field__input', name: 'tags', value: (strategy.tags || []).join(', '), placeholder: 'btc, 5m' }),
    ]),
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit', style: { alignSelf: 'flex-start', marginTop: '10px' } }, 'Salvar dados'),
  ]);
}

async function updateStrategyMeta(event, ctx, strategyId) {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  const payload = {
    name: String(fd.get('name') || '').trim(),
    description: String(fd.get('description') || '').trim() || null,
    status: String(fd.get('status') || 'draft'),
    tags: String(fd.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  if (!payload.name) {
    ctx.toast.warn('Informe um nome para a estratégia.');
    return;
  }
  const res = await ctx.api.patch(`/api/strategies/${strategyId}`, payload);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao salvar dados');
    return;
  }
  const updated = res.data.strategy;
  state.list = state.list.map((item) => (item.id === updated.id ? updated : item));
  ctx.setBreadcrumb('strategies', updated.name);
  
  const title = document.getElementById('strategy-title');
  if (title) title.textContent = updated.name;
  
  const titleMeta = document.getElementById('strategy-title-meta');
  if (titleMeta) titleMeta.textContent = `${updated.slug} · status: ${updated.status} · versão atual: v${updated.latest_version ?? '-'}`;
  
  const listPanel = document.getElementById('strategy-list-panel');
  if (listPanel) mount(listPanel, renderStrategyList(ctx));
  ctx.toast.ok('Dados da estratégia atualizados');
}

async function saveTabCodeVersion(ctx, strategyId) {
  if (state.focusedEditor) state.sourceCode = state.focusedEditor.getValue();
  return saveSourceVersion(ctx, strategyId, state.sourceCode);
}

async function validateTabCode(ctx) {
  if (state.focusedEditor) state.sourceCode = state.focusedEditor.getValue();
  const validation = await validateStrategySource(ctx, state.sourceCode);
  if (!validation) return;
  if (validation.ok) ctx.toast.ok('Código GLS válido');
  else ctx.toast.err(`Código inválido: ${validation.errors?.length || 0} erro(s)`);
}

async function saveSourceVersion(ctx, strategyId, source) {
  if (!hasSourceChanged(source, state.currentVersion?.source_code)) {
    ctx.toast.warn('Nenhuma alteração detectada. Versão não criada.');
    return null;
  }
  const validation = await validateStrategySource(ctx, source);
  if (!validation?.ok) {
    ctx.toast.warn('Corrija os erros de validação do GLS antes de salvar.');
    return null;
  }
  const res = await ctx.api.post(`/api/strategies/${strategyId}/versions`, { source_code: source });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao salvar versão');
    return null;
  }
  state.selectedVersionId = res.data.version.id;
  state.sourceCode = res.data.version.source_code;
  state.validation = res.data.version.validation;
  ctx.toast.ok(`Versão v${res.data.version.version} salva com sucesso`);
  
  // Re-render strategy view but preserve the active tab
  await renderStrategies(ctx, { id: strategyId, versionId: state.selectedVersionId });
  return res.data.version;
}

function hasSourceChanged(nextSource, currentSource) {
  return normalizeSource(nextSource) !== normalizeSource(currentSource || '');
}

function normalizeSource(source) {
  return String(source || '').replace(/\r\n/g, '\n').trim();
}

async function saveParamsVersion(ctx, strategyId) {
  const form = document.getElementById('strategy-params-form');
  if (!form) return;
  const schema = state.validation?.params_schema || {};
  const values = {};
  try {
    for (const [key, def] of Object.entries(schema)) {
      const input = form.elements[key];
      if (!input) continue;
      values[key] = parseParamValue(input.value, typeof def?.default);
    }
  } catch (err) {
    ctx.toast.err(err.message || 'Parâmetro inválido');
    return;
  }
  const source = updateParamDefaults(state.sourceCode, values);
  if (source === state.sourceCode) {
    ctx.toast.warn('Nenhum parâmetro foi alterado.');
    return;
  }
  await saveSourceVersion(ctx, strategyId, source);
  
  // Go back to parameters tab to see changes
  switchTab('params');
}

function parseParamValue(value, type) {
  if (type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`Valor numérico inválido: ${value}`);
    return num;
  }
  if (type === 'boolean') return String(value) === 'true';
  return String(value);
}

function updateParamDefaults(source, values) {
  let next = String(source || '');
  for (const [name, value] of Object.entries(values)) {
    const literal = glsLiteral(value);
    const re = new RegExp(`(^\\s*param\\s+${escapeRegExp(name)}\\s*=\\s*)(?:"(?:\\\\.|[^"])*"|true|false|null|-?\\d+(?:\\.\\d+)?)`, 'm');
    next = next.replace(re, `$1${literal}`);
  }
  return next;
}

function glsLiteral(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null) return 'null';
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function showGlsHint(cm, automatic = false) {
  if (!window.CodeMirror?.showHint) return;
  cm.showHint({ hint: glsHint, completeSingle: false, closeOnUnfocus: !automatic });
}

function glsHint(cm) {
  const cursor = cm.getCursor();
  const token = cm.getTokenAt(cursor);
  const line = cm.getLine(cursor.line);
  const prefix = line.slice(0, cursor.ch).match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] || '';
  const from = window.CodeMirror.Pos(cursor.line, cursor.ch - prefix.length);
  const to = window.CodeMirror.Pos(cursor.line, cursor.ch);
  const words = buildHintWords();
  const filtered = words.filter((word) => word.text.startsWith(prefix) || word.displayText.startsWith(prefix));
  return { list: filtered.length ? filtered : words.slice(0, 30), from, to };
}

function buildHintWords() {
  const base = [
    'strategy', 'param', 'onEventStart(event)', 'onTick(tick, event)', 'onEventEnd(event)',
    'params', 'state', 'runState', 'position', 'tick', 'event', 'samples',
    'enter(side, { price: ask, budget: params.budget, reason: "entry" })',
    'exit({ price: bid, reason: "exit" })', 'reverse(side, { price: ask, budget: params.budget })',
    'closeOpenPosition({ reason: "event_end" })', 'mark("name")', 'log("name", value)', 'metric("name", value)',
  ].map((text) => ({ text, displayText: text }));
  const blocks = state.blocks.map((block) => ({ text: block.signature.replace('(...)', '('), displayText: block.signature }));
  return [...base, ...blocks];
}

async function createStrategyFlow(ctx) {
  const slug = await promptDialog({ title: 'Nova estratégia', message: 'Slug (ex: simple-ptb):', placeholder: 'minha-estrategia' });
  if (!slug?.trim()) return;
  const name = await promptDialog({ title: 'Nome', message: 'Nome da estratégia:', placeholder: slug }) || slug;
  const created = await ctx.api.post('/api/strategies', { slug: slug.trim(), name: name.trim() });
  if (!created.ok) {
    ctx.toast.err(created.error?.message || 'Falha ao criar');
    return;
  }
  await ctx.api.post(`/api/strategies/${created.data.strategy.id}/versions`, { source_code: GLS_TEMPLATE });
  state.selectedId = created.data.strategy.id;
  ctx.navigate(`strategies/${state.selectedId}`);
  await renderStrategies(ctx, { id: state.selectedId });
}

async function deleteStrategyFlow(ctx, strategy) {
  const ok = await confirmDialog({
    title: 'Apagar estratégia',
    message: `Apagar "${strategy.name}" e todas as versões salvas?`,
    detail: 'Runs antigos permanecem no histórico com o snapshot já gravado.',
    confirmLabel: 'Apagar',
    tone: 'danger',
  });
  if (!ok) return;

  const res = await ctx.api.delete(`/api/strategies/${strategy.id}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao apagar estratégia');
    return;
  }
  ctx.toast.ok('Estratégia apagada');
  state.selectedId = null;
  state.selectedVersionId = null;
  ctx.navigate('strategies');
  await renderStrategies(ctx);
}

async function deleteVersionFlow(ctx, strategy, version) {
  if (!version) return;
  const ok = await confirmDialog({
    title: 'Excluir versão',
    message: `Excluir a versão v${version.version} de "${strategy.name}"?`,
    detail: 'A exclusão só é permitida se a versão não foi usada em nenhum backtest e se não for a última versão da estratégia.',
    confirmLabel: 'Excluir versão',
    tone: 'danger',
  });
  if (!ok) return;
  const res = await ctx.api.delete(`/api/strategies/${strategy.id}/versions/${version.id}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao excluir versão');
    return;
  }
  ctx.toast.ok(`Versão v${version.version} excluída`);
  state.selectedVersionId = null;
  await renderStrategies(ctx, { id: strategy.id });
}

function toggleGlsDrawer(isOpen) {
  let drawer = document.getElementById('gls-help-drawer');
  if (!drawer) {
    drawer = createGlsDrawer();
    document.body.appendChild(drawer);
  }
  drawer.classList.toggle('is-open', isOpen);
  if (isOpen) {
    const input = drawer.querySelector('.drawer-search-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    renderDrawerBlocks('');
  }
}

function createGlsDrawer() {
  return el('div', { class: 'gls-drawer', id: 'gls-help-drawer' }, [
    el('div', { class: 'gls-drawer__header' }, [
      el('h3', {}, 'Ajuda GLS 🛟'),
      el('button', { class: 'btn btn--icon btn--ghost', type: 'button', onclick: () => toggleGlsDrawer(false) }, '✕'),
    ]),
    el('div', { class: 'gls-drawer__body' }, [
      el('section', { class: 'editor-help-card' }, [
        el('h4', { style: { margin: '0 0 8px 0' } }, 'Teclas de Atalho'),
        el('div', { class: 'shortcut-list' }, [
          shortcut('Ctrl+Space', 'Autocomplete'),
          shortcut('Ctrl+S', 'Salvar versão'),
          shortcut('Tab', 'Indentar Código'),
        ]),
      ]),
      el('section', { class: 'editor-help-card' }, [
        el('h4', { style: { margin: '0 0 8px 0' } }, 'Blocos GLS'),
        el('input', {
          class: 'strategy-search-input drawer-search-input',
          type: 'text',
          placeholder: '🔍 Buscar bloco ou assinatura...',
          oninput: (e) => renderDrawerBlocks(e.target.value),
        }),
        el('div', { id: 'drawer-blocks-list-wrap', style: { marginTop: '12px' } }),
        el('p', { class: 'muted', style: { fontSize: '11px', marginTop: '12px' } }, 'Namespaces do runtime: market, book, prices, time, risk, debug. Clique em um bloco para inseri-lo no cursor.'),
      ]),
    ]),
  ]);
}

function renderDrawerBlocks(query = '') {
  const wrap = document.getElementById('drawer-blocks-list-wrap');
  if (!wrap) return;
  const q = query.toLowerCase().trim();
  const filtered = state.blocks.filter(block => 
    block.signature.toLowerCase().includes(q) || 
    (block.description && block.description.toLowerCase().includes(q))
  );
  mount(wrap, el('ul', { class: 'mono-list mono-list--dense', style: { fontSize: '11px', lineHeight: '1.4', paddingLeft: '12px', listStyle: 'none', margin: 0 } }, 
    filtered.length 
      ? filtered.map((block) => el('li', { style: { marginBottom: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' } }, [
          el('code', { 
            style: { display: 'block', color: 'var(--accent)', cursor: 'pointer', fontWeight: 'bold' }, 
            onclick: () => insertBlockIntoEditor(block.signature) 
          }, block.signature),
          block.description ? el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '2px' } }, block.description) : null
        ]))
      : [el('li', { class: 'muted' }, 'Nenhum bloco encontrado.')]
  ));
}

function insertBlockIntoEditor(signature) {
  if (!state.focusedEditor) return;
  const cm = state.focusedEditor;
  const doc = cm.getDoc();
  const cursor = doc.getCursor();
  const cleanSig = signature.split(' -> ')[0].trim();
  doc.replaceRange(cleanSig, cursor);
  cm.focus();
}
