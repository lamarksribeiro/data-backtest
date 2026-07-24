import { el } from '../utils/dom.js';
import { formatStoredRange } from '../utils/dateRange.js';
import { StatusBadge } from './Skeleton.js';

export function formatRunDateRange(from, to) {
  return formatStoredRange(from, to);
}

export function intervalBadgeClass(interval) {
  const key = String(interval || '').toLowerCase();
  if (['5m', '15m', '1h', '4h'].includes(key)) return `interval-badge--${key}`;
  return 'interval-badge--unknown';
}

export function formatIntervalLabel(interval) {
  const text = String(interval || '');
  const match = text.match(/^(\d+)([mhd])$/);
  if (!match) return text || '—';
  const unit = { m: 'min', h: 'h', d: 'd' }[match[2]];
  return `${match[1]} ${unit}`;
}

function strategyName(run) {
  return run.strategy_snapshot?.name || run.strategy || '—';
}

function versionLabel(run) {
  return run.strategy_snapshot?.version != null
    ? `v${run.strategy_snapshot.version}`
    : (run.strategy_version_id ? `#${run.strategy_version_id}` : null);
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s`;
}

function renderAssetChips(run) {
  const underlying = run.underlying || '—';
  const interval = run.interval || '—';
  const bookDepth = run.bookDepth ?? run.book_depth;

  return el('div', { class: 'run-context-banner__chips' }, [
    el('div', { class: 'asset-label' }, [
      el('div', { class: 'asset-label__text' }, [
        el('div', { class: 'asset-label__primary' }, underlying),
        bookDepth != null ? el('div', { class: 'asset-label__sub muted' }, `Book top ${bookDepth}`) : null,
      ]),
    ]),
    el('span', { class: `interval-badge interval-badge--md ${intervalBadgeClass(interval)}` }, formatIntervalLabel(interval)),
  ]);
}

export function renderRunContextBanner(run, {
  compact = false,
  showId = true,
  showStatus = true,
  onUsePeriod = null,
} = {}) {
  const period = formatRunDateRange(run.from, run.to);
  const version = versionLabel(run);

  const headChildren = [];
  if (showId) headChildren.push(el('strong', { class: 'run-context-banner__id' }, `Backtest #${run.id}`));
  if (showStatus && run.status) headChildren.push(StatusBadge({ status: run.status }));

  const periodActions = onUsePeriod
    ? el('div', { class: 'run-context-banner__period-actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm run-context-banner__use-period',
        title: 'Copiar período e ativo para o formulário do Estúdio',
        onclick: (event) => {
          event.preventDefault();
          onUsePeriod(run);
        },
      }, 'Usar período no formulário'),
    ])
    : null;

  if (compact) {
    return el('div', { class: 'run-context-banner run-context-banner--compact' }, [
      el('div', { class: 'run-context-banner__head' }, headChildren),
      el('div', { class: 'run-context-banner__row' }, [
        renderAssetChips(run),
        el('span', { class: 'run-context-banner__period muted' }, period),
      ]),
    ]);
  }

  const metaItems = [
    el('span', { class: 'run-context-banner__meta-item' }, period),
  ];
  if (run.ticks) {
    metaItems.push(el('span', { class: 'run-context-banner__meta-item' }, `${Number(run.ticks).toLocaleString('pt-BR')} ticks`));
  }
  const duration = formatDuration(run.duration_ms);
  if (duration) {
    metaItems.push(el('span', { class: 'run-context-banner__meta-item' }, duration));
  }

  return el('section', { class: 'run-context-banner card card--compact' }, [
    el('div', { class: 'run-context-banner__head row row--between' }, [
      el('div', { class: 'run-context-banner__title-group' }, [
        el('div', { class: 'run-context-banner__headline' }, headChildren),
        el('span', { class: 'run-context-banner__strategy' }, [
          strategyName(run),
          version ? el('span', { class: 'muted' }, ` · ${version}`) : null,
        ]),
      ]),
      renderAssetChips(run),
    ]),
    el('div', { class: 'run-context-banner__meta-row muted' }, metaItems),
    periodActions,
  ]);
}

export function formatRunAssetMeta(run) {
  const underlying = run.underlying || '?';
  const interval = run.interval || '?';
  const bookDepth = run.bookDepth ?? run.book_depth;
  return bookDepth != null
    ? `${underlying} · ${interval} · book ${bookDepth}`
    : `${underlying} · ${interval}`;
}
