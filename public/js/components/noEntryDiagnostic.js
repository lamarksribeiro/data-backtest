import { el } from '../utils/dom.js';

const REASON_LABELS = {
  outside_entry_window: 'Fora da janela',
  waiting_momentum: 'Aguardando momentum',
  distance_below_min: 'Distância abaixo do mínimo',
  no_candidate: 'Sem candidato',
  liquidity_below_min: 'Liquidez insuficiente',
  entry_rejected: 'Entrada rejeitada',
  event_closed_after_exit: 'Evento já fechado',
  unknown: 'Sem diagnóstico',
};

export function noEntryReasonLabel(reason) {
  return REASON_LABELS[reason] || String(reason || '').replaceAll('_', ' ');
}

export function partitionNoEntryEvents(events) {
  const tradedIds = new Set();
  for (const event of events || []) {
    if (event.entries_count > 0 || event.result === 'win' || event.result === 'loss') {
      tradedIds.add(event.condition_id);
    }
  }
  return events.filter((e) => e.result === 'no_entry' && !tradedIds.has(e.condition_id));
}

export function renderNoEntryDiagnostic(summary, events = []) {
  const totalEntries = summary?.totalEntries ?? summary?.entries ?? 0;
  const totalEvents = summary?.totalEvents ?? events.length ?? 0;
  if (totalEntries > 0 || totalEvents <= 0) return null;

  const reasons = summary?.noEntryReasons || countEventReasons(events);
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);

  return el('section', { class: 'card card--warning' }, [
    el('h2', { class: 'card__title' }, 'Diagnóstico: nenhuma entrada'),
    el('p', {}, `A estratégia processou ${totalEvents} eventos e não abriu nenhuma posição.`),
    entries.length
      ? el('div', { class: 'grid grid--4', style: { marginTop: '12px' } }, entries.slice(0, 8).map(([reason, count]) =>
        el('div', { class: 'stat stat--compact' }, [
          el('span', { class: 'stat__label' }, noEntryReasonLabel(reason)),
          el('span', { class: 'stat__value' }, String(count)),
        ])))
      : el('p', { class: 'muted' }, 'Sem motivos detalhados salvos neste run.'),
  ]);
}

function countEventReasons(events) {
  const counts = {};
  for (const event of events || []) {
    const reason = event.reason_detail;
    if (!reason) continue;
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}
