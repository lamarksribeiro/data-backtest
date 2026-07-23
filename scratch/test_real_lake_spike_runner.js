import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createAbruptSpikeScalperRunner } from '../src/strategies/abruptSpikeScalper.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { loadBacktestColumnSetFromDuckdb } from '../src/query/columnChunkReader.js';

async function testExitsOnRealLake() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const dt = '2026-06-01';
    console.log(`Testando saídas rápidas (Scalp sem levar até expiração) em ${dt}...`);

    const columnSet = await loadBacktestColumnSetFromDuckdb(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      from: `${dt}T00:00:00.000Z`,
      to: `${dt}T23:59:59.999Z`,
      bookDepth: 25,
    });

    const btcPrices = columnSet.columns.get('underlying_price');
    const timestamps = columnSet.columns.get('_ts_ms');
    const upAsks = columnSet.columns.get('up_best_ask');
    const downAsks = columnSet.columns.get('down_best_ask');
    const upBids = columnSet.columns.get('up_best_bid');
    const downBids = columnSet.columns.get('down_best_bid');
    const ptbs = columnSet.columns.get('price_to_beat');

    const total = columnSet.length;

    for (const holdSec of [5, 10, 15, 20]) {
      const runner = createAbruptSpikeScalperRunner({
        minSpikeAbs: 5.0,
        strategyMode: 'fade',
        impulseSec: 5,
        cooldownSec: 8,
        takeProfitPct: 0.10,
        partialTakeProfitPct: 0.50,
        takeProfitBid: 0.70,
        stopLossPct: 0.10,
        maxHoldTimeSec: holdSec, // Force exit after X seconds so position is NEVER held to binary expiration
        walletSize: 100,
        maxOrderValue: 15,
        entryWindowStart: 250,
        entryWindowEnd: 30, // Don't enter near expiry
      });

      let currentCond = null;
      let eventStartMs = null;
      let eventEndMs = null;

      for (let i = 0; i < total; i++) {
        const condCode = columnSet.codes.get('condition_id')[i];
        const condStr = columnSet.dictionaries.get('condition_id')[condCode];
        const tsMs = timestamps[i];

        if (condStr !== currentCond) {
          currentCond = condStr;
          eventStartMs = columnSet.columns.get('_event_start_ms')[i];
          eventEndMs = columnSet.columns.get('_event_end_ms')[i];
        }

        const tick = {
          condition_id: condStr,
          event_start: new Date(eventStartMs).toISOString(),
          event_end: new Date(eventEndMs).toISOString(),
          ts: new Date(tsMs).toISOString(),
          btc_price: btcPrices[i],
          price_to_beat: ptbs[i],
          up_best_ask: upAsks[i],
          down_best_ask: downAsks[i],
          up_best_bid: upBids[i],
          down_best_bid: downBids[i],
        };

        runner.processTick(tick);
      }

      const raw = runner.finish();
      const withFees = applyPolymarketFeesToBacktestResult(raw, { category: 'crypto', feeRate: 0.07 });

      let exitsMade = 0;
      let profitExits = 0;

      for (const ev of raw.events) {
        for (const ex of ev.exits || []) {
          exitsMade++;
          if (ex.pnl > 0) profitExits++;
        }
      }

      const winRate = exitsMade > 0 ? (profitExits / exitsMade) * 100 : 0;

      console.log(`\n--- RESULTADO COM MAX HOLD TIME = ${holdSec}s (Sem levar a expiração) ---`);
      console.log('Total Operações de Saída Executadas:', exitsMade);
      console.log('Saídas com Lucro                  :', profitExits);
      console.log('Taxa de Acerto nas Saídas (Scalp) :', winRate.toFixed(1), '%');
      console.log('Lucro Bruto (Sem Taxas)           : $', raw.summary.totalPnl.toFixed(2));
      console.log('Lucro Líquido (Com Taxas 7%)      : $', withFees.summary?.totalPnl?.toFixed(2) ?? 'N/A');
    }

  } catch (err) {
    console.error(err);
  } finally {
    closeStateDatabase(db);
  }
}

testExitsOnRealLake();
