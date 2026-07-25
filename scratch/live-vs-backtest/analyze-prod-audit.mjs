#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = [
  join(__dirname, 'prod-audit-2026-07-24.jsonl'),
  join(__dirname, 'prod-audit-2026-07-25.jsonl'),
];

const settles = [];
const enters = [];
const reverses = [];
const rejects = [];
const lateFlipSeen = [];
const protectiveHalts = [];
const fakMiss = [];
const typeCounts = new Map();

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

for (const file of files) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    bump(typeCounts, o.type || 'unknown');

    if (o.type === 'position_settled') {
      settles.push({
        marketId: o.fromMarketId || o.marketId,
        side: o.side,
        qty: o.qty,
        avgPrice: o.avgPrice,
        settlementPrice: o.settlementPrice,
        pnlDelta: o.pnlDelta,
        winner: o.winner,
        reason: o.reason,
        tsMs: o.tsMs,
        day: new Date(o.tsMs).toISOString().slice(0, 10),
      });
    }

    if (o.type === 'protective_halt') {
      protectiveHalts.push({
        marketId: o.marketId || o.fromMarketId,
        reason: o.reason,
        tsMs: o.tsMs,
      });
    }

    if (o.type === 'decision') {
      for (const a of o.accepted || []) {
        if (a.kind === 'ENTER') {
          enters.push({
            marketId: o.marketId,
            side: a.side,
            budget: a.budget,
            qty: a.quantity,
            maxPrice: a.maxPrice,
            reason: a.reason,
            tsMs: o.tsMs,
            day: new Date(o.tsMs).toISOString().slice(0, 10),
          });
        }
        if (a.kind === 'REVERSE' || a.reason === 'late_flip_reverse') {
          reverses.push({
            marketId: o.marketId,
            side: a.side,
            maxPrice: a.maxPrice,
            reason: a.reason,
            tsMs: o.tsMs,
            day: new Date(o.tsMs).toISOString().slice(0, 10),
          });
        }
      }
      for (const r of o.denied || []) {
        rejects.push({
          marketId: o.marketId,
          kind: r.kind,
          reasonCode: r.reasonCode || r.reason,
          tsMs: o.tsMs,
        });
      }
      const late = o.diagnostics?.lateFlip;
      if (late && (late.action === 'REVERSE' || late.action === 'EXIT' || late.eligible)) {
        lateFlipSeen.push({
          marketId: o.marketId,
          action: late.action,
          eligible: late.eligible,
          secsLeft: late.secsLeft ?? o.diagnostics?.secsLeft,
          signedDistance: late.signedDistance,
          oppAsk: late.oppAsk,
          tsMs: o.tsMs,
        });
      }
    }

    if (o.type === 'order_terminal') {
      const reason = String(o.reason || o.error || o.message || '');
      const state = o.state || o.order?.state;
      if (
        state === 'REJECTED' ||
        /no orders found/i.test(reason) ||
        /FAK/i.test(reason)
      ) {
        fakMiss.push({
          marketId: o.marketId || o.order?.marketId,
          state,
          reason: reason.slice(0, 160),
          kind: o.kind || o.order?.kind,
          tsMs: o.tsMs,
        });
      }
    }
  }
}

const byDay = new Map();
for (const s of settles) {
  const b = byDay.get(s.day) || { n: 0, pnl: 0, wins: 0, losses: 0 };
  b.n += 1;
  b.pnl += Number(s.pnlDelta || 0);
  if (s.pnlDelta > 0) b.wins += 1;
  if (s.pnlDelta < 0) b.losses += 1;
  byDay.set(s.day, b);
}

const summary = {
  typeCounts: Object.fromEntries([...typeCounts.entries()].sort()),
  settles: {
    n: settles.length,
    pnl: Number(settles.reduce((a, s) => a + Number(s.pnlDelta || 0), 0).toFixed(4)),
    wins: settles.filter((s) => s.pnlDelta > 0).length,
    losses: settles.filter((s) => s.pnlDelta < 0).length,
    byDay: Object.fromEntries(
      [...byDay.entries()].map(([d, b]) => [d, { ...b, pnl: Number(b.pnl.toFixed(4)) }]),
    ),
    settlementPrices: settles.reduce((acc, s) => {
      const k = String(s.settlementPrice);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  },
  enters: {
    n: enters.length,
    uniqueMarkets: new Set(enters.map((e) => e.marketId)).size,
    aboveMaxAskDecision: enters.filter((e) => Number(e.maxPrice) > 0.96).length, // ask+slip 0.94+0.02
    maxPriceHist: enters.reduce((acc, e) => {
      const p = Number(e.maxPrice);
      const bin = p >= 0.96 ? '>=0.96' : p >= 0.9 ? '0.90-0.96' : p >= 0.8 ? '0.80-0.90' : '<0.80';
      acc[bin] = (acc[bin] || 0) + 1;
      return acc;
    }, {}),
  },
  reversesAccepted: reverses.length,
  reverseMarkets: [...new Set(reverses.map((r) => r.marketId))],
  lateFlipSignals: lateFlipSeen.length,
  lateFlipActions: lateFlipSeen.reduce((acc, x) => {
    acc[x.action || 'null'] = (acc[x.action || 'null'] || 0) + 1;
    return acc;
  }, {}),
  fakMisses: fakMiss.length,
  fakMissSample: fakMiss.slice(0, 8),
  protectiveHalts: protectiveHalts.length,
  protectiveHaltSample: protectiveHalts.slice(0, 5),
  rejectReasonTop: Object.entries(
    rejects.reduce((acc, r) => {
      const k = String(r.reasonCode || 'unknown');
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15),
  lossSettles: settles
    .filter((s) => s.pnlDelta < 0)
    .sort((a, b) => a.pnlDelta - b.pnlDelta)
    .map((s) => ({
      marketId: s.marketId,
      side: s.side,
      avgPrice: s.avgPrice,
      qty: s.qty,
      pnl: Number(Number(s.pnlDelta).toFixed(4)),
      winner: s.winner,
      settlementPrice: s.settlementPrice,
    })),
};

writeFileSync(join(__dirname, 'prod-audit-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
