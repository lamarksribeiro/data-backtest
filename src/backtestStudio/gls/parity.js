import { createEdgeSniperBacktestRunner } from '../../strategies/edgeSniperV2.js';
import { createGlsRunnerFromSource } from './runtime.js';
import { getEdgeSniperV2GlsSource } from './loadStrategySource.js';

export function compareGlsExecutionParity(source, ticks, params = {}, options = {}) {
  const interpreter = createGlsRunnerFromSource(source, params, { ...options, executionMode: 'interpreter' });
  const compiled = createGlsRunnerFromSource(source, params, { ...options, executionMode: 'compiled' });
  for (const tick of ticks) {
    interpreter.processTick(tick);
    compiled.processTick(tick);
  }
  const interpreterResult = interpreter.finish();
  const compiledResult = compiled.finish();
  return {
    interpreter: summarize(interpreterResult),
    compiled: summarize(compiledResult),
    match: parityMatch(interpreterResult, compiledResult),
    divergences: collectDivergences(interpreterResult, compiledResult),
  };
}

export function compareEdgeSniperParity(ticks, params = {}, options = {}) {
  const native = createEdgeSniperBacktestRunner(params);
  const gls = createGlsRunnerFromSource(getEdgeSniperV2GlsSource(), params, options);
  for (const tick of ticks) {
    native.processTick(tick);
    gls.processTick(tick);
  }
  const nativeResult = native.finish();
  const glsResult = gls.finish();
  return {
    native: summarize(nativeResult),
    gls: summarize(glsResult),
    match: parityMatch(nativeResult, glsResult),
    divergences: collectDivergences(nativeResult, glsResult),
  };
}

function summarize(result) {
  const summary = result.summary || {};
  return {
    strategy: result.strategy,
    totalEvents: summary.totalEvents ?? result.events?.length ?? 0,
    totalEntries: summary.totalEntries ?? 0,
    totalWins: summary.totalWins ?? summary.wins ?? 0,
    totalLosses: summary.totalLosses ?? summary.losses ?? 0,
    totalPnl: Number((summary.totalPnl ?? 0).toFixed(4)),
    totalNoEntry: summary.totalNoEntry ?? 0,
  };
}

function parityMatch(nativeResult, glsResult) {
  const native = summarize(nativeResult);
  const gls = summarize(glsResult);
  return native.totalEvents === gls.totalEvents
    && native.totalEntries === gls.totalEntries
    && native.totalPnl === gls.totalPnl
    && native.totalWins === gls.totalWins
    && native.totalLosses === gls.totalLosses;
}

function collectDivergences(nativeResult, glsResult) {
  const divergences = [];
  const native = summarize(nativeResult);
  const gls = summarize(glsResult);
  for (const key of ['totalEvents', 'totalEntries', 'totalPnl', 'totalWins', 'totalLosses']) {
    if (native[key] !== gls[key]) divergences.push({ field: key, native: native[key], gls: gls[key] });
  }
  return divergences;
}
