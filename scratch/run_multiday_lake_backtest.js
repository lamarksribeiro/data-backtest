import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { createStrategy, createStrategyVersion } from '../src/backtestStudio/state/strategies.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const targetDays = [
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ];

    console.log('====================================================================================');
    console.log(` VARREDURA DE LIMIAR DE IMPULSO (MIN SPIKE) NO LAKE REAL (5 DIAS DE MERCADO REAL)`);
    console.log('====================================================================================\n');

    const testThreshold = async (minSpike) => {
      let strategy = db.prepare("SELECT * FROM strategy_definitions WHERE slug = 'abrupt-spike-scalper'").get();
      if (!strategy) {
        strategy = createStrategy(db, { slug: 'abrupt-spike-scalper', name: 'Abrupt Spike Scalper' });
      }

      const jsSource = `
      export default strategy({
        name: "Abrupt Spike Scalper",
        params: {
          impulseSec: 5,
          minSpikeAbs: ${minSpike},
          strategyMode: "fade",
          maxTradesPerEvent: 5,
          cooldownSec: 8,
          takeProfitPct: 0.12,
          partialTakeProfitPct: 0.50,
          stopLossPct: 0.15,
          maxHoldTimeSec: 25,
          budget: 15
        },
        onEventStart({ state }) { state.entered = false; },
        onTick(ctx) {
          const { tick, event, state, params } = ctx;
          if (position.open) {
            const bid = book.bid(position.side, tick);
            if (bid >= 0.85) {
              orders.exit({ price: bid, reason: "take_profit" });
            } else if (bid <= 0.14) {
              orders.exit({ price: bid, reason: "stop_loss" });
            }
          } else {
            const btc = tick.underlyingPrice;
            const ago = signals.underlyingAgo(params.impulseSec);
            if (ago) {
              const impulse = btc - ago;
              if (Math.abs(impulse) >= params.minSpikeAbs) {
                const side = impulse > 0 ? "DOWN" : "UP";
                const ask = book.ask(side, tick);
                if (ask >= 0.05 && ask <= 0.75) {
                  orders.enter(side, { price: ask, budget: params.budget, reason: "spike_entry" });
                }
              }
            }
          }
        },
        onEventEnd() { orders.closeOpenPosition({ reason: "end" }); }
      });
      `;

      const version = createStrategyVersion(db, strategy.id, {
        language: 'strategy-js-v1',
        source_code: jsSource,
      });

      const resolved = resolveVersionForBacktest(version, { bookDepth: config.backtestBookDepth, db });

      let aggEvents = 0;
      let aggEntries = 0;
      let aggWins = 0;
      let aggLosses = 0;
      let aggGrossPnl = 0;
      let aggNetPnl = 0;
      let aggFees = 0;

      for (const dt of targetDays) {
        const from = `${dt}T00:00:00.000Z`;
        const to = `${dt}T23:59:59.999Z`;

        try {
          const rawResult = await runBacktest(db, {
            from,
            to,
            underlying: 'BTC',
            interval: '5m',
            bookDepth: config.backtestBookDepth,
            batchSize: 25000,
            fastRun: true,
            glsAst: resolved.glsAst,
            columnAnalysis: resolved.columnAnalysis,
            embeddedRunner: resolved.embeddedRunner,
            embeddedModels: resolved.embeddedModels,
            strategySourceCode: resolved.strategySourceCode,
            db,
            strategyMeta: resolved.strategyMeta,
            params: {},
          });

          const withFees = applyPolymarketFeesToBacktestResult(rawResult, { category: 'crypto', feeRate: 0.07 });
          const dayFee = Math.abs(rawResult.summary.totalPnl - withFees.summary.totalPnl);

          aggEvents += rawResult.summary?.totalEvents || 0;
          aggEntries += rawResult.summary?.totalEntries || 0;
          aggWins += rawResult.summary?.totalWins || 0;
          aggLosses += rawResult.summary?.totalLosses || 0;
          aggGrossPnl += rawResult.summary?.totalPnl || 0;
          aggNetPnl += withFees.summary?.totalPnl || 0;
          aggFees += dayFee;
        } catch {}
      }

      const winRate = aggEntries > 0 ? (aggWins / aggEntries) * 100 : 0;
      console.log(` Limiar $${String(minSpike).padEnd(4)}: Eventos=${aggEvents} | Entradas=${String(aggEntries).padEnd(5)} | WinRate=${winRate.toFixed(1)}% | Lucro Bruto=$${aggGrossPnl.toFixed(2).padEnd(8)} | Taxas=$${aggFees.toFixed(2).padEnd(7)} | Lucro Líquido=$${aggNetPnl.toFixed(2)}`);
    };

    for (const spike of [2, 3, 5, 8]) {
      await testThreshold(spike);
    }

  } catch (err) {
    console.error('Erro na varredura:', err);
  } finally {
    closeStateDatabase(db);
  }
}

main();
