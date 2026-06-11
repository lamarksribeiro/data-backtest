import { el } from '../utils/dom.js';

export function Skeleton({ lines = 3, className = '' } = {}) {
  const wrap = el('div', { class: `skeleton-block ${className}` });
  for (let i = 0; i < lines; i += 1) {
    wrap.appendChild(el('div', { class: 'skeleton-line', style: { width: `${70 + (i % 3) * 10}%` } }));
  }
  return wrap;
}

export function MetricCard({ label, value, tone = 'default' }) {
  return el('div', { class: `metric-card metric-card--${tone}` }, [
    el('div', { class: 'metric-card__label' }, label),
    el('div', { class: 'metric-card__value' }, value ?? '—'),
  ]);
}

export function StatusBadge({ status }) {
  const map = { completed: 'ok', running: 'warn', queued: 'muted', failed_runtime: 'err', cancelled: 'muted' };
  return el('span', { class: `status-badge status-badge--${map[status] || 'muted'}` }, status || '—');
}
