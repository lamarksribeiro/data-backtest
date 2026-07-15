export default strategy({
  name: "Hopper 4 V1",

  dependencies: {
    runner: strategyLibrary("hopper-4-runner", 1),
  },

  params: {
    walletSize: 100,
    pctWallet: 0.04,
    minShares: 10,
    walletMinLimit: 100,
    walletMaxCap: 1000,
    monitoringWindowSec: 290,
    minTimeForNewCycleSec: 35,
    triggerCents: 55,
    distMinPtb: 10,
    distFinalPtb: 2,
    distFinalSec: 30,
    cooldownBuySec: 3,
    cooldownFlipSec: 35,
    cooldownHaltEndSec: 60,
    fallbackBookSize: 0,
    multVirada: "3,6,12,24,36",
    maxViradas: 3,
    fokEnabled: false,
    fokPriceCap: 0.75,
    fokAteVirada: 1,
    somaMinValida: 85,
    somaMaxValida: 115,
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});
