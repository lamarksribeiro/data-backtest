import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('reports/labs/edge-sniper-v3/2026-06-16T01-40-27-878Z-eth-optimization/top-results.json', 'utf8'));

// Print detailed info for rank 1 (v0224) and rank 17 (v0007 or whichever variant has PnL 212.3847)
console.log("Total variants in top-results:", data.length);
console.log("Top 3 variants:");
console.log(data.slice(0, 3).map(v => ({ id: v.id, rank: v.rank, pnl: v.summary.totalPnl, pf: v.summary.profitFactor, winRate: v.summary.winRate, maxDrawdown: v.summary.maxDrawdown, params: v.params })));

console.log("\nVariants with PnL near 212.38:");
const highPnl = data.filter(v => Math.abs(v.summary.totalPnl - 212.38) < 1.0);
console.log(highPnl.map(v => ({ id: v.id, rank: v.rank, pnl: v.summary.totalPnl, pf: v.summary.profitFactor, winRate: v.summary.winRate, maxDrawdown: v.summary.maxDrawdown, params: { minDistanceAbs: v.params.minDistanceAbs, minDistanceNearExpiry: v.params.minDistanceNearExpiry, minSigma: v.params.minSigma, minEdge: v.params.minEdge, stopBid: v.params.stopBid, dynamicStopEnabled: v.params.dynamicStopEnabled } })));
