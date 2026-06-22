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

  const header = el('div', { class: 'card__header metrics-card__header' }, [
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

  const kpiStrip = el('div', { class: 'metrics-kpi-strip' }, [
    kpiCell('PnL líquido', formatPnl(metrics.totalPnl ?? 0), tonePnl(metrics.totalPnl), `média ${formatPnl(metrics.avgPnl ?? 0)}`),
    kpiCell('Taxa de acerto', `${formatRate(winRate)}%`, winRate >= 50 ? 'good' : 'bad', `${wins}W · ${losses}L`),
    kpiCell('Drawdown acum.', formatDrawdown(maxDrawdown), 'bad', `recup. ${formatRateValue(metrics.recoveryFactor)}`),
    kpiCell('Fator de lucro', formatRateValue(metrics.profitFactor), (metrics.profitFactor ?? 0) >= 1 ? 'good' : 'bad', `Sharpe ${formatRateValue(metrics.sharpeRatio ?? metrics.sharpe)}`),
  ]);

  const moreMetrics = el('details', { class: 'metrics-more' }, [
    el('summary', { class: 'metrics-more__summary' }, 'Mais métricas'),
    el('div', { class: 'metrics-dense-grid' }, [
      denseItem('Sortino', formatRateValue(metrics.sortinoRatio ?? metrics.sortino)),
      denseItem('Volume', formatVolume(metrics.volume ?? metrics.fees?.volume ?? 0)),
      denseItem('Taxas pagas', formatPnl(metrics.feesPaid ?? metrics.totalFees ?? metrics.fees?.totalFee ?? 0)),
      denseItem('Total operações', String(totalEntries)),
      denseItem('Retorno médio', formatPnl(metrics.avgPnl ?? 0), tonePnl(metrics.avgPnl)),
      denseItem('Média vencedora', formatPnl(metrics.avgWin ?? 0), 'good'),
      denseItem('Média perdedora', formatPnl(metrics.avgLoss ?? 0), 'bad'),
      denseItem('Razão Win/Loss', formatRateValue(metrics.winLossRatio ?? (metrics.avgLoss ? Math.abs(metrics.avgWin / metrics.avgLoss) : 0))),
      denseItem('Maior vitória', formatPnl(metrics.maxWin ?? 0), 'good'),
      denseItem('Maior derrota', formatPnl(metrics.maxLoss ?? 0), 'bad'),
    ]),
  ]);

  return el('section', { class: 'card card--compact metrics-card', id: cardId }, [
    header,
    kpiStrip,
    moreMetrics,
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

function kpiCell(label, value, tone = '', hint = '') {
  let valClass = 'metrics-kpi-cell__value';
  if (tone === 'good') valClass += ' metric-item__value--good';
  if (tone === 'bad') valClass += ' metric-item__value--bad';
  return el('div', { class: 'metrics-kpi-cell' }, [
    el('span', { class: 'metrics-kpi-cell__label' }, label),
    el('span', { class: valClass }, String(value ?? '-')),
    hint ? el('span', { class: 'metrics-kpi-cell__hint muted' }, hint) : null,
  ]);
}

function denseItem(label, value, tone = '') {
  let valClass = 'metrics-dense-item__value';
  if (tone === 'good') valClass += ' metric-item__value--good';
  if (tone === 'bad') valClass += ' metric-item__value--bad';
  return el('div', { class: 'metrics-dense-item' }, [
    el('span', { class: 'metrics-dense-item__label' }, label),
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