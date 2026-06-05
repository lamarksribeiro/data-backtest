import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml, formatPnl, shortId, resultBadgeClass } from '../utils/format.js';
import { destroyActiveChart, renderEquityChart } from '../utils/chart.js';

export async function renderRunDetail(ctx, params) {
  const runId = Number(params.id);
  ctx.setBreadcrumb('backtests', `Run #${runId}`);
  destroyActiveChart();

  mount(ctx.contentEl, el('p', { class: 'muted' }, 'Carregando run...'));

  const [runRes, eventsRes] = await Promise.all([
    ctx.api.get(`/api/backtest/runs/${runId}`),
    ctx.api.get(`/api/backtest/runs/${runId}/events?limit=200`),
  ]);

  if (!runRes.ok) {
    mount(ctx.contentEl, el('section', { class: 'card card--error' }, el('p', {}, runRes.error?.message || 'Run não encontrado')));
    return;
  }

  const run = runRes.data.run;
  const events = eventsRes.ok ? eventsRes.data.events || [] : [];
  const summary = run.summary || {};
  const paramsObj = run.params || {};
  const equity = Array.isArray(run.result?.equity) ? run.result.equity : [];

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, `Run #${run.id}`),
        el('p', { class: 'page-header__sub' }, `${run.strategy} · ${run.underlying} ${run.interval} · ${run.from} → ${run.to}`),
      ]),
    ]),
    el('div', { class: 'grid grid--4' }, metricCards(run, summary)),
    equity.length ? el('section', { class: 'card chart-card' }, [
      el('h2', { class: 'card__title' }, 'Curva de desempenho'),
      el('p', { class: 'muted' }, 'PnL acumulado ao final de cada evento simulado.'),
      el('div', { class: 'chart-wrap chart-wrap--equity' }, el('canvas', { id: 'equity-chart' })),
    ]) : el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Curva de desempenho'),
      emptyState('Este run ainda não tem série de equity.'),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Métricas completas'),
      Object.keys(summary).length
        ? el('pre', { class: 'code-block' }, JSON.stringify(summary, null, 2))
        : el('p', { class: 'muted' }, 'Nenhuma métrica agregada registrada.'),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Parâmetros'),
      Object.keys(paramsObj).length
        ? el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify(paramsObj, null, 2)))
        : el('p', { class: 'muted' }, 'Parâmetros padrão.'),
      run.strategy_snapshot ? el('details', { class: 'details-block' }, [
        el('summary', {}, 'Strategy snapshot'),
        el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify(run.strategy_snapshot, null, 2))),
      ]) : null,
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, `Eventos (${events.length})`),
      events.length ? eventTable(ctx, runId, events) : emptyState('Nenhum evento neste run.'),
    ]),
  ]);

  if (equity.length) renderEquityChart(document.getElementById('equity-chart'), equity);
}

function stat(label, value) {
  return el('div', { class: 'stat stat--compact' }, [
    el('span', { class: 'stat__label' }, label),
    el('span', { class: 'stat__value' }, String(value)),
  ]);
}

function metricCards(run, summary) {
  const totalEntries = summary.totalEntries ?? summary.entries ?? 0;
  const wins = summary.totalWins ?? summary.wins ?? 0;
  const losses = summary.totalLosses ?? summary.losses ?? 0;
  const winRate = summary.winRate ?? (totalEntries > 0 ? (wins / totalEntries) * 100 : 0);
  return [
    stat('Ticks', run.ticks),
    stat('Eventos', summary.totalEvents ?? 0),
    stat('Entradas', totalEntries),
    stat('PnL', formatPnl(summary.totalPnl ?? 0)),
    stat('Win rate', `${formatMetric(winRate)}%`),
    stat('Wins / losses', `${wins} / ${losses}`),
    stat('Drawdown', formatPnl(summary.maxDrawdown ?? 0)),
    stat('Profit factor', formatMetric(summary.profitFactor ?? 0)),
  ];
}

function formatMetric(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? 0);
  return num.toFixed(Math.abs(num) >= 100 ? 1 : 2);
}

function eventTable(ctx, runId, events) {
  return el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'Condition'), el('th', {}, 'Início'), el('th', {}, 'Resultado'), el('th', {}, 'PnL'),
      el('th', {}, 'Lado'), el('th', {}, 'Entradas'), el('th', {}, 'Saídas'), el('th', {}, 'Ticks'), el('th', {}, 'Motivo'),
    ])),
    el('tbody', {}, events.map((event) => el('tr', {}, [
      el('td', {}, el('button', {
        class: 'btn btn--link',
        type: 'button',
        onclick: () => ctx.navigate(`backtests/${runId}/events/${event.id}`),
      }, el('code', {}, shortId(event.condition_id)))),
      el('td', {}, formatTime(event.event_start)),
      el('td', {}, el('span', { class: `badge ${resultBadgeClass(event.result)}` }, event.result || 'n/a')),
      el('td', {}, formatPnl(event.final_pnl)),
      el('td', {}, event.side || '-'),
      el('td', {}, String(event.entries_count)),
      el('td', {}, String(event.exits_count)),
      el('td', {}, String(event.ticks_count ?? 0)),
      el('td', {}, escapeHtml(event.reason || '-')),
    ]))),
  ]);
}

function formatTime(value) {
  if (!value) return '-';
  return new Date(value).toISOString().slice(11, 19);
}
