export default strategy({
  name: "Convergence Undershoot V1",

  dependencies: {
    runner: strategyLibrary("convergence-undershoot-runner", 1),
  },

  params: {
    walletSize: 100,
    maxOrderValue: 15,
    minShares: 5,
    entryWindowStart: 45,
    entryWindowEnd: 15,
    minAheadDist: 5,
    maxAheadDist: 20,
    minAsk: 0.55,
    maxAsk: 0.82,
    maxSpread: 0.04,
    minOddsSum: 0.98,
    maxOddsSum: 1.06,
    requireStabilityTicks: 10,
    profitExitBid: 0,
    stopIfCrossed: true,
    stopCrossDist: -2,
    stopMinBid: 0.04,
    entrySlippageMax: 0.02,
    minLiquidityRatio: 0.55,
    fallbackBookSize: 0,
    stopReverseEnabled: false,
    stopReverseMaxAttempts: 1,
    stopReverseMaxSecondsRemaining: 40,
    stopReverseMinSecondsRemaining: 5,
    stopReverseMinDistanceAbs: 5,
    stopReverseMaxAsk: 0.85,
    stopReverseSlippageMax: 0.02,
    stopReverseMinLiquidityRatio: 0.5,
    stopReverseMinBid: 0.02,
    stopReverseBudgetMode: "same-cost",
    stopReverseBudgetFactor: 1,
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});

