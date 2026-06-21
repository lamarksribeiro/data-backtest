export default strategy({
  name: "Stable Carry Compression V1",

  dependencies: {
    runner: strategyLibrary("stable-carry-compression-runner", 1),
  },

  params: {
    walletSize: 100,
    maxOrderValue: 15,
    minShares: 5,
    entryWindowStart: 120,
    entryWindowEnd: 30,
    fastLookbackSec: 10,
    slowLookbackSec: 30,
    maxCurveAbs: 0.025,
    minAsk: 0.7,
    maxAsk: 0.82,
    maxSpread: 0.05,
    minOddsSum: 0.99,
    maxOddsSum: 1.06,
    minDistanceAbs: 20,
    maxDistanceAbs: 100,
    minBtcSupport: 5,
    minDecisionMetric: 0,
    entrySlippageMax: 0.02,
    minLiquidityRatio: 0.65,
    fallbackBookSize: 0,
    profitExitBid: 0.88,
    stopBid: 0,
    exitSlippageMax: 0.02,
    exitLiquidityRatio: 0.65,
    allowedPositionSide: "BOTH",
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});

