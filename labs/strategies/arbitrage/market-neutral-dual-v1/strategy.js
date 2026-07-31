export default strategy({
  name: "Market-Neutral Dual-Side V1 (ATFR & DLSL)",

  dependencies: {
    runner: strategyLibrary("market-neutral-runner", 1),
  },

  params: {
    variant: "dlsl-v1",
    maxOrderValue: 10.0,
    maxSlippage: 0.01,
    maxAllowedCombinedCost: 0.94,
    phase1MinSecondsLeft: 120,
    phase1MaxSecondsLeft: 240,
    phase1MaxAsk: 0.44,
    applyPolymarketFees: true,
    feeScenario: "base",
  },

  onEventStart() {},
  onTick() {},
  onEventEnd() {},
});
