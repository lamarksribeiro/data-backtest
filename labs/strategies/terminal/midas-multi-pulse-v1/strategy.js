export default strategy({
  name: "MIDAS Multi-Pulse V1",

  params: {
    walletSize: 100,
    entryBudget: 10,
    minShares: 1,
    entrySlippageMax: 0.02,
    minLiquidityRatio: 0.6,
    maxEntriesPerEvent: 3,
    minEntryIntervalSecs: 3,
    maxEventBudget: 35,
    minSecondsLeft: 4,
    maxSecondsLeft: 30,
    maxDistAbs: 40,
    minAsk: 0.55,
    maxAsk: 0.94,
    maxSpread: 0.03,
    minOddsSum: 0.98,
    maxOddsSum: 1.06,
    earlyPulseEnabled: true,
    earlyMinSecondsLeft: 30,
    earlyMaxSecondsLeft: 90,
    earlyMinZ: 0.8,
    earlyMinObi: 0.1,
    earlyMaxAsk: 0.82,
    velocityLookbackSecs: 5,
    maxAdverseSpotChange: 8,
    minObi: 0,
    obiLevels: 5,
    sigmaSizingEnabled: true,
    sigmaLookbackSecs: 90,
    sigmaDivisor: 5.48,
    zT1: 0.5,
    zT2: 1,
    zT3: 2.5,
    zT4: 4,
    wZ0: 0.5,
    wZ1: 0.8,
    wZ2: 1,
    wZ3: 1.4,
    wZ4: 1.8,
    scoopEnabled: true,
    scoopMinZ: 1.5,
    scoopMinAsk: 0.1,
    scoopMaxAsk: 0.55,
    scoopMaxSpread: 0.05,
    scoopMaxDistAbs: 80,
    scoopMinSecondsLeft: 5,
    scoopMaxSecondsLeft: 30,
    scoopBudgetFactor: 1,
    stopMinBid: 0.05,
    lateFlipExitEnabled: true,
    lateFlipExitSec: 8,
    lateFlipExitCrossDist: 0,
    lateFlipMinSec: 4,
    lateFlipReverseEnabled: true,
    lateFlipReverseMaxAsk: 0.95,
    lateFlipReverseMinAsk: 0,
    lateFlipReverseBudgetFactor: 1,
    minEntryZ: 0,
    tierAskThreshold: 0.82,
    tierAskBudgetFactor: 1.5,
  },

  onEventStart({ state }) {
    state.entered = false;
    state.closed = false;
    state.reversed = false;
    state.signedDistance = 0;
    state.entryZ = 0;
    state.entryMode = "";
    state.entryBudgetUsed = 0;
    state.z = 0;
    state.isAdverseMove = false;
    state.obiOk = true;
    state.budgetFactor = 1;
    state.reverseBudget = 0;
    state.entriesCount = 0;
    state.totalBudgetSpent = 0;
    state.lastEntrySecsLeft = 999;
  },

  onTick(ctx) {
    const { tick, event, state, params, position, runState } = ctx;
    const secsLeft = time.secondsUntil(event.end, tick.ts);
    if (position.open) {
      if (!state.entered) {
        state.entered = true;
      }
      const side = position.side;
      const bid = book.bid(side, tick);
      state.signedDistance = (tick.underlyingPrice - event.priceToBeat);
      if ((side == "DOWN")) {
        state.signedDistance = (event.priceToBeat - tick.underlyingPrice);
      }
      const lateFlipExitOn = ((params.lateFlipExitEnabled == true) || (params.lateFlipExitEnabled == 1));
      if ((((((!state.closed && lateFlipExitOn) && (secsLeft <= params.lateFlipExitSec)) && (secsLeft >= params.lateFlipMinSec)) && (state.signedDistance <= params.lateFlipExitCrossDist)) && (bid >= params.stopMinBid))) {
        const lateFlipReverseOn = ((params.lateFlipReverseEnabled == true) || (params.lateFlipReverseEnabled == 1));
        if ((lateFlipReverseOn && !state.reversed)) {
          const oppSide = prices.oppositeSide(side);
          const oppAsk = book.ask(oppSide, tick);
          if ((((oppAsk >= params.lateFlipReverseMinAsk) && (oppAsk > 0)) && (oppAsk <= params.lateFlipReverseMaxAsk))) {
            state.reverseBudget = params.entryBudget;
            if ((state.entryBudgetUsed > 0)) {
              state.reverseBudget = state.entryBudgetUsed;
            }
            state.reverseBudget = (state.reverseBudget * params.lateFlipReverseBudgetFactor);
            const flipped = orders.reverse(oppSide, { "price": oppAsk, "exitPrice": bid, "budget": state.reverseBudget, "tick": tick, "ignoreConsumed": true, "reason": "late_flip_reverse" });
            if (flipped) {
              state.reversed = true;
              trace.mark("reverse", { "reason": "late_flip_reverse", "from": side, "to": oppSide, "ask": oppAsk });
            }
          }
        }
        if (!state.reversed) {
          const lateFlipped = orders.exit({ "price": bid, "reason": "late_flip_exit" });
          if (lateFlipped) {
            state.closed = lateFlipped.closed;
            trace.mark("exit", { "reason": "late_flip_exit", "price": bid });
          }
        }
      }
    }
    const canPulse = ((((state.entriesCount < params.maxEntriesPerEvent) && (state.totalBudgetSpent < params.maxEventBudget)) && !state.closed) && !state.reversed);
    const timeIntervalOk = ((state.lastEntrySecsLeft - secsLeft) >= params.minEntryIntervalSecs);
    if ((canPulse && timeIntervalOk)) {
      const btc = tick.underlyingPrice;
      const ptb = event.priceToBeat;
      const dist = math.abs((btc - ptb));
      const fav = market.sideFromPrice(btc, ptb);
      const ask = book.ask(fav, tick);
      const bid = book.bid(fav, tick);
      const spread = (ask - bid);
      const sigmaLevel = signals.volatility(samples, params.sigmaLookbackSecs);
      const sigmaPs = (sigmaLevel / params.sigmaDivisor);
      state.z = 0;
      if (((sigmaPs > 0) && (secsLeft > 0))) {
        state.z = (dist / (sigmaPs * math.sqrt(secsLeft)));
      }
      state.isAdverseMove = false;
      const btcPast = signals.underlyingAgo(samples, params.velocityLookbackSecs);
      if (btcPast) {
        const spotChange = (btc - btcPast);
        if (((fav == "UP") && (spotChange < (0 - params.maxAdverseSpotChange)))) {
          state.isAdverseMove = true;
        }
        if (((fav == "DOWN") && (spotChange > params.maxAdverseSpotChange))) {
          state.isAdverseMove = true;
        }
      }
      const equity = math.max(0, (params.walletSize + runState.totalPnl));
      const earlyPulseOn = ((params.earlyPulseEnabled == true) || (params.earlyPulseEnabled == 1));
      if (((((((((earlyPulseOn && !state.isAdverseMove) && (secsLeft >= params.earlyMinSecondsLeft)) && (secsLeft <= params.earlyMaxSecondsLeft)) && (dist < params.maxDistAbs)) && (ask >= params.minAsk)) && (ask <= params.earlyMaxAsk)) && (spread <= params.maxSpread)) && (state.z >= params.earlyMinZ))) {
        const earlyObi = model.orderBookImbalance(fav, tick, params.obiLevels);
        if ((earlyObi >= params.earlyMinObi)) {
          const pulseBudget = math.min(params.entryBudget, (params.maxEventBudget - state.totalBudgetSpent), equity);
          const maxPrice = (ask + params.entrySlippageMax);
          const earlyBought = orders.enter(fav, { "price": ask, "maxPrice": maxPrice, "budget": pulseBudget, "minShares": params.minShares, "minLiquidityRatio": params.minLiquidityRatio, "tick": tick, "reason": "midas_early_pulse" });
          if (earlyBought) {
            state.entered = true;
            state.entriesCount = (state.entriesCount + 1);
            state.totalBudgetSpent = (state.totalBudgetSpent + pulseBudget);
            state.lastEntrySecsLeft = secsLeft;
            state.entryZ = state.z;
            state.entryMode = "early_pulse";
            state.entryBudgetUsed = pulseBudget;
            trace.mark("midas_pulse", { "mode": "early_pulse", "pulseIndex": state.entriesCount, "side": fav, "ask": ask, "dist": dist, "z": state.z, "secsLeft": secsLeft });
          }
        }
      }
      const remainingCanPulse = ((state.entriesCount < params.maxEntriesPerEvent) && (state.totalBudgetSpent < params.maxEventBudget));
      if (((((((((remainingCanPulse && !state.isAdverseMove) && (state.z >= params.minEntryZ)) && (secsLeft >= params.minSecondsLeft)) && (secsLeft <= params.maxSecondsLeft)) && (dist < params.maxDistAbs)) && (ask >= params.minAsk)) && (ask <= params.maxAsk)) && (spread <= params.maxSpread))) {
        const upAsk = book.ask("UP", tick);
        const downAsk = book.ask("DOWN", tick);
        const oddsSum = (upAsk + downAsk);
        if (((oddsSum >= params.minOddsSum) && (oddsSum <= params.maxOddsSum))) {
          state.obiOk = true;
          if ((params.minObi > (0 - 1))) {
            const obi = model.orderBookImbalance(fav, tick, params.obiLevels);
            if ((obi < params.minObi)) {
              state.obiOk = false;
            }
          }
          if (state.obiOk) {
            state.budgetFactor = 1;
            const sizingOn = ((params.sigmaSizingEnabled == true) || (params.sigmaSizingEnabled == 1));
            if (sizingOn) {
              state.budgetFactor = params.wZ2;
              if ((state.z < params.zT1)) {
                state.budgetFactor = params.wZ0;
              }
              if (((state.z >= params.zT1) && (state.z < params.zT2))) {
                state.budgetFactor = params.wZ1;
              }
              if (((state.z >= params.zT3) && (state.z < params.zT4))) {
                state.budgetFactor = params.wZ3;
              }
              if ((state.z >= params.zT4)) {
                state.budgetFactor = params.wZ4;
              }
            }
            if ((ask >= params.tierAskThreshold)) {
              state.budgetFactor = (state.budgetFactor * params.tierAskBudgetFactor);
            }
            const pulseBudget = math.min((params.entryBudget * state.budgetFactor), (params.maxEventBudget - state.totalBudgetSpent), equity);
            const maxPrice = (ask + params.entrySlippageMax);
            const coreBought = orders.enter(fav, { "price": ask, "maxPrice": maxPrice, "budget": pulseBudget, "minShares": params.minShares, "minLiquidityRatio": params.minLiquidityRatio, "tick": tick, "reason": "midas_core_pulse" });
            if (coreBought) {
              state.entered = true;
              state.entriesCount = (state.entriesCount + 1);
              state.totalBudgetSpent = (state.totalBudgetSpent + pulseBudget);
              state.lastEntrySecsLeft = secsLeft;
              state.entryZ = state.z;
              state.entryMode = "core_pulse";
              state.entryBudgetUsed = pulseBudget;
              trace.mark("midas_pulse", { "mode": "core_pulse", "pulseIndex": state.entriesCount, "side": fav, "ask": ask, "dist": dist, "z": state.z, "budgetFactor": state.budgetFactor, "secsLeft": secsLeft });
            }
          }
        }
      }
      const scoopOn = ((params.scoopEnabled == true) || (params.scoopEnabled == 1));
      const scoopCanPulse = ((state.entriesCount < params.maxEntriesPerEvent) && (state.totalBudgetSpent < params.maxEventBudget));
      if ((((((((((scoopOn && scoopCanPulse) && !state.isAdverseMove) && (secsLeft >= params.scoopMinSecondsLeft)) && (secsLeft <= params.scoopMaxSecondsLeft)) && (dist < params.scoopMaxDistAbs)) && (ask >= params.scoopMinAsk)) && (ask < params.scoopMaxAsk)) && (spread <= params.scoopMaxSpread)) && (state.z >= params.scoopMinZ))) {
        const scoopUpAsk = book.ask("UP", tick);
        const scoopDownAsk = book.ask("DOWN", tick);
        const scoopOddsSum = (scoopUpAsk + scoopDownAsk);
        if (((scoopOddsSum >= 0.9) && (scoopOddsSum <= 1.1))) {
          const scoopBudget = math.min((params.entryBudget * params.scoopBudgetFactor), (params.maxEventBudget - state.totalBudgetSpent), equity);
          const scoopMaxPrice = (ask + params.entrySlippageMax);
          const scooped = orders.enter(fav, { "price": ask, "maxPrice": scoopMaxPrice, "budget": scoopBudget, "minShares": params.minShares, "minLiquidityRatio": params.minLiquidityRatio, "tick": tick, "reason": "midas_scoop_pulse" });
          if (scooped) {
            state.entered = true;
            state.entriesCount = (state.entriesCount + 1);
            state.totalBudgetSpent = (state.totalBudgetSpent + scoopBudget);
            state.lastEntrySecsLeft = secsLeft;
            state.entryZ = state.z;
            state.entryMode = "scoop_pulse";
            state.entryBudgetUsed = scoopBudget;
            trace.mark("midas_pulse", { "mode": "scoop_pulse", "pulseIndex": state.entriesCount, "side": fav, "ask": ask, "dist": dist, "z": state.z, "secsLeft": secsLeft });
          }
        }
      }
    }
  },

  onEventEnd() {
  },

});