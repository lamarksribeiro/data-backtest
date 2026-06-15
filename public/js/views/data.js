import { renderQualityEventChart } from '../components/qualityEventChart.js';
import { el, mount, emptyState } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { connectSse, disconnectSse } from '../utils/sse.js';
import { confirmDialog } from '../utils/confirm.js';

const UI_LABELS = { ready: 'Pronto', processing: 'Processando', attention: 'Atenção' };
const UI_CLASS = { ready: 'ok', processing: 'warn', attention: 'err' };

const dataStyles = `
  .data-dashboard-grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 24px;
    align-items: start;
    margin-top: 16px;
  }
  @media (max-width: 1100px) {
    .data-dashboard-grid {
      grid-template-columns: 1fr;
    }
  }

  .data-sidebar-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    position: sticky;
    top: calc(var(--topbar-h, 60px) + 12px);
    align-self: start;
  }

  #data-jobs-section {
    flex-shrink: 0;
    order: -1;
  }

  #data-jobs-section.data-jobs-active {
    border-color: rgba(245, 158, 11, 0.28);
    box-shadow:
      0 0 0 1px rgba(245, 158, 11, 0.06),
      0 10px 28px rgba(15, 23, 42, 0.35);
  }

  #data-jobs-section .card__title {
    margin-bottom: 4px;
  }

  #data-actions-section {
    flex-shrink: 0;
  }

  .studio-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .studio-form label.field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-weight: 500;
    font-size: 12.5px;
    color: var(--text-2);
  }

  .data-prepare-footer {
    margin-top: 10px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .data-jobs-inline {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
  }

  .data-job-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(30, 41, 59, 0.72), rgba(15, 23, 42, 0.55));
    border: 1px solid rgba(245, 158, 11, 0.18);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .data-job-card:hover {
    border-color: rgba(245, 158, 11, 0.32);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.05),
      0 6px 18px rgba(0, 0, 0, 0.18);
  }

  .data-job-card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .data-job-card__title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .data-job-card__id {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-0);
    letter-spacing: 0.01em;
  }

  .data-job-card__badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.28);
  }

  .data-job-card__pct {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 12px;
    font-weight: 700;
    color: #fbbf24;
    flex-shrink: 0;
  }

  .data-job-progress-track {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .data-job-progress-bar {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 999px;
    overflow: hidden;
  }

  .data-job-progress-fill {
    display: block;
    height: 100%;
    min-width: 0;
    border-radius: 999px;
    background: linear-gradient(90deg, #f59e0b 0%, #fbbf24 55%, #fde68a 100%);
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.35);
    transition: width 0.35s ease;
  }

  .data-job-card__phase {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--text-2);
  }

  .data-pending-panel {
    margin: 16px 0 18px;
    padding: 14px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius);
    background: rgba(15, 23, 42, 0.38);
  }

  .data-pending-panel__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .data-pending-panel__title {
    margin: 0;
    font-size: 13px;
    font-weight: 800;
    color: var(--text-0);
  }

  .data-pending-panel__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }

  .data-pending-group {
    min-width: 0;
  }

  .data-pending-group__title {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  .data-pending-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 340px;
    overflow: auto;
    padding-right: 4px;
  }

  .data-pending-item {
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.025);
  }

  .data-pending-item--processing {
    border-color: rgba(245, 158, 11, 0.24);
    background: rgba(245, 158, 11, 0.06);
  }

  .data-pending-item--attention {
    border-color: rgba(239, 68, 68, 0.22);
    background: rgba(239, 68, 68, 0.055);
  }

  .data-pending-item__top {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
  }

  .data-pending-item__date {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    font-weight: 800;
    color: var(--text-0);
  }

  .data-pending-item__status {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .data-pending-item__meta {
    margin: 7px 0 0;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--text-2);
  }

  .data-pending-item__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 10px;
  }

  .coverage-years-container {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-top: 12px;
  }

  .coverage-year-group {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: rgba(13, 19, 32, 0.35);
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.02);
    overflow: hidden;
    transition: border-color 0.2s ease;
  }

  .coverage-year-group:hover {
    border-color: rgba(249, 115, 22, 0.2);
  }

  .coverage-year-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: rgba(255, 255, 255, 0.015);
    border: none;
    border-bottom: 1px solid var(--border);
    padding: 14px 20px;
    color: var(--text-0);
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    transition: background-color 0.2s ease;
    outline: none;
    text-align: left;
  }

  .coverage-year-header:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .coverage-year-header.is-collapsed {
    border-bottom: none;
  }

  .coverage-year-header__chevron {
    font-size: 11px;
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    color: var(--text-3);
  }

  .coverage-year-header.is-collapsed .coverage-year-header__chevron {
    transform: rotate(-90deg);
  }

  .coverage-year-content {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
    gap: 20px;
    padding: 20px;
    background: rgba(7, 10, 16, 0.2);
  }

  .coverage-year-content.is-collapsed {
    display: none;
  }

  .coverage-year-header__title {
    min-width: 0;
    word-break: break-word;
    padding-right: 8px;
  }

  .data-coverage-desc {
    max-width: 100%;
    word-break: break-word;
  }

  .data-coverage-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }

  .data-dashboard-grid,
  .data-main-panel,
  #data-coverage-section,
  .coverage-years-container,
  .coverage-year-group {
    min-width: 0;
    max-width: 100%;
  }

  .coverage-month {
    background: rgba(17, 24, 39, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.03);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(4px);
    display: flex;
    flex-direction: column;
    align-items: center;
    transition: border-color 0.2s ease, transform 0.2s ease;
  }

  .coverage-month:hover {
    border-color: rgba(255, 255, 255, 0.08);
    transform: translateY(-1px);
  }

  .coverage-month__header {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text-0);
    margin-bottom: 12px;
    text-align: center;
    text-transform: capitalize;
    letter-spacing: 0.02em;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    width: 100%;
    padding-bottom: 6px;
  }

  .coverage-month__weekdays {
    display: grid;
    grid-template-columns: repeat(7, 22px);
    gap: 6px;
    margin-bottom: 8px;
    text-align: center;
    font-size: 9.5px;
    font-weight: 800;
    color: var(--text-3);
    opacity: 0.6;
    text-transform: uppercase;
  }

  .coverage-month__days {
    display: grid;
    grid-template-columns: repeat(7, 22px);
    grid-auto-rows: 22px;
    gap: 6px;
  }

  .coverage-day {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.04);
    font-size: 10px;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    user-select: none;
    padding: 0;
  }

  .coverage-day--empty {
    background: rgba(255, 255, 255, 0.015);
    border-color: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.18);
    cursor: default;
  }

  .coverage-day--empty:hover {
    transform: none;
  }

  .coverage-day--ready {
    background: rgba(16, 185, 129, 0.28);
    border-color: rgba(16, 185, 129, 0.65);
    color: #ffffff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }

  .coverage-day--ready:hover {
    background: #10b981;
    border-color: #34d399;
    color: #090d16;
    text-shadow: none;
    box-shadow: 0 0 12px var(--ok-glow);
    transform: scale(1.2) translateY(-1px);
    z-index: 2;
  }

  .coverage-day--processing {
    background: rgba(245, 158, 11, 0.22);
    border-color: rgba(245, 158, 11, 0.55);
    color: #ffffff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    animation: day-pulse 2s infinite ease-in-out;
  }

  .coverage-day--processing:hover {
    background: #f59e0b;
    border-color: #fbbf24;
    color: #090d16;
    text-shadow: none;
    box-shadow: 0 0 12px var(--warn-glow);
    transform: scale(1.2) translateY(-1px);
    z-index: 2;
  }

  .coverage-day--attention {
    background: rgba(239, 68, 68, 0.22);
    border-color: rgba(239, 68, 68, 0.55);
    color: #ffffff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }

  .coverage-day--attention:hover {
    background: #ef4444;
    border-color: #f87171;
    color: #090d16;
    text-shadow: none;
    box-shadow: 0 0 12px var(--err-glow);
    transform: scale(1.2) translateY(-1px);
    z-index: 2;
  }

  @keyframes day-pulse {
    0%, 100% { opacity: 0.95; }
    50% { opacity: 0.6; }
  }

  .coverage-day__pad {
    width: 22px;
    height: 22px;
  }

  .coverage-day.is-out-of-range {
    opacity: 0.55;
    border-style: dashed;
    filter: saturate(0.7);
  }

  .coverage-day.is-out-of-range:hover {
    opacity: 0.95;
    filter: none;
  }

  .coverage-day.is-selected {
    box-shadow: 0 0 0 2px var(--accent);
    border-color: var(--accent) !important;
    transform: scale(1.15) translateY(-1px);
    z-index: 2;
  }

  /* Painel de Detalhes Integrado (Inline) */
  .data-partition-inline-panel {
    background: rgba(30, 41, 59, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: var(--radius);
    padding: 20px 24px;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    gap: 16px;
    animation: slide-down 0.25s ease-out;
  }
  @keyframes slide-down {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Normalização em Grid de mini cards */
  .normalization-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin-bottom: 4px;
  }
  .normalization-item {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: var(--radius-sm);
    padding: 10px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .normalization-item:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .normalization-item.is-active {
    background: rgba(249, 115, 22, 0.1);
    border-color: var(--accent);
  }
  .normalization-item__value {
    font-size: 16px;
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .normalization-item__value--omit { color: var(--err); }
  .normalization-item__value--trim { color: var(--warn); }
  .normalization-item__value--manual { color: #818cf8; }
  .normalization-item__label {
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    font-weight: 600;
  }

  /* Timeline Horizontal para horas */
  .quality-hours-timeline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(255, 255, 255, 0.01);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: var(--radius-sm);
    padding: 12px;
  }
  .quality-hours-timeline__title {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .quality-hours-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .quality-hour-chip {
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    font-size: 11px;
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-2);
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    gap: 5px;
    border-style: solid;
  }
  .quality-hour-chip:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .quality-hour-chip.is-active {
    background: rgba(249, 115, 22, 0.15);
    border-color: var(--accent);
    color: var(--accent);
  }
  .quality-hour-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .quality-hour-indicator--kept { background: var(--ok); }
  .quality-hour-indicator--trim { background: var(--warn); }
  .quality-hour-indicator--omit { background: var(--err); }
  .quality-hour-indicator--manual { background: #818cf8; }

  /* Detalhes de Eventos com Visual Glassmorphic */
  .events-timeline {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .event-timeline-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    transition: all 0.2s ease;
  }
  .event-timeline-card:hover {
    border-color: rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
  }
  .event-timeline-card--excluded {
    opacity: 0.45;
    border-style: dashed;
    background: rgba(0, 0, 0, 0.1);
  }
  .event-info-left {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .event-time-badge {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent);
    font-family: var(--font-mono);
  }
  .event-desc {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-1);
    word-break: break-all;
  }
  .event-meta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 2px;
  }
  .event-badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .event-badge--ok { background: rgba(16, 185, 129, 0.1); color: var(--ok); }
  .event-badge--omit { background: rgba(239, 68, 68, 0.1); color: var(--err); }
  .event-badge--trim { background: rgba(245, 158, 11, 0.1); color: var(--warn); }
  .event-badge--manual { background: rgba(129, 140, 248, 0.1); color: #818cf8; }
  .event-coverage-text {
    font-size: 11px;
    color: var(--text-3);
    font-family: var(--font-mono);
  }
  .event-timeline-card.is-selected {
    border-color: rgba(249, 115, 22, 0.45);
    background: rgba(249, 115, 22, 0.05);
  }
  .event-timeline-card__issues {
    font-size: 11px;
    color: var(--text-3);
  }
  .quality-event-chart {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
  .quality-event-chart__summary,
  .quality-event-chart__legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 11px;
  }
  .quality-event-chart__issues { color: var(--text-2); }
  .quality-event-chart__swatch {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
  }
  .quality-event-chart__swatch--clob { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }
  .quality-event-chart__swatch--underlying { background: rgba(245, 158, 11, 0.15); color: #fcd34d; }
  .quality-event-chart__swatch--omit { background: rgba(239, 68, 68, 0.22); color: #fecaca; }
  .quality-event-chart__meta {
    font-size: 10px;
    margin-left: auto;
  }
  .quality-event-chart__charts {
    min-width: 0;
  }
  .quality-event-chart__empty {
    padding: 12px 0;
    font-size: 11px;
  }
  .quality-event-chart .explorer-charts {
    gap: 12px;
  }
  .quality-event-chart .explorer-charts__section {
    padding: 12px;
    background: rgba(0, 0, 0, 0.12);
    border-color: rgba(255, 255, 255, 0.06);
    box-shadow: none;
  }
  .quality-event-chart .explorer-charts__section:hover {
    box-shadow: none;
    transform: none;
  }
  .quality-event-chart .explorer-charts__title {
    font-size: 12px;
  }
  .quality-event-chart .explorer-charts__hint {
    font-size: 10px;
  }
  .quality-event-chart .chart--compact .chart__viewport {
    min-height: 140px;
  }
  .quality-omit-rules {
    font-size: 12px;
    color: var(--text-2);
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 10px 12px;
    line-height: 1.45;
  }

  @media (max-width: 768px) {
    .data-sidebar-panel {
      position: static;
      top: auto;
    }

    .data-main-panel {
      order: -1;
    }

    .data-dashboard-grid {
      gap: 16px;
    }

    .data-partition-inline-panel {
      padding: 14px 12px;
    }

    .coverage-year-header {
      padding: 12px 14px;
      font-size: 13px;
    }

    .coverage-year-content {
      padding: 14px;
      gap: 14px;
      grid-template-columns: 1fr;
    }

    .data-coverage-legend .badge {
      flex: 1 1 calc(50% - 4px);
      justify-content: center;
      min-width: 0;
    }

    .data-coverage-legend .badge:last-child:nth-child(odd) {
      flex-basis: 100%;
    }

    .data-pending-panel {
      padding: 12px;
    }

    .data-pending-panel__head {
      flex-direction: column;
      align-items: stretch;
    }

    #data-coverage-section .card__header {
      flex-direction: column;
      align-items: flex-start;
    }
  }

  @media (max-width: 640px) {
    .normalization-grid {
      grid-template-columns: 1fr;
    }

    .event-timeline-card {
      flex-direction: column;
      align-items: stretch;
    }

    .event-timeline-card > .btn {
      width: 100%;
      justify-content: center;
    }

    .coverage-month {
      width: 100%;
      padding: 10px 8px;
    }

    .coverage-month__weekdays,
    .coverage-month__days {
      width: min(100%, 240px);
      margin: 0 auto;
      gap: 4px;
      grid-template-columns: repeat(7, minmax(0, 1fr));
    }

    .coverage-day,
    .coverage-day__pad {
      width: 100%;
      max-width: 30px;
      height: auto;
      aspect-ratio: 1;
      justify-self: center;
    }

    .data-coverage-legend .badge {
      flex: 1 1 100%;
      white-space: normal;
      text-align: center;
    }
  }

  @media (hover: none) and (pointer: coarse) {
    .coverage-day--ready:hover,
    .coverage-day--processing:hover,
    .coverage-day--attention:hover,
    .coverage-day.is-selected {
      transform: none;
    }

    .coverage-month:hover {
      transform: none;
    }
  }
`;

let sseHandler = null;
let latestJobs = [];
let jobsTimer = null;
let jobsRefreshDebounce = null;
let displayedProgress = {};
let dayDrawerLoadToken = 0;
let dayDrawerAbort = null;
let eventPreviewAbort = null;

const EVENTS_PAGE_SIZE = 48;
const DAY_EVENTS_TIMEOUT_MS = 60_000;
const EVENT_PREVIEW_TIMEOUT_MS = 45_000;

export function buildDetailsEmptyState() {
  return el('div', { class: 'card data-details-empty', style: { borderStyle: 'dashed', background: 'rgba(255,255,255,0.01)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 16px', textAlign: 'center' } }, [
    el('div', { style: { fontSize: '24px', color: 'var(--text-3)', marginBottom: '12px' } }, [
      el('i', { class: 'fa-solid fa-calendar-day' })
    ]),
    el('p', { class: 'muted', style: { margin: 0, fontSize: '13.5px', maxWidth: '100%', wordBreak: 'break-word' } }, 'Selecione um dia ativo no calendário para ver os detalhes da partição e eventos.')
  ]);
}

export function closeDrawer() {
  dayDrawerLoadToken += 1;
  dayDrawerAbort?.abort();
  dayDrawerAbort = null;
  eventPreviewAbort?.abort();
  eventPreviewAbort = null;
  document.querySelectorAll('.coverage-day.is-selected').forEach(el => el.classList.remove('is-selected'));
  const container = document.getElementById('data-partition-details-container');
  if (container) {
    mount(container, buildDetailsEmptyState());
  }
}

export function buildPartitionDrawerLoading(day) {
  return el('div', { class: 'data-partition-inline-panel' }, [
    el('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '14px' } }, [
      el('div', {}, [
        el('h3', { style: { fontSize: '16px', fontWeight: '800', margin: 0, color: 'var(--text-0)' } }, `Detalhes: ${day.dt}`),
        el('p', { class: 'muted', style: { fontSize: '11px', margin: '4px 0 0' } }, 'Carregando…')
      ]),
      el('button', { type: 'button', class: 'btn btn--ghost btn--sm btn--icon', onclick: closeDrawer }, [
        el('i', { class: 'fa-solid fa-xmark' })
      ]),
    ]),
    el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '140px' } }, [
      el('span', { class: 'muted' }, 'Carregando eventos do dia…')
    ])
  ]);
}

export async function renderData(ctx) {
  ctx.setBreadcrumb('data', 'Dados');
  ctx.renderContextBar?.();

  // Limpar timer e progresso exibido ao renderizar a tela
  if (jobsTimer) {
    clearInterval(jobsTimer);
    jobsTimer = null;
  }
  displayedProgress = {};

  // Injetar a tag de estilos para os mini-calendários se ainda não foi criada
  if (!document.getElementById('data-custom-styles')) {
    const styleEl = el('style', { id: 'data-custom-styles' }, dataStyles);
    document.head.appendChild(styleEl);
  }

  // Se houver overlay sobrando do drawer antigo, remove
  const overlay = document.getElementById('data-drawer-overlay');
  if (overlay) overlay.remove();

  const fallbackCtx = loadContext();
  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Dados'),
        el('p', { class: 'page-header__sub' }, 'Cobertura do lakehouse, preparação e jobs em um só lugar.'),
      ]),
    ]),
    
    // Grid de duas colunas
    el('div', { class: 'data-dashboard-grid' }, [
      // Coluna lateral esquerda (Ações e Jobs)
      el('div', { class: 'data-sidebar-panel' }, [
        el('section', { class: 'card', id: 'data-jobs-section' }, el('p', { class: 'muted' }, 'Carregando jobs…')),
        el('section', { class: 'card', id: 'data-actions-section' }),
      ]),
      // Coluna principal direita (Heatmap / Cobertura e Detalhes)
      el('div', { class: 'data-main-panel', style: { display: 'flex', flexDirection: 'column', gap: '24px' } }, [
        el('section', { class: 'card', id: 'data-coverage-section', style: { margin: '0' } }, el('p', { class: 'muted' }, 'Carregando cobertura…')),
        el('div', { id: 'data-partition-details-container' })
      ])
    ])
  ]);

  // Inicializar o estado vazio do painel integrado
  const detailsContainer = document.getElementById('data-partition-details-container');
  if (detailsContainer) {
    mount(detailsContainer, buildDetailsEmptyState());
  }

  renderActions(ctx, fallbackCtx, contextBarOptions({}));
  bindJobsSse(ctx);
  void refreshJobs(ctx);

  const apiOptions = await fetchContextOptionsCached(ctx.api);
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(fallbackCtx, fieldOptions);
  renderActions(ctx, formCtx, fieldOptions);
  await refreshCoverage(ctx, formCtx);
}

function dataFormFromDom() {
  const form = document.getElementById('data-prepare-form');
  if (!form) return loadContext();
  const fd = new FormData(form);
  return {
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: fd.get('book_depth'),
  };
}

function applyDayToPrepareForm(day, ctxSaved) {
  const form = document.getElementById('data-prepare-form');
  if (!form) return;
  form.querySelector('[name="from"]').value = day.dt;
  form.querySelector('[name="to"]').value = day.dt;
  saveContext({ ...ctxSaved, from: day.dt, to: day.dt });
}

async function reprocessDay(ctx, day, ctxSaved, { fieldOptions = null } = {}) {
  if (day.ui_state === 'processing' && (day.active_jobs || []).length > 0) {
    ctx.toast.warn('Este dia já está em processamento — aguarde o job atual.');
    return false;
  }
  const request = {
    from: day.dt,
    to: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
    book_depth: ctxSaved.book_depth,
  };
  const rebuild = day.ui_state === 'ready' || ['needs_review', 'stale', 'invalid'].includes(day.raw_status);
  return submitDataFix(ctx, request, { rebuild, fieldOptions });
}

async function submitDataFix(ctx, request, { rebuild = false, fieldOptions = null } = {}) {
  const payload = {
    ...request,
    dataset: 'backtest_ticks',
    book_depth: Number(request.book_depth),
    ...(rebuild ? { rebuild: true } : {}),
  };
  saveContext(payload);
  const preview = await ctx.api.post('/api/data/fix', { request: payload, dry_run: true });
  if (!preview.ok) {
    ctx.toast.err(preview.error?.message || 'Falha no plano');
    return false;
  }
  const lines = preview.data.summary_lines || [];
  const intro = rebuild
    ? 'Reprocessar dia(s) inteiro(s), incluindo partições já prontas.'
    : 'Preparar / corrigir dia(s) com dados faltando ou inválidos.';
  const detail = lines.length ? lines.join('\n') : (preview.data.summary || null);
  const ok = await confirmDialog({
    title: rebuild ? 'Reprocessar período' : 'Preparar dados',
    message: intro,
    detail: detail || undefined,
    confirmLabel: 'Executar',
    tone: rebuild ? 'danger' : 'primary',
  });
  if (!ok) return false;
  const fix = await ctx.api.post('/api/data/fix', {
    request: payload,
    confirm_rebuild: preview.data.needs_rebuild_confirm || rebuild ? true : undefined,
  });
  if (!fix.ok) {
    ctx.toast.err(fix.error?.message || 'Falha');
    return false;
  }
  ctx.toast.ok(fix.data.ready ? 'Dados prontos' : `Job #${fix.data.job?.id} criado`);
  const options = fieldOptions || contextBarOptions(await fetchContextOptionsCached(ctx.api));
  await refreshCoverage(ctx, applyContextOptions(loadContext(), options));
  await refreshJobs(ctx);
  return true;
}

function renderActions(ctx, formCtx, fieldOptions) {
  const section = document.getElementById('data-actions-section');
  if (!section) return;
  mount(section, el('div', {}, [
    el('h2', { class: 'card__title' }, 'Reprocessar período'),
    el('form', { id: 'data-prepare-form', class: 'studio-form' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'De'),
        el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Até (incluso)'),
        el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Ativo'),
        selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Intervalo'),
        selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Book'),
        selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth),
      ]),
      el('div', { class: 'data-prepare-footer' }, [
        el('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 8px' } },
          'Prepara o período selecionado, dia a dia.'
        ),
        el('label', { class: 'field field--checkbox' }, [
          el('input', { type: 'checkbox', name: 'rebuild', value: '1' }),
          ' Incluir dias já prontos',
        ]),
        el('button', { class: 'btn btn--primary', type: 'submit' }, 'Executar'),
      ]),
    ]),
  ]));

  const form = document.getElementById('data-prepare-form');
  form?.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('change', () => {
      const current = dataFormFromDom();
      saveContext(current);
      refreshCoverage(ctx, current);
    });
  });

  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const request = {
      from: fd.get('from'),
      to: fd.get('to'),
      underlying: fd.get('underlying'),
      interval: fd.get('interval'),
      book_depth: fd.get('book_depth'),
    };
    await submitDataFix(ctx, request, {
      rebuild: fd.get('rebuild') === '1',
      fieldOptions,
    });
  });
}

async function refreshCoverage(ctx, formCtx, { full = true } = {}) {
  const q = new URLSearchParams({
    underlying: formCtx.underlying,
    interval: formCtx.interval,
    book_depth: formCtx.book_depth,
    from: formCtx.from,
    to: formCtx.to,
  });
  if (full) q.set('full', '1');
  const res = await ctx.api.get(`/api/data/coverage?${q}`);
  const section = document.getElementById('data-coverage-section');
  if (!section) return;
  if (!res.ok) {
    mount(section, el('p', { class: 'bad' }, res.error?.message || 'Falha'));
    return;
  }
  const { coverage } = res.data;
  mount(section, el('div', {}, [
    el('div', { class: 'card__header' }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, `Cobertura · ${coverage.underlying} ${coverage.interval}`),
        el('p', { class: 'data-coverage-desc muted', style: { fontSize: '11.5px', marginTop: '4px', lineHeight: '1.4' } },
          'Exibindo todas as partições do banco de dados para a configuração selecionada. Os dias fora do período ativo do formulário lateral aparecem esmaecidos.'
        ),
      ]),
      el('div', { class: 'data-coverage-legend' }, [
        legendChip('ready', coverage.summary?.ready ?? 0),
        legendChip('processing', coverage.summary?.processing ?? 0),
        legendChip('attention', coverage.summary?.attention ?? 0),
      ]),
    ]),
    renderCoveragePendingPanel(ctx, coverage, formCtx),
    renderMonthlyHeatmap(ctx, coverage)
  ]));
}

function renderCoveragePendingPanel(ctx, coverage, formCtx) {
  const days = coverage.days || [];
  const processing = days.filter((day) => day.ui_state === 'processing');
  const attention = days.filter((day) => day.ui_state === 'attention');
  if (!processing.length && !attention.length) return null;

  return el('div', { class: 'data-pending-panel' }, [
    el('div', { class: 'data-pending-panel__head' }, [
      el('div', {}, [
        el('h3', { class: 'data-pending-panel__title' }, 'Pendências da seleção'),
        el('p', { class: 'muted', style: { margin: '4px 0 0', fontSize: '11.5px' } },
          `${processing.length} processando · ${attention.length} precisam de atenção`
        ),
      ]),
    ]),
    el('div', { class: 'data-pending-panel__grid' }, [
      renderPendingGroup(ctx, 'Processando', processing, 'processing', formCtx),
      renderPendingGroup(ctx, 'Atenção', attention, 'attention', formCtx),
    ]),
  ]);
}

function renderPendingGroup(ctx, title, days, tone, formCtx) {
  return el('div', { class: 'data-pending-group' }, [
    el('p', { class: 'data-pending-group__title' }, `${title} (${days.length})`),
    days.length
      ? el('div', { class: 'data-pending-list' }, days.map((day) => renderPendingItem(ctx, day, tone, formCtx)))
      : el('p', { class: 'muted', style: { fontSize: '11.5px', margin: 0 } }, 'Nenhum item.'),
  ]);
}

function renderPendingItem(ctx, day, tone, formCtx) {
  const activeJobs = day.active_jobs || [];
  const activeJob = activeJobs[0] || null;
  const canReprocess = tone === 'attention' || !activeJob;
  const canAccept = day.raw_status === 'needs_review' && Boolean(day.partitions?.[0]?.active_path);
  return el('div', { class: `data-pending-item data-pending-item--${tone}` }, [
    el('div', { class: 'data-pending-item__top' }, [
      el('span', { class: 'data-pending-item__date' }, day.dt),
      el('span', { class: 'data-pending-item__status' }, day.raw_status || day.ui_label),
    ]),
    el('p', { class: 'data-pending-item__meta' }, pendingDayDescription(day, activeJob)),
    el('div', { class: 'data-pending-item__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => openPartitionDrawer(ctx, day),
      }, 'Ver detalhes'),
      activeJob ? el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => cancelPrepareJobFromData(ctx, activeJob.id, formCtx),
      }, `Cancelar #${activeJob.id}`) : null,
      canAccept ? el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        onclick: () => acceptReviewPartition(ctx, day, formCtx),
      }, 'Aceitar e liberar') : null,
      canReprocess ? el('button', {
        type: 'button',
        class: canAccept ? 'btn btn--ghost btn--sm' : 'btn btn--primary btn--sm',
        onclick: async () => {
          const ok = await reprocessDay(ctx, day, formCtx);
          if (ok) await refreshCoverage(ctx, loadContext());
        },
      }, tone === 'attention' ? 'Reprocessar' : 'Reprocessar órfão') : null,
    ]),
  ]);
}

function pendingDayDescription(day, activeJob) {
  if (activeJob) {
    const pct = activeJob.percent == null ? '' : ` · ${Math.round(Number(activeJob.percent))}%`;
    const current = activeJob.current_dt && activeJob.current_dt !== day.dt ? ` · atual: ${activeJob.current_dt}` : '';
    const updated = activeJob.updated_at ? ` · atualizado ${formatJobTimestamp(activeJob.updated_at)}` : '';
    const phase = activeJob.phase ? formatJobPhase({ status: activeJob.status, progress: { current: { phase: activeJob.phase } } }) : 'na fila';
    return `Job #${activeJob.id} ${activeJob.status}: ${phase}${pct}${current}${updated}`;
  }
  if (day.ui_state === 'processing') {
    return `Sem job ativo associado. Pode ser processamento antigo interrompido ou manifesto preso em ${day.raw_status}.`;
  }
  if (day.raw_status === 'needs_review' && day.partitions?.[0]?.active_path) {
    return `${day.error || day.hint || 'Partição gerada, mas bloqueada para revisão.'} Use Aceitar se a omissão for esperada, ou reprocessar para tentar gerar novamente.`;
  }
  return day.error || day.hint || 'Partição indisponível para uso em backtest strict.';
}

function formatJobTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function cancelPrepareJobFromData(ctx, jobId, formCtx) {
  const ok = await confirmDialog({
    title: `Cancelar job #${jobId}`,
    message: 'Interromper o processamento em andamento?',
    detail: 'O parquet antigo será mantido. Se o novo arquivo ainda estiver temporário, ele será descartado.',
    confirmLabel: 'Cancelar job',
    tone: 'danger',
  });
  if (!ok) return;
  const res = await ctx.api.post(`/api/prepare/jobs/${jobId}/cancel`, {});
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao cancelar job');
    return;
  }
  ctx.toast.ok(res.data.status === 'cancelled' ? 'Job cancelado' : 'Cancelamento solicitado');
  await refreshJobs(ctx);
  await refreshCoverage(ctx, formCtx);
}

async function acceptReviewPartition(ctx, day, formCtx) {
  const ok = await confirmDialog({
    title: `Aceitar ${day.dt}`,
    message: 'Liberar esta partição para uso em backtests?',
    detail: day.error || 'A partição ficará como accepted mesmo com alerta de qualidade.',
    confirmLabel: 'Aceitar e liberar',
    tone: 'danger',
  });
  if (!ok) return;
  const res = await ctx.api.post('/api/manifest/accept', {
    dataset: 'backtest_ticks',
    market_id: day.partitions?.[0]?.market_id ?? null,
    underlying: formCtx.underlying,
    interval: formCtx.interval,
    book_depth: Number(formCtx.book_depth),
    dt: day.dt,
    reason: 'accepted from data pending panel after review',
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao aceitar partição');
    return;
  }
  ctx.toast.ok('Partição aceita e liberada');
  await refreshCoverage(ctx, formCtx);
}

function legendChip(state, count) {
  const iconClass = state === 'ready'
    ? 'fa-solid fa-circle-check'
    : state === 'processing'
      ? (count > 0 ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-spinner')
      : 'fa-solid fa-circle-exclamation';
  return el('span', { class: `badge badge--${UI_CLASS[state]}`, style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '30px' } }, [
    el('i', { class: iconClass }),
    `${UI_LABELS[state]}: `,
    el('strong', { style: { marginLeft: '2px', fontFamily: 'var(--font-mono)' } }, String(count))
  ]);
}

// Determina o intervalo de meses que aparecem nas partições de cobertura de dados
function getMonthsRange(days) {
  if (days.length === 0) return [];

  const sortedDts = days.map(d => d.dt).sort();
  const firstDt = sortedDts[0];
  const lastDt = sortedDts[sortedDts.length - 1];

  const minYear = parseInt(firstDt.slice(0, 4), 10);
  const minMonth = parseInt(firstDt.slice(5, 7), 10);
  const maxYear = parseInt(lastDt.slice(0, 4), 10);
  const maxMonth = parseInt(lastDt.slice(5, 7), 10);

  const months = [];
  let currentYear = minYear;
  let currentMonth = minMonth;

  while (currentYear < maxYear || (currentYear === maxYear && currentMonth <= maxMonth)) {
    months.push({ year: currentYear, month: currentMonth });
    currentMonth++;
    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear++;
    }
  }
  return months;
}

// Renderiza a cobertura de dados no formato de mini-calendários agrupados por mês e ano (colapsável)
function renderMonthlyHeatmap(ctx, coverage) {
  const days = coverage.days || [];
  if (days.length === 0) {
    return emptyState('Nenhuma partição no intervalo.');
  }

  const selectedFrom = coverage.from_date || String(coverage.from || '').slice(0, 10);
  const selectedTo = coverage.to_date || String(coverage.from || '').slice(0, 10);

  const monthsRange = getMonthsRange(days);
  
  // Agrupar meses por ano
  const yearsMap = {};
  for (const item of monthsRange) {
    if (!yearsMap[item.year]) {
      yearsMap[item.year] = [];
    }
    yearsMap[item.year].push(item.month);
  }

  // Ordenar os anos de forma decrescente (mais recente primeiro)
  const sortedYears = Object.keys(yearsMap).map(Number).sort((a, b) => b - a);

  const MONTH_NAMES = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];

  return el('div', { class: 'coverage-years-container' }, sortedYears.map((year, yearIndex) => {
    const months = yearsMap[year];
    
    // O primeiro ano (mais recente) inicia aberto, os demais iniciam fechados
    const isOpen = yearIndex === 0;

    const headerChevron = el('span', { class: 'coverage-year-header__chevron' }, '▼');
    const contentEl = el('div', {
      class: `coverage-year-content${isOpen ? '' : ' is-collapsed'}`,
    }, months.map((month) => {
      // 0 = Domingo, 1 = Segunda, etc.
      const firstDayOfWeek = new Date(year, month - 1, 1).getDay();
      const daysInMonth = new Date(year, month, 0).getDate();
      
      const dayElements = [];
      
      // Adicionar células vazias de alinhamento antes do primeiro dia
      for (let i = 0; i < firstDayOfWeek; i++) {
        dayElements.push(el('div', { class: 'coverage-day__pad' }));
      }
      
      // Adicionar os quadradinhos dos dias
      for (let d = 1; d <= daysInMonth; d++) {
        const dayStr = String(d).padStart(2, '0');
        const monthStr = String(month).padStart(2, '0');
        const dateKey = `${year}-${monthStr}-${dayStr}`;
        
        const dayData = days.find(x => x.dt === dateKey);
        if (dayData) {
          const dtDate = new Date(`${dateKey}T00:00:00.000Z`);
          const isSelected = dateKey >= selectedFrom && dateKey <= selectedTo;
          const rangeClass = isSelected ? 'is-selected' : 'is-out-of-range';
          const titleSuffix = isSelected ? '' : ' (Fora do período selecionado)';

          dayElements.push(el('button', {
            type: 'button',
            class: `coverage-day coverage-day--${dayData.ui_state} ${rangeClass}`,
            title: `${dateKey}: ${UI_LABELS[dayData.ui_state]} (${dayData.raw_status})${titleSuffix}`,
            onclick: () => openPartitionDrawer(ctx, dayData),
          }, String(d)));
        } else {
          dayElements.push(el('div', {
            class: 'coverage-day coverage-day--empty',
            title: `${dateKey}: Sem cobertura de dados`,
          }, String(d)));
        }
      }

      return el('div', { class: 'coverage-month' }, [
        el('div', { class: 'coverage-month__header' }, `${MONTH_NAMES[month]}`),
        el('div', { class: 'coverage-month__weekdays' }, WEEKDAYS.map(w => el('span', {}, w))),
        el('div', { class: 'coverage-month__days' }, dayElements)
      ]);
    }));

    const headerEl = el('button', {
      type: 'button',
      class: `coverage-year-header${isOpen ? '' : ' is-collapsed'}`,
      onclick: (e) => {
        const btn = e.currentTarget;
        const group = btn.closest('.coverage-year-group');
        const content = group?.querySelector('.coverage-year-content');
        const collapsed = btn.classList.toggle('is-collapsed');
        content?.classList.toggle('is-collapsed', collapsed);
      }
    }, [
      el('span', { class: 'coverage-year-header__title' }, `Ano de ${year} (${months.length} ${months.length === 1 ? 'mês' : 'meses'} com cobertura)`),
      headerChevron
    ]);

    return el('div', { class: 'coverage-year-group' }, [
      headerEl,
      contentEl
    ]);
  }));
}

function formatEventTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function shortConditionId(value) {
  const text = String(value || '');
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

function hourTone(bucket) {
  if (bucket.manual > 0) return 'manual';
  if (bucket.omitted > 0) return 'omit';
  return 'kept';
}

function eventStatusLabel(event) {
  if (event.manually_excluded) return 'manual';
  if (event.normalization_action === 'omit') return 'omitido';
  return 'ok';
}

function eventBadgeTone(event) {
  if (event.manually_excluded) return 'manual';
  if (event.normalization_action === 'omit') return 'omit';
  return 'ok';
}

function formatIssues(issues = []) {
  return issues.map((issue) => {
    if (issue === 'clob_stale') return 'CLOB travado';
    if (issue === 'underlying_stale') return 'Spot travado';
    if (issue === 'underlying_flat') return 'Spot flat prolongado';
    if (issue === 'missing_ticks') return 'Sem ticks no coletor';
    return issue;
  }).join(' · ');
}

async function loadEventPreview(ctx, day, ctxSaved, conditionId, eventMeta = null, loadToken = dayDrawerLoadToken) {
  const host = document.getElementById(`quality-preview-${conditionId}`);
  if (!host) return;
  if (eventMeta?.ticks_recorded === 0 || eventMeta?.normalization_action === 'omit' && eventMeta?.normalization_issues?.includes('missing_ticks')) {
    mount(host, el('p', { class: 'muted', style: { padding: '8px 0' } }, 'Evento omitido automaticamente — sem ticks no coletor.'));
    return;
  }
  eventPreviewAbort?.abort();
  eventPreviewAbort = new AbortController();
  const signal = eventPreviewAbort.signal;
  mount(host, el('p', { class: 'muted', style: { padding: '8px 0' } }, 'Carregando gráfico…'));
  const query = new URLSearchParams({
    dt: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
    condition_id: conditionId,
  });
  const res = await ctx.api.get(`/api/quality/event-preview?${query.toString()}`, {
    timeoutMs: EVENT_PREVIEW_TIMEOUT_MS,
    signal,
  });
  if (loadToken !== dayDrawerLoadToken) return;
  if (!res.ok) {
    if (res.error?.code === 'ABORTED') return;
    mount(host, el('p', { class: 'bad', style: { padding: '8px 0' } }, res.error?.message || 'Falha ao carregar preview'));
    return;
  }
  renderQualityEventChart(host, res.data, { assetSymbol: res.data.underlying });
}

async function setEventExclusion(ctx, day, eventData, marketId, excluded) {
  const ctxSaved = loadContext();
  const endpoint = excluded ? '/api/quality/restore' : '/api/quality/exclude';
  const body = {
    dt: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
    book_depth: Number(ctxSaved.book_depth),
    market_id: marketId,
    condition_id: eventData.condition_id,
    event_start: eventData.event_start,
  };
  const res = await ctx.api.post(endpoint, body);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao atualizar exclusão');
    return false;
  }
  ctx.toast.ok(excluded ? 'Evento restaurado — re-sync enfileirado' : 'Evento excluído — re-sync enfileirado');
  return true;
}

function buildPartitionDrawer(ctx, day, eventPayload, ctxSaved, drawerUiState = {}, fieldOptions = null) {
  const selectedHour = drawerUiState.selectedHour ?? null;
  const selectedTypeFilter = drawerUiState.selectedTypeFilter ?? null;
  const selectedEventId = drawerUiState.selectedEventId ?? null;
  const visibleCount = drawerUiState.visibleCount ?? EVENTS_PAGE_SIZE;
  const loadToken = drawerUiState.loadToken ?? dayDrawerLoadToken;

  const remountDrawer = (patch = {}) => {
    Object.assign(drawerUiState, patch);
    const container = document.getElementById('data-partition-details-container');
    mount(container, buildPartitionDrawer(ctx, day, eventPayload, ctxSaved, drawerUiState, fieldOptions));
    if (drawerUiState.selectedEventId) {
      const selectedEvent = events.find((event) => event.condition_id === drawerUiState.selectedEventId);
      void loadEventPreview(ctx, day, ctxSaved, drawerUiState.selectedEventId, selectedEvent, loadToken);
    }
  };
  const events = (eventPayload.events || []).filter((event) => {
    const matchesHour = selectedHour == null || event.hour_utc === selectedHour;
    let matchesType = true;
    if (selectedTypeFilter === 'omit') {
      matchesType = event.normalization_action === 'omit';
    } else if (selectedTypeFilter === 'manual') {
      matchesType = event.manually_excluded;
    }
    return matchesHour && matchesType;
  });
  
  // Calcular totais de normalização para os mini cards
  const norm = day.partitions?.[0]?.quality_details?.normalization;
  const countOmitted = norm?.events_omitted ?? 0;
  const countManual = norm?.events_manual_omitted ?? (eventPayload.exclusions || []).length;

  const hourButtons = (eventPayload.hours || []).map((bucket) => {
    return el('button', {
      type: 'button',
      class: `quality-hour-chip${selectedHour === bucket.hour ? ' is-active' : ''}`,
      title: `${bucket.total} evento(s) · omit: ${bucket.omitted} · manual: ${bucket.manual}`,
      onclick: () => {
        drawerUiState.selectedHour = selectedHour === bucket.hour ? null : bucket.hour;
        drawerUiState.visibleCount = EVENTS_PAGE_SIZE;
        remountDrawer();
      },
    }, [
      el('span', { class: `quality-hour-indicator quality-hour-indicator--${hourTone(bucket)}` }),
      `${bucket.hour}h`
    ]);
  });

  return el('div', { class: 'data-partition-inline-panel' }, [
    // Header
    el('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '14px' } }, [
      el('div', {}, [
        el('h3', { style: { fontSize: '16px', fontWeight: '800', margin: 0, color: 'var(--text-0)' } }, `Detalhes: ${day.dt}`),
        el('p', { class: 'muted', style: { fontSize: '11px', margin: '4px 0 0' } }, `Status Bruto: ${day.raw_status}`)
      ]),
      el('button', { type: 'button', class: 'btn btn--ghost btn--sm btn--icon', onclick: closeDrawer }, [
        el('i', { class: 'fa-solid fa-xmark' })
      ]),
    ]),
    
    // Body
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } }, [
      // Configuração rápida
      el('div', { style: { background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)', fontSize: '12.5px' } }, [
        el('strong', { style: { color: 'var(--text-0)' } }, 'Configuração ativa: '),
        el('span', { class: 'muted' }, `${ctxSaved.underlying} · ${ctxSaved.interval} · book depth ${ctxSaved.book_depth}`)
      ]),

      el('div', { class: 'quality-omit-rules' }, [
        el('strong', { style: { color: 'var(--text-0)' } }, 'Omissão automática: '),
        '≥ 50% dos ticks em trechos ',
        el('em', {}, 'clob_stale'),
        ', ',
        el('em', {}, 'underlying_stale'),
        ', spot no mesmo valor por ≥30s ou sem ticks no coletor → evento inteiro fora do Parquet.',
      ]),

      // Cards de resumo de normalização
      el('div', { class: 'normalization-grid' }, [
        el('div', {
          class: `normalization-item${selectedTypeFilter === 'omit' ? ' is-active' : ''}`,
          onclick: () => {
            drawerUiState.selectedTypeFilter = selectedTypeFilter === 'omit' ? null : 'omit';
            drawerUiState.selectedEventId = null;
            drawerUiState.visibleCount = EVENTS_PAGE_SIZE;
            remountDrawer();
          }
        }, [
          el('span', { class: 'normalization-item__value normalization-item__value--omit' }, String(countOmitted)),
          el('span', { class: 'normalization-item__label' }, 'Omitidos')
        ]),
        el('div', {
          class: `normalization-item${selectedTypeFilter === 'manual' ? ' is-active' : ''}`,
          onclick: () => {
            drawerUiState.selectedTypeFilter = selectedTypeFilter === 'manual' ? null : 'manual';
            drawerUiState.selectedEventId = null;
            drawerUiState.visibleCount = EVENTS_PAGE_SIZE;
            remountDrawer();
          }
        }, [
          el('span', { class: 'normalization-item__value normalization-item__value--manual' }, String(countManual)),
          el('span', { class: 'normalization-item__label' }, 'Manuais')
        ]),
      ]),

      // Timeline de Horas
      hourButtons.length ? el('div', { class: 'quality-hours-timeline' }, [
        el('div', { class: 'quality-hours-timeline__title' }, 'Filtrar por Hora'),
        el('div', { class: 'quality-hours-grid' }, [
          el('button', {
            type: 'button',
            class: `quality-hour-chip${selectedHour == null ? ' is-active' : ''}`,
            onclick: () => {
              drawerUiState.selectedHour = null;
              drawerUiState.visibleCount = EVENTS_PAGE_SIZE;
              remountDrawer();
            },
          }, 'Todas'),
          ...hourButtons,
        ])
      ]) : null,

      // Lista de eventos
      el('div', { class: 'events-timeline' }, [
        el('h4', { style: { fontSize: '13px', fontWeight: '700', color: 'var(--text-0)', margin: '8px 0 4px' } }, `Eventos (${events.length})`),
        events.length ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
          ...events.slice(0, visibleCount).map((event) => {
          const excluded = event.manually_excluded;
          const badgeTone = eventBadgeTone(event);
          const isSelected = selectedEventId === event.condition_id;
          return el('div', { class: `event-timeline-card${excluded ? ' event-timeline-card--excluded' : ''}${isSelected ? ' is-selected' : ''}` }, [
            el('div', {
              class: 'event-info-left',
              style: { cursor: 'pointer', flex: '1' },
              onclick: () => {
                drawerUiState.selectedEventId = isSelected ? null : event.condition_id;
                remountDrawer();
              },
            }, [
              el('span', { class: 'event-time-badge' }, formatEventTime(event.event_start)),
              el('span', { class: 'event-desc' }, shortConditionId(event.condition_id)),
              el('div', { class: 'event-meta-row' }, [
                el('span', { class: `event-badge event-badge--${badgeTone}` }, eventStatusLabel(event)),
                event.normalization_issues?.length
                  ? el('span', { class: 'event-timeline-card__issues' }, formatIssues(event.normalization_issues))
                  : null,
                event.normalization_bad_ratio != null
                  ? el('span', { class: 'event-coverage-text' }, `Ruim: ${Math.round(event.normalization_bad_ratio * 100)}%`)
                  : null,
                event.coverage != null ? el('span', { class: 'event-coverage-text' }, `Cob: ${Math.round(event.coverage * 100)}%`) : null,
              ]),
              isSelected ? el('div', { id: `quality-preview-${event.condition_id}` }) : null,
            ]),
            el('button', {
              type: 'button',
              class: `btn btn--ghost btn--sm${excluded ? '' : ' btn--danger'}`,
              style: { padding: '6px 10px', fontSize: '11px' },
              onclick: async (ev) => {
                ev.stopPropagation();
                const ok = await setEventExclusion(ctx, day, event, eventPayload.market_id, excluded);
                if (!ok) return;
                await openPartitionDrawer(ctx, day, fieldOptions);
                refreshJobs(ctx);
              },
            }, excluded ? 'Restaurar' : 'Excluir')
          ]);
        }),
          visibleCount < events.length ? el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            style: { alignSelf: 'center', marginTop: '4px' },
            onclick: () => remountDrawer({ visibleCount: visibleCount + EVENTS_PAGE_SIZE }),
          }, `Mostrar mais (${events.length - visibleCount} restantes)`) : null,
        ]) : el('p', { class: 'muted', style: { textAlign: 'center', padding: '20px 0' } }, 'Nenhum evento registrado com este filtro.')
      ])
    ]),
    
    // Footer
    el('div', { style: { display: 'flex', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '16px', marginTop: '4px' } }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        style: { flex: '1' },
        disabled: day.ui_state === 'processing',
        onclick: async () => {
          const ok = await reprocessDay(ctx, day, ctxSaved, { fieldOptions });
          if (ok) await openPartitionDrawer(ctx, day, fieldOptions);
        },
      }, day.ui_state === 'processing' ? 'Processando…' : 'Reprocessar Dia'),
    ]),
  ]);
}

async function openPartitionDrawer(ctx, day, fieldOptions = null) {
  const container = document.getElementById('data-partition-details-container');
  if (!container) return;

  dayDrawerLoadToken += 1;
  const loadToken = dayDrawerLoadToken;
  dayDrawerAbort?.abort();
  dayDrawerAbort = new AbortController();
  const signal = dayDrawerAbort.signal;
  eventPreviewAbort?.abort();
  eventPreviewAbort = null;
  
  // Destacar o dia selecionado no calendário
  document.querySelectorAll('.coverage-day.is-selected').forEach(el => el.classList.remove('is-selected'));
  const targetDayEl = document.querySelector(`.coverage-day[title*="${day.dt}:"]`);
  if (targetDayEl) targetDayEl.classList.add('is-selected');

  const ctxSaved = loadContext();
  applyDayToPrepareForm(day, ctxSaved);
  mount(container, buildPartitionDrawerLoading(day));

  // Focar suavemente a tela no painel de detalhes integrado
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const query = new URLSearchParams({
    dt: day.dt,
    underlying: ctxSaved.underlying,
    interval: ctxSaved.interval,
    book_depth: ctxSaved.book_depth,
  });
  const res = await ctx.api.get(`/api/quality/day-events?${query.toString()}`, {
    timeoutMs: DAY_EVENTS_TIMEOUT_MS,
    signal,
  });
  if (loadToken !== dayDrawerLoadToken) return;
  if (!res.ok) {
    if (res.error?.code === 'ABORTED') return;
    mount(container, el('div', { class: 'data-partition-inline-panel' }, [
      el('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '14px' } }, [
        el('h3', { style: { fontSize: '16px', fontWeight: '800', margin: 0, color: 'var(--text-0)' } }, `Detalhes: ${day.dt}`),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm btn--icon', onclick: closeDrawer }, [
          el('i', { class: 'fa-solid fa-xmark' })
        ]),
      ]),
      el('div', { style: { padding: '20px 0' } }, [
        el('p', { class: 'bad' }, `Falha ao carregar eventos: ${res.error?.message || 'erro desconhecido'}`)
      ])
    ]));
    return;
  }
  const drawerUiState = {
    selectedHour: null,
    selectedTypeFilter: null,
    selectedEventId: null,
    visibleCount: EVENTS_PAGE_SIZE,
    loadToken,
  };
  mount(container, buildPartitionDrawer(ctx, day, res.data, ctxSaved, drawerUiState, fieldOptions));
}

async function refreshJobs(ctx) {
  const section = document.getElementById('data-jobs-section');
  if (!section) return;
  const res = await ctx.api.get('/api/prepare/jobs?limit=10');
  latestJobs = res.ok ? res.data.jobs || [] : [];
  const active = latestJobs.filter((j) => j.status === 'running' || j.status === 'queued');

  // Inicializa o progresso exibido dos novos jobs ativos
  active.forEach((job) => {
    if (displayedProgress[job.id] === undefined) {
      displayedProgress[job.id] = calculateJobProgress(job);
    }
  });

  section.classList.toggle('data-jobs-active', active.length > 0);

  mount(section, el('div', {}, [
    el('h2', { class: 'card__title' }, 'Jobs ativos'),
    active.length
      ? el('div', { class: 'data-jobs-inline' }, active.map((job) => jobCard(ctx, job)))
      : el('p', { class: 'muted' }, 'Nenhum job em execução.'),
  ]));

  // Gerenciar o timer de atualização suave de progresso na DOM
  if (active.length && !jobsTimer) {
    jobsTimer = setInterval(tickJobsProgress, 500);
  } else if (!active.length && jobsTimer) {
    clearInterval(jobsTimer);
    jobsTimer = null;
  }
}

const JOB_PHASE_WEIGHT = {
  starting: 5,
  listing_events: 12,
  counting_ticks: 28,
  fetching_rows: 58,
  writing_parquet: 88,
  done: 100,
  skipped: 100,
};

function calculateJobProgress(job) {
  if (job.status === 'completed') return 100;
  if (job.status === 'failed') return 0;

  const prog = job.progress;
  if (prog?.percent != null && Number.isFinite(Number(prog.percent))) {
    return Math.min(99, Math.max(0, Math.round(Number(prog.percent))));
  }
  if (!prog) return job.status === 'queued' ? 2 : 5;

  const actionsTotal = Math.max(1, Number(prog.actions_total) || 1);
  const actionIndex = Math.max(0, Number(prog.action_index) || 0);
  const actionWeight = 100 / actionsTotal;
  const partitionsTotal = Math.max(1, Number(prog.partitions_total) || 1);
  const partitionsDone = Math.max(0, Number(prog.partitions_done) || 0);

  let currentActionFraction = partitionsDone / partitionsTotal;
  if (partitionsDone < partitionsTotal) {
    const phase = prog.current?.phase;
    const phasePct = JOB_PHASE_WEIGHT[phase] ?? 20;
    currentActionFraction += (phasePct / 100) * (1 / partitionsTotal);
  }

  return Math.min(99, Math.round((actionIndex * actionWeight) + (currentActionFraction * actionWeight)));
}

function tickJobsProgress() {
  const activeJobs = latestJobs.filter((j) => j.status === 'running' || j.status === 'queued');
  // Se não houver jobs ativos ou se o container foi desmontado (mudança de tela)
  if (!activeJobs.length || !document.getElementById('data-jobs-section')) {
    if (jobsTimer) {
      clearInterval(jobsTimer);
      jobsTimer = null;
    }
    return;
  }

  activeJobs.forEach((job) => {
    const cardEl = document.getElementById(`data-job-${job.id}`);
    if (!cardEl) return;

    const fillEl = cardEl.querySelector('.data-job-progress-fill');
    const pctEl = cardEl.querySelector('.data-job-card__pct');
    if (!fillEl) return;

    const targetPct = calculateJobProgress(job);
    let currentPct = displayedProgress[job.id] ?? targetPct;

    if (targetPct > currentPct) {
      currentPct = Math.min(targetPct, currentPct + 4);
    } else if (targetPct < currentPct) {
      currentPct = targetPct;
    }

    displayedProgress[job.id] = currentPct;
    const pctLabel = `${Math.round(currentPct)}%`;
    fillEl.style.width = `${currentPct}%`;
    if (pctEl) pctEl.textContent = pctLabel;
  });
}

function formatJobPhase(job) {
  const phase = job.progress?.current?.phase;
  if (phase === 'listing_events') return 'listando eventos';
  if (phase === 'counting_ticks') return 'contando ticks';
  if (phase === 'fetching_rows') return 'buscando ticks';
  if (phase === 'writing_parquet') return 'gravando parquet';
  if (phase === 'done') return 'finalizando';
  if (phase === 'skipped') return 'pulado';
  if (phase === 'starting') return 'iniciando partição';
  if (job.status === 'queued') return 'na fila';
  return phase || 'aguardando';
}

function jobCard(ctx, job) {
  const pct = displayedProgress[job.id] ?? calculateJobProgress(job);
  const pctLabel = `${Math.round(pct)}%`;
  return el('div', { class: 'data-job-card', id: `data-job-${job.id}` }, [
    el('div', { class: 'data-job-card__head' }, [
      el('div', { class: 'data-job-card__title' }, [
        el('span', { class: 'data-job-card__id' }, `Job #${job.id}`),
        el('span', { class: 'data-job-card__badge' }, job.status),
      ]),
      el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
        el('span', { class: 'data-job-card__pct' }, pctLabel),
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          title: 'Cancelar job',
          onclick: async () => {
            const res = await ctx.api.post(`/api/prepare/jobs/${job.id}/cancel`, {});
            if (!res.ok) {
              ctx.toast.err(res.error?.message || 'Falha ao cancelar job');
              return;
            }
            ctx.toast.ok(res.data.status === 'cancelled' ? 'Job cancelado' : 'Cancelamento solicitado');
            await refreshJobs(ctx);
          },
        }, 'Cancelar'),
      ]),
    ]),
    el('div', { class: 'data-job-progress-track' }, [
      el('div', { class: 'data-job-progress-bar' }, [
        el('span', { class: 'data-job-progress-fill', style: { width: `${pct}%` } }),
      ]),
    ]),
    el('p', { class: 'data-job-card__phase' }, formatJobPhase(job)),
  ]);
}

function updateJobCardFromProgress(jobId, progress, status = 'running') {
  const existing = latestJobs.find((job) => job.id === jobId);
  const job = existing
    ? { ...existing, progress, status }
    : { id: jobId, status, progress, dry_run: false, mode: 'prepare' };
  if (existing) {
    Object.assign(existing, job);
  } else {
    latestJobs.unshift(job);
  }

  const targetPct = calculateJobProgress(job);
  displayedProgress[jobId] = targetPct;
  const cardEl = document.getElementById(`data-job-${jobId}`);
  if (!cardEl) return false;

  const fillEl = cardEl.querySelector('.data-job-progress-fill');
  const pctEl = cardEl.querySelector('.data-job-card__pct');
  const phaseEl = cardEl.querySelector('.data-job-card__phase');
  const pctLabel = `${Math.round(targetPct)}%`;
  if (fillEl) fillEl.style.width = `${targetPct}%`;
  if (pctEl) pctEl.textContent = pctLabel;
  if (phaseEl) phaseEl.textContent = formatJobPhase(job);
  return true;
}

function scheduleRefreshJobs(ctx) {
  if (jobsRefreshDebounce) clearTimeout(jobsRefreshDebounce);
  jobsRefreshDebounce = setTimeout(() => {
    jobsRefreshDebounce = null;
    void refreshJobs(ctx);
  }, 2000);
}

function bindJobsSse(ctx) {
  if (sseHandler) disconnectSse(sseHandler);
  sseHandler = (event) => {
    if (!['job:progress', 'job:completed', 'job:failed'].includes(event.type)) return;

    if (event.type === 'job:progress' && event.jobId && event.progress) {
      const updated = updateJobCardFromProgress(event.jobId, event.progress, 'running');
      if (!updated) scheduleRefreshJobs(ctx);
      return;
    }

    if (event.type === 'job:completed' && event.jobId && event.status !== 'cancelled') {
      displayedProgress[event.jobId] = 100;
      void refreshJobs(ctx).then(() => refreshCoverage(ctx, loadContext()));
      ctx.toast.ok('Job concluído — cobertura atualizada');
      return;
    }

    if ((event.status === 'cancelled' || event.type === 'job:failed') && event.jobId) {
      delete displayedProgress[event.jobId];
      scheduleRefreshJobs(ctx);
      refreshCoverage(ctx, loadContext());
      ctx.toast.warn(event.status === 'cancelled' ? 'Job cancelado' : 'Job falhou');
    }
  };
  connectSse(sseHandler);
}

export function redirectJobsToData() {
  location.hash = '#/data';
}
