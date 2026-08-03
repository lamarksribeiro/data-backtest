const DEFAULT_SCALPER_PARAMS = {
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
  takeProfitPct: 0.20, // Realiza lucro ao atingir +20% no Bid
  takeProfitCents: 0.10, // Realiza lucro ao subir +10 centavos no Bid
  maxHoldTimeSec: 25, // Tempo máximo de retenção do scalp (25 segundos)
  stopLossPct: 0.15, // Stop loss de -15% se o impulso falhar
  maxSpread: 0.05,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.75,
};

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function runHyperionScalper(event, ticks, userParams = {}) {
  const params = { ...DEFAULT_SCALPER_PARAMS, ...userParams };
  const traces = [];
  let totalPnl = 0;
  let tradesInEvent = 0;
  let lastExitTs = 0;
  let currentPosition = null;

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    const secsLeft = Math.max(0, (event.end - tick.ts) / 1000);

    // 1. Manage Open Scalp Position
    if (currentPosition) {
      const holdTime = (tick.ts - currentPosition.entryTs) / 1000;
      const currentBid = currentPosition.side === 'UP'
        ? Number(tick.up_best_bid ?? 0.5)
        : Number(tick.down_best_bid ?? 0.5);

      const pnlCents = currentBid - currentPosition.entryPrice;
      const pnlPct = pnlCents / Math.max(0.01, currentPosition.entryPrice);

      let shouldExit = false;
      let exitReason = '';

      if (pnlCents >= params.takeProfitCents || pnlPct >= params.takeProfitPct) {
        shouldExit = true;
        exitReason = 'take_profit_scalp';
      } else if (pnlPct <= -params.stopLossPct) {
        shouldExit = true;
        exitReason = 'stop_loss_scalp';
      } else if (holdTime >= params.maxHoldTimeSec) {
        shouldExit = true;
        exitReason = 'max_hold_time_exceeded';
      }

      if (shouldExit) {
        const tradePnl = (currentBid - currentPosition.entryPrice) * currentPosition.shares;
        totalPnl += tradePnl;

        traces.push({
          type: 'EXIT',
          ts: tick.ts,
          side: currentPosition.side,
          price: currentBid,
          pnl: tradePnl,
          reason: exitReason,
          holdTime,
        });

        currentPosition = null;
        lastExitTs = tick.ts;
      }
      continue;
    }

    // 2. Check Entry Signal for New Scalp
    const cooldownPassed = (tick.ts - lastExitTs) / 1000 >= params.cooldownSec;
    if (
      tradesInEvent < params.maxTradesPerEvent &&
      cooldownPassed &&
      secsLeft <= params.entryWindowStart &&
      secsLeft >= params.entryWindowEnd
    ) {
      // Calculate 5s impulse on underlying spot
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

          currentPosition = {
            side,
            entryPrice: ask,
            shares,
            entryTs: tick.ts,
          };

          tradesInEvent++;
          traces.push({
            type: 'ENTRY',
            ts: tick.ts,
            side,
            price: ask,
            impulse,
            tradeIndex: tradesInEvent,
          });
        }
      }
    }
  }

  return {
    traces,
    totalPnl,
    tradesCount: tradesInEvent,
  };
}
