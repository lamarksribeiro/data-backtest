/**
 * Replay MIDAS micro-aggressive nos 2 eventos live e dumpa orders/PnL.
 * Uso no container Brutus:
 *   node scratch/compare-live-events.js
 */
import fs from 'fs';
import path from 'path';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../src/backtestStudio/gls/columnAnalysis.js';
import { runBacktest } from '../src/backtest/engine.js';
import { loadConfig } from '../src/config.js';
import { closeStateDatabase, openStateDatabase } from '../src/state/sqlite.js';
import { loadPreset } from '../labs/shared/presets.js';

const TARGET_IDS = new Set([
  '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533',
  '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5',
].map((s) => s.toLowerCase()));

const TARGET_STARTS = new Set([
  '2026-07-24T22:15:00.000Z',
  '2026-07-24T22:45:00.000Z',
]);

function parseDateStart(value) {
  return new Date(`${value}T00:00:00.000Z`);
}
function parseDateEnd(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

const { params, strategyRoot } = loadPreset('btc-micro-aggressive-v1', {
  strategyFamily: 'terminal',
  strategyId: 'midas-carry-v1',
});
const strategy = JSON.parse(fs.readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
const sourcePath = path.resolve(strategy.source.path || strategy.source.glsPath);
const glsAst = parse(fs.readFileSync(sourcePath, 'utf8'));
const bookDepth = Number(strategy.defaultBookDepth || 25);
const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);
const captured = [];

try {
  await runBacktest(db, {
    from: parseDateStart('2026-07-24').toISOString(),
    to: parseDateEnd('2026-07-25').toISOString(),
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
    batchSize: 25_000,
    strategy: `gls:${strategy.id}`,
    strategyLabel: strategy.name,
    glsAst,
    columnAnalysis,
    params,
    fastRun: false,
    glsExecution: 'compiled-soa',
    strategyMeta: { lab: true, analysis: 'live-vs-backtest' },
    onEventFinalized: (event) => {
      const cid = String(event.eventId || event.conditionId || '').toLowerCase();
      const start = event.eventStart ? new Date(event.eventStart).toISOString() : null;
      if (!TARGET_IDS.has(cid) && !TARGET_STARTS.has(start)) return;
      captured.push({
        conditionId: event.eventId || event.conditionId,
        eventStart: event.eventStart,
        eventEnd: event.eventEnd,
        finalPnl: event.finalPnl ?? event.pnl ?? null,
        winner: event.winner ?? null,
        orders: (event.orders || []).map((o) => ({
          type: o.type,
          side: o.side,
          ts: o.ts,
          avgPrice: o.avgPrice ?? o.price,
          qty: o.qty ?? o.quantity,
          reason: o.reason,
          budget: o.budget,
        })),
        marks: (event.marks || []).slice(0, 20),
      });
    },
  });

  const out = {
    ok: true,
    preset: 'btc-micro-aggressive-v1',
    capturedCount: captured.length,
    captured: captured.sort((a, b) => String(a.eventStart).localeCompare(String(b.eventStart))),
  };
  const outPath = '/app/scratch/live-vs-backtest-events.json';
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  console.error(`wrote ${outPath}`);
} finally {
  closeStateDatabase(db);
}
