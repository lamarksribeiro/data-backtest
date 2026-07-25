#!/usr/bin/env node
/**
 * For each live loss market, scan audit decisions in last 30s for late-flip
 * eligibility ingredients (secsLeft, signedDistance, bid).
 */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const trades = JSON.parse(readFileSync(join(__dirname, 'prod-trades.json'), 'utf8'));
const losses = (trades.trades || []).filter((t) => Number(t.pnl) < 0);

const byMarket = new Map(losses.map((t) => [t.marketId, { trade: t, ticks: [] }]));

for (const file of [
  join(__dirname, 'prod-audit-2026-07-24.jsonl'),
  join(__dirname, 'prod-audit-2026-07-25.jsonl'),
]) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'decision' || !byMarket.has(o.marketId)) continue;
    const secs = o.diagnostics?.secsLeft;
    if (secs == null || secs > 30) continue;
    const late = o.diagnostics?.lateFlip || {};
    const entry = o.diagnostics?.entry || {};
    byMarket.get(o.marketId).ticks.push({
      tsMs: o.tsMs,
      secsLeft: secs,
      signedDistance: late.signedDistance ?? null,
      lateAction: late.action ?? null,
      lateActive: late.active ?? null,
      bid: late.bid ?? late.exitBid ?? null,
      oppAsk: late.oppAsk ?? null,
      inPosition: o.diagnostics?.inPosition,
      reversed: o.diagnostics?.reversed,
      fav: entry.fav,
      ask: entry.ask,
    });
  }
}

function analyze(ticks) {
  const inLateWindow = ticks.filter((t) => t.secsLeft <= 8 && t.secsLeft >= 4);
  const crossed = ticks.filter((t) => t.signedDistance != null && t.signedDistance <= 0);
  const crossedInWindow = inLateWindow.filter((t) => t.signedDistance != null && t.signedDistance <= 0);
  const bidOkInWindow = inLateWindow.filter((t) => t.bid != null && t.bid >= 0.05);
  const reverseActions = ticks.filter((t) => t.lateAction === 'REVERSE');
  const exitActions = ticks.filter((t) => t.lateAction === 'EXIT');
  const firstCross = crossed[0] || null;
  const minSigned = ticks.reduce(
    (m, t) => (t.signedDistance == null ? m : Math.min(m, t.signedDistance)),
    Infinity,
  );
  return {
    tickCount30s: ticks.length,
    lateWindowTicks: inLateWindow.length,
    crossedAny: crossed.length > 0,
    firstCrossSecsLeft: firstCross?.secsLeft ?? null,
    firstCrossSigned: firstCross?.signedDistance ?? null,
    minSignedDistance: Number.isFinite(minSigned) ? minSigned : null,
    crossedInLateWindow: crossedInWindow.length,
    bidOkInLateWindow: bidOkInWindow.length,
    reverseActions: reverseActions.length,
    exitActions: exitActions.length,
    sampleLateWindow: inLateWindow.slice(0, 3),
    sampleNearCross: crossed.slice(0, 3),
  };
}

const report = losses.map((t) => {
  const row = byMarket.get(t.marketId);
  return {
    marketId: t.marketId,
    side: t.side,
    entry: t.entryPrice,
    qty: t.qty,
    pnl: t.pnl,
    winner: t.winner,
    analysis: analyze(row?.ticks || []),
  };
});

const out = {
  n: report.length,
  whyNoReverse: report.map((r) => {
    const a = r.analysis;
    let reason = 'unknown';
    if (a.reverseActions > 0) reason = 'reverse_signaled_but_failed_or_incomplete';
    else if (!a.crossedAny) reason = 'never_crossed_before_expiry_in_feed';
    else if (a.firstCrossSecsLeft != null && a.firstCrossSecsLeft < 4)
      reason = 'crossed_after_late_flip_floor_lt_4s';
    else if (a.firstCrossSecsLeft != null && a.firstCrossSecsLeft > 8)
      reason = 'crossed_before_late_window_then_maybe_recovered_or_missed';
    else if (a.crossedInLateWindow === 0) reason = 'no_cross_inside_4_to_8s_window';
    else if (a.bidOkInLateWindow === 0) reason = 'bid_below_stopMinBid_in_window';
    else reason = 'eligible_ingredients_present_but_no_action';
    return { marketId: r.marketId, pnl: r.pnl, side: r.side, entry: r.entry, reason, ...a };
  }),
  detail: report,
};

writeFileSync(join(__dirname, 'prod-loss-lateflip.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.whyNoReverse, null, 2));
