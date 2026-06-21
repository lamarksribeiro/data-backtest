export default strategy({
  name: "ERM V1",

  dependencies: {
    runner: strategyLibrary("erm-runner", 1),
  },

  params: {
    walletSize: 200,
    maxOrderValue: 15,
    minShares: 5,
    entryWindowStart: 150,
    entryWindowEnd: 50,
    minAsk: 0.1,
    maxAsk: 0.48,
    maxSpread: 0.05,
    minOddsSum: 0.96,
    maxOddsSum: 1.08,
    minCalSamples: 50,
    minEmpiricalProb: 0.8,
    minEdge: 0.28,
    minMarketResidual: 0.24,
    minScore: 0,
    minSignedDistance: 40,
    maxSignedDistance: 140,
    maxVol: 18,
    minPinRatio: 0,
    minCrosses: 0,
    maxMarketProbability: 0.58,
    entrySlippageMax: 0.02,
    minLiquidityRatio: 0.75,
    fallbackBookSize: 0,
    allowedPositionSide: "BOTH",
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});

