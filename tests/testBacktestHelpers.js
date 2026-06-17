import path from 'node:path';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { getEdgeSniperV2GlsSource, getEdgeSniperV3V2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';

export const NATIVE_EDGE_SNIPER_PATH = path.resolve('src/strategies/edgeSniperV2.js');

/** Manifest de testes usa backtest_ticks com book_depth; o módulo nativo não declara requiresBook. */
export const NATIVE_EDGE_SNIPER_TICK_CONTEXT = {
  columnAnalysis: { needsBookLevels: true, bookDepth: 2 },
};

export function edgeSniperV3GlsAst() {
  return parse(getEdgeSniperV3V2GlsSource());
}

/** @deprecated use edgeSniperV3GlsAst — mantido para testes de paridade legada v2 */
export function edgeSniperV2GlsAst() {
  return parse(getEdgeSniperV2GlsSource());
}
