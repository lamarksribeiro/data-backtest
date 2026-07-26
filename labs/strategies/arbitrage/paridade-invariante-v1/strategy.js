export default strategy({
  name: "Paridade Invariante V1",

  dependencies: {
    runner: strategyLibrary("paridade-invariante-runner", 1),
  },

  params: {
    walletSize: 100,
    sizingMode: "maximize",
    targetPairShares: 20,
    minPairShares: 5,
    maxPairShares: 80,
    maxEventNotional: 80,
    maxPairsPerEvent: 1,
    payoutPerPair: 1,
    takerFeeRate: 0.07,
    minNetEdgePerShare: 0.005,
    minNetProfitUsd: 0.10,
    operationalBufferPerShare: 0.002,
    confirmationTicks: 2,
    executionLatencyTicks: 1,
    maxSignalGapMs: 750,
    minSecondsLeft: 15,
    maxSecondsLeft: 285,
    maxSpread: 0.03,
    requireBookCoherence: true,
    maxBookTopDrift: 0.0015,
    requireQuality: true,
    minCoverage: 0.99,
    applyPolymarketFees: true,
    polymarketFeeCategory: "crypto",
  },

  onEventStart() {},
  onTick() {},
  onEventEnd() {},
});
