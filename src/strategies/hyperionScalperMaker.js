const DEFAULT_MAKER_SCALPER_PARAMS = {
  walletSize: 100,
  maxOrderValue: 15,
  minShares: 5,
  entryWindowStart: 295,
  entryWindowEnd: 20,
  maxTradesPerEvent: 4,
  cooldownSec: 8,
  minSpikeAbs: 20,
  minAsk: 0.15,
  maxAsk: 0.70,
  // Maker Partial Limit Exit Targets
  targetLimit1Cents: 0.08, // +8¢ limit sell (50% partial exit, 0% maker fee)
  targetLimit2Cents: 0.14, // +14¢ limit sell (50% partial exit, 0% maker fee)
  maxHoldTimeSec: 20, // Failsafe time-stop (20s)
  stopLossPct: 0.15,
  maxSpread: 0.05,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.75,
};

export function runHyperionMakerScalper(event, ticks, userParams = {}) {
  const params = { ...DEFAULT_MAKER_SCALPER_PARAMS, ...userParams };
  const traces = [];
  let totalPnl = 0;
  let totalFees = 0;
  let tradesInEvent = 0;
  let lastExitTs = 0;
  let currentPosition = null;

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    const secsLeft = Math.max(0, (event.end - tick.ts) / 1000);

    // 1. Manage Open Scalp Position with Maker Partial Limits
    if (currentPosition) {
      const holdTime = (tick.ts - currentPosition.entryTs) / 1000;
      const currentAsk = currentPosition.side === 'UP'
        ? Number(tick.up_best_ask ?? 0.5)
        : Number(tick.down_best_ask ?? 0.5);
      const currentBid = currentPosition.side === 'UP'
        ? Number(tick.up_best_bid ?? 0.5)
        : Number(tick.down_best_bid ?? 0.5);

      const pnlPctBid = (currentBid - currentPosition.entryPrice) / Math.max(0.01, currentPosition.entryPrice);

      // Level 1 Limit Target (+8¢ Maker)
      if (!currentPosition.part1Exited && currentAsk >= currentPosition.entryPrice + params.targetLimit1Cents) {
        const sharesToExit = currentPosition.shares * 0.5;
        const exitPrice = currentPosition.entryPrice + params.targetLimit1Cents;
        const grossPnl = (exitPrice - currentPosition.entryPrice) * sharesToExit;
        // Maker Exit Fee: ZERO (0.00)
        const exitFee = 0;

        totalPnl += grossPnl;
        currentPosition.remainingShares -= sharesToExit;
        currentPosition.part1Exited = true;

        traces.push({
          type: 'PARTIAL_MAKER_EXIT',
          ts: tick.ts,
          side: currentPosition.side,
          price: exitPrice,
          pnl: grossPnl,
          fee: exitFee,
          reason: 'maker_limit_target_1',
        });
      }

      // Level 2 Limit Target (+14¢ Maker)
      if (!currentPosition.part2Exited && currentAsk >= currentPosition.entryPrice + params.targetLimit2Cents) {
        const sharesToExit = currentPosition.remainingShares;
        const exitPrice = currentPosition.entryPrice + params.targetLimit2Cents;
        const grossPnl = (exitPrice - currentPosition.entryPrice) * sharesToExit;
        // Maker Exit Fee: ZERO (0.00)
        const exitFee = 0;

        totalPnl += grossPnl;
        currentPosition.remainingShares = 0;
        currentPosition.part2Exited = true;

        traces.push({
          type: 'MAKER_EXIT_FINAL',
          ts: tick.ts,
          side: currentPosition.side,
          price: exitPrice,
          pnl: grossPnl,
          fee: exitFee,
          reason: 'maker_limit_target_2',
        });

        currentPosition = null;
        lastExitTs = tick.ts;
        continue;
      }

      // Failsafe Taker Time-Stop or Stop Loss (Taker Exit at Bid)
      if (currentPosition && (pnlPctBid <= -params.stopLossPct || holdTime >= params.maxHoldTimeSec)) {
        const sharesToExit = currentPosition.remainingShares;
        const grossPnl = (currentBid - currentPosition.entryPrice) * sharesToExit;
        // Taker Exit Fee on Failsafe
        const takerExitFee = sharesToExit * 0.07 * currentBid * (1 - currentBid);

        totalPnl += (grossPnl - takerExitFee);
        totalFees += takerExitFee;

        traces.push({
          type: 'TAKER_FAILSAFE_EXIT',
          ts: tick.ts,
          side: currentPosition.side,
          price: currentBid,
          pnl: grossPnl - takerExitFee,
          fee: takerExitFee,
          reason: holdTime >= params.maxHoldTimeSec ? 'time_stop_failsafe' : 'stop_loss_failsafe',
        });

        currentPosition = null;
        lastExitTs = tick.ts;
      }
      continue;
    }

    // 2. Entry Trigger
    const cooldownPassed = (tick.ts - lastExitTs) / 1000 >= params.cooldownSec;
    if (
      tradesInEvent < params.maxTradesPerEvent &&
      cooldownPassed &&
      secsLeft <= params.entryWindowStart &&
      secsLeft >= params.entryWindowEnd
    ) {
      const spot = tick.underlyingPrice;
      const prevSpot = ticks[Math.max(0, i - 5)]?.underlyingPrice ?? spot;
      const impulse = spot - prevSpot;

      if (Math.abs(impulse) >= params.minSpikeAbs) {
        const side = impulse > 0 ? 'UP' : 'DOWN';
        const ask = side === 'UP' ? Number(tick.up_best_ask ?? 0.5) : Number(tick.down_best_ask ?? 0.5);
        const spread = side === 'UP'
          ? (Number(tick.up_best_ask) - Number(tick.up_best_bid))
          : (Number(tick.down_best_ask) - Number(tick.down_best_bid));

        if (ask >= params.minAsk && ask <= params.maxAsk && spread <= params.maxSpread) {
          const budget = Math.min(params.maxOrderValue, params.walletSize + totalPnl);
          const shares = budget / Math.max(0.01, ask);
          const entryFee = shares * 0.07 * ask * (1 - ask);

          totalFees += entryFee;

          currentPosition = {
            side,
            entryPrice: ask,
            shares,
            remainingShares: shares,
            entryTs: tick.ts,
            part1Exited: false,
            part2Exited: false,
          };

          tradesInEvent++;
          traces.push({
            type: 'ENTRY',
            ts: tick.ts,
            side,
            price: ask,
            impulse,
            fee: entryFee,
          });
        }
      }
    }
  }

  return {
    traces,
    totalPnl,
    totalFees,
    tradesCount: tradesInEvent,
  };
}
