import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { loadBacktestColumnSetFromDuckdb } from '../src/query/columnChunkReader.js';

async function analyzeRealBtcSpikes() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    const dt = '2026-06-01';
    console.log(`Analyzing real Lake partition for ${dt}...`);
    const columnSet = await loadBacktestColumnSetFromDuckdb(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      from: `${dt}T00:00:00.000Z`,
      to: `${dt}T23:59:59.999Z`,
      bookDepth: 25,
    });

    const total = columnSet.length;
    console.log(`Total ticks in ${dt}: ${total}`);

    const btcPrices = columnSet.columns.get('underlying_price');
    const timestamps = columnSet.columns.get('_ts_ms');

    if (!btcPrices || !timestamps) {
      console.error('Columns not found!');
      return;
    }

    console.log('First 5 BTC prices:', Array.from(btcPrices.subarray(0, 5)));

    let max5sMove = 0;
    let max15sMove = 0;
    let max30sMove = 0;

    let count5sAbove0_10 = 0;
    let count5sAbove0_50 = 0;
    let count5sAbove1_00 = 0;
    let count5sAbove2_00 = 0;

    let count15sAbove0_50 = 0;
    let count15sAbove1_00 = 0;
    let count15sAbove2_00 = 0;

    for (let i = 10; i < total; i++) {
      const currentBtc = btcPrices[i];
      const currentTs = timestamps[i];

      let btc5s = currentBtc;
      let btc15s = currentBtc;
      let btc30s = currentBtc;

      for (let j = i - 1; j >= Math.max(0, i - 100); j--) {
        const dtSec = (currentTs - timestamps[j]) / 1000;
        if (dtSec >= 5 && btc5s === currentBtc) btc5s = btcPrices[j];
        if (dtSec >= 15 && btc15s === currentBtc) btc15s = btcPrices[j];
        if (dtSec >= 30) {
          btc30s = btcPrices[j];
          break;
        }
      }

      const diff5s = Math.abs(currentBtc - btc5s);
      const diff15s = Math.abs(currentBtc - btc15s);
      const diff30s = Math.abs(currentBtc - btc30s);

      if (diff5s > max5sMove) max5sMove = diff5s;
      if (diff15s > max15sMove) max15sMove = diff15s;
      if (diff30s > max30sMove) max30sMove = diff30s;

      if (diff5s >= 0.10) count5sAbove0_10++;
      if (diff5s >= 0.50) count5sAbove0_50++;
      if (diff5s >= 1.00) count5sAbove1_00++;
      if (diff5s >= 2.00) count5sAbove2_00++;

      if (diff15s >= 0.50) count15sAbove0_50++;
      if (diff15s >= 1.00) count15sAbove1_00++;
      if (diff15s >= 2.00) count15sAbove2_00++;
    }

    console.log('\n--- ESTATÍSTICAS REAIS DE VARIAÇÃO DE PREÇO DO BTC NO LAKE ---');
    console.log(`Maior variação em 5s : USD $${max5sMove.toFixed(4)}`);
    console.log(`Maior variação em 15s: USD $${max15sMove.toFixed(4)}`);
    console.log(`Maior variação em 30s: USD $${max30sMove.toFixed(4)}`);

    console.log(`\nOcorrências em 1 Dia (${total} Ticks):`);
    console.log(`Em 5s  >= $0.10 : ${count5sAbove0_10} ticks`);
    console.log(`Em 5s  >= $0.50 : ${count5sAbove0_50} ticks`);
    console.log(`Em 5s  >= $1.00 : ${count5sAbove1_00} ticks`);
    console.log(`Em 5s  >= $2.00 : ${count5sAbove2_00} ticks`);

    console.log(`Em 15s >= $0.50 : ${count15sAbove0_50} ticks`);
    console.log(`Em 15s >= $1.00 : ${count15sAbove1_00} ticks`);
    console.log(`Em 15s >= $2.00 : ${count15sAbove2_00} ticks`);

  } catch (err) {
    console.error(err);
  } finally {
    closeStateDatabase(db);
  }
}

analyzeRealBtcSpikes();
