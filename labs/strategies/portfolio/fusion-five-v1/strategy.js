export default strategy({
  name: "Fusion Five V1",

  dependencies: {
    runner: strategyLibrary("fusion-five-runner", 1),
  },

  params: {
    walletSize: 100,
    selectionMode: "stack",
    includeModules: ["terminal","cofre","impulse","edge","gamma"],
    priority: ["terminal","cofre","impulse","edge","gamma"],
    maxStackedModulesPerEvent: 0,
    edgeParams: {},
    gammaParams: {},
    cofreParams: {},
    impulseParams: {},
    terminalParams: {},
  },

  onEventStart() {},

  onTick() {},

  onEventEnd() {},
});

