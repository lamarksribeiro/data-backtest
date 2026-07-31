import { writeFileSync, mkdirSync } from 'node:fs';
import { closeDatabasePool, getTicksForBacktestBatches } from '../src/database.js';
import { MarketNeutralLabEngine } from './lab-market-neutral-dual.js';

const engine = new MarketNeutralLabEngine({
  variant: 'dlsl-v1',
  feeScenario: 'base',
  maxSlippage: 0.01,
});

let currentEventStart = null;
let currentEventTicks = [];
let ticks = 0;

for await (const batch of getTicksForBacktestBatches('2026-05-04T15:00:00.000Z', null, 50000)) {
  ticks += batch.length;
  for (const tick of batch) {
    if (tick.event_start !== currentEventStart) {
      if (currentEventTicks.length) engine.processEvent(currentEventTicks);
      currentEventStart = tick.event_start;
      currentEventTicks = [tick];
    } else {
      currentEventTicks.push(tick);
    }
  }
}
if (currentEventTicks.length) engine.processEvent(currentEventTicks);

const trades = engine.trades;
const locked = trades.filter((t) => t.profitLocked);
const orphan = trades.filter((t) => !t.profitLocked);
const sum = (arr, f) => arr.reduce((a, b) => a + f(b), 0);
const avg = (arr, f) => (arr.length ? sum(arr, f) / arr.length : 0);
const wins = (arr) => arr.filter((t) => t.netPnL > 0);
const losses = (arr) => arr.filter((t) => t.netPnL < 0);
const pf = (arr) => {
  const w = sum(wins(arr), (t) => t.netPnL);
  const l = Math.abs(sum(losses(arr), (t) => t.netPnL));
  return l > 0 ? w / l : w > 0 ? 99 : 0;
};

function bucket(arr, name) {
  return {
    name,
    n: arr.length,
    pct: +((100 * arr.length) / Math.max(trades.length, 1)).toFixed(1),
    pnl: +sum(arr, (t) => t.netPnL).toFixed(2),
    wr: arr.length ? +((wins(arr).length / arr.length) * 100).toFixed(1) : 0,
    pf: +pf(arr).toFixed(2),
    avgPnl: +avg(arr, (t) => t.netPnL).toFixed(2),
    avgCost: +avg(arr, (t) => t.totalCost).toFixed(2),
    avgFees: +avg(arr, (t) => t.feesPaid).toFixed(2),
    avgWorst: +avg(arr, (t) => t.worstCase).toFixed(2),
    avgBest: +avg(arr, (t) => t.bestCase).toFixed(2),
    negFloorPct: arr.length
      ? +((arr.filter((t) => t.worstCase < 0).length / arr.length) * 100).toFixed(1)
      : 0,
  };
}

// Locked: pnl = qty - totalCost on both outcomes → qty = pnl + totalCost
const lockedWithUnit = locked
  .map((t) => {
    const qty = t.netPnL + t.totalCost;
    const unit = qty > 0 ? t.totalCost / qty : null;
    return { ...t, qty, unit };
  })
  .filter((t) => t.unit != null);

const unitBins = [
  ['<0.94', (t) => t.unit < 0.94],
  ['0.94–0.98', (t) => t.unit >= 0.94 && t.unit < 0.98],
  ['0.98–1.00', (t) => t.unit >= 0.98 && t.unit < 1.0],
  ['1.00–1.05', (t) => t.unit >= 1.0 && t.unit < 1.05],
  ['>=1.05', (t) => t.unit >= 1.05],
];

const unitDist = unitBins.map(([label, pred]) => {
  const s = lockedWithUnit.filter(pred);
  return {
    label,
    n: s.length,
    pnl: +sum(s, (t) => t.netPnL).toFixed(2),
    avgUnit: s.length ? +avg(s, (t) => t.unit).toFixed(4) : null,
  };
});

const orphanWins = orphan.filter((t) => t.netPnL > 0);
const orphanLosses = orphan.filter((t) => t.netPnL < 0);

const report = {
  generatedAt: new Date().toISOString(),
  ticks,
  events: engine.eventsProcessed,
  maxSlippage: 0.01,
  metrics: engine.getMetrics(),
  locked: bucket(locked, 'locked'),
  orphan: bucket(orphan, 'orphan'),
  lockedUnitCostDist: unitDist,
  lockedNegFloor: locked.filter((t) => t.worstCase < 0).length,
  lockedPosFloor: locked.filter((t) => t.worstCase >= 0).length,
  orphanWinPnl: +sum(orphanWins, (t) => t.netPnL).toFixed(2),
  orphanLossPnl: +sum(orphanLosses, (t) => t.netPnL).toFixed(2),
  orphanAvgWin: +avg(orphanWins, (t) => t.netPnL).toFixed(2),
  orphanAvgLoss: +avg(orphanLosses, (t) => t.netPnL).toFixed(2),
  sampleLockedNeg: lockedWithUnit
    .filter((t) => t.unit >= 1)
    .slice(0, 8)
    .map((t) => ({
      unit: +t.unit.toFixed(4),
      cost: +t.totalCost.toFixed(2),
      qty: +t.qty.toFixed(2),
      pnl: +t.netPnL.toFixed(2),
      fees: +t.feesPaid.toFixed(2),
    })),
  sampleLockedPos: lockedWithUnit
    .filter((t) => t.unit < 1)
    .slice(0, 8)
    .map((t) => ({
      unit: +t.unit.toFixed(4),
      cost: +t.totalCost.toFixed(2),
      qty: +t.qty.toFixed(2),
      pnl: +t.netPnL.toFixed(2),
      fees: +t.feesPaid.toFixed(2),
    })),
};

mkdirSync('reports/market-neutral-dual-v1', { recursive: true });
writeFileSync(
  'reports/market-neutral-dual-v1/dlsl-v1-breakdown.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
await closeDatabasePool();
