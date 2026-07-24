import { createSourcePool, closeSourcePool, getTicksWithBooksForEvents } from '../src/source/postgres.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const pool = createSourcePool(config);
const partition = {
  marketId: '9586e5b0-d92a-40f4-8ca3-d2329a4d92e1',
  underlying: 'BTC',
  interval: '5m',
  dt: '2026-07-24',
};
const conditionId = '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5';
const eventEnd = Date.parse('2026-07-24T22:50:00.000Z');

try {
  const rows = await getTicksWithBooksForEvents(pool, partition, [conditionId]);
  const window = rows
    .map((r) => {
      const tsMs = new Date(r.ts).getTime();
      const secsLeft = (eventEnd - tsMs) / 1000;
      const signedDown = r.priceToBeat - r.underlyingPrice; // DOWN position
      return {
        ts: r.ts,
        secsLeft: Number(secsLeft.toFixed(3)),
        spot: r.underlyingPrice,
        ptb: r.priceToBeat,
        signedDown: Number(signedDown.toFixed(4)),
        crossed: signedDown <= 0,
        downBid: r.downBestBid,
        upAsk: r.upBestAsk,
        lateFlipEligible:
          secsLeft <= 8 &&
          secsLeft >= 4 &&
          signedDown <= 0 &&
          r.downBestBid >= 0.05 &&
          r.upBestAsk > 0 &&
          r.upBestAsk <= 0.95,
      };
    })
    .filter((r) => r.secsLeft <= 12 && r.secsLeft >= 0);

  const firstCross = window.find((r) => r.crossed);
  const firstEligible = window.find((r) => r.lateFlipEligible);
  const inLateWindow = window.filter((r) => r.secsLeft <= 8 && r.secsLeft >= 4);

  console.log(JSON.stringify({
    firstCross,
    firstEligible,
    lateWindowCount: inLateWindow.length,
    lateWindowCrossedCount: inLateWindow.filter((r) => r.crossed).length,
    lateWindowEligibleCount: inLateWindow.filter((r) => r.lateFlipEligible).length,
    lateWindowSample: inLateWindow,
  }, null, 2));
} finally {
  await closeSourcePool(pool);
}
