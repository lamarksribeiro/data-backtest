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

const targets = [
  { slug: 'win', id: '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533', fillTs: 1784931570804 },
  { slug: 'loss', id: '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5', fillTs: 1784933384632 },
];

try {
  for (const t of targets) {
    const rows = await getTicksWithBooksForEvents(pool, partition, [t.id]);
    const spots = rows.map((r) => r.underlyingPrice).filter((x) => x != null);
    const uniq = [...new Set(spots.map((x) => Number(x).toFixed(2)))];
    const around = rows
      .map((r) => ({
        ts: r.ts,
        tsMs: new Date(r.ts).getTime(),
        spot: r.underlyingPrice,
        ptb: r.priceToBeat,
        dist: r.underlyingPrice != null && r.priceToBeat != null ? r.underlyingPrice - r.priceToBeat : null,
        upAsk: r.upBestAsk,
        downAsk: r.downBestAsk,
        upBid: r.upBestBid,
        downBid: r.downBestBid,
      }))
      .filter((r) => Math.abs(r.tsMs - t.fillTs) <= 8000)
      .sort((a, b) => a.tsMs - b.tsMs);
    console.log(JSON.stringify({
      slug: t.slug,
      ticks: rows.length,
      uniqueSpots: uniq.slice(0, 10),
      spotMin: Math.min(...spots),
      spotMax: Math.max(...spots),
      aroundLiveFill: around,
    }, null, 2));
  }
} finally {
  await closeSourcePool(pool);
}
