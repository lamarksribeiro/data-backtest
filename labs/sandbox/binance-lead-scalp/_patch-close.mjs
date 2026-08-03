import fs from 'node:fs';

const p = new URL('./run-scalp-lab.mjs', import.meta.url);
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('function closePosition(');
const end = s.indexOf('\n/**\n * Simulate one event chronologically.', start);
if (start < 0 || end < 0) {
  console.error('markers not found', { start, end });
  process.exit(1);
}
const neu = `function closePosition(pos, exitPx, exitFeeExtra, reason, tsMs, trades) {
  const holdSec = (tsMs - pos.entryTsMs) / 1000;
  const dumpShares = pos.remaining > 1e-9 ? pos.remaining : 0;
  const proceeds =
    pos.fills.reduce((a, f) => a + f.shares * f.px, 0) + (dumpShares > 0 ? dumpShares * exitPx : 0);
  const exitFee = pos.fills.reduce((a, f) => a + f.fee, 0) + exitFeeExtra;
  const soldShares = pos.fills.reduce((a, f) => a + f.shares, 0) + dumpShares;
  const avgExit = soldShares > 0 ? proceeds / soldShares : exitPx;
  const pnl =
    Math.round((proceeds - pos.shares * pos.entryAsk - pos.entryFee - exitFee) * 1e4) / 1e4;
  const makerShares = pos.fills.reduce((a, f) => a + f.shares, 0);
  trades.push({
    side: pos.side,
    entryAsk: pos.entryAsk,
    exitPx: Math.round(avgExit * 1e4) / 1e4,
    shares: pos.shares,
    entryFee: pos.entryFee,
    exitFee: Math.round(exitFee * 1e4) / 1e4,
    makerExitShares: Math.round(makerShares * 100) / 100,
    takerExitShares: Math.round(dumpShares * 100) / 100,
    pnl,
    holdSec: Math.round(holdSec * 100) / 100,
    reason,
    tauAtEntry: pos.tauAtEntry,
    binRet: pos.binRet,
    entryTsMs: pos.entryTsMs,
    exitTsMs: tsMs,
    ladderFills: pos.fills.length,
  });
}
`;
fs.writeFileSync(p, s.slice(0, start) + neu + s.slice(end));
console.log('patched closePosition');
