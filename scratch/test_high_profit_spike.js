import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { loadBacktestColumnSetFromDuckdb } from '../src/query/columnChunkReader.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';

async function testHighProfitStrategy() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const dt = '2026-06-01';
    console.log(`Carregando ticks reais de 1 dia completo (${dt})...`);

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
    console.log(`Total Ticks no dia: ${total}`);

    const runSim = ({
      minDistancePtb = 25,     // Distância mínima do PTB para garantir lado dominante
      impulseSec = 5,          // Janela de variação do BTC
      minDipAbs = 3.0,         // Queda/subida abrupta do BTC contra a tendência
      maxAsk = 0.65,           // Preço máximo de entrada (garante compra com desconto)
      minAsk = 0.20,           // Preço mínimo de entrada
      maxSpread = 0.04,        // Spread máximo do livro
      takeProfitBid = 0.78,    // Alvo de realização total no Bid
      takeProfitPct = 0.18,    // Meta de ganho relativo (+18%)
      stopLossBid = 0.35,      // Stop Loss bid floor
      stopLossPct = 0.20,      // Stop Loss relativo (-20%)
      maxHoldSec = 30,         // Tempo máximo de retenção do scalp
      budget = 15,
      walletSize = 100,
    }) => {
      let totalPnl = 0;
      let entriesCount = 0;
      let wins = 0;
      let losses = 0;
      let tradesList = [];

      let samples = [];
      let activePosition = null;
      let lastExitTimeMs = 0;

      for (let i = 0; i < total; i++) {
        const tsMs = timestamps[i];
        const btc = btcPrices[i];
        const ptb = ptbs[i];
        const upAsk = upAsks[i];
        const downAsk = downAsks[i];
        const upBid = upBids[i];
        const downBid = downBids[i];

        samples.push({ tsMs, btc });
        if (samples.length > 500) samples.shift();

        // 1. Process position if open
        if (activePosition) {
          const side = activePosition.side;
          const bid = side === 'UP' ? upBid : downBid;
          const holdSec = (tsMs - activePosition.entryTsMs) / 1000;

          let exitReason = null;
          let exitPrice = bid;

          if (bid >= takeProfitBid) {
            exitReason = 'tp_target_bid';
          } else if (bid >= activePosition.entryPrice * (1 + takeProfitPct)) {
            exitReason = 'tp_pct_gain';
          } else if (bid <= stopLossBid) {
            exitReason = 'sl_bid_floor';
          } else if (bid <= activePosition.entryPrice * (1 - stopLossPct)) {
            exitReason = 'sl_pct_loss';
          } else if (holdSec >= maxHoldSec) {
            exitReason = 'max_hold_timeout';
          }

          if (exitReason) {
            const qty = activePosition.qty;
            const cost = activePosition.cost;
            const proceeds = qty * exitPrice;
            const pnl = proceeds - cost;

            totalPnl += pnl;
            if (pnl > 0) wins++;
            else if (pnl < 0) losses++;

            tradesList.push({ pnl, reason: exitReason, holdSec, cost, proceeds });
            activePosition = null;
            lastExitTimeMs = tsMs;
          }
        } else {
          // 2. Check entry signals
          if (tsMs - lastExitTimeMs < 8000) continue; // 8s cooldown

          // Calculate BTC impulse in last 5s
          const targetMs = tsMs - impulseSec * 1000;
          let pastBtc = btc;
          for (let k = samples.length - 1; k >= 0; k--) {
            if (samples[k].tsMs <= targetMs) {
              pastBtc = samples[k].btc;
              break;
            }
          }
          const deltaBtc = btc - pastBtc;

          const distPtb = btc - ptb;
          const absDist = Math.abs(distPtb);

          if (absDist < minDistancePtb) continue; // Precisa estar em tendência clara em relação ao PTB

          let targetSide = null;
          let ask = null;
          let bid = null;

          // Se BTC > PTB + 25 (Lado dominante = UP) e o BTC sofreu uma queda abrupta (deltaBtc <= -minDipAbs)
          if (distPtb > minDistancePtb && deltaBtc <= -minDipAbs) {
            targetSide = 'UP';
            ask = upAsk;
            bid = upBid;
          }
          // Se BTC < PTB - 25 (Lado dominante = DOWN) e o BTC sofreu uma subida abrupta (deltaBtc >= +minDipAbs)
          else if (distPtb < -minDistancePtb && deltaBtc >= minDipAbs) {
            targetSide = 'DOWN';
            ask = downAsk;
            bid = downBid;
          }

          if (!targetSide || ask == null || bid == null) continue;
          if (ask < minAsk || ask > maxAsk) continue;
          if (ask - bid > maxSpread) continue;

          const qty = Math.floor(budget / ask);
          if (qty < 5) continue;

          const cost = qty * ask;
          activePosition = {
            side: targetSide,
            qty,
            cost,
            entryPrice: ask,
            entryTsMs: tsMs,
          };
          entriesCount++;
        }
      }

      const winRate = entriesCount > 0 ? (wins / entriesCount) * 100 : 0;
      return { entriesCount, wins, losses, winRate, totalPnl };
    };

    console.log('------------------------------------------------------------------------------------------------------');
    console.log(' DIST PTB | MIN DIP | MAX ASK | MAX HOLD | TRADES | WIN RATE | LUCRO BRUTO (1 DIA REAL)');
    console.log('------------------------------------------------------------------------------------------------------');

    for (const dist of [15, 25, 35, 50]) {
      for (const dip of [2.0, 3.0, 5.0]) {
        for (const askCap of [0.55, 0.65, 0.72]) {
          const res = runSim({ minDistancePtb: dist, minDipAbs: dip, maxAsk: askCap, maxHoldSec: 25 });
          if (res.entriesCount > 5) {
            console.log(
              ` $${String(dist).padEnd(8)} | $${dip.toFixed(1).padEnd(6)} | ${askCap.toFixed(2).padEnd(7)} | 25s      | ${String(res.entriesCount).padEnd(6)} | ${res.winRate.toFixed(1).padEnd(5)}%   | $${res.totalPnl.toFixed(2)}`
            );
          }
        }
      }
    }
    console.log('------------------------------------------------------------------------------------------------------\n');

  } catch (err) {
    console.error(err);
  } finally {
    closeStateDatabase(db);
  }
}

testHighProfitStrategy();
