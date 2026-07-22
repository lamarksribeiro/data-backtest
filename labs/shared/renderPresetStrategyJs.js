import { updateStrategyJsParams } from '../../src/backtestStudio/source/updateSourceParams.js';

export function renderPresetStrategyJs(sourceCode, params, strategyName) {
  let result = updateStrategyJsParams(sourceCode, params);
  if (strategyName) {
    result = result.replace(/name:\s*"[^"]*"/, `name: "${strategyName}"`);
  }
  return result;
}
