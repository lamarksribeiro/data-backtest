/**
 * Contrafactual v2: separa SKIP (nunca entrou) vs DEFER (entrou depois / outro preço).
 * Explica o gap: bloqueados net negativo mas PnL gated > baseline.
 *
 * Uso:
 *   node --max-old-space-size=8192 labs/sandbox/midas-odds-vel-cf-defer.mjs --from 2026-07-01 --to 2026-07-26
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

const BASE = {
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

function eventKey(ev) {
  return String(ev.conditionId || ev.condition_id || ev.eventId || '');
}

function tradeRow(ev) {
  return {
    key: eventKey(ev),
    dt: String(ev.eventStart || ev.closedAt || '').slice(0, 10),
    finalPnl: num(ev.finalPnl) ?? 0,
    secsLeft: num(ev.entryTimeRemaining),
    ask: num(ev.avgEntryPrice),
    dist: num(ev.entryDistanceToPtb),
    side: ev.positionType,
  };
}

function sum(rows, key = 'finalPnl') {
  return rows.reduce((s, r) => s + (r[key] || 0), 0);
}

function summarize(rows) {
  const n = rows.length;
  const pnl = sum(rows);
  const losses = rows.filter((r) => r.finalPnl < -0.01);
  const wins = rows.filter((r) => r.finalPnl > 0.01);
  return {
    n,
    pnl: Number(pnl.toFixed(2)),
    losses: losses.length,
    wins: wins.length,
    wr: n ? Number((wins.length / n).toFixed(3)) : 0,
    avgPnl: n ? Number((pnl / n).toFixed(3)) : 0,
  };
}

function bin(value, edges, labels) {
  if (!Number.isFinite(value)) return 'unknown';
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (value >= edges[i] && value < edges[i + 1]) return labels[i];
  }
  return labels[labels.length - 1];
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
  const byKey = new Map();
  for (const ev of (outcome.events || []).filter((e) => e.reason !== 'no_entry')) {
    const row = tradeRow(ev);
    if (row.key) byKey.set(row.key, row);
  }
  return {
    totalPnl: Number(outcome.summary?.totalPnl ?? 0),
    byKey,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const from = flags.from || '2026-07-01';
  const to = flags.to || '2026-07-26';
  const delta = Number(flags.delta || 0.10);
  const lookback = Number(flags.lookback || 2);
  const tag = flags.tag || `defer-${from.slice(5)}`;

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  const defaults = JSON.parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'defaults.json'), 'utf8'));
  const glsAst = parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'strategy.gls'), 'utf8'));

  console.log(`Loading ${from} → ${to}...`);
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
  console.log(`ticks=${columnSet.length}`);

  const baseline = await runVariant(glsAst, defaults, BASE, columnSet);
  const gated = await runVariant(glsAst, defaults, {
    ...BASE,
    oddsVelGateEnabled: true,
    oddsVelMaxDelta: delta,
    oddsVelLookbackSec: lookback,
  }, columnSet);
  closeStateDatabase(db);

  const skipped = [];
  const deferred = [];
  const identical = [];
  const onlyGated = [];

  for (const [key, b] of baseline.byKey) {
    const g = gated.byKey.get(key);
    if (!g) {
      skipped.push({
        ...b,
        filterClass: b.finalPnl < -0.01 ? 'TP' : b.finalPnl > 0.01 ? 'FP' : 'flat',
        askBin: bin(b.ask, [0, 0.7, 0.82, 0.9, 0.95, 2], ['<0.70', '0.70-0.82', '0.82-0.90', '0.90-0.95', '>=0.95']),
        tauBin: bin(b.secsLeft, [0, 8, 12, 20, 30, 999], ['<8s', '8-12s', '12-20s', '20-30s', '>=30s']),
        distBin: bin(b.dist, [0, 20, 30, 40, 999], ['<20', '20-30', '30-40', '>=40']),
      });
      continue;
    }
    const secsDiff = (g.secsLeft ?? 0) - (b.secsLeft ?? 0);
    const askDiff = (g.ask ?? 0) - (b.ask ?? 0);
    const pnlDiff = g.finalPnl - b.finalPnl;
    const changed = Math.abs(secsDiff) > 0.5 || Math.abs(askDiff) > 0.005 || Math.abs(pnlDiff) > 0.01;
    const row = {
      key,
      dt: b.dt,
      basePnl: b.finalPnl,
      gatePnl: g.finalPnl,
      pnlDiff,
      baseSecs: b.secsLeft,
      gateSecs: g.secsLeft,
      secsDiff,
      baseAsk: b.ask,
      gateAsk: g.ask,
      askDiff,
      baseDist: b.dist,
      askBin: bin(b.ask, [0, 0.7, 0.82, 0.9, 0.95, 2], ['<0.70', '0.70-0.82', '0.82-0.90', '0.90-0.95', '>=0.95']),
    };
    if (changed) deferred.push(row);
    else identical.push(row);
  }

  for (const [key, g] of gated.byKey) {
    if (!baseline.byKey.has(key)) onlyGated.push(g);
  }

  const skipSum = summarize(skipped);
  const deferPnlGain = Number(sum(deferred, 'pnlDiff').toFixed(2));
  const skipNet = Number((-skipSum.pnl).toFixed(2)); // value of skipping = -their pnl
  const explained = Number((skipNet + deferPnlGain + sum(onlyGated)).toFixed(2));
  const observed = Number((gated.totalPnl - baseline.totalPnl).toFixed(2));

  const deferImproved = deferred.filter((r) => r.pnlDiff > 0.01);
  const deferWorsened = deferred.filter((r) => r.pnlDiff < -0.01);

  // Conditional slices on SKIPPED: where is TP worth it?
  function sliceSkip(pred) {
    const rows = skipped.filter(pred);
    const tp = rows.filter((r) => r.filterClass === 'TP');
    const fp = rows.filter((r) => r.filterClass === 'FP');
    return {
      n: rows.length,
      tp: tp.length,
      fp: fp.length,
      pnl: Number(sum(rows).toFixed(2)),
      netIfSkip: Number((-sum(rows)).toFixed(2)),
      precision: rows.length ? Number((tp.length / rows.length).toFixed(3)) : 0,
    };
  }

  const conditionals = {
    all: sliceSkip(() => true),
    ask_lt_070: sliceSkip((r) => r.askBin === '<0.70'),
    ask_070_082: sliceSkip((r) => r.askBin === '0.70-0.82'),
    ask_ge_082: sliceSkip((r) => r.ask != null && r.ask >= 0.82),
    dist_ge_30: sliceSkip((r) => r.dist != null && r.dist >= 30),
    dist_lt_20: sliceSkip((r) => r.distBin === '<20'),
    tau_20_30: sliceSkip((r) => r.tauBin === '20-30s'),
    tau_12_20: sliceSkip((r) => r.tauBin === '12-20s'),
    ask_lt_070_or_dist_ge_30: sliceSkip((r) => (r.ask != null && r.ask < 0.7) || (r.dist != null && r.dist >= 30)),
    ask_lt_070_and_tau_ge_12: sliceSkip((r) => r.ask != null && r.ask < 0.7 && r.secsLeft != null && r.secsLeft >= 12),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from, to },
    gate: { delta, lookback },
    baselinePnl: baseline.totalPnl,
    gatedPnl: gated.totalPnl,
    observedDeltaPnl: observed,
    decomposition: {
      skipN: skipped.length,
      skipPnlIfTaken: skipSum.pnl,
      skipNetValue: skipNet,
      deferredN: deferred.length,
      deferredPnlGain: deferPnlGain,
      identicalN: identical.length,
      onlyGatedN: onlyGated.length,
      onlyGatedPnl: Number(sum(onlyGated).toFixed(2)),
      explainedDelta: explained,
      residual: Number((observed - explained).toFixed(2)),
    },
    skip: {
      ...skipSum,
      tp: skipped.filter((r) => r.filterClass === 'TP').length,
      fp: skipped.filter((r) => r.filterClass === 'FP').length,
    },
    defer: {
      n: deferred.length,
      improved: deferImproved.length,
      worsened: deferWorsened.length,
      pnlGain: deferPnlGain,
      avgSecsDiff: deferred.length
        ? Number((sum(deferred, 'secsDiff') / deferred.length).toFixed(2))
        : 0,
      avgAskDiff: deferred.length
        ? Number((sum(deferred, 'askDiff') / deferred.length).toFixed(4))
        : 0,
      topGains: [...deferred].sort((a, b) => b.pnlDiff - a.pnlDiff).slice(0, 12),
      topLosses: [...deferred].sort((a, b) => a.pnlDiff - b.pnlDiff).slice(0, 12),
    },
    conditionalsOnSkip: conditionals,
  };

  const outJson = path.join(ROOT, `labs/sandbox/midas-odds-vel-cf-${tag}.json`);
  const outMd = path.join(ROOT, `labs/sandbox/midas-odds-vel-cf-${tag}.md`);
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);

  const md = [];
  md.push(`# MIDAS — contrafactual v2 skip vs defer (${tag})`);
  md.push('');
  md.push(`Janela: ${from} → ${to} · gate Δ=${delta} lb=${lookback}s`);
  md.push('');
  md.push('## Achado central');
  md.push('');
  md.push(`ΔPnL observado (gated−base): **${observed}**`);
  md.push('');
  md.push('| componente | n | efeito no ΔPnL |');
  md.push('|---|---:|---:|');
  md.push(`| SKIP (nunca entrou) | ${skipped.length} | ${skipNet} (−pnl dos skip) |`);
  md.push(`| DEFER (mesma event, entrada diferente) | ${deferred.length} | ${deferPnlGain} |`);
  md.push(`| only-gated | ${onlyGated.length} | ${report.decomposition.onlyGatedPnl} |`);
  md.push(`| soma explicada | — | ${explained} |`);
  md.push(`| residual | — | ${report.decomposition.residual} |`);
  md.push('');
  md.push(`SKIP puro: TP=${report.skip.tp} FP=${report.skip.fp} · pnl se tivesse entrado=${skipSum.pnl} → **bloquear sozinho ${skipNet > 0 ? 'ajuda' : 'prejudica'}**`);
  md.push(`DEFER: improved=${deferImproved.length} worsened=${deferWorsened.length} · avg Δsecs=${report.defer.avgSecsDiff} · avg Δask=${report.defer.avgAskDiff}`);
  md.push('');
  md.push('## Se o gate só fizesse SKIP (sem defer) — slices condicionais');
  md.push('');
  md.push('| condição nos skipped | n | TP | FP | pnl se entrasse | net se skip | precisão |');
  md.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [name, s] of Object.entries(conditionals)) {
    md.push(`| ${name} | ${s.n} | ${s.tp} | ${s.fp} | ${s.pnl} | ${s.netIfSkip} | ${s.precision} |`);
  }
  md.push('');
  md.push('Slices com **netIfSkip > 0** são candidatos a gate condicional (item 2).');
  md.push('');
  md.push('## Top DEFER ganhos (entrada adiada melhorou PnL)');
  md.push('');
  md.push('| event | dt | base→gate pnl | Δpnl | secs | ask |');
  md.push('|---|---|---:|---:|---:|---:|');
  for (const r of report.defer.topGains) {
    md.push(`| ${r.key.slice(0, 12)} | ${r.dt} | ${r.basePnl.toFixed(2)}→${r.gatePnl.toFixed(2)} | ${r.pnlDiff.toFixed(2)} | ${r.baseSecs?.toFixed?.(0)}→${r.gateSecs?.toFixed?.(0)} | ${r.baseAsk?.toFixed?.(2)}→${r.gateAsk?.toFixed?.(2)} |`);
  }
  md.push('');

  fs.writeFileSync(outMd, `${md.join('\n')}\n`);
  console.log(JSON.stringify({
    observedDeltaPnl: observed,
    decomposition: report.decomposition,
    conditionalsOnSkip: conditionals,
  }, null, 2));
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
