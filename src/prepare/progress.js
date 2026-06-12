const PHASE_FRACTION = {
  queued: 0,
  starting: 0.05,
  skipped: 1,
  listing_events: 0.12,
  counting_ticks: 0.28,
  fetching_rows: 0.58,
  writing_parquet: 0.88,
  done: 1,
};

export function phaseToFraction(phase) {
  if (!phase) return 0.02;
  return PHASE_FRACTION[phase] ?? 0.35;
}

export function computePrepareJobPercent(progress = {}) {
  if (!progress || typeof progress !== 'object') return 0;

  const actionsTotal = Math.max(1, Number(progress.actions_total) || 1);
  const actionIndex = Math.max(0, Number(progress.action_index) || 0);
  const actionWeight = 100 / actionsTotal;

  const partitionsTotal = Math.max(1, Number(progress.partitions_total) || 1);
  const partitionsDone = Math.max(0, Number(progress.partitions_done) || 0);

  let currentActionFraction = partitionsDone / partitionsTotal;
  if (partitionsDone < partitionsTotal) {
    const phaseFraction = phaseToFraction(progress.current?.phase);
    const partitionSlice = 1 / partitionsTotal;
    currentActionFraction = (partitionsDone / partitionsTotal) + (phaseFraction * partitionSlice);
  }

  const pct = (actionIndex * actionWeight) + (currentActionFraction * actionWeight);
  return Math.min(99, Math.max(0, Math.round(pct)));
}
