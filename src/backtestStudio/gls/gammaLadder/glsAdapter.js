import { createTickCursorView } from '../../../backtest/columnStore.js';
import { createGammaLadderBacktestRunner } from './runner.js';
import { legacyTickFromAny, legacyTickFromCursor } from './tickBridge.js';

export const GAMMA_LADDER_COLUMN_ANALYSIS = {
  needsBookLevels: true,
  bookDepth: 25,
};

export function isGammaLadderStrategy(astOrName) {
  const name = typeof astOrName === 'string' ? astOrName : astOrName?.name;
  return String(name || '').toLowerCase().includes('gamma ladder');
}

export function getExecutionKind(versionOrAst) {
  if (versionOrAst?.validation?.execution_kind) {
    return versionOrAst.validation.execution_kind;
  }
  if (versionOrAst?.validation_json) {
    try {
      const parsed = typeof versionOrAst.validation_json === 'string'
        ? JSON.parse(versionOrAst.validation_json)
        : versionOrAst.validation_json;
      if (parsed?.execution_kind) return parsed.execution_kind;
    } catch {
      // ignore
    }
  }
  if (isGammaLadderStrategy(versionOrAst)) return 'native-extension';
  return 'compiled-soa';
}

export function enrichGammaLadderValidation(validation, ast) {
  if (!validation || !isGammaLadderStrategy(ast)) return validation;
  return {
    ...validation,
    execution_kind: 'native-extension',
    editable_logic: false,
  };
}

export function createGammaLadderGlsRunner(rawParams = {}, options = {}) {
  const inner = createGammaLadderBacktestRunner(rawParams);
  const bookDepth = options.bookDepth ?? 25;
  let columnSet = null;
  let tickCursor = null;
  let ticksProcessed = 0;

  function processLegacyTick(tick) {
    ticksProcessed += 1;
    inner.processTick(legacyTickFromAny(tick, bookDepth));
  }

  return {
    executionMode: 'gamma-ladder',
    bindColumnSet(nextColumnSet) {
      columnSet = nextColumnSet;
      tickCursor = createTickCursorView(columnSet);
    },
    beginEvent() {},
    endEvent() {},
    processTick(rawTick) {
      processLegacyTick(rawTick);
    },
    processIndex(rowIndex) {
      if (!columnSet || !tickCursor) return;
      tickCursor.setIndex(rowIndex);
      ticksProcessed += 1;
      inner.processTick(legacyTickFromCursor(tickCursor, columnSet, bookDepth));
    },
    importParallelSlices() {
      throw new Error('gamma-ladder runner does not support parallel event slices yet');
    },
    finish() {
      const result = inner.finish();
      result.summary.ticksProcessed = ticksProcessed;
      return result;
    },
  };
}
