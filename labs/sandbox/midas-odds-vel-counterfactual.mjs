/**
 * Auditoria contrafactual do oddsVelGate:
 * trades que o baseline fez e o gate bloqueou — eram loss (TP) ou win (FP)?
 *
 * Uso:
 *   node --max-old-space-size=8192 labs/sandbox/midas-odds-vel-counterfactual.mjs
 *   node labs/sandbox/midas-odds-vel-counterfactual.mjs --from 2026-07-01 --to 2026-07-26 --delta 0.10
 *   node labs/sandbox/midas-odds-vel-counterfactual.mjs --from 2026-05-04 --to 2026-07-01 --delta 0.10 --tag train
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bin(value, edges, labels) {
  if (!Number.isFinite(value)) return 'unknown';
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (value >= edges[i] && value < edges[i + 1]) return labels[i];
  }
  return labels[labels.length - 1];
}

function eventKey(ev) {
  return String(ev.conditionId || ev.condition_id || ev.eventId || '');
}

function summarize(rows, pnlKey = 'finalPnl') {
  const n = rows.length;
  const pnl = rows.reduce((s, r) => s + (r[pnlKey] || 0), 0);
  const losses = rows.filter((r) => (r[pnlKey] || 0) < -0.01);
  const wins = rows.filter((r) => (r[pnlKey] || 0) > 0.01);
  return {
    n,
    pnl: Number(pnl.toFixed(2)),
    losses: losses.length,
    wins: wins.length,
    lossPnl: Number(losses.reduce((s, r) => s + r[pnlKey], 0).toFixed(2)),
    winPnl: Number(wins.reduce((s, r) => s + r[pnlKey], 0).toFixed(2)),
    wr: n ? Number((wins.length / n).toFixed(3)) : 0,
    avgPnl: n ? Number((pnl / n).toFixed(3)) : 0,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()]
    .map(([key, items]) => ({ key, ...summarize(items) }))
    .sort((a, b) => a.pnl - b.pnl);
}

function tradeRow(ev) {
  const secsLeft = num(ev.entryTimeRemaining);
  const ask = num(ev.avgEntryPrice);
  const dist = num(ev.entryDistanceToPtb);
  const finalPnl = num(ev.finalPnl) ?? 0;
  return {
    key: eventKey(ev),
    dt: String(ev.eventStart || ev.closedAt || '').slice(0, 10),
    finalPnl,
    side: ev.positionType,
    secsLeft,
    ask,
    dist,
    reason: ev.reason,
    tauBin: bin(secsLeft, [0, 8, 12, 20, 30, 999], ['<8s', '8-12s', '12-20s', '20-30s', '>=30s']),
    askBin: bin(ask, [0, 0.7, 0.82, 0.9, 0.95, 2], ['<0.70', '0.70-0.82', '0.82-0.90', '0.90-0.95', '>=0.95']),
    distBin: bin(dist, [0, 20, 30, 40, 999], ['<20', '20-30', '30-40', '>=40']),
    outcome: finalPnl < -0.01 ? 'loss' : finalPnl > 0.01 ? 'win' : 'flat',
  };
}

async function runVariant(glsAst, defaults, params, columnSet) {
  const runner = createGlsBacktestRunner(glsAst, { ...defaults, ...params }, {
    executionMode: 'compiled-soa',
    fastRun: true,
    bookDepth: 25,
  });
  runner.bindColumnSet(columnSet);
  await runSequentialSoA(runner, columnSet, true);
  const outcome = runner.finish();
  applyPolymarketFeesToBacktestResult(outcome, { category: 'crypto' });
  const traded = (outcome.events || []).filter((e) => e.reason !== 'no_entry');
  const byKey = new Map();
  for (const ev of traded) {
    const row = tradeRow(ev);
    if (row.key) byKey.set(row.key, row);
  }
  return {
    summary: {
      totalPnl: Number(outcome.summary?.totalPnl ?? 0),
      trades: traded.length,
      ...summarize([...byKey.values()]),
    },
    byKey,
  };
}

function mdTable(rows, cols) {
  const lines = [];
  lines.push(`| ${cols.map((c) => c.h).join(' | ')} |`);
  lines.push(`| ${cols.map((c) => (c.align === 'l' ? '---' : '---:')).join('|')} |`);
  for (const row of rows) {
    lines.push(`| ${cols.map((c) => row[c.k]).join(' | ')} |`);
  }
  return lines.join('\n');
}

async function analyzeWindow({ from, to, delta, lookback, tag, glsAst, defaults, db }) {
  console.log(`\n=== ${tag}: ${from} → ${to} | delta=${delta} lb=${lookback} ===`);
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

  const baseline = await runVariant(glsAst, defaults, BASELINE_PARAMS, columnSet);
  console.log(`Baseline: trades=${baseline.summary.trades} pnl=${baseline.summary.totalPnl.toFixed(2)}`);

  const gatedParams = {
    ...BASELINE_PARAMS,
    oddsVelGateEnabled: true,
    oddsVelMaxDelta: delta,
    oddsVelLookbackSec: lookback,
  };
  const gated = await runVariant(glsAst, defaults, gatedParams, columnSet);
  console.log(`Gated:    trades=${gated.summary.trades} pnl=${gated.summary.totalPnl.toFixed(2)}`);

  const blocked = [];
  const kept = [];
  for (const [key, row] of baseline.byKey) {
    if (gated.byKey.has(key)) kept.push(row);
    else blocked.push({ ...row, filterClass: row.outcome === 'loss' ? 'TP_avoided_loss' : row.outcome === 'win' ? 'FP_missed_win' : 'flat' });
  }

  const added = [];
  for (const [key, row] of gated.byKey) {
    if (!baseline.byKey.has(key)) added.push(row);
  }

  const blockedSum = summarize(blocked);
  const keptSum = summarize(kept);
  const tp = blocked.filter((r) => r.filterClass === 'TP_avoided_loss');
  const fp = blocked.filter((r) => r.filterClass === 'FP_missed_win');
  const precision = blocked.length ? tp.length / blocked.length : 0;
  // Value of filter on blocked set: -sum(blocked pnl) would be "saved" if all blocked;
  // net = avoided losses - missed wins = -blocked.pnl (since we don't take those trades)
  const netFromBlocking = -blockedSum.pnl;

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from, to, tag },
    gate: { oddsVelMaxDelta: delta, oddsVelLookbackSec: lookback },
    baseline: baseline.summary,
    gated: gated.summary,
    deltaPnl: Number((gated.summary.totalPnl - baseline.summary.totalPnl).toFixed(2)),
    blocked: {
      ...blockedSum,
      tp: tp.length,
      fp: fp.length,
      precision: Number(precision.toFixed(3)),
      netFromBlocking: Number(netFromBlocking.toFixed(2)),
      avoidedLossPnl: Number(summarize(tp).lossPnl.toFixed?.(2) ? summarize(tp).lossPnl : summarize(tp).pnl),
      missedWinPnl: Number(summarize(fp).pnl.toFixed?.(2) ? summarize(fp).pnl : summarize(fp).pnl),
    },
    kept: keptSum,
    added: summarize(added),
    byOutcome: groupBy(blocked, (r) => r.filterClass),
    byTau: groupBy(blocked, (r) => r.tauBin),
    byAsk: groupBy(blocked, (r) => r.askBin),
    byDist: groupBy(blocked, (r) => r.distBin),
    byDay: groupBy(blocked, (r) => r.dt).sort((a, b) => a.pnl - b.pnl),
    tpByAsk: groupBy(tp, (r) => r.askBin),
    fpByAsk: groupBy(fp, (r) => r.askBin),
    tpByTau: groupBy(tp, (r) => r.tauBin),
    fpByTau: groupBy(fp, (r) => r.tauBin),
    topMissedWins: [...fp].sort((a, b) => b.finalPnl - a.finalPnl).slice(0, 15),
    topAvoidedLosses: [...tp].sort((a, b) => a.finalPnl - b.finalPnl).slice(0, 15),
  };

  // Fix avoided/missed fields cleanly
  report.blocked.avoidedLossPnl = summarize(tp).pnl;
  report.blocked.missedWinPnl = summarize(fp).pnl;

  const outJson = path.join(ROOT, `labs/sandbox/midas-odds-vel-cf-${tag}.json`);
  const outMd = path.join(ROOT, `labs/sandbox/midas-odds-vel-cf-${tag}.md`);
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);

  const md = [];
  md.push(`# MIDAS — contrafactual oddsVelGate (${tag})`);
  md.push('');
  md.push(`Gerado: ${report.generatedAt}`);
  md.push(`Janela: ${from} → ${to}`);
  md.push(`Gate: delta=${delta}, lookback=${lookback}s`);
  md.push('');
  md.push('## Resumo');
  md.push('');
  md.push(`| | trades | PnL | WR |`);
  md.push(`|---|---:|---:|---:|`);
  md.push(`| baseline | ${baseline.summary.trades} | ${baseline.summary.totalPnl.toFixed(2)} | ${baseline.summary.wr} |`);
  md.push(`| gated | ${gated.summary.trades} | ${gated.summary.totalPnl.toFixed(2)} | ${gated.summary.wr} |`);
  md.push(`| Δ | ${gated.summary.trades - baseline.summary.trades} | ${report.deltaPnl} | — |`);
  md.push('');
  md.push('## Trades bloqueados (baseline fez, gate não)');
  md.push('');
  md.push(`- n=${blockedSum.n} · PnL contrafactual dos bloqueados=${blockedSum.pnl}`);
  md.push(`- **TP** (evitou loss): ${tp.length} · PnL evitado=${report.blocked.avoidedLossPnl}`);
  md.push(`- **FP** (perdeu win): ${fp.length} · PnL perdido=${report.blocked.missedWinPnl}`);
  md.push(`- Precisão TP/(TP+FP+flat): ${(precision * 100).toFixed(1)}%`);
  md.push(`- Net de bloquear (−PnL dos bloqueados): **${report.blocked.netFromBlocking}**`);
  md.push('');
  md.push('### Por classe');
  md.push('');
  md.push(mdTable(report.byOutcome, [
    { h: 'classe', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
    { h: 'avg', k: 'avgPnl' },
  ]));
  md.push('');
  md.push('### Bloqueados por secsLeft');
  md.push('');
  md.push(mdTable(report.byTau, [
    { h: 'tau', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
    { h: 'wins', k: 'wins' },
    { h: 'losses', k: 'losses' },
  ]));
  md.push('');
  md.push('### Bloqueados por ask');
  md.push('');
  md.push(mdTable(report.byAsk, [
    { h: 'ask', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
    { h: 'wins', k: 'wins' },
    { h: 'losses', k: 'losses' },
  ]));
  md.push('');
  md.push('### Bloqueados por dist');
  md.push('');
  md.push(mdTable(report.byDist, [
    { h: 'dist', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
    { h: 'wins', k: 'wins' },
    { h: 'losses', k: 'losses' },
  ]));
  md.push('');
  md.push('### TP vs FP por ask');
  md.push('');
  md.push('TP (losses evitadas):');
  md.push(mdTable(report.tpByAsk, [
    { h: 'ask', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
  ]));
  md.push('');
  md.push('FP (wins perdidas):');
  md.push(mdTable(report.fpByAsk, [
    { h: 'ask', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
  ]));
  md.push('');
  md.push('### TP vs FP por secsLeft');
  md.push('');
  md.push('TP:');
  md.push(mdTable(report.tpByTau, [
    { h: 'tau', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
  ]));
  md.push('');
  md.push('FP:');
  md.push(mdTable(report.fpByTau, [
    { h: 'tau', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL', k: 'pnl' },
  ]));
  md.push('');
  md.push('### Dias em que o bloqueio mais ajudou (PnL dos bloqueados mais negativo)');
  md.push('');
  md.push(mdTable(report.byDay.slice(0, 10), [
    { h: 'dia', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL bloqueado', k: 'pnl' },
    { h: 'losses', k: 'losses' },
    { h: 'wins', k: 'wins' },
  ]));
  md.push('');
  md.push('### Dias em que o bloqueio mais prejudicou (PnL dos bloqueados mais positivo)');
  md.push('');
  md.push(mdTable([...report.byDay].sort((a, b) => b.pnl - a.pnl).slice(0, 10), [
    { h: 'dia', k: 'key', align: 'l' },
    { h: 'n', k: 'n' },
    { h: 'PnL bloqueado', k: 'pnl' },
    { h: 'losses', k: 'losses' },
    { h: 'wins', k: 'wins' },
  ]));
  md.push('');
  md.push('## Top losses evitadas (TP)');
  md.push('');
  md.push(mdTable(report.topAvoidedLosses.map((r) => ({
    key: r.key.slice(0, 12),
    dt: r.dt,
    pnl: r.finalPnl.toFixed(2),
    ask: r.ask?.toFixed?.(2) ?? r.ask,
    dist: r.dist?.toFixed?.(1) ?? r.dist,
    tau: r.tauBin,
  })), [
    { h: 'event', k: 'key', align: 'l' },
    { h: 'dt', k: 'dt', align: 'l' },
    { h: 'pnl', k: 'pnl' },
    { h: 'ask', k: 'ask' },
    { h: 'dist', k: 'dist' },
    { h: 'tau', k: 'tau', align: 'l' },
  ]));
  md.push('');
  md.push('## Top wins perdidas (FP)');
  md.push('');
  md.push(mdTable(report.topMissedWins.map((r) => ({
    key: r.key.slice(0, 12),
    dt: r.dt,
    pnl: r.finalPnl.toFixed(2),
    ask: r.ask?.toFixed?.(2) ?? r.ask,
    dist: r.dist?.toFixed?.(1) ?? r.dist,
    tau: r.tauBin,
  })), [
    { h: 'event', k: 'key', align: 'l' },
    { h: 'dt', k: 'dt', align: 'l' },
    { h: 'pnl', k: 'pnl' },
    { h: 'ask', k: 'ask' },
    { h: 'dist', k: 'dist' },
    { h: 'tau', k: 'tau', align: 'l' },
  ]));
  md.push('');

  fs.writeFileSync(outMd, `${md.join('\n')}\n`);
  console.log(`Wrote ${outMd}`);
  console.log(JSON.stringify({
    tag,
    deltaPnl: report.deltaPnl,
    blocked: report.blocked,
  }, null, 2));

  return report;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const delta = Number(flags.delta || 0.10);
  const lookback = Number(flags.lookback || 2);
  const only = flags.only || 'both'; // july | train | both

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  const defaults = JSON.parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'defaults.json'), 'utf8'));
  const glsAst = parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'strategy.gls'), 'utf8'));

  const results = {};
  if (only === 'july' || only === 'both') {
    results.july = await analyzeWindow({
      from: flags.from || '2026-07-01',
      to: flags.to || '2026-07-26',
      delta,
      lookback,
      tag: flags.tag || 'july-d10',
      glsAst,
      defaults,
      db,
    });
  }
  if (only === 'train' || only === 'both') {
    // Se --from/--to foram passados com only=both, train usa defaults de treino
    const trainFrom = only === 'train' && flags.from ? flags.from : '2026-05-04';
    const trainTo = only === 'train' && flags.to ? flags.to : '2026-07-01';
    results.train = await analyzeWindow({
      from: trainFrom,
      to: trainTo,
      delta,
      lookback,
      tag: 'train-d10',
      glsAst,
      defaults,
      db,
    });
  }

  if (results.july && results.train) {
    const cmpPath = path.join(ROOT, 'labs/sandbox/midas-odds-vel-cf-compare.md');
    const j = results.july;
    const t = results.train;
    const lines = [
      '# MIDAS — contrafactual oddsVelGate: julho vs treino',
      '',
      `Gate: delta=${delta}, lookback=${lookback}s`,
      '',
      '| métrica | julho | treino |',
      '|---|---:|---:|',
      `| ΔPnL gated−base | ${j.deltaPnl} | ${t.deltaPnl} |`,
      `| bloqueados n | ${j.blocked.n} | ${t.blocked.n} |`,
      `| TP (evitou loss) | ${j.blocked.tp} | ${t.blocked.tp} |`,
      `| FP (perdeu win) | ${j.blocked.fp} | ${t.blocked.fp} |`,
      `| precisão TP/n | ${j.blocked.precision} | ${t.blocked.precision} |`,
      `| PnL bloqueados | ${j.blocked.pnl} | ${t.blocked.pnl} |`,
      `| net de bloquear (−pnl bloq.) | ${j.blocked.netFromBlocking} | ${t.blocked.netFromBlocking} |`,
      `| avoided loss PnL | ${j.blocked.avoidedLossPnl} | ${t.blocked.avoidedLossPnl} |`,
      `| missed win PnL | ${j.blocked.missedWinPnl} | ${t.blocked.missedWinPnl} |`,
      '',
      '## Leitura',
      '',
      j.blocked.netFromBlocking > 0 && t.blocked.netFromBlocking < 0
        ? 'Julho: bloquear vale a pena (net>0). Treino: bloquear destrói valor (net<0) — regime-dependente.'
        : j.blocked.netFromBlocking > 0 && t.blocked.netFromBlocking > 0
          ? 'Bloquear tem net positivo nos dois períodos — candidato a promover (ainda validar condicional).'
          : 'Bloquear não é claramente positivo nos dois lados — preferir gate condicional ou size-halve.',
      '',
    ];
    fs.writeFileSync(cmpPath, `${lines.join('\n')}\n`);
    console.log(`Wrote ${cmpPath}`);
  }

  closeStateDatabase(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
