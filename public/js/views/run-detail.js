import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml, formatPnl, shortId, resultBadgeClass } from '../utils/format.js';
import { destroyActiveChart, renderEquityChart } from '../utils/chart.js';

let metricsViewMode = 'panel';

export async function renderRunDetail(ctx, params) {
  metricsViewMode = 'panel'; // Reset status on load
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
  const equity = Array.isArray(run.equity) ? run.equity : (Array.isArray(run.result?.equity) ? run.result.equity : []);

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, `Run #${run.id}`),
        el('p', { class: 'page-header__sub' }, `${run.strategy} · ${run.underlying} ${run.interval} · ${run.from} → ${run.to}`),
      ]),
    ]),
    el('div', { class: 'grid grid--4' }, metricCards(run, summary)),
    run.status === 'failed_runtime' ? failedRunCard(run, summary) : null,
    equity.length ? el('section', { class: 'card chart-card' }, [
      el('h2', { class: 'card__title' }, 'Curva de desempenho'),
      el('p', { class: 'muted' }, 'PnL acumulado ao final de cada evento simulado.'),
      el('div', { class: 'chart-wrap chart-wrap--equity' }, el('canvas', { id: 'equity-chart' })),
    ]) : el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Curva de desempenho'),
      emptyState('Este run ainda não tem série de equity.'),
    ]),
    el('section', { class: 'card', id: 'run-metrics-card' }, renderMetricsSection(summary)),
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

function stat(label, value, iconClass) {
  return el('div', { class: 'stat stat--compact' }, [
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } }, [
      el('span', { class: 'stat__label', style: { margin: 0 } }, label),
      iconClass ? el('i', { class: iconClass, style: { fontSize: '12px', opacity: 0.8 } }) : null,
    ]),
    el('span', { class: 'stat__value' }, String(value)),
  ]);
}

function metricCards(run, summary) {
  const totalEntries = summary.totalEntries ?? summary.entries ?? 0;
  const wins = summary.totalWins ?? summary.wins ?? 0;
  const losses = summary.totalLosses ?? summary.losses ?? 0;
  const winRate = summary.winRate ?? (totalEntries > 0 ? (wins / totalEntries) * 100 : 0);
  return [
    stat('Ticks', run.ticks, 'fa-solid fa-wave-square'),
    stat('Eventos', summary.totalEvents ?? 0, 'fa-solid fa-bolt'),
    stat('Entradas', totalEntries, 'fa-solid fa-right-to-bracket'),
    stat('PnL', formatPnl(summary.totalPnl ?? 0), 'fa-solid fa-wallet'),
    stat('Win rate', `${formatMetric(winRate)}%`, 'fa-solid fa-bullseye'),
    stat('Wins / losses', `${wins} / ${losses}`, 'fa-solid fa-scale-balanced'),
    stat('Drawdown', formatPnl(summary.maxDrawdown ?? 0), 'fa-solid fa-arrow-trend-down'),
    stat('Profit factor', formatMetric(summary.profitFactor ?? 0), 'fa-solid fa-arrow-trend-up'),
  ];
}

function failedRunCard(run, summary) {
  const timings = summary.timings || run.result?.timings || {};
  return el('section', { class: 'card card--error' }, [
    el('h2', { class: 'card__title' }, 'Falha da execução'),
    el('p', {}, escapeHtml(run.error || summary.error || 'Erro não registrado.')),
    el('div', { class: 'grid grid--4', style: { marginTop: '12px' } }, [
      stat('Ticks processados', summary.ticksProcessed ?? run.ticks ?? 0, 'fa-solid fa-wave-square'),
      stat('Carga DuckDB', formatDuration(timings.loadMs), 'fa-solid fa-database'),
      stat('Processamento', formatDuration(timings.processMs), 'fa-solid fa-stopwatch'),
      stat('Escrita SQLite', formatDuration(timings.sqliteWriteMs), 'fa-solid fa-hard-drive'),
    ]),
  ]);
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '-';
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s`;
}

function formatMetric(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? 0);
  return num.toFixed(Math.abs(num) >= 100 ? 1 : 2);
}

function eventTable(ctx, runId, events) {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
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
    ])
  ]);
}

function formatTime(value) {
  if (!value) return '-';
  return new Date(value).toISOString().slice(11, 19);
}

function renderMetricsSection(summary) {
  if (!Object.keys(summary).length) {
    return [
      el('h2', { class: 'card__title' }, 'Métricas completas'),
      el('p', { class: 'muted' }, 'Nenhuma métrica agregada registrada.')
    ];
  }

  const toggleBtn = el('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    onclick: () => {
      const card = document.getElementById('run-metrics-card');
      if (card) {
        metricsViewMode = metricsViewMode === 'panel' ? 'json' : 'panel';
        mount(card, renderMetricsSection(summary));
      }
    }
  }, metricsViewMode === 'panel' ? 'Ver JSON Bruto' : 'Ver Painel Visual');

  const header = el('div', { class: 'card__header' }, [
    el('h2', { class: 'card__title' }, 'Métricas completas'),
    toggleBtn
  ]);

  if (metricsViewMode === 'json') {
    return [
      header,
      el('pre', { class: 'code-block' }, JSON.stringify(summary, null, 2))
    ];
  }

  // Visual panel representation
  const totalEntries = summary.totalEntries ?? summary.entries ?? 0;
  const wins = summary.totalWins ?? summary.wins ?? 0;
  const losses = summary.totalLosses ?? summary.losses ?? 0;
  const winRate = summary.winRate ?? (totalEntries > 0 ? (wins / totalEntries) * 100 : 0);

  const grid = el('div', { class: 'metrics-dashboard-grid' }, [
    // Group 1: Geral
    el('div', { class: 'metrics-group-card' }, [
      el('h3', { class: 'metrics-group-title' }, 'Visão Geral'),
      el('div', { class: 'metrics-grid' }, [
        metricItem('PnL Líquido', formatPnl(summary.totalPnl ?? 0), (summary.totalPnl ?? 0) > 0 ? 'good' : (summary.totalPnl ?? 0) < 0 ? 'bad' : ''),
        metricItem('Drawdown Máximo', formatPnl(summary.maxDrawdown ?? 0), 'bad'),
        metricItem('Volume Operado', formatVolume(summary.volume ?? 0)),
        metricItem('Taxas Pagas', formatPnl(summary.feesPaid ?? summary.totalFees ?? 0)),
        metricItem('Sharpe Ratio', formatRateValue(summary.sharpeRatio)),
        metricItem('Sortino Ratio', formatRateValue(summary.sortinoRatio)),
      ])
    ]),
    // Group 2: Trades
    el('div', { class: 'metrics-group-card' }, [
      el('h3', { class: 'metrics-group-title' }, 'Assertividade'),
      el('div', { class: 'metrics-grid' }, [
        metricItem('Total Operações', totalEntries),
        metricItem('Vitórias (Wins)', wins, 'good'),
        metricItem('Derrotas (Losses)', losses, 'bad'),
        metricItem('Taxa de Acerto', `${formatRate(winRate)}%`, winRate >= 50 ? 'good' : 'bad'),
        metricItem('Fator de Lucro', formatRateValue(summary.profitFactor), (summary.profitFactor ?? 0) >= 1 ? 'good' : 'bad'),
        metricItem('Fator Recuperação', formatRateValue(summary.recoveryFactor)),
      ]),
      el('div', { class: 'win-rate-progress-wrap' }, [
        el('div', { class: 'win-rate-progress-bar', style: { width: `${Math.min(100, Math.max(0, winRate))}%` } })
      ])
    ]),
    // Group 3: Médias
    el('div', { class: 'metrics-group-card' }, [
      el('h3', { class: 'metrics-group-title' }, 'Médias e Limites'),
      el('div', { class: 'metrics-grid' }, [
        metricItem('Retorno Médio', formatPnl(summary.avgPnl ?? 0), (summary.avgPnl ?? 0) > 0 ? 'good' : (summary.avgPnl ?? 0) < 0 ? 'bad' : ''),
        metricItem('Média Vencedora', formatPnl(summary.avgWin ?? 0), 'good'),
        metricItem('Média Perdedora', formatPnl(summary.avgLoss ?? 0), 'bad'),
        metricItem('Razão Win/Loss', formatRateValue(summary.winLossRatio ?? (summary.avgLoss ? Math.abs(summary.avgWin / summary.avgLoss) : 0))),
        metricItem('Maior Vitória', formatPnl(summary.maxWin ?? 0), 'good'),
        metricItem('Maior Derrota', formatPnl(summary.maxLoss ?? 0), 'bad'),
      ])
    ]),
  ]);

  return [
    header,
    grid
  ];
}

function metricItem(label, value, tone = '') {
  let valClass = 'metric-item__value';
  if (tone === 'good') valClass += ' metric-item__value--good';
  if (tone === 'bad') valClass += ' metric-item__value--bad';
  
  return el('div', { class: 'metric-item' }, [
    el('span', { class: 'metric-item__label' }, label),
    el('span', { class: valClass }, String(value ?? '-')),
  ]);
}

function formatVolume(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val ?? '-');
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
}

function formatRate(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val ?? '0');
  return num.toFixed(1);
}

function formatRateValue(val) {
  if (val == null) return '-';
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  return num.toFixed(2);
}
