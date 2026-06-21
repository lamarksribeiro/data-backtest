#!/usr/bin/env node
/**
 * Analisa padrões de falha da Terminal Convexity V1:
 * - cross_stop vs expiry
 * - perdas por distância, edge, janela temporal
 * - dias negativos recorrentes
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../../../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../../../../src/state/sqlite.js';
import { runBacktest } from '../../../../../src/backtest/engine.js';
import { parse } from '../../../../../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../../../../../src/backtestStudio/gls/compiler.js';
import { loadPreset } from '../../../../shared/presets.js';

const STRATEGY_ID = 'terminal-convexity-v1';
const STRATEGY_FAMILY = 'terminal';

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

function parseDateStart(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid from date: ${value}`);
  return date;
}

function parseDateEnd(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid to date: ${value}`);
  return date;
}

function tsMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function analyzeEvent(event) {
  const orders = event.orders || [];
  const entry = orders.find((o) => o.type === 'entry');
  if (!entry) return null;

  const exits = orders.filter((o) => o.type === 'exit');
  const exitReasons = exits.map((o) => String(o.reason || ''));
  const crossStop = exitReasons.some((r) => r.includes('cross_stop'));
  const profitExit = exitReasons.some((r) => r.includes('profit_exit'));
  const stopReverse = exitReasons.some((r) => r.includes('stop_reverse'));
  const finalPnl = Number(event.final_pnl ?? event.finalPnl ?? 0);
  const entryPrice = Number(entry.avgPrice ?? entry.price ?? 0);
  const entryCost = Number(entry.notional ?? event.cost ?? 0);
  const side = entry.side ?? event.positionType ?? null;
  const winnerSide = event.winnerSide ?? event.expirationResult ?? null;
  const won = winnerSide && side && winnerSide === side;

  return {
    eventId: event.eventId,
    eventStart: event.eventStart,
    side,
    entryPrice,
    entryCost,
    entryTimeRemaining: Number(event.entryTimeRemaining ?? 0),
    finalPnl,
    reason: event.reason,
    winnerSide,
    won: won === true,
    crossStop,
    profitExit,
    stopReverse,
    exitReasons,
    heldToExpiry: !crossStop && !profitExit && !stopReverse,
    lostOnCross: crossStop && finalPnl < 0,
    lostOnExpiry: !crossStop && !profitExit && finalPnl < 0,
  };
}

function bucketBy(rows, keyFn) {
  const map = {};
  for (const row of rows) {
    const key = keyFn(row);
    if (!map[key]) map[key] = { count: 0, pnl: 0, wins: 0 };
    map[key].count += 1;
    map[key].pnl += row.finalPnl;
    if (row.finalPnl > 0) map[key].wins += 1;
  }
  return map;
}

function summarize(rows) {
  const entered = rows.filter(Boolean);
  const losses = entered.filter((r) => r.finalPnl < 0);
  const wins = entered.filter((r) => r.finalPnl > 0);
  const sumPnl = (list) => list.reduce((s, r) => s + r.finalPnl, 0);

  const crossStopLosses = entered.filter((r) => r.lostOnCross);
  const expiryLosses = entered.filter((r) => r.lostOnExpiry);
  const crossStopAll = entered.filter((r) => r.crossStop);

  return {
    totalEntries: entered.length,
    totalPnl: sumPnl(entered),
    winCount: wins.length,
    lossCount: losses.length,
    winRate: entered.length ? (wins.length / entered.length) * 100 : 0,
    pnlWins: sumPnl(wins),
    pnlLosses: sumPnl(losses),
    crossStopCount: crossStopAll.length,
    crossStopLossCount: crossStopLosses.length,
    crossStopPnl: sumPnl(crossStopAll),
    crossStopLossPnl: sumPnl(crossStopLosses),
    expiryLossCount: expiryLosses.length,
    expiryLossPnl: sumPnl(expiryLosses),
    profitExitCount: entered.filter((r) => r.profitExit).length,
    profitExitPnl: sumPnl(entered.filter((r) => r.profitExit)),
    stopReverseCount: entered.filter((r) => r.stopReverse).length,
    stopReversePnl: sumPnl(entered.filter((r) => r.stopReverse)),
    bySide: bucketBy(entered, (r) => r.side || 'unknown'),
    byEntryTimeRemaining: bucketBy(entered, (r) => {
      const t = r.entryTimeRemaining;
      if (t <= 9) return '8-9s';
      if (t <= 11) return '10-11s';
      if (t <= 13) return '12-13s';
      return '14-15s';
    }),
    byExitPattern: bucketBy(entered, (r) => {
      if (r.crossStop) return 'cross_stop';
      if (r.profitExit) return 'profit_exit';
      if (r.stopReverse) return 'stop_reverse';
      if (r.finalPnl > 0) return 'expiry_win';
      return 'expiry_loss';
    }),
    worstLosses: [...losses].sort((a, b) => a.finalPnl - b.finalPnl).slice(0, 15),
    bestWins: [...wins].sort((a, b) => b.finalPnl - a.finalPnl).slice(0, 10),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const presetId = flags.preset || 'v1';
  const from = flags.from || '2026-05-04';
  const to = flags.to || '2026-06-19';

  let params;
  let strategyRoot;
  if (flags.params) {
    params = JSON.parse(flags.params);
    strategyRoot = path.resolve('labs/strategies/terminal/terminal-convexity-v1');
  } else {
    const loaded = loadPreset(presetId, { strategyFamily: STRATEGY_FAMILY, strategyId: STRATEGY_ID });
    params = loaded.params;
    strategyRoot = loaded.strategyRoot;
  }

  const defaults = JSON.parse(readFileSync(path.join(strategyRoot, 'defaults.json'), 'utf8'));
  params = { ...defaults, ...params };

  const strategy = JSON.parse(readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
  const sourcePath = path.resolve(strategy.source.path || strategy.source.glsPath);
  const sourceCode = readFileSync(sourcePath, 'utf8');
  const glsAst = parse(sourceCode);
  const bookDepth = Number(flags['book-depth'] || strategy.defaultBookDepth || 25);
  const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  console.error(`[analyze-failure-patterns] preset=${presetId} window=${from}..${to}`);

  try {
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
      params,
      fastRun: false,
      glsExecution: 'compiled-soa',
      backtestWorkers: Number(flags.workers || 1),
      strategyMeta: { lab: true, preset: presetId, analysis: 'failure-patterns' },
    });

    const analyzed = (result.events || []).map(analyzeEvent).filter(Boolean);
    const summary = summarize(analyzed);

    const output = {
      ok: true,
      preset: presetId,
      window: { from, to },
      params,
      backtestSummary: result.summary,
      failureAnalysis: summary,
      recommendations: buildRecommendations(summary),
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

function buildRecommendations(summary) {
  const recs = [];
  if (summary.crossStopLossPnl < -20) {
    recs.push({
      issue: 'cross_stop_losses',
      impact: summary.crossStopLossPnl,
      count: summary.crossStopLossCount,
      action: 'Aumentar minAheadDist ou desabilitar stopIfCrossed; testar stopCrossDist mais negativo',
    });
  }
  if (summary.expiryLossPnl < -30) {
    recs.push({
      issue: 'expiry_losses',
      impact: summary.expiryLossPnl,
      count: summary.expiryLossCount,
      action: 'Aumentar minModelEdge/minModelProb; filtrar entradas com marketLag negativo',
    });
  }
  const sideEntries = summary.bySide || {};
  for (const [side, stats] of Object.entries(sideEntries)) {
    if (stats.count >= 5 && stats.pnl < -15) {
      recs.push({
        issue: `losing_side_${side}`,
        impact: stats.pnl,
        count: stats.count,
        action: `Considerar allowedPositionSide=${side === 'UP' ? 'DOWN' : 'UP'} ou filtros assimétricos`,
      });
    }
  }
  const timeBuckets = summary.byEntryTimeRemaining || {};
  for (const [bucket, stats] of Object.entries(timeBuckets)) {
    if (stats.count >= 5 && stats.pnl < -10) {
      recs.push({
        issue: `losing_window_${bucket}`,
        impact: stats.pnl,
        count: stats.count,
        action: 'Ajustar entryWindowStart/entryWindowEnd para evitar este bucket',
      });
    }
  }
  return recs;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});