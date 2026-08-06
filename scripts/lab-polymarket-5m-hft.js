import { openSharedConnection } from '../src/query/duckdbPool.js';
import { loadConfig } from '../src/config.js';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

function calculatePolymarketTakerFee(price, qty = 1, feeRate = 0.07) {
  if (price <= 0 || price >= 1) return 0;
  return qty * feeRate * price * (1 - price);
}

async function runComparisonSuite() {
  console.log('================================================================');
  console.log('  SUÍTE DE ANÁLISE QUANTITATIVA COMPLETA: POLYMARKET BTC 5M     ');
  console.log('  (ESTUDO DE IMPACTO DE TAXAS, MAKER VS TAKER E KELLY COMPOUND)  ');
  console.log('================================================================\n');

  const config = loadConfig();
  const lakeRoot = config.lakeRoot;
  const btcTicksDir = path.join(lakeRoot, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');

  const dtDirs = readdirSync(btcTicksDir)
    .filter(d => d.startsWith('dt='))
    .sort()
    .slice(-15);

  const conn = await openSharedConnection();

  // Vamos testar 3 Modos de Execução:
  // Modo 1: Taker Fixo $30 (Taxa 7% Dinâmica + Slippage 0.5c)
  // Modo 2: Maker Fixo $30 (Ordens Limite Bid = 0% Taxa + sem Slippage)
  // Modo 3: Taker com Gestão de Banca Kelly Fracionado (Compounding)

  const modes = [
    { id: 'taker_fixed', name: '1. Taker Fixo $30 (Taxa 7% + Slippage)', feeModel: 'taker', sizeModel: 'fixed', initial: 1000 },
    { id: 'maker_fixed', name: '2. Maker Fixo $30 (0% Taxa / Limite)', feeModel: 'maker', sizeModel: 'fixed', initial: 1000 },
    { id: 'taker_kelly', name: '3. Taker Compound (Kelly Fracionado 15%)', feeModel: 'taker', sizeModel: 'kelly', initial: 1000 },
  ];

  const results = modes.map(m => ({
    ...m,
    capital: m.initial,
    maxCapital: m.initial,
    maxDrawdown: 0,
    totalEvents: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    totalFees: 0,
    totalSlippage: 0
  }));

  for (const dtDir of dtDirs) {
    const fullPath = path.join(btcTicksDir, dtDir);
    const files = readdirSync(fullPath).filter(f => f.endsWith('.parquet'));
    if (!files.length) continue;

    const parquetFile = path.join(fullPath, files[0]).replace(/\\/g, '/');

    const query = `
      SELECT 
        condition_id,
        epoch(TRY_CAST(ts AS TIMESTAMP)) AS ts_sec,
        epoch(TRY_CAST(event_start AS TIMESTAMP)) AS start_sec,
        epoch(TRY_CAST(event_end AS TIMESTAMP)) AS end_sec,
        underlying_price,
        price_to_beat,
        up_best_bid,
        up_best_ask,
        down_best_bid,
        down_best_ask
      FROM read_parquet('${parquetFile}')
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND price_to_beat > 1000
      ORDER BY condition_id, ts ASC
    `;

    let rows;
    try {
      const res = await conn.runAndReadAll(query);
      rows = res.getRowObjectsJS();
    } catch (err) {
      continue;
    }

    if (!rows || !rows.length) continue;

    const eventsMap = new Map();
    for (const r of rows) {
      const cid = r.condition_id;
      if (!eventsMap.has(cid)) eventsMap.set(cid, []);
      eventsMap.get(cid).push(r);
    }

    for (const [cid, ticks] of eventsMap.entries()) {
      if (ticks.length < 10) continue;

      const firstTick = ticks[0];
      const lastTick = ticks[ticks.length - 1];
      const priceToBeat = Number(firstTick.price_to_beat || firstTick.underlying_price);
      const finalPrice = Number(lastTick.underlying_price);
      const eventEndSec = Number(firstTick.end_sec || ticks[ticks.length - 1].ts_sec + 30);

      if (!priceToBeat || !finalPrice) continue;
      const isUpOutcome = finalPrice > priceToBeat;

      let priceSum = 0;
      for (const t of ticks) priceSum += Number(t.underlying_price);
      const avgPrice = priceSum / ticks.length;
      let varSum = 0;
      for (const t of ticks) varSum += Math.pow(Number(t.underlying_price) - avgPrice, 2);
      const stdDev = Math.sqrt(varSum / ticks.length) || 15.0;

      // Executar a mesma oportunidade para todos os modos simultaneamente
      let signalFound = null;

      for (const t of ticks) {
        const tsSec = Number(t.ts_sec);
        const remainingSec = Math.max(1, eventEndSec - tsSec);
        const curSpot = Number(t.underlying_price);
        const upAsk = t.up_best_ask != null ? Number(t.up_best_ask) : null;
        const downAsk = t.down_best_ask != null ? Number(t.down_best_ask) : null;

        const volPerSec = (stdDev / curSpot) / Math.sqrt(300);
        const totalVol = Math.max(0.0001, volPerSec * Math.sqrt(remainingSec));
        const zScore = (Math.log(curSpot / priceToBeat)) / totalVol;
        const pUp = normalCDF(zScore);
        const pDown = 1 - pUp;

        if (remainingSec <= 40 && remainingSec >= 5) {
          if (pUp >= 0.96 && upAsk != null && upAsk <= 0.78 && upAsk >= 0.40) {
            signalFound = { side: 'UP', rawPrice: upAsk, pWin: pUp };
            break;
          } else if (pDown >= 0.96 && downAsk != null && downAsk <= 0.78 && downAsk >= 0.40) {
            signalFound = { side: 'DOWN', rawPrice: downAsk, pWin: pDown };
            break;
          }
        }
      }

      if (signalFound) {
        const isWin = (signalFound.side === 'UP' && isUpOutcome) || (signalFound.side === 'DOWN' && !isUpOutcome);

        for (const res of results) {
          res.totalEvents++;
          let entryPrice = signalFound.rawPrice;
          let slippage = 0;
          let feeRate = 0.07;

          if (res.feeModel === 'taker') {
            slippage = 0.005;
            entryPrice = signalFound.rawPrice + slippage;
          } else {
            // Maker: executa na ordem limite sem slippage
            entryPrice = signalFound.rawPrice;
            feeRate = 0.0; // 0% maker fee
          }

          if (entryPrice >= 1.0) continue;

          let tradeNotional = 30.0;
          if (res.sizeModel === 'kelly') {
            // 15% Fractional Kelly
            const b = (1.00 - entryPrice) / entryPrice;
            const p = signalFound.pWin;
            const q = 1 - p;
            const fullKelly = (p * b - q) / b;
            const kellyFraction = Math.max(0.02, Math.min(0.15, fullKelly * 0.15));
            tradeNotional = Math.max(10, res.capital * kellyFraction);
          }

          const shares = tradeNotional / entryPrice;
          const fee = res.feeModel === 'taker' ? calculatePolymarketTakerFee(entryPrice, shares, feeRate) : 0;

          res.trades++;
          res.totalFees += fee;
          res.totalSlippage += shares * slippage;

          if (isWin) {
            res.wins++;
            const winPnl = (1.00 - entryPrice) * shares - fee;
            res.grossProfit += winPnl;
            res.capital += winPnl;
          } else {
            res.losses++;
            const lossPnl = (entryPrice * shares) + fee;
            res.grossLoss += lossPnl;
            res.capital -= lossPnl;
          }

          if (res.capital > res.maxCapital) res.maxCapital = res.capital;
          const dd = res.maxCapital > 0 ? ((res.maxCapital - res.capital) / res.maxCapital) * 100 : 0;
          if (dd > res.maxDrawdown) res.maxDrawdown = dd;
        }
      }
    }
  }

  console.log('================================================================');
  console.log('       QUADRO COMPARATIVO FINAL DE ESTRATÉGIAS POLYMARKET       ');
  console.log('================================================================\n');

  for (const res of results) {
    const netPnl = res.capital - res.initial;
    const winRate = res.trades > 0 ? (res.wins / res.trades) * 100 : 0;
    const pf = res.grossLoss > 0 ? res.grossProfit / res.grossLoss : (res.grossProfit > 0 ? 99 : 0);
    const roi = (netPnl / res.initial) * 100;

    console.log(`📌 ${res.name}:`);
    console.log(`   • Trades: ${res.trades} | Win Rate: ${winRate.toFixed(2)}% | Profit Factor: ${pf.toFixed(2)} | Max DD: ${res.maxDrawdown.toFixed(2)}%`);
    console.log(`   • Lucro Bruto: +$${res.grossProfit.toFixed(2)} | Perdas Brutas: -$${res.grossLoss.toFixed(2)}`);
    console.log(`   • Taxas Pagas: -$${res.totalFees.toFixed(2)} | Custo Slippage: -$${res.totalSlippage.toFixed(2)}`);
    console.log(`   • Capital Final: $${res.capital.toFixed(2)} USDC | Net PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} USDC (${roi >= 0 ? '+' : ''}${roi.toFixed(2)}% ROI)`);
    console.log('----------------------------------------------------------------');
  }
}

runComparisonSuite().catch(console.error);
