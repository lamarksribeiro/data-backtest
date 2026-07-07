/**
 * Roda backtests evento-a-evento (fastRun:false) para V5 Practical, V6 Hybrid e contrafactual hold.
 *
 * Uso:
 *   node --max-old-space-size=8192 labs/sandbox/tfc-v7-diag-run-events.mjs
 *   node --max-old-space-size=8192 labs/sandbox/tfc-v7-diag-run-events.mjs --from 2026-05-04 --to 2026-05-10 --smoke
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { runBacktest } from '../../src/backtest/engine.js';
import { parse } from '../../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../../src/backtestStudio/gls/compiler.js';
import { loadPreset } from '../shared/presets.js';
import {
  FROM, TO, CACHE_DIR, compactEvent, parseArgs, parseDateStart, parseDateEnd, writeJson, traceCrossMeta,
} from './tfc-v7-diag-lib.mjs';

const STRATEGY_ID = 'tfc';
const STRATEGY_FAMILY = 'terminal';

const VARIANTS = [
  { id: 'v5-practical', preset: 'btc-champion-v5-practical' },
  {
    id: 'v5-hold-contrafactual',
    preset: 'btc-champion-v5-practical',
    paramOverrides: { lateFlipExitEnabled: false, lateFlipReverseEnabled: false },
  },
  { id: 'v6-hybrid', preset: 'btc-champion-v6-hybrid' },
];

async function runVariant(db, { id, preset, paramOverrides }, from, to) {
  const { params, strategyRoot } = loadPreset(preset, { strategyFamily: STRATEGY_FAMILY, strategyId: STRATEGY_ID });
  const mergedParams = { ...params, ...(paramOverrides || {}) };
  const strategy = JSON.parse(fs.readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
  const sourcePath = path.resolve(strategy.source.path || strategy.source.glsPath);
  const glsAst = parse(fs.readFileSync(sourcePath, 'utf8'));
  const bookDepth = Number(strategy.defaultBookDepth || 25);
  const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);

  const captured = [];
  const crossByEventId = new Map();
  console.error(`[run-events] ${id} ${from}..${to}`);

  const result = await runBacktest(db, {
    from: parseDateStart(from).toISOString(),
    to: parseDateEnd(to).toISOString(),
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
    batchSize: 25_000,
    strategy: `gls:${strategy.id}`,
    strategyLabel: strategy.name,
    glsAst,
    columnAnalysis,
    params: mergedParams,
    fastRun: false,
    glsExecution: 'compiled-soa',
    strategyMeta: { lab: true, analysis: 'tfc-v7-diag', variant: id },
    onEventFinalized: (event, samples) => {
      const entry = (event.orders || []).find((o) => !o.type || o.type === 'entry');
      if (!entry) return;
      crossByEventId.set(event.eventId, traceCrossMeta({ event, samples, entryOrder: entry }));
    },
  });

  for (const event of result.events || []) {
    const entry = (event.orders || []).find((o) => !o.type || o.type === 'entry');
    if (!entry) continue;
    const compact = compactEvent(event);
    compact.cross = crossByEventId.get(event.eventId) ?? compact.cross;
    captured.push(compact);
  }

  const out = {
    ok: true,
    variant: id,
    preset,
    paramOverrides: paramOverrides || null,
    window: { from, to },
    summary: result.summary,
    events: captured,
  };
  const outPath = path.join(CACHE_DIR, `events-${id}.json`);
  writeJson(outPath, out);
  console.error(`[run-events] ${id}: n=${captured.length} pnl=${result.summary?.totalPnl?.toFixed(2)} -> ${outPath}`);
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const from = flags.from || FROM;
  const to = flags.to || TO;
  const only = flags.variant ? [flags.variant] : null;

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const results = [];
    for (const variant of VARIANTS) {
      if (only && !only.includes(variant.id)) continue;
      results.push(await runVariant(db, variant, from, to));
    }
    writeJson(path.join(CACHE_DIR, 'run-meta.json'), {
      ok: true,
      from,
      to,
      variants: results.map((r) => ({ id: r.variant, summary: r.summary, events: r.events.length })),
    });
    console.log(JSON.stringify(results.map((r) => ({
      variant: r.variant,
      entries: r.events.length,
      totalPnl: r.summary?.totalPnl,
      maxDrawdown: r.summary?.maxDrawdown,
    })), null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
