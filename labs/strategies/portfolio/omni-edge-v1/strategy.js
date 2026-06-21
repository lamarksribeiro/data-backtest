export default strategy({
  name: "Omni Edge V1",

  dependencies: {
    runner: strategyLibrary("omni-edge-runner", 1),
  },

  params: {
    walletSize: 100,
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});

