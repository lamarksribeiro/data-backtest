import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml } from '../utils/format.js';
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

/** @type {{ list: object[], selectedId: number|null, selectedVersionId: number|null, editor: object|null, validation: object|null }} */
const state = { list: [], selectedId: null, selectedVersionId: null, editor: null, validation: null };

export async function renderStrategies(ctx, params = {}) {
  const strategyId = params.id ? Number(params.id) : null;
  if (strategyId) state.selectedId = strategyId;
  ctx.setBreadcrumb('strategies', state.selectedId ? `Estratégia #${state.selectedId}` : null);

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
  if (!state.selectedId && state.list.length) state.selectedId = state.list[0].id;

  mount(document.getElementById('strategies-root'), [
    el('aside', { class: 'editor-sidebar card' }, renderStrategyList(ctx)),
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
  const versions = versionsRes.ok ? versionsRes.data.versions || [] : [];
  const version = versionId
    ? versions.find((item) => item.id === versionId) || versions[0]
    : versions[0];
  state.selectedVersionId = version?.id ?? null;

  if (state.editor) {
    state.editor.toTextArea();
    state.editor = null;
  }

  mount(editorPanel, [
    el('h2', { class: 'card__title' }, strategy.name),
    el('div', { class: 'row row--wrap editor-toolbar' }, [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => validateStrategyEditor(ctx) }, 'Validar'),
      el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => saveStrategyVersion(ctx, strategyId) }, 'Salvar versão'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => runStrategyBacktest(ctx, strategyId) }, 'Executar backtest'),
      el('button', { class: 'btn btn--danger btn--sm', type: 'button', onclick: () => deleteStrategyFlow(ctx, strategy) }, 'Apagar'),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Versão'),
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
    el('textarea', { id: 'strategy-source' }, version?.source_code || GLS_TEMPLATE),
    el('div', { id: 'strategy-validation' }),
  ]);

  mount(metaPanel, [
    el('h3', { class: 'card__title' }, 'Parâmetros'),
    el('div', { id: 'strategy-params', class: 'params-list' }, el('p', { class: 'muted' }, 'Valide o código para detectar params.')),
    el('h3', { class: 'card__title' }, 'Blocos MVP'),
    el('ul', { class: 'mono-list' }, (blocksRes.data?.blocks || []).slice(0, 12).map((block) => el('li', {}, el('code', {}, block.signature)))),
    el('p', { class: 'muted' }, 'Namespaces: market, book, prices, time, risk, debug.'),
  ]);

  state.editor = window.CodeMirror.fromTextArea(document.getElementById('strategy-source'), {
    mode: 'javascript',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true,
  });

  if (version?.validation) renderValidation(version.validation);
}

async function validateStrategyEditor(ctx) {
  const source = state.editor?.getValue() || '';
  const res = await ctx.api.post('/api/strategies/validate', { source_code: source });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao validar');
    return;
  }
  renderValidation(res.data.validation);
}

function renderValidation(validation) {
  state.validation = validation;
  const panel = document.getElementById('strategy-validation');
  const paramsPanel = document.getElementById('strategy-params');
  if (panel) {
    const errors = validation.errors || [];
    const warnings = validation.warnings || [];
    mount(panel, [
      el('span', { class: `badge ${validation.ok ? 'badge--ok' : 'badge--err'}` }, validation.ok ? 'Válido' : 'Inválido'),
      errors.length ? el('ul', { class: 'validation-list' }, errors.map((item) => el('li', { class: 'is-error' }, `L${item.line}:${item.column} · ${item.message}`))) : null,
      warnings.length ? el('ul', { class: 'validation-list' }, warnings.map((item) => el('li', { class: 'is-warn' }, item.message))) : null,
    ]);
  }
  if (paramsPanel) {
    const schema = validation.params_schema || {};
    const keys = Object.keys(schema);
    mount(paramsPanel, keys.length
      ? keys.map((key) => el('div', { class: 'param-row' }, [el('code', {}, key), el('span', {}, String(schema[key]?.default ?? ''))]))
      : el('p', { class: 'muted' }, 'Nenhum param detectado.'));
  }
}

async function saveStrategyVersion(ctx, strategyId) {
  const source = state.editor?.getValue() || '';
  const res = await ctx.api.post(`/api/strategies/${strategyId}/versions`, { source_code: source });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao salvar versão');
    return;
  }
  state.selectedVersionId = res.data.version.id;
  ctx.toast.ok(`Versão v${res.data.version.version} salva`);
  await renderStrategies(ctx, { id: strategyId, versionId: state.selectedVersionId });
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
