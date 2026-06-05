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

/** @type {{ list: object[], selectedId: number|null, selectedVersionId: number|null, focusedEditor: object|null, sourceCode: string, validation: object|null, blocks: object[], currentStrategy: object|null, currentVersion: object|null }} */
const state = { list: [], selectedId: null, selectedVersionId: null, focusedEditor: null, sourceCode: '', validation: null, blocks: [], currentStrategy: null, currentVersion: null };

export async function renderStrategies(ctx, params = {}) {
  const strategyId = params.id ? Number(params.id) : null;
  if (strategyId) state.selectedId = strategyId;
  ctx.setBreadcrumb('strategies', null);

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Estratégias'),
        el('p', { class: 'page-header__sub' }, 'Editor GLS, validação e versões.'),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => createStrategyFlow(ctx) }, 'Nova'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => renderStrategies(ctx) }, 'Recarregar'),
      ]),
    ]),
    el('div', { class: 'editor-layout', id: 'strategies-root' }, el('p', { class: 'muted' }, 'Carregando...')),
  ]);

  const res = await ctx.api.get('/api/strategies');
  if (!res.ok) {
    mount(document.getElementById('strategies-root'), el('p', { class: 'bad' }, res.error?.message || 'Falha'));
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
    el('aside', { class: 'editor-meta card', id: 'strategy-meta' }),
  ]);

  if (state.selectedId) await openStrategyEditor(ctx, state.selectedId, params.versionId ? Number(params.versionId) : null);
}

function renderStrategyList(ctx) {
  if (!state.list.length) return emptyState('Nenhuma estratégia salva.');
  return el('ul', { class: 'strategy-list' }, state.list.map((strategy) => el('li', {}, [
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
      el('div', {}, strategy.name),
      el('div', { class: 'muted mono' }, `${strategy.slug} · v${strategy.latest_version ?? '-'} · ${strategy.status}`),
    ]),
  ])));
}

async function openStrategyEditor(ctx, strategyId, versionId = null) {
  const editorPanel = document.getElementById('strategy-editor');
  const metaPanel = document.getElementById('strategy-meta');
  if (!editorPanel || !metaPanel) return;

  const [strategyRes, versionsRes, blocksRes] = await Promise.all([
    ctx.api.get(`/api/strategies/${strategyId}`),
    ctx.api.get(`/api/strategies/${strategyId}/versions`),
    ctx.api.get('/api/strategy-blocks'),
  ]);
  if (!strategyRes.ok) {
    mount(editorPanel, el('p', { class: 'bad' }, strategyRes.error?.message || 'Falha'));
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
  const hasParams = Object.keys(state.validation?.params_schema || version?.params_schema || {}).length > 0;

  mount(editorPanel, [
    el('div', { class: 'editor-main__header' }, [
      el('div', { class: 'editor-title-block' }, [
        el('h2', { class: 'card__title', id: 'strategy-title' }, strategy.name),
        el('p', { class: 'muted mono editor-title-block__meta', id: 'strategy-title-meta' }, `${strategy.slug} · ${strategy.status} · v${strategy.latest_version ?? '-'}`),
      ]),
      el('div', { class: 'row row--wrap editor-toolbar' }, [
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: !hasParams, onclick: () => saveParamsVersion(ctx, strategy.id) }, 'Salvar parâmetros'),
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => openFocusedCodeEditor(ctx, strategy, version) }, 'Editar código'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => validateStrategySource(ctx) }, 'Validar'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => runStrategyBacktest(ctx, strategyId) }, 'Executar backtest'),
        el('button', { class: 'btn btn--danger btn--sm', type: 'button', onclick: () => deleteStrategyFlow(ctx, strategy) }, 'Apagar'),
      ]),
    ]),
    renderVersionSelector(ctx, strategyId, versions, version),
    renderStrategyWorkbench(ctx, strategy, version),
  ]);

  mount(metaPanel, [
    el('div', { class: 'editor-meta__scroll' }, [
      el('section', { class: 'editor-meta-section' }, [
        el('h3', { class: 'card__title' }, 'Dados da estratégia'),
        renderStrategyMetaForm(ctx, strategy),
      ]),
      el('section', { class: 'editor-meta-section' }, [
        el('h3', { class: 'card__title' }, 'Parâmetros'),
        el('div', { id: 'strategy-params', class: 'params-list params-list--compact' }, renderParamsSummary(state.validation)),
      ]),
      el('section', { class: 'editor-meta-section' }, [
        el('h3', { class: 'card__title' }, 'Blocos'),
        el('ul', { class: 'mono-list' }, state.blocks.slice(0, 14).map((block) => el('li', {}, el('code', {}, block.signature)))),
        el('p', { class: 'muted' }, 'Namespaces: market, book, prices, time, risk, debug.'),
      ]),
    ]),
  ]);
}

function renderVersionSelector(ctx, strategyId, versions, version) {
  return el('div', { class: 'strategy-version-card' }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Versão ativa'),
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
        ? versions.map((item) => el('option', { value: item.id, selected: item.id === version?.id }, `v${item.version} · ${item.created_at}`))
        : [el('option', { value: '' }, 'Sem versões')]),
    ]),
    el('div', { class: 'strategy-version-card__status' }, renderValidationBadge(state.validation)),
  ]);
}

function renderStrategyWorkbench(ctx, strategy, version) {
  const schema = state.validation?.params_schema || version?.params_schema || {};
  const keys = Object.keys(schema);
  return el('div', { class: 'strategy-workbench', id: 'strategy-workbench-root' }, [
    keys.length ? renderParamsForm(schema) : emptyState('Esta versão não declara parâmetros editáveis.'),
    el('div', { id: 'strategy-validation' }, renderValidationDetails(state.validation)),
  ]);
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
  const paramsPanel = document.getElementById('strategy-params');
  if (panel) mount(panel, renderValidationDetails(validation));
  if (paramsPanel) mount(paramsPanel, renderParamsSummary(validation));
}

function renderValidationBadge(validation) {
  if (!validation) return el('span', { class: 'badge badge--idle' }, 'Não validado');
  return el('span', { class: `badge ${validation.ok ? 'badge--ok' : 'badge--err'}` }, validation.ok ? 'Válido' : 'Inválido');
}

function renderValidationDetails(validation) {
  if (!validation) return null;
  const errors = validation.errors || [];
  const warnings = validation.warnings || [];
  return el('div', { class: 'validation-panel' }, [
    renderValidationBadge(validation),
    errors.length ? el('ul', { class: 'validation-list' }, errors.map((item) => el('li', { class: 'is-error' }, `L${item.line}:${item.column} · ${item.message}`))) : null,
    warnings.length ? el('ul', { class: 'validation-list' }, warnings.map((item) => el('li', { class: 'is-warn' }, item.message))) : null,
  ]);
}

function renderParamsSummary(validation) {
  const schema = validation?.params_schema || {};
  const keys = Object.keys(schema);
  return keys.length
    ? keys.map((key) => el('div', { class: 'param-row' }, [
      el('code', { class: 'param-row__key', title: key }, key),
      el('span', { class: 'param-row__value', title: String(schema[key]?.default ?? '') }, String(schema[key]?.default ?? '')),
    ]))
    : el('p', { class: 'muted' }, 'Nenhum param detectado.');
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
    el('button', { class: 'btn btn--ghost btn--sm', type: 'submit' }, 'Salvar dados'),
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
  if (titleMeta) titleMeta.textContent = `${updated.slug} · ${updated.status} · v${updated.latest_version ?? '-'}`;
  const listPanel = document.getElementById('strategy-list-panel');
  if (listPanel) mount(listPanel, renderStrategyList(ctx));
  ctx.toast.ok('Dados da estratégia atualizados');
}

async function saveStrategyVersion(ctx, strategyId) {
  return saveSourceVersion(ctx, strategyId, state.sourceCode);
}

async function saveSourceVersion(ctx, strategyId, source) {
  const validation = await validateStrategySource(ctx, source);
  if (!validation?.ok) {
    ctx.toast.warn('Corrija a validação antes de salvar a versão.');
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
  ctx.toast.ok(`Versão v${res.data.version.version} salva`);
  await renderStrategies(ctx, { id: strategyId, versionId: state.selectedVersionId });
  return res.data.version;
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

function openFocusedCodeEditor(ctx, strategy, version) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.setAttribute('aria-hidden', 'false');
  const textareaId = `focused-strategy-source-${strategy.id}`;
  const validationId = `focused-strategy-validation-${strategy.id}`;
  const overlay = el('div', { class: 'code-workspace-overlay' }, [
    el('section', { class: 'code-workspace', role: 'dialog', 'aria-modal': 'true' }, [
      el('header', { class: 'code-workspace__header' }, [
        el('div', { class: 'code-workspace__title' }, [
          el('span', { class: 'eyebrow' }, 'Editor GLS'),
          el('h2', {}, strategy.name),
          el('p', { class: 'muted mono' }, `${strategy.slug} · v${version?.version ?? '-'} · Ctrl+Space autocomplete · Ctrl+S salvar`),
        ]),
        el('div', { class: 'row row--wrap code-workspace__actions' }, [
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => validateFocusedEditor(ctx, validationId) }, 'Validar'),
          el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => saveFocusedEditor(ctx, strategy.id) }, 'Salvar versão'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => closeFocusedEditor(ctx, root, overlay, true) }, 'Aplicar e fechar'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => closeFocusedEditor(ctx, root, overlay, false) }, 'Fechar'),
        ]),
      ]),
      el('div', { class: 'code-workspace__body' }, [
        el('div', { class: 'code-workspace__editor' }, el('textarea', { id: textareaId }, state.sourceCode)),
        el('aside', { class: 'code-workspace__side' }, [
          el('section', { class: 'editor-help-card' }, [
            el('h3', {}, 'Assistente'),
            el('p', { class: 'muted' }, 'Use autocomplete para blocos, hooks, variáveis do runtime e funções de ordem.'),
            el('div', { class: 'shortcut-list' }, [
              shortcut('Ctrl+Space', 'autocomplete'),
              shortcut('Ctrl+S', 'salvar versão'),
              shortcut('Esc', 'fechar'),
            ]),
          ]),
          el('section', { class: 'editor-help-card' }, [
            el('h3', {}, 'Blocos disponíveis'),
            el('ul', { class: 'mono-list mono-list--dense' }, state.blocks.slice(0, 28).map((block) => el('li', {}, el('code', {}, block.signature)))),
          ]),
          el('section', { class: 'editor-help-card', id: validationId }, renderValidationDetails(state.validation)),
        ]),
      ]),
    ]),
  ]);
  root.appendChild(overlay);
  const editor = window.CodeMirror.fromTextArea(document.getElementById(textareaId), {
    mode: 'javascript',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true,
    autofocus: true,
    extraKeys: {
      'Ctrl-Space': (cm) => showGlsHint(cm),
      'Ctrl-S': async (cm) => {
        state.sourceCode = cm.getValue();
        await saveFocusedEditor(ctx, strategy.id);
      },
      Esc: () => closeFocusedEditor(ctx, root, overlay, false),
      Tab: (cm) => cm.execCommand('indentMore'),
    },
  });
  state.focusedEditor = editor;
  editor.on('inputRead', (cm, change) => {
    if (!change.text?.[0] || /\s/.test(change.text[0])) return;
    if (/[A-Za-z_.]/.test(change.text[0])) showGlsHint(cm, true);
  });
  window.setTimeout(() => editor.refresh(), 0);
}

function shortcut(keys, label) {
  return el('div', { class: 'shortcut-row' }, [el('kbd', {}, keys), el('span', {}, label)]);
}

async function validateFocusedEditor(ctx, validationId) {
  state.sourceCode = state.focusedEditor?.getValue() || state.sourceCode;
  const validation = await validateStrategySource(ctx, state.sourceCode);
  const panel = document.getElementById(validationId);
  if (panel) mount(panel, renderValidationDetails(validation));
}

async function saveFocusedEditor(ctx, strategyId) {
  state.sourceCode = state.focusedEditor?.getValue() || state.sourceCode;
  await saveSourceVersion(ctx, strategyId, state.sourceCode);
}

async function closeFocusedEditor(ctx, root, overlay, applyChanges) {
  if (applyChanges) state.sourceCode = state.focusedEditor?.getValue() || state.sourceCode;
  if (state.focusedEditor) {
    state.focusedEditor.toTextArea();
    state.focusedEditor = null;
  }
  overlay.remove();
  root.setAttribute('aria-hidden', root.children.length ? 'false' : 'true');
  if (applyChanges) await refreshWorkbench(ctx);
}

async function refreshWorkbench(ctx) {
  if (!state.currentStrategy) return;
  await validateStrategySource(ctx, state.sourceCode);
  const root = document.getElementById('strategy-workbench-root');
  if (root?.parentElement) mount(root.parentElement, renderStrategyWorkbench(ctx, state.currentStrategy, state.currentVersion));
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

async function runStrategyBacktest(ctx, strategyId) {
  if (!state.selectedVersionId) {
    ctx.toast.warn('Salve uma versão válida antes de executar.');
    return;
  }
  const ok = await confirmDialog({
    title: 'Executar backtest GLS',
    message: 'Executar backtest com o contexto global (datas/ativo)?',
    tone: 'primary',
    confirmLabel: 'Executar',
  });
  if (!ok) return;

  const formCtx = loadContext();
  const payload = backtestPayloadFromPick(`gls:${strategyId}:${state.selectedVersionId}`, formCtx);
  const res = await ctx.api.post('/api/backtest/run', payload);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao executar backtest');
    return;
  }
  const pnl = res.data.result?.summary?.totalPnl ?? 0;
  ctx.toast.ok(`Backtest #${res.data.run.id} concluído · PnL ${pnl}`);
  ctx.navigate(`backtests/${res.data.run.id}`);
}
