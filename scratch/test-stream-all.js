import { getTicksForBacktestBatches } from '../src/database.js';

async function testAll() {
  let count = 0;
  let batchCount = 0;
  for await (const batch of getTicksForBacktestBatches('2026-05-04T15:00:00.000Z', null, 50000)) {
    batchCount++;
    count += batch.length;
    if (batchCount % 10 === 0) {
      console.log(`Batches: ${batchCount}, Ticks: ${count}, Current TS: ${batch[batch.length - 1].ts}`);
    }
  }
  console.log(`TOTAL STREAMED: ${count} ticks in ${batchCount} batches.`);
}

testAll().catch(console.error);
