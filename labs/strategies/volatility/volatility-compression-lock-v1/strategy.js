export default strategy({
  name: "Volatility Compression Lock V1",

  dependencies: {
    runner: strategyLibrary("volatility-compression-lock-runner", 1),
  },

  params: {
    walletSize: 100,
    maxOrderValue: 15,
    minShares: 5,
    entryWindowStart: 110,
    entryWindowEnd: 20,
    minAheadDist: 15,
    maxAheadDist: 60,
    minAsk: 0.05,
    maxAsk: 0.5,
    maxSpread: 0.1,
    minOddsSum: 0.95,
    maxOddsSum: 1.1,
    minModelEdge: 0.08,
    entrySlippageMax: 0.02,
    minLiquidityRatio: 0.6,
    fallbackBookSize: 0,
    fastVolLookbackSec: 10,
    fastVolThreshold: 3,
    minSigma: 2,
    stopIfCrossed: false,
    stopCrossDist: -2,
    stopMinBid: 0.04,
    allowedPositionSide: "BOTH",
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});

