import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function main() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens });
  const client = await pool.connect();

  try {
    const FROM_TS = '2026-05-04T15:00:00.000Z';
    console.log("=== INSTANT JS AGGREGATOR FOR RANGE ===");

    let totalTicks = 0;
    const events = new Set();
    let minTs = null;
    let maxTs = null;

    let upAskValid = 0;
    let downAskValid = 0;
    let upBidValid = 0;
    let downBidValid = 0;
    let bothAsksValid = 0;
    let bothBidsValid = 0;

    let sumAskLt100 = 0;
    let sumAskLt099 = 0;
    let sumAskLt098 = 0;
    let sumAskLt097 = 0;
    let sumAskLt096 = 0;
    let sumAskLt095 = 0;
    let sumAskLt092 = 0;
    let sumAskLt090 = 0;

    let sumBidGt100 = 0;

    const askSums = [];
    const dailyStats = new Map();

    const minIdRow = await client.query(`SELECT id, ts FROM ticks WHERE ts >= $1 ORDER BY ts ASC LIMIT 1`, [FROM_TS]);
    const minId = minIdRow.rows[0].id;
    const maxIdRow = await client.query(`SELECT id, ts FROM ticks ORDER BY id DESC LIMIT 1`);
    const maxId = maxIdRow.rows[0].id;

    console.log(`Scanning ticks from ID ${minId} to ${maxId}...`);

    const batchSize = 50000;
    let currentId = minId;

    while (currentId <= maxId) {
      const nextId = currentId + batchSize;
      const res = await client.query(`
        SELECT 
          event_start, ts, up_best_bid, up_best_ask, down_best_bid, down_best_ask
        FROM ticks
        WHERE id >= $1 AND id < $2
      `, [currentId, nextId]);

      for (const row of res.rows) {
        totalTicks++;
        const evt = row.event_start ? row.event_start.toISOString() : 'null';
        events.add(evt);

        const tsStr = row.ts.toISOString();
        if (!minTs || tsStr < minTs) minTs = tsStr;
        if (!maxTs || tsStr > maxTs) maxTs = tsStr;

        const dayKey = tsStr.slice(0, 10);
        if (!dailyStats.has(dayKey)) dailyStats.set(dayKey, { ticks: 0, events: new Set() });
        const dStat = dailyStats.get(dayKey);
        dStat.ticks++;
        dStat.events.add(evt);

        const upAsk = row.up_best_ask ?? 0;
        const downAsk = row.down_best_ask ?? 0;
        const upBid = row.up_best_bid ?? 0;
        const downBid = row.down_best_bid ?? 0;

        if (upAsk > 0) upAskValid++;
        if (downAsk > 0) downAskValid++;
        if (upBid > 0) upBidValid++;
        if (downBid > 0) downBidValid++;
        if (upAsk > 0 && downAsk > 0) bothAsksValid++;
        if (upBid > 0 && downBid > 0) bothBidsValid++;

        if (upAsk > 0 && downAsk > 0) {
          const sumAsk = upAsk + downAsk;
          if (totalTicks % 100 === 0) askSums.push(sumAsk);

          if (sumAsk < 1.00) sumAskLt100++;
          if (sumAsk < 0.99) sumAskLt099++;
          if (sumAsk < 0.98) sumAskLt098++;
          if (sumAsk < 0.97) sumAskLt097++;
          if (sumAsk < 0.96) sumAskLt096++;
          if (sumAsk < 0.95) sumAskLt095++;
          if (sumAsk < 0.92) sumAskLt092++;
          if (sumAsk < 0.90) sumAskLt090++;
        }

        if (upBid > 0 && downBid > 0) {
          const sumBid = upBid + downBid;
          if (sumBid > 1.00) sumBidGt100++;
        }
      }

      currentId = nextId;
    }

    askSums.sort((a, b) => a - b);
    const p01 = askSums[Math.floor(askSums.length * 0.01)] || 0;
    const p05 = askSums[Math.floor(askSums.length * 0.05)] || 0;
    const p10 = askSums[Math.floor(askSums.length * 0.10)] || 0;
    const p50 = askSums[Math.floor(askSums.length * 0.50)] || 0;
    const p90 = askSums[Math.floor(askSums.length * 0.90)] || 0;
    const avgSumAsk = askSums.reduce((a, b) => a + b, 0) / (askSums.length || 1);

    console.log("\n--- RESULTADOS FINAIS ---");
    console.log(`1. Total Ticks: ${totalTicks}`);
    console.log(`2. Total Eventos: ${events.size}`);
    console.log(`3. Primeiro TS: ${minTs}`);
    console.log(`   Último TS: ${maxTs}`);
    
    console.log("\n4. Cobertura Diária:");
    const dailyArray = Array.from(dailyStats.entries()).map(([dia, stat]) => ({
      dia,
      ticks: stat.ticks,
      eventos: stat.events.size
    })).sort((a, b) => a.dia.localeCompare(b.dia));
    console.table(dailyArray);

    console.log("\n6, 7, 8. Cobertura de Books & Bids/Asks:");
    console.log({
      totalTicks,
      upAskValid,
      downAskValid,
      upBidValid,
      downBidValid,
      bothAsksValid,
      bothBidsValid,
      pctBothAsksValid: ((bothAsksValid / totalTicks) * 100).toFixed(2) + '%'
    });

    console.log("\n9, 10, 11, 12. Distribuição da Soma Ask & Mispricing:");
    console.log({
      avgSumAsk: avgSumAsk.toFixed(4),
      p01: p01.toFixed(4),
      p05: p05.toFixed(4),
      p10: p10.toFixed(4),
      p50: p50.toFixed(4),
      p90: p90.toFixed(4),
      sumAskLt100: `${sumAskLt100} (${((sumAskLt100/bothAsksValid)*100).toFixed(2)}%)`,
      sumAskLt099: `${sumAskLt099} (${((sumAskLt099/bothAsksValid)*100).toFixed(2)}%)`,
      sumAskLt098: `${sumAskLt098} (${((sumAskLt098/bothAsksValid)*100).toFixed(2)}%)`,
      sumAskLt097: `${sumAskLt097} (${((sumAskLt097/bothAsksValid)*100).toFixed(2)}%)`,
      sumAskLt096: `${sumAskLt096} (${((sumAskLt096/bothAsksValid)*100).toFixed(2)}%)`,
      sumAskLt095: `${sumAskLt095} (${((sumAskLt095/bothAsksValid)*100).toFixed(2)}%)`,
      sumAskLt092: `${sumAskLt092} (${((sumAskLt092/bothAsksValid)*100).toFixed(2)}%)`,
      sumAskLt090: `${sumAskLt090} (${((sumAskLt090/bothAsksValid)*100).toFixed(2)}%)`,
      sumBidGt100: `${sumBidGt100}`
    });

  } catch (err) {
    console.error("Error:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
