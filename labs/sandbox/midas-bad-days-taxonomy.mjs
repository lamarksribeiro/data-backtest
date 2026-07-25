/**
 * Exporta eventos perdedores do baseline aggressive e taxonomiza por features de entrada.
 *
 * Uso:
 *   node --max-old-space-size=8192 labs/sandbox/midas-bad-days-taxonomy.mjs
 *   node labs/sandbox/midas-bad-days-taxonomy.mjs --bad-days labs/sandbox/midas-bad-days-july.json
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { parse } from '../../src/backtestStudio/gls/parser.js';
import { createGlsBacktestRunner } from '../../src/backtestStudio/gls/runtime.js';
import { runSequentialSoA } from '../../src/backtest/engine.js';
import { loadBacktestColumnSet } from '../../src/query/columnChunkReader.js';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const STRATEGY_ROOT = path.join(ROOT, 'labs/strategies/terminal/midas-carry-v1');
const REPORT_MD = path.join(ROOT, 'labs/sandbox/midas-bad-days-taxonomy.md');
const REPORT_JSON = path.join(ROOT, 'labs/sandbox/midas-bad-days-taxonomy.json');

const BASELINE_PARAMS = {
  maxAsk: 0.94,
  maxDistAbs: 40,
  tierAskBudgetFactor: 2.0,
  entryBudget: 10,
  maxEntryBudget: 30,
};

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function bin(value, edges, labels) {
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (value >= edges[i] && value < edges[i + 1]) return labels[i];
  }
  return labels[labels.length - 1];
}

function hadReverse(exits) {
  return (exits || []).some((e) => /reverse/i.test(String(e.reason || e.type || '')));
}

function hadDanger(exits) {
  return (exits || []).some((e) => /danger/i.test(String(e.reason || e.type || '')));
}

function summarizeGroup(rows) {
  const n = rows.length;
  const pnl = rows.reduce((s, r) => s + r.finalPnl, 0);
  const avgPnl = n ? pnl / n : 0;
  return { n, pnl: Number(pnl.toFixed(2)), avgPnl: Number(avgPnl.toFixed(3)) };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()]
    .map(([key, items]) => ({ key, ...summarizeGroup(items) }))
    .sort((a, b) => a.pnl - b.pnl);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const from = flags.from || '2026-07-01';
  const to = flags.to || '2026-07-25';
  const badDaysPath = flags['bad-days'] || path.join(ROOT, 'labs/sandbox/midas-bad-days-july.json');
  let badDays = null;
  if (fs.existsSync(badDaysPath)) {
    badDays = JSON.parse(fs.readFileSync(badDaysPath, 'utf8')).badDays || [];
  }

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  const defaults = JSON.parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'defaults.json'), 'utf8'));
  const glsSource = fs.readFileSync(path.join(STRATEGY_ROOT, 'strategy.gls'), 'utf8');
  const glsAst = parse(glsSource);
  const params = { ...defaults, ...BASELINE_PARAMS };

  console.log(`Carregando ticks ${from} → ${to}...`);
  const columnSet = await loadBacktestColumnSet(db, {
    from: new Date(`${from}T00:00:00.000Z`).toISOString(),
    to: new Date(`${to}T00:00:00.000Z`).toISOString(),
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    selectBookDepth: 25,
    dataset: 'backtest_ticks',
    includeBook: true,
    validBacktestRows: true,
  });
  console.log(`ColumnSet: ${columnSet.length} ticks`);

  const runner = createGlsBacktestRunner(glsAst, params, {
    executionMode: 'compiled-soa',
    fastRun: true,
    bookDepth: 25,
  });
  runner.bindColumnSet(columnSet);
  await runSequentialSoA(runner, columnSet, true);
  const outcome = runner.finish();
  applyPolymarketFeesToBacktestResult(outcome, { category: 'crypto' });
  closeStateDatabase(db);

  const events = (outcome.events || []).filter((e) => e.reason !== 'no_entry');
  const losses = events.filter((e) => Number(e.finalPnl) < 0);
  const wins = events.filter((e) => Number(e.finalPnl) > 0);

  const lossRows = losses.map((e) => {
    const dt = String(e.eventStart || e.closedAt || '').slice(0, 10);
    const secsLeft = Number(e.entryTimeRemaining);
    const ask = Number(e.avgEntryPrice);
    const dist = Number(e.entryDistanceToPtb);
    const exitCount = (e.exits || []).length;
  return {
      eventId: e.eventId,
      dt,
      finalPnl: Number(e.finalPnl),
      reason: e.reason,
      side: e.positionType,
      secsLeft: Number.isFinite(secsLeft) ? secsLeft : null,
      ask: Number.isFinite(ask) ? ask : null,
      dist: Number.isFinite(dist) ? dist : null,
      exitCount,
      hadReverse: hadReverse(e.exits),
      hadDanger: hadDanger(e.exits),
      winnerSide: e.winnerSide,
      tauBin: Number.isFinite(secsLeft)
        ? bin(secsLeft, [0, 8, 12, 20, 30, 999], ['<8s', '8-12s', '12-20s', '20-30s', '>=30s'])
        : 'unknown',
      askBin: Number.isFinite(ask)
        ? bin(ask, [0, 0.7, 0.82, 0.9, 0.95, 2], ['<0.70', '0.70-0.82', '0.82-0.90', '0.90-0.95', '>=0.95'])
        : 'unknown',
      distBin: Number.isFinite(dist)
        ? bin(dist, [0, 20, 30, 40, 999], ['<20', '20-30', '30-40', '>=40'])
        : 'unknown',
    };
  });

  const stressLosses = badDays?.length
    ? lossRows.filter((r) => badDays.includes(r.dt))
    : lossRows;

  const taxonomy = {
    generatedAt: new Date().toISOString(),
    window: { from, to },
    badDays: badDays || [],
    totals: {
      events: events.length,
      wins: wins.length,
      losses: losses.length,
      totalPnl: Number(outcome.summary?.totalPnl ?? 0),
      lossPnl: Number(losses.reduce((s, e) => s + Number(e.finalPnl), 0).toFixed(2)),
      stressLossCount: stressLosses.length,
      stressLossPnl: Number(stressLosses.reduce((s, r) => s + r.finalPnl, 0).toFixed(2)),
    },
    byTau: groupBy(lossRows, (r) => r.tauBin),
    byAsk: groupBy(lossRows, (r) => r.askBin),
    byDist: groupBy(lossRows, (r) => r.distBin),
    byReason: groupBy(lossRows, (r) => r.reason || 'unknown'),
    byReverse: groupBy(lossRows, (r) => (r.hadReverse ? 'reverse_yes' : 'reverse_no')),
    byDanger: groupBy(lossRows, (r) => (r.hadDanger ? 'danger_yes' : 'danger_no')),
    stressByTau: groupBy(stressLosses, (r) => r.tauBin),
    stressByAsk: groupBy(stressLosses, (r) => r.askBin),
    topLosses: [...lossRows].sort((a, b) => a.finalPnl - b.finalPnl).slice(0, 20),
  };

  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(taxonomy, null, 2)}\n`);

  const lines = [
    '# MIDAS — taxonomia de perdas (julho)',
    '',
    `Gerado: ${taxonomy.generatedAt}`,
    `Janela: ${from} → ${to}`,
    `Bad days: ${(badDays || []).join(', ') || 'n/a'}`,
    '',
    `Eventos: ${taxonomy.totals.events} | Losses: ${taxonomy.totals.losses} | Loss PnL: ${taxonomy.totals.lossPnl}`,
    `Stress losses: ${taxonomy.totals.stressLossCount} | Stress loss PnL: ${taxonomy.totals.stressLossPnl}`,
    '',
    '## Por secsLeft na entrada (losses)',
    '',
    '| bin | n | loss PnL | avg |',
    '|---|---:|---:|---:|',
    ...taxonomy.byTau.map((r) => `| ${r.key} | ${r.n} | ${r.pnl} | ${r.avgPnl} |`),
    '',
    '## Por ask na entrada (losses)',
    '',
    '| bin | n | loss PnL | avg |',
    '|---|---:|---:|---:|',
    ...taxonomy.byAsk.map((r) => `| ${r.key} | ${r.n} | ${r.pnl} | ${r.avgPnl} |`),
    '',
    '## Por distância PTB (losses)',
    '',
    '| bin | n | loss PnL | avg |',
    '|---|---:|---:|---:|',
    ...taxonomy.byDist.map((r) => `| ${r.key} | ${r.n} | ${r.pnl} | ${r.avgPnl} |`),
    '',
    '## Por path de saída',
    '',
    '| reverse | n | loss PnL |',
    '|---|---:|---:|',
    ...taxonomy.byReverse.map((r) => `| ${r.key} | ${r.n} | ${r.pnl} |`),
    '',
    '## Top 10 piores trades',
    '',
    '| event | dt | pnl | secs | ask | dist | reverse | reason |',
    '|---|---|---:|---:|---:|---:|---|---|',
    ...taxonomy.topLosses.slice(0, 10).map((r) => (
      `| ${r.eventId?.slice(-12) || '?'} | ${r.dt} | ${r.finalPnl.toFixed(2)} | ${r.secsLeft ?? '?'} | ${r.ask?.toFixed(2) ?? '?'} | ${r.dist?.toFixed(1) ?? '?'} | ${r.hadReverse ? 'Y' : 'N'} | ${r.reason} |`
    )),
    '',
  ];
  fs.writeFileSync(REPORT_MD, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  console.log(`\nSalvo: ${REPORT_MD}`);
  console.log(`Salvo: ${REPORT_JSON}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
