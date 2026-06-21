#!/usr/bin/env node
/**
 * Trace evento-a-evento: quando o BTC cruza o PTB após a entrada (virada tardia).
 *
 * Uso:
 *   node labs/strategies/terminal/terminal-convexity-v1/scripts/analyze-late-flip-trace.js
 *   node labs/strategies/terminal/terminal-convexity-v1/scripts/analyze-late-flip-trace.js --from 2026-06-07 --to 2026-06-11
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../../../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../../../../src/state/sqlite.js';
import { runBacktest } from '../../../../../src/backtest/engine.js';
import { parse } from '../../../../../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../../../../../src/backtestStudio/gls/compiler.js';
import { loadPreset } from '../../../../shared/presets.js';

const STRATEGY_ID = 'terminal-convexity-v1';
const STRATEGY_FAMILY = 'terminal';
const TARGET_DAYS = new Set(['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-19']);

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
  return new Date(`${value}T00:00:00.000Z`);
}

function parseDateEnd(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function tsMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function signedDistance(side, underlying, ptb) {
  if (!Number.isFinite(underlying) || !Number.isFinite(ptb)) return null;
  return side === 'UP' ? underlying - ptb : ptb - underlying;
}

function secsUntilEnd(sample, eventEndMs) {
  const tickMs = sample._tsMs ?? tsMs(sample.ts);
  if (!Number.isFinite(tickMs) || !Number.isFinite(eventEndMs)) return null;
  return Math.max(0, (eventEndMs - tickMs) / 1000);
}

function traceCrossTimeline({ event, samples, entryOrder }) {
  const side = entryOrder.side ?? event.positionType;
  const ptb = Number(event.priceToBeat);
  const entryMs = tsMs(entryOrder.ts);
  const eventEndMs = tsMs(event.eventEnd ?? event.closedAt);
  const entryIdx = samples.findIndex((s) => Math.abs((s._tsMs ?? tsMs(s.ts)) - entryMs) <= 1500);

  let entrySnap = entryIdx >= 0 ? samples[entryIdx] : samples[samples.length - 1];
  const underlying = Number(entrySnap?.underlying_price ?? entrySnap?.underlyingPrice);
  const entryDist = signedDistance(side, underlying, ptb);
  const entrySecsLeft = secsUntilEnd(entrySnap, eventEndMs);

  let firstCross = null;
  let lastFavorable = null;
  let minSecsLeftWhileAhead = entrySecsLeft;

  for (let i = Math.max(0, entryIdx); i < samples.length; i += 1) {
    const sample = samples[i];
    const tickMs = sample._tsMs ?? tsMs(sample.ts);
    if (entryMs != null && tickMs < entryMs - 500) continue;
    const px = Number(sample.underlying_price ?? sample.underlyingPrice);
    const dist = signedDistance(side, px, ptb);
    const secsLeft = secsUntilEnd(sample, eventEndMs);
    if (dist == null || secsLeft == null) continue;

    if (dist > 0) {
      lastFavorable = { dist, secsLeft, ts: sample.ts, tickMs };
      if (secsLeft < minSecsLeftWhileAhead) minSecsLeftWhileAhead = secsLeft;
    }
    if (dist <= 0 && !firstCross) {
      firstCross = {
        dist,
        secsLeft,
        ts: sample.ts,
        tickMs,
        msAfterEntry: entryMs != null ? tickMs - entryMs : null,
      };
      break;
    }
  }

  const exits = (event.orders || []).filter((o) => o.type === 'exit');
  const exitDetails = exits.map((o) => ({
    reason: o.reason,
    ts: o.ts,
    price: Number(o.avgPrice ?? o.price),
    secsAfterEntry: entryMs != null ? ((tsMs(o.ts) - entryMs) / 1000) : null,
    secsLeftAtExit: null,
  }));

  for (const exit of exitDetails) {
    const exitMs = tsMs(exit.ts);
    const nearest = samples.reduce((best, s) => {
      const sms = s._tsMs ?? tsMs(s.ts);
      if (sms == null) return best;
      const diff = Math.abs(sms - exitMs);
      if (!best || diff < best.diff) return { diff, sample: s };
      return best;
    }, null);
    if (nearest?.sample) exit.secsLeftAtExit = secsUntilEnd(nearest.sample, eventEndMs);
  }

  const pattern = classifyPattern({
    entryDist,
    entrySecsLeft,
    firstCross,
    lastFavorable,
    exitDetails,
    finalPnl: Number(event.final_pnl ?? event.finalPnl ?? 0),
    winnerSide: event.winnerSide,
    side,
  });

  return {
    eventId: event.eventId,
    eventStart: event.eventStart,
    side,
    winnerSide: event.winnerSide,
    priceToBeat: ptb,
    entry: {
      ts: entryOrder.ts,
      price: Number(entryOrder.avgPrice ?? entryOrder.price),
      shares: Number(entryOrder.shares ?? 0),
      cost: Number(entryOrder.notional ?? 0),
      underlyingAtEntry: underlying,
      signedDistance: entryDist,
      secsRemaining: entrySecsLeft,
    },
    firstCross,
    lastMomentAhead: lastFavorable,
    minSecsLeftWhileAhead,
    exits: exitDetails,
    finalPnl: Number(event.final_pnl ?? event.finalPnl ?? 0),
    reason: event.reason,
    pattern,
    ticksInEvent: samples.length,
  };
}

function classifyPattern({ entryDist, entrySecsLeft, firstCross, exitDetails, finalPnl, winnerSide, side }) {
  if (finalPnl > 0) return 'win';
  const exitReasons = exitDetails.map((e) => e.reason).filter(Boolean);
  if (exitReasons.some((r) => String(r).includes('late_flip'))) {
    return 'late_flip_exit';
  }
  if (exitReasons.some((r) => String(r).includes('stop_reverse'))) {
    return 'stop_reverse_failed';
  }
  if (exitReasons.some((r) => String(r).includes('cross_stop'))) {
    return 'cross_stop';
  }
  if (!firstCross) {
    return winnerSide && side && winnerSide !== side ? 'expiry_wrong_side_no_cross_detected' : 'expiry_loss';
  }
  if (firstCross.secsLeft <= 4) return 'late_reversal_final_seconds';
  if (firstCross.secsLeft <= 8) return 'late_reversal_terminal_window';
  if (firstCross.msAfterEntry != null && firstCross.msAfterEntry < 3000) return 'immediate_reversal_after_entry';
  return 'mid_hold_reversal';
}

function summarizeTraces(traces) {
  const losses = traces.filter((t) => t.finalPnl < 0);
  const byPattern = {};
  for (const t of traces) {
    byPattern[t.pattern] = byPattern[t.pattern] || { count: 0, pnl: 0 };
    byPattern[t.pattern].count += 1;
    byPattern[t.pattern].pnl += t.finalPnl;
  }
  const crossSecs = losses
    .filter((t) => t.firstCross?.secsLeft != null)
    .map((t) => t.firstCross.secsLeft);
  return {
    totalTraced: traces.length,
    losses: losses.length,
    wins: traces.filter((t) => t.finalPnl > 0).length,
    totalPnl: traces.reduce((s, t) => s + t.finalPnl, 0),
    byPattern,
    avgCrossSecsLeft: crossSecs.length ? crossSecs.reduce((a, b) => a + b, 0) / crossSecs.length : null,
    crossInLast4Sec: losses.filter((t) => t.firstCross?.secsLeft <= 4).length,
    crossInLast8Sec: losses.filter((t) => t.firstCross?.secsLeft <= 8).length,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const presetId = flags.preset || 'btc-champion';
  const from = flags.from || '2026-06-07';
  const to = flags.to || '2026-06-20';

  const { params, strategyRoot } = loadPreset(presetId, {
    strategyFamily: STRATEGY_FAMILY,
    strategyId: STRATEGY_ID,
  });
  const strategy = JSON.parse(readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
  const sourcePath = path.resolve(strategy.source.path || strategy.source.glsPath);
  const glsAst = parse(readFileSync(sourcePath, 'utf8'));
  const bookDepth = Number(flags['book-depth'] || strategy.defaultBookDepth || 25);
  const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);

  const captured = [];
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  console.error(`[late-flip-trace] preset=${presetId} window=${from}..${to}`);

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
      strategyMeta: { lab: true, analysis: 'late-flip-trace' },
      onEventFinalized: (event, samples) => {
        const day = String(event.eventStart || '').slice(0, 10);
        if (!TARGET_DAYS.has(day)) return;
        const entry = (event.orders || []).find((o) => o.type === 'entry');
        if (!entry || !samples?.length) return;
        captured.push(traceCrossTimeline({ event, samples, entryOrder: entry }));
      },
    });

    captured.sort((a, b) => String(a.eventStart).localeCompare(String(b.eventStart)));

    const output = {
      ok: true,
      preset: presetId,
      window: { from, to },
      targetDays: [...TARGET_DAYS].sort(),
      backtestSummary: result.summary,
      summary: summarizeTraces(captured),
      traces: captured,
    };

    const outPath = path.resolve('scratch/tc-late-flip-trace.json');
    writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(output, null, 2));
    console.error(`[late-flip-trace] wrote ${outPath}`);
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});