import { createAbruptSpikeScalperRunner } from '../src/strategies/abruptSpikeScalper.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

function runPerformanceReport() {
  console.log('====================================================================================');
  console.log('  RELATÓRIO DE DESEMPENHO E APROVAÇÃO DA ESTRATÉGIA ABRUPT SPIKE SCALPER (COM TAXAS)');
  console.log('====================================================================================\n');

  const generateMarketStream = () => {
    const ticks = [];
    const baseStart = new Date('2026-07-22T00:00:00.000Z').getTime();

    for (let e = 0; e < 100; e++) {
      const eventStartMs = baseStart + e * 300000;
      const conditionId = `event-${e + 1}`;
      let btc = 65000 + (Math.random() - 0.5) * 200;
      const priceToBeat = btc;

      for (let s = 0; s < 300; s += 2) {
        const ts = new Date(eventStartMs + s * 1000).toISOString();

        // Subida ou Queda Abrupta em s=40, s=120, s=200
        if (s === 40 || s === 120 || s === 200) {
          const spikeSign = Math.random() > 0.5 ? 1 : -1;
          btc += spikeSign * 35; // Spike abrupto de 35 USD em 2s
        } else if (s === 44 || s === 124 || s === 204) {
          // Reação/Correção imediata de 18 USD em 4s
          const lastSign = btc > priceToBeat ? 1 : -1;
          btc -= lastSign * 18;
        } else {
          btc += (Math.random() - 0.5) * 1.5;
        }

        const dist = btc - priceToBeat;
        let upProb = 0.50 + dist * 0.005;
        upProb = Math.min(0.95, Math.max(0.05, upProb));
        const downProb = 1 - upProb;

        ticks.push({
          condition_id: conditionId,
          event_start: new Date(eventStartMs).toISOString(),
          event_end: new Date(eventStartMs + 300000).toISOString(),
          ts,
          btc_price: btc,
          price_to_beat: priceToBeat,
          up_best_ask: Math.min(0.98, upProb + 0.015),
          down_best_ask: Math.min(0.98, downProb + 0.015),
          up_best_bid: Math.max(0.01, upProb - 0.015),
          down_best_bid: Math.max(0.01, downProb - 0.015),
        });
      }
    }
    return ticks;
  };

  const marketTicks = generateMarketStream();

  const evaluateStrategy = (mode, minSpikeAbs, takeProfitPct, stopLossPct) => {
    const runner = createAbruptSpikeScalperRunner({
      minSpikeAbs,
      strategyMode: mode,
      impulseSec: 4,
      cooldownSec: 6,
      takeProfitPct,
      partialTakeProfitPct: 0.50,
      takeProfitBid: 0.85,
      stopLossPct,
      maxTradesPerEvent: 5,
      walletSize: 100,
      maxOrderValue: 15,
    });

    for (const tick of marketTicks) runner.processTick(tick);

    const raw = runner.finish();

    // Calculate trade-level metrics & polymarket fees explicitly
    let tradeWins = 0;
    let tradeLosses = 0;
    let totalFeePaid = 0;

    for (const ev of raw.events) {
      for (const ex of ev.exits || []) {
        if (ex.pnl > 0) tradeWins++;
        else if (ex.pnl < 0) tradeLosses++;
      }
      // Sum order & exit fees: shares * 0.07 * price * (1 - price)
      for (const ord of ev.orders || []) {
        for (const fill of ord.fills || []) {
          totalFeePaid += fill.qty * 0.07 * fill.price * (1 - fill.price);
        }
      }
      for (const ex of ev.exits || []) {
        if (ex.reason !== 'event_expiry' && ex.price > 0 && ex.price < 1) {
          totalFeePaid += ex.qty * 0.07 * ex.price * (1 - ex.price);
        }
      }
    }

    const totalTrades = tradeWins + tradeLosses;
    const tradeWinRate = totalTrades > 0 ? (tradeWins / totalTrades) * 100 : 0;

    const grossPnl = raw.summary.totalPnl;
    const netPnl = grossPnl - totalFeePaid;

    return {
      mode,
      minSpikeAbs,
      takeProfitPct,
      stopLossPct,
      totalEvents: raw.summary.totalEvents,
      totalTrades,
      tradeWins,
      tradeLosses,
      tradeWinRate,
      grossPnl,
      totalFees: totalFeePaid,
      netPnl,
      netRoi: (netPnl / 100) * 100,
    };
  };

  const results = [
    evaluateStrategy('fade', 20, 0.12, 0.15),
    evaluateStrategy('fade', 25, 0.15, 0.15),
    evaluateStrategy('fade', 30, 0.20, 0.18),
    evaluateStrategy('impulse', 20, 0.12, 0.15),
    evaluateStrategy('impulse', 25, 0.15, 0.15),
    evaluateStrategy('impulse', 30, 0.20, 0.18),
  ];

  console.log('---------------------------------------------------------------------------------------------------------------------------------');
  console.log(' MODO     | SPIKE MIN | TAKE PROFIT | STOP LOSS | TRADES | WIN RATE | LUCRO BRUTO | TAXAS (7%) | LUCRO LÍQUIDO | ROI LÍQUIDO');
  console.log('---------------------------------------------------------------------------------------------------------------------------------');

  for (const r of results) {
    const isApproved = r.netPnl > 0 && r.tradeWinRate > 50;
    const status = isApproved ? 'APROVADA' : 'REPROVADA';
    console.log(
      ` ${r.mode.padEnd(8)} | $${String(r.minSpikeAbs).padEnd(8)} | ${(r.takeProfitPct * 100).toFixed(0)}%         | ${(r.stopLossPct * 100).toFixed(0)}%       | ${String(r.totalTrades).padEnd(6)} | ${r.tradeWinRate.toFixed(1).padEnd(5)}%   | $${r.grossPnl.toFixed(2).padEnd(10)} | $${r.totalFees.toFixed(2).padEnd(9)} | $${r.netPnl.toFixed(2).padEnd(12)} | +${r.netRoi.toFixed(1)}% [${status}]`
    );
  }
  console.log('---------------------------------------------------------------------------------------------------------------------------------\n');
}

runPerformanceReport();
