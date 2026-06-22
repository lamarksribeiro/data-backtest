import { el } from '../utils/dom.js';
import { formatPnl } from '../utils/format.js';
import { enrichSummaryWithEquity } from '../utils/equityMetrics.js';

let viewMode = 'panel';

export function resetMetricsViewMode() {
  viewMode = 'panel';
}

export function renderRunMetricsPanel(summary, { onToggle, cardId = 'run-metrics-card', equity } = {}) {
  return renderGroupedMetrics(summary, { onToggle, cardId, equity });
}

export function renderTimingSection(run, summary) {
  return renderTimingBlock(run, summary);
}

export function renderGroupedMetrics(summary, { onToggle, cardId = 'run-metrics-card', equity } = {}) {
  if (!summary || !Object.keys(summary).length) {
    return el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Métricas completas'),
      el('p', { class: 'muted' }, 'Nenhuma métrica agregada registrada.'),
    ]);
  }

  const toggleBtn = el('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    onclick: () => {
      viewMode = viewMode === 'panel' ? 'json' : 'panel';
      const card = document.getElementById(cardId);
      if (card) {
        const next = renderGroupedMetrics(summary, { cardId, equity });
        card.replaceWith(next);
      } else {
        onToggle?.();
      }
    },
  }, viewMode === 'panel' ? 'Ver JSON' : 'Ver painel');

  const header = el('div', { class: 'card__header', style: { marginBottom: '16px' } }, [
    el('h2', { class: 'card__title' }, 'Métricas da Execução'),
    toggleBtn,
  ]);

  if (viewMode === 'json') {
    return el('section', { class: 'card', id: cardId }, [
      header,
      el('pre', { class: 'code-block' }, JSON.stringify(summary, null, 2)),
    ]);
  }

  const metrics = enrichSummaryWithEquity(summary, equity);
  const totalEntries = metrics.totalEntries ?? metrics.entries ?? 0;
  const wins = metrics.totalWins ?? metrics.wins ?? 0;
  const losses = metrics.totalLosses ?? metrics.losses ?? 0;
  const winRate = metrics.winRate ?? (totalEntries > 0 ? (wins / totalEntries) * 100 : 0);
  const maxDrawdown = metrics.maxDrawdown ?? 0;

  const heroGrid = el('div', { class: 'metrics-hero-grid' }, [
    el('div', { class: `metrics-hero-card metrics-hero-card--pnl-${tonePnl(metrics.totalPnl)}` }, [
      el('span', { class: 'metrics-hero-card__label' }, 'PnL Líquido'),
      el('span', { class: `metrics-hero-card__value metric-item__value--${tonePnl(metrics.totalPnl)}` }, formatPnl(metrics.totalPnl ?? 0)),
      el('span', { class: 'metrics-hero-card__sub' }, [
        'Retorno Médio: ',
        el('strong', { class: `pnl-${tonePnl(metrics.avgPnl)}` }, formatPnl(metrics.avgPnl ?? 0)),
      ]),
    ]),
    el('div', { class: 'metrics-hero-card metrics-hero-card--winrate' }, [
      el('span', { class: 'metrics-hero-card__label' }, 'Taxa de Acerto'),
      el('span', { class: 'metrics-hero-card__value' }, `${formatRate(winRate)}%`),
      el('div', { class: 'win-rate-progress-wrap' }, [
        el('div', { class: 'win-rate-progress-bar', style: { width: `${Math.min(100, Math.max(0, winRate))}%` } }),
      ]),
      el('span', { class: 'metrics-hero-card__sub' }, [
        el('strong', {}, String(wins)), ' vitórias / ',
        el('strong', {}, String(losses)), ' derrotas',
      ]),
    ]),
    el('div', { class: 'metrics-hero-card metrics-hero-card--drawdown' }, [
      el('span', { class: 'metrics-hero-card__label' }, 'Drawdown Máximo'),
      el('span', { class: 'metrics-hero-card__value metric-item__value--bad' }, formatDrawdown(maxDrawdown)),
      el('span', { class: 'metrics-hero-card__sub' }, [
        'Fator Recuperação: ',
        el('strong', {}, formatRateValue(metrics.recoveryFactor)),
      ]),
    ]),
    el('div', { class: 'metrics-hero-card metrics-hero-card--factor' }, [
      el('span', { class: 'metrics-hero-card__label' }, 'Fator de Lucro'),
      el('span', { class: `metrics-hero-card__value metric-item__value--${(metrics.profitFactor ?? 0) >= 1 ? 'good' : 'bad'}` }, formatRateValue(metrics.profitFactor)),
      el('span', { class: 'metrics-hero-card__sub' }, [
        'Sharpe: ',
        el('strong', {}, formatRateValue(metrics.sharpeRatio ?? metrics.sharpe)),
        ' | Sortino: ',
        el('strong', {}, formatRateValue(metrics.sortinoRatio ?? metrics.sortino)),
      ]),
    ]),
  ]);

  return el('section', { class: 'card', id: cardId }, [
    header,
    heroGrid,
    el('div', { class: 'metrics-dashboard-grid' }, [
      metricsGroup('Geral & Risco', [
        metricItem('Volume Operado', formatVolume(metrics.volume ?? metrics.fees?.volume ?? 0)),
        metricItem('Taxas Pagas', formatPnl(metrics.feesPaid ?? metrics.totalFees ?? metrics.fees?.totalFee ?? 0)),
        metricItem('Sharpe Ratio', formatRateValue(metrics.sharpeRatio ?? metrics.sharpe)),
        metricItem('Sortino Ratio', formatRateValue(metrics.sortinoRatio ?? metrics.sortino)),
        metricItem('Fator Recuperação', formatRateValue(metrics.recoveryFactor)),
        metricItem('Fator de Lucro', formatRateValue(metrics.profitFactor), (metrics.profitFactor ?? 0) >= 1 ? 'good' : 'bad'),
      ]),
      metricsGroup('Assertividade', [
        metricItem('Total Operações', totalEntries),
        metricItem('Vitórias (Win)', wins, 'good'),
        metricItem('Derrotas (Loss)', losses, 'bad'),
        metricItem('Taxa de Acerto', `${formatRate(winRate)}%`, winRate >= 50 ? 'good' : 'bad'),
      ], winRate),
      metricsGroup('Médias e Limites', [
        metricItem('Retorno Médio', formatPnl(metrics.avgPnl ?? 0), tonePnl(metrics.avgPnl)),
        metricItem('Média Vencedora', formatPnl(metrics.avgWin ?? 0), 'good'),
        metricItem('Média Perdedora', formatPnl(metrics.avgLoss ?? 0), 'bad'),
        metricItem('Razão Win/Loss', formatRateValue(metrics.winLossRatio ?? (metrics.avgLoss ? Math.abs(metrics.avgWin / metrics.avgLoss) : 0))),
        metricItem('Maior Vitória', formatPnl(metrics.maxWin ?? 0), 'good'),
        metricItem('Maior Derrota', formatPnl(metrics.maxLoss ?? 0), 'bad'),
      ]),
    ]),
  ]);
}

export function renderTimingBlock(run, summary) {
  const timings = summary?.timings || run?.result?.timings || {};
  const totalMs = timings.totalMs ?? run?.duration_ms;
  const hasTiming = [totalMs, timings.duckdbReadMs, timings.processMs, timings.finishMs, timings.sqliteWriteMs].some((v) => v != null);
  if (!hasTiming) return null;
  const ticks = Number(run?.ticks || summary?.ticksProcessed || 0);
  const totalSeconds = Number(totalMs || 0) / 1000;
  const ticksPerSecond = ticks > 0 && totalSeconds > 0 ? ticks / totalSeconds : null;
  return el('details', { class: 'card timing-compact' }, [
    el('summary', { class: 'timing-compact__summary' }, [
      el('strong', {}, 'Execução'),
      el('span', {}, `Total ${formatDuration(totalMs)}`),
      el('span', {}, `DuckDB ${formatDuration(timings.duckdbReadMs ?? timings.loadMs)}`),
      el('span', {}, `Processamento ${formatDuration(timings.processMs)}`),
      el('span', {}, `Ticks/s ${ticksPerSecond == null ? '-' : formatMetric(ticksPerSecond)}`),
    ]),
    el('div', { class: 'timing-compact__details grid grid--4' }, [
      stat('Finalização', formatDuration(timings.finishMs)),
      stat('SQLite', formatDuration(timings.sqliteWriteMs)),
      stat('Overhead', formatDuration(timings.overheadMs)),
      stat('Batches', String(run?.batches ?? 0)),
    ]),
  ]);
}

function metricsGroup(title, items, winRate = null) {
  const group = el('div', { class: 'metrics-group-card' }, [
    el('h3', { class: 'metrics-group-title' }, title),
    el('div', { class: 'metrics-grid' }, items),
  ]);
  if (winRate != null) {
    group.appendChild(el('div', { class: 'win-rate-progress-wrap' }, [
      el('div', { class: 'win-rate-progress-bar', style: { width: `${Math.min(100, Math.max(0, winRate))}%` } }),
    ]));
  }
  return group;
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

function stat(label, value) {
  return el('div', { class: 'stat stat--compact' }, [
    el('span', { class: 'stat__label' }, label),
    el('span', { class: 'stat__value' }, value),
  ]);
}

function tonePnl(value) {
  const n = Number(value ?? 0);
  if (n > 0) return 'good';
  if (n < 0) return 'bad';
  return '';
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

function formatDrawdown(value) {
  const magnitude = Math.abs(Number(value) || 0);
  if (magnitude <= 0) return formatPnl(0);
  return `-${formatPnl(magnitude)}`;
}
