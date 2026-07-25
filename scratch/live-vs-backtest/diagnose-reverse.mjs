#!/usr/bin/env node
import { createReadStream, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = [
  join(__dirname, 'prod-audit-2026-07-24.jsonl'),
  join(__dirname, 'prod-audit-2026-07-25.jsonl'),
];

const reverseDecisions = [];
const reverseOrders = [];
const lossMarkets = new Set([
  'btc-updown-5m-1784990400',
  'btc-updown-5m-1784966100',
  'btc-updown-5m-1784949000',
  'btc-updown-5m-1784951400',
  'btc-updown-5m-1784933100',
  'btc-updown-5m-1784955300',
  'btc-updown-5m-1784971800',
  'btc-updown-5m-1784963700',
]);

const lossLate = new Map();

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

    if (o.type === 'decision') {
      const late = o.diagnostics?.lateFlip;
      const acceptedRev = (o.accepted || []).filter(
        (a) => a.kind === 'REVERSE' || a.reason === 'late_flip_reverse',
      );
      const rejectedRev = (o.denied || []).filter(
        (a) => a.kind === 'REVERSE' || String(a.reasonCode || '').includes('REVERSE'),
      );
      if (late?.action === 'REVERSE' || acceptedRev.length || rejectedRev.length) {
        reverseDecisions.push({
          marketId: o.marketId,
          tsMs: o.tsMs,
          action: o.action,
          lateAction: late?.action,
          secsLeft: late?.secsLeft ?? o.diagnostics?.secsLeft,
          signedDistance: late?.signedDistance,
          oppAsk: late?.oppAsk,
          exitBid: late?.exitBid ?? late?.bid,
          accepted: acceptedRev,
          rejected: rejectedRev,
          riskBlocked: o.riskBlocked || o.blocked || null,
          state: o.state || o.engineState,
          inPosition: o.diagnostics?.inPosition,
          reversed: o.diagnostics?.reversed,
        });
      }

      if (lossMarkets.has(o.marketId) && late) {
        const arr = lossLate.get(o.marketId) || [];
        if (arr.length < 8 || late.action === 'REVERSE' || late.action === 'EXIT') {
          arr.push({
            tsMs: o.tsMs,
            secsLeft: late.secsLeft ?? o.diagnostics?.secsLeft,
            action: late.action,
            eligible: late.eligible,
            signedDistance: late.signedDistance,
            oppAsk: late.oppAsk,
            bid: late.bid ?? late.exitBid,
            reason: late.reason,
            acceptedKinds: (o.accepted || []).map((a) => a.kind + ':' + a.reason),
          });
          lossLate.set(o.marketId, arr);
        }
      }
    }

    if (o.type === 'order_submit' || o.type === 'order_terminal') {
      const kind = o.kind || o.order?.kind;
      const reason = o.reason || o.order?.reason;
      if (kind === 'REVERSE' || reason === 'late_flip_reverse') {
        reverseOrders.push({
          type: o.type,
          marketId: o.marketId || o.order?.marketId,
          state: o.state || o.order?.state,
          reason: reason,
          error: o.error || o.message || null,
          tsMs: o.tsMs,
          qty: o.qty || o.order?.qty,
          price: o.price || o.order?.price,
        });
      }
    }
  }
}

// group reverse decisions by market
const byMarket = new Map();
for (const d of reverseDecisions) {
  const b = byMarket.get(d.marketId) || {
    signals: 0,
    accepted: 0,
    rejected: 0,
    firstTs: d.tsMs,
    lastTs: d.tsMs,
    sample: null,
  };
  b.signals += 1;
  if (d.accepted?.length) b.accepted += 1;
  if (d.rejected?.length) b.rejected += 1;
  b.firstTs = Math.min(b.firstTs, d.tsMs);
  b.lastTs = Math.max(b.lastTs, d.tsMs);
  if (!b.sample) b.sample = d;
  byMarket.set(d.marketId, b);
}

const markets = [...byMarket.entries()]
  .map(([marketId, v]) => ({ marketId, ...v }))
  .sort((a, b) => b.signals - a.signals);

const trades = JSON.parse(readFileSync(join(__dirname, 'prod-trades.json'), 'utf8'));
const tradeById = new Map((trades.trades || []).map((t) => [t.marketId, t]));

const lossParity = [...lossMarkets].map((marketId) => {
  const t = tradeById.get(marketId);
  const late = lossLate.get(marketId) || [];
  const rev = byMarket.get(marketId);
  return {
    marketId,
    livePnl: t?.pnl ?? null,
    side: t?.side,
    entry: t?.entryPrice,
    winner: t?.winner,
    reverseSignals: rev?.signals || 0,
    reverseAccepted: rev?.accepted || 0,
    lateSamples: late.slice(0, 5),
  };
});

const out = {
  reverseDecisionRows: reverseDecisions.length,
  reverseMarkets: markets.length,
  marketsWithAcceptedReverse: markets.filter((m) => m.accepted > 0).length,
  topSignalMarkets: markets.slice(0, 10),
  reverseOrders,
  lossParity,
  tradesSummary: trades.summary,
  tradesNet: trades.summary?.net,
  tradesCount: trades.trades?.length,
};

writeFileSync(join(__dirname, 'prod-reverse-diagnosis.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
