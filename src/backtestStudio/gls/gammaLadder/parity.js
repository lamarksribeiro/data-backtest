import { createGammaLadderBacktestRunner } from './runner.js';
import { createGammaLadderGlsRunner } from './glsAdapter.js';
import { legacyTickFromAny } from './tickBridge.js';

function compareNumber(left, right, tolerance = 0.0001) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

export function runGammaLadderOnTicks(ticks, params = {}, { useGlsRunner = false } = {}) {
  const runner = useGlsRunner
    ? createGammaLadderGlsRunner(params, { bookDepth: 25 })
    : createGammaLadderBacktestRunner(params);
  for (const tick of ticks) {
    if (useGlsRunner) runner.processTick(tick);
    else runner.processTick(legacyTickFromAny(tick, 25));
  }
  return runner.finish();
}

export function compareGammaLadderParity(ticks, params = {}) {
  const native = runGammaLadderOnTicks(ticks, params, { useGlsRunner: false });
  const gls = runGammaLadderOnTicks(ticks, params, { useGlsRunner: true });
  const divergences = [];

  const fields = ['totalPnl', 'totalEntries', 'totalWins', 'totalLosses', 'totalEvents', 'totalNoEntry'];
  for (const field of fields) {
    if (!compareNumber(native.summary?.[field], gls.summary?.[field], field === 'totalPnl' ? 0.01 : 0)) {
      divergences.push({ field, native: native.summary?.[field], gls: gls.summary?.[field] });
    }
  }

  return {
    match: divergences.length === 0,
    divergences,
    native: native.summary,
    gls: gls.summary,
  };
}
