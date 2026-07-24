import fs from 'fs';
import path from 'path';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../src/backtestStudio/gls/columnAnalysis.js';
import { runBacktest } from '../src/backtest/engine.js';
import { loadConfig } from '../src/config.js';
import { closeStateDatabase, openStateDatabase } from '../src/state/sqlite.js';
import { loadPreset } from '../labs/shared/presets.js';

const TARGET_STARTS = new Set([
  '2026-07-24T22:15:00.000Z',
  '2026-07-24T22:45:00.000Z',
]);
const TARGET_IDS = new Set([
  '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533',
  '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5',
].map((s) => s.toLowerCase()));

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

const parquet = db.prepare(`
  SELECT active_path, rows, status FROM lake_manifest
  WHERE dataset='backtest_ticks' AND underlying='BTC' AND interval='5m'
    AND book_depth=25 AND dt='2026-07-24'
`).all();
console.log('manifest', JSON.stringify(parquet, null, 2));

const { params, strategyRoot } = loadPreset('btc-micro-aggressive-v1', {
  strategyFamily: 'terminal',
  strategyId: 'midas-carry-v1',
});
const strategy = JSON.parse(fs.readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
const sourcePath = path.resolve(strategy.source.path || strategy.source.glsPath);
const glsAst = parse(fs.readFileSync(sourcePath, 'utf8'));
const bookDepth = Number(strategy.defaultBookDepth || 25);
const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);

const exact = [];
const near = [];
let finalized = 0;

try {
  await runBacktest(db, {
    from: '2026-07-24T00:00:00.000Z',
    to: '2026-07-25T00:00:00.000Z',
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
    onEventFinalized: (event) => {
      finalized += 1;
      const cid = String(event.eventId || event.conditionId || '').toLowerCase();
      const start = event.eventStart ? new Date(event.eventStart).toISOString() : null;
      const entry = (event.orders || []).find((o) => o.type === 'entry');
      const row = {
        conditionId: event.eventId || event.conditionId,
        eventStart: start,
        finalPnl: event.finalPnl ?? null,
        orderCount: (event.orders || []).length,
        entrySide: entry?.side || null,
        entryTs: entry?.ts || null,
        entryPrice: entry?.avgPrice ?? entry?.price ?? null,
        orders: (event.orders || []).map((o) => `${o.type}:${o.side}:${o.reason}@${o.avgPrice ?? o.price}`),
      };
      if (TARGET_IDS.has(cid) || TARGET_STARTS.has(start)) exact.push({ ...row, rawKeys: Object.keys(event) });
      if (start && (start.includes('T22:1') || start.includes('T22:4'))) near.push(row);
    },
  });
} finally {
  closeStateDatabase(db);
}

const out = {
  finalized,
  exact,
  near: near.sort((a, b) => String(a.eventStart).localeCompare(String(b.eventStart))),
};
fs.writeFileSync('/app/scratch/live-vs-backtest-debug.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
