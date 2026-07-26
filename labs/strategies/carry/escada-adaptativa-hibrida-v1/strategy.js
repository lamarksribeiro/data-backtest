export default strategy({
  name: "Escada Adaptativa Híbrida V1",

  dependencies: {
    runner: strategyLibrary("escada-adaptativa-hibrida-runner", 1),
  },

  params: {
    walletSize: 1000,
    riskPerEventPct: 0.0025,
    minShares: 5,
    tickSize: 0.01,
    maxGrossExposurePct: 0.025,
    maxCycles: 3,
    entryWindowStartSec: 240,
    entryWindowEndSec: 60,
    hedgeCutoffSec: 10,
    minEdge: 0.06,
    cancelEdge: 0.03,
    minDirectionalProbability: 0.57,
    maxSpread: 0.05,
    cancelSpread: 0.07,
    makerFillMode: "strict_cross",
    cancelLatencyTicks: 1,
    takerLatencyTicks: 1,
    applyPolymarketFees: true,
    polymarketFeeCategory: "crypto",
  },

  onEventStart() {},
  onTick() {},
  onEventEnd() {},
});
