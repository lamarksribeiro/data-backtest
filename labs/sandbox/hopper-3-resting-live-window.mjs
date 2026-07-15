/**
 * Roda Hopper 3 (preset campeão) nos 3 modos de execução na mesma janela DuckDB.
 *
 * Uso:
 *   node --max-old-space-size=8192 labs/sandbox/hopper-3-resting-live-window.mjs
 *   node labs/sandbox/hopper-3-resting-live-window.mjs --from 2026-06-01 --to 2026-06-03
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../../src/backtestStudio/nativeLibrary/registry.js';
import { createLibraryRunnerAdapter } from '../../src/backtestStudio/strategyLibrary/runnerAdapter.js';
import { runSequentialSoA } from '../../src/backtest/engine.js';
import { loadBacktestColumnSet } from '../../src/query/columnChunkReader.js';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';
import { renderPresetStrategyJs } from '../shared/renderPresetStrategyJs.js';
import { validateStrategySource } from '../../src/backtestStudio/strategyJs/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const STRATEGY_ROOT = path.join(ROOT, 'labs/strategies/carry/hopper-3');
const REPORT_PATH = path.join(ROOT, 'labs/sandbox/hopper-3-resting-live-window-report.md');

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

function summarize(mode, outcome) {
  const s = outcome.summary || {};
  const events = outcome.events || [];
  const restingPlaced = events.reduce((n, e) => n + (e.restingPlaced || 0), 0);
  const restingFilled = events.reduce((n, e) => n + (e.restingFilled || 0), 0);
  const restingCancelled = events.reduce((n, e) => n + (e.restingCancelled || 0), 0);
  const fees = events.reduce((n, e) => n + (e.fees?.totalFee || 0), 0);
  const pnl = Number(s.totalPnl || 0);
  return {
    mode,
    totalEvents: s.totalEvents ?? events.length,
    totalEntries: s.totalEntries ?? events.filter((e) => e.reason !== 'no_entry').length,
    totalNoEntry: s.totalNoEntry ?? events.filter((e) => e.reason === 'no_entry').length,
    totalWins: s.totalWins ?? 0,
    totalLosses: s.totalLosses ?? 0,
    winRate: s.winRate ?? 0,
    totalPnl: Number(pnl.toFixed(2)),
    fees: Number(fees.toFixed(2)),
    totalPnlAfterFees: Number((pnl - fees).toFixed(2)),
    maxDrawdown: Number((s.maxDrawdown || 0).toFixed(2)),
    restingPlaced: s.restingPlaced ?? restingPlaced,
    restingFilled: s.restingFilled ?? restingFilled,
    restingCancelled: s.restingCancelled ?? restingCancelled,
    makerFillRate: s.makerFillRate
      ?? (restingPlaced > 0 ? restingFilled / restingPlaced : null),
  };
}

async function runMode(db, runnerLibrary, baseParams, mode, columnSet) {
  const params = { ...baseParams, executionMode: mode, simulateMaker: mode !== 'taker' };
  const runner = createLibraryRunnerAdapter(db, runnerLibrary, params, { fastRun: true, bookDepth: 25 });
  runner.bindColumnSet(columnSet);
  await runSequentialSoA(runner, columnSet, false);
  const outcome = runner.finish();
  applyPolymarketFeesToBacktestResult(outcome, { category: 'crypto' });
  return summarize(mode, outcome);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const from = flags.from || '2026-06-01';
  const to = flags.to || '2026-06-07';
  const modes = String(flags.modes || 'optimistic_maker,resting_maker,taker')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: false });
  bindStrategyLibraryDatabase(db);

  const strategy = JSON.parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'strategy.json'), 'utf8'));
  const defaults = JSON.parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'defaults.json'), 'utf8'));
  const preset = JSON.parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'presets/btc-champion.json'), 'utf8'));
  const baseParams = { ...defaults, ...preset.params };

  const sourcePath = path.join(STRATEGY_ROOT, 'strategy.js');
  const rendered = renderPresetStrategyJs(fs.readFileSync(sourcePath, 'utf8'), defaults, strategy.name);
  const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: rendered, db });
  if (!validation.ok) {
    throw new Error(validation.errors?.[0]?.message || 'strategy-js validation failed');
  }

  console.log(`Carregando ticks BTC 5m ${from} → ${to}...`);
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

  const rows = [];
  for (const mode of modes) {
    console.log(`\n=== ${mode} ===`);
    const t0 = Date.now();
    const row = await runMode(db, validation.runner_library, baseParams, mode, columnSet);
    row.elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(1));
    rows.push(row);
    console.log(JSON.stringify(row, null, 2));
  }

  closeStateDatabase(db);

  const md = [
    '# Hopper 3 — janela real (optimistic vs resting vs taker)',
    '',
    `Gerado: ${new Date().toISOString()}`,
    `Janela: ${from} → ${to} | ticks: ${columnSet.length}`,
    `Preset base: btc-champion (params) + override executionMode`,
    '',
    '| mode | entries | no_entry | win% | PnL bruto | fees | PnL pós-fee | DD | resting P/F/C | fill% | sec |',
    '|------|---------|----------|------|-----------|------|-------------|----|---------------|-------|-----|',
    ...rows.map((r) => {
      const fillPct = r.makerFillRate == null ? '—' : `${(r.makerFillRate * 100).toFixed(0)}%`;
      return `| ${r.mode} | ${r.totalEntries} | ${r.totalNoEntry} | ${r.winRate} | ${r.totalPnl} | ${r.fees} | ${r.totalPnlAfterFees} | ${r.maxDrawdown} | ${r.restingPlaced}/${r.restingFilled}/${r.restingCancelled} | ${fillPct} | ${r.elapsedSec} |`;
    }),
    '',
    '## Leitura',
    '',
    '- `resting_maker` é o modo mais próximo da conta real (LIMIT postOnly + fill por atravessamento).',
    '- Se resting for bem pior que optimistic, o edge do campeão dependia do fill otimista.',
    '- Compare resting vs taker: resting deve ter menos fees e fill rate < 100%.',
    '',
  ].join('\n');

  fs.writeFileSync(REPORT_PATH, md);
  console.log(`\n${md}`);
  console.log(`Salvo: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
