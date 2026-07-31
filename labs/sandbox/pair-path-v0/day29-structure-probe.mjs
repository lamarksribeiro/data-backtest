/**
 * Day-29 structural probe — NO strategy, only measurement.
 *
 * Question 1: what does an INSTANT complete set cost, after real taker fees,
 *             walking real depth? Where (price regime x tau) is it cheapest?
 * Question 2: how much size is available below break-even, if any?
 * Question 3: what is the true payoff surface of the temporal path
 *             (open favorite at p0, hedge later)?
 *
 * Fee (crypto taker): 0.07 * p * (1-p) per share.
 * A complete set pays exactly $1.00 per share at resolution.
 *
 *   node labs/sandbox/pair-path-v0/day29-structure-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);
const FEE_RATE = 0.07;
const OUT_DIR = path.join(ROOT, '.tmp/day29-structure-probe');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const DAY = arg('day', '2026-07-29');

function fee(price, shares) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return FEE_RATE * p * (1 - p) * shares;
}

function levelList(prefix, field) {
  return Array.from(
    { length: 25 },
    (_, i) => `${prefix}_ask_${field}_${i + 1}`,
  ).join(', ');
}

/** Sorted ascending ask ladder. */
function ladderOf(prices, sizes) {
  const out = [];
  for (let i = 0; i < 25; i += 1) {
    const px = prices[i];
    const sz = sizes[i];
    if (px != null && sz != null && Number(sz) > 0) {
      out.push({ px: Number(px), size: Number(sz) });
    }
  }
  out.sort((a, b) => a.px - b.px);
  return out;
}

/**
 * Greedy marginal walk: repeatedly take the next cheapest available share on
 * each side and keep going while the MARGINAL pair still clears $1 net of fee.
 * Returns the maximum profitable size and the locked profit.
 */
function arbWalk(upLadder, downLadder) {
  let ui = 0;
  let di = 0;
  let uLeft = upLadder.length ? upLadder[0].size : 0;
  let dLeft = downLadder.length ? downLadder[0].size : 0;
  let shares = 0;
  let profit = 0;
  let lastPairCost = null;
  // step in small chunks so a fat level does not overshoot
  for (let guard = 0; guard < 2000; guard += 1) {
    if (ui >= upLadder.length || di >= downLadder.length) break;
    const a = upLadder[ui].px;
    const b = downLadder[di].px;
    const marginal = a + b + FEE_RATE * a * (1 - a) + FEE_RATE * b * (1 - b);
    if (marginal >= 1) break;
    const chunk = Math.min(uLeft, dLeft);
    if (chunk <= 1e-9) break;
    shares += chunk;
    profit += (1 - marginal) * chunk;
    lastPairCost = marginal;
    uLeft -= chunk;
    dLeft -= chunk;
    if (uLeft <= 1e-9) {
      ui += 1;
      uLeft = ui < upLadder.length ? upLadder[ui].size : 0;
    }
    if (dLeft <= 1e-9) {
      di += 1;
      dLeft = di < downLadder.length ? downLadder[di].size : 0;
    }
  }
  return { shares, profit, marginalPairCost: lastPairCost };
}

function bucketTau(tau) {
  if (tau > 240) return '>240';
  if (tau > 180) return '180-240';
  if (tau > 120) return '120-180';
  if (tau > 60) return '60-120';
  if (tau > 30) return '30-60';
  if (tau > 10) return '10-30';
  return '0-10';
}

function bucketFav(p) {
  if (p >= 0.98) return '0.98+';
  if (p >= 0.95) return '0.95-0.98';
  if (p >= 0.90) return '0.90-0.95';
  if (p >= 0.85) return '0.85-0.90';
  if (p >= 0.75) return '0.75-0.85';
  if (p >= 0.65) return '0.65-0.75';
  if (p >= 0.55) return '0.55-0.65';
  return '<0.55';
}

function q(values, f) {
  const c = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!c.length) return null;
  return c[Math.min(c.length - 1, Math.max(0, Math.floor((c.length - 1) * f)))];
}

function r4(x) {
  return x == null ? null : Math.round(x * 10000) / 10000;
}

async function main() {
  const dayDir = path.join(LAKE, `dt=${DAY}`);
  const files = fs
    .readdirSync(dayDir)
    .filter((n) => n.endsWith('.parquet'))
    .map((n) => path.join(dayDir, n));
  const parquet = `[${files.map((f) => quotedString(f)).join(',')}]`;

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  const query = `
    SELECT
      epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS event_epoch,
      epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
      extract(epoch FROM (
        try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
      ))::DOUBLE AS tau,
      up_best_ask, down_best_ask,
      underlying_price, price_to_beat,
      list_value(${levelList('up', 'px')}) AS up_ask_prices,
      list_value(${levelList('up', 'sz')}) AS up_ask_sizes,
      list_value(${levelList('down', 'px')}) AS down_ask_prices,
      list_value(${levelList('down', 'sz')}) AS down_ask_sizes
    FROM read_parquet(${parquet})
    WHERE coverage >= 0.99
      AND coalesce(degraded, false) = false
      AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
      AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
    QUALIFY row_number() OVER (
      PARTITION BY event_start, ts ORDER BY coverage DESC
    ) = 1
    ORDER BY event_start, ts
  `;
  const rows = (await c.runAndReadAll(query)).getRowObjectsJS();
  console.log(`ticks=${rows.length}`);

  // ---- per-tick structural stats ----
  const cells = new Map(); // key: favBucket|tauBucket
  const arbHits = [];
  let nTicks = 0;
  let nSumBelow1 = 0;
  let nNetBelow1 = 0;
  const allSums = [];
  const allNet = [];

  // group into events for the payoff surface
  const events = new Map();

  for (const row of rows) {
    const upAsk = Number(row.up_best_ask);
    const downAsk = Number(row.down_best_ask);
    const tau = Number(row.tau);
    if (!Number.isFinite(upAsk) || !Number.isFinite(downAsk)) continue;
    nTicks += 1;
    const sum = upAsk + downAsk;
    const netTop =
      sum + FEE_RATE * upAsk * (1 - upAsk) + FEE_RATE * downAsk * (1 - downAsk);
    allSums.push(sum);
    allNet.push(netTop);
    if (sum < 1) nSumBelow1 += 1;
    if (netTop < 1) nNetBelow1 += 1;

    const fav = Math.max(upAsk, downAsk);
    const key = `${bucketFav(fav)}|${bucketTau(tau)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        favBucket: bucketFav(fav),
        tauBucket: bucketTau(tau),
        n: 0,
        sums: [],
        nets: [],
        sumBelow1: 0,
        netBelow1: 0,
        arbShares: 0,
        arbProfit: 0,
        arbTicks: 0,
      };
      cells.set(key, cell);
    }
    cell.n += 1;
    cell.sums.push(sum);
    cell.nets.push(netTop);
    if (sum < 1) cell.sumBelow1 += 1;
    if (netTop < 1) cell.netBelow1 += 1;

    // full depth arb walk only when the top of book is even close
    if (sum < 1.005) {
      const upL = ladderOf(row.up_ask_prices, row.up_ask_sizes);
      const dnL = ladderOf(row.down_ask_prices, row.down_ask_sizes);
      const w = arbWalk(upL, dnL);
      if (w.shares > 1e-9) {
        cell.arbTicks += 1;
        cell.arbShares += w.shares;
        cell.arbProfit += w.profit;
        arbHits.push({
          eventEpoch: String(row.event_epoch),
          tsEpoch: Number(row.ts_epoch),
          tau: r4(tau),
          upAsk,
          downAsk,
          sum: r4(sum),
          netTop: r4(netTop),
          shares: r4(w.shares),
          profit: r4(w.profit),
          marginalPairCost: r4(w.marginalPairCost),
          favBucket: bucketFav(fav),
          tauBucket: bucketTau(tau),
        });
      }
    }

    const ek = String(row.event_epoch);
    let ev = events.get(ek);
    if (!ev) {
      ev = [];
      events.set(ek, ev);
    }
    ev.push({
      tau,
      tsMs: Number(row.ts_epoch) * 1000,
      upAsk,
      downAsk,
      underlyingPrice: Number(row.underlying_price),
      priceToBeat: Number(row.price_to_beat),
    });
  }

  const cellRows = [...cells.values()]
    .map((cell) => ({
      favBucket: cell.favBucket,
      tauBucket: cell.tauBucket,
      n: cell.n,
      sumP01: r4(q(cell.sums, 0.01)),
      sumP05: r4(q(cell.sums, 0.05)),
      sumP50: r4(q(cell.sums, 0.5)),
      netP01: r4(q(cell.nets, 0.01)),
      netP05: r4(q(cell.nets, 0.05)),
      netP50: r4(q(cell.nets, 0.5)),
      sumBelow1Pct: r4((cell.sumBelow1 / cell.n) * 100),
      netBelow1Pct: r4((cell.netBelow1 / cell.n) * 100),
      arbTicks: cell.arbTicks,
      arbShares: r4(cell.arbShares),
      arbProfit: r4(cell.arbProfit),
    }))
    .sort(
      (a, b) => b.netBelow1Pct - a.netBelow1Pct || b.arbProfit - a.arbProfit,
    );

  // ---- payoff surface of the temporal path ----
  // For every tick where the favourite ask sits in [0.52,0.62] (the legacy open
  // window) AND for a set of alternative windows, measure what happened next.
  const openWindows = [
    ['0.52-0.62', 0.52, 0.62],
    ['0.62-0.72', 0.62, 0.72],
    ['0.72-0.82', 0.72, 0.82],
    ['0.82-0.90', 0.82, 0.9],
    ['0.90-0.96', 0.9, 0.96],
  ];
  const surface = [];
  for (const [label, lo, hi] of openWindows) {
    for (const tauBand of [
      ['200-260', 200, 260],
      ['120-200', 120, 200],
      ['60-120', 60, 120],
      ['20-60', 20, 60],
    ]) {
      const samples = [];
      for (const ticks of events.values()) {
        const last = ticks[ticks.length - 1];
        const spotWinner =
          last.underlyingPrice > last.priceToBeat
            ? 'UP'
            : last.underlyingPrice < last.priceToBeat
              ? 'DOWN'
              : null;
        const bookWinner =
          last.upAsk > last.downAsk
            ? 'UP'
            : last.downAsk > last.upAsk
              ? 'DOWN'
              : null;
        const winner = spotWinner && spotWinner === bookWinner ? spotWinner : null;
        if (!winner) continue;
        // first qualifying tick in this band (one sample per event)
        for (let i = 0; i < ticks.length; i += 1) {
          const t = ticks[i];
          if (t.tau < tauBand[1] || t.tau > tauBand[2]) continue;
          const side = t.upAsk >= t.downAsk ? 'UP' : 'DOWN';
          const ask = side === 'UP' ? t.upAsk : t.downAsk;
          if (ask < lo || ask > hi) continue;
          // forward: best (cheapest) opposite ask reachable afterwards
          let bestOpp = Infinity;
          let bestOppTau = null;
          const oppKey = side === 'UP' ? 'downAsk' : 'upAsk';
          for (let j = i + 1; j < ticks.length; j += 1) {
            if (ticks[j][oppKey] < bestOpp) {
              bestOpp = ticks[j][oppKey];
              bestOppTau = ticks[j].tau;
            }
          }
          samples.push({
            openAsk: ask,
            side,
            won: side === winner,
            bestOpp: Number.isFinite(bestOpp) ? bestOpp : null,
            bestOppTau,
            bestNet: Number.isFinite(bestOpp)
              ? ask +
                bestOpp +
                FEE_RATE * ask * (1 - ask) +
                FEE_RATE * bestOpp * (1 - bestOpp)
              : null,
          });
          break;
        }
      }
      if (!samples.length) continue;
      const nets = samples.map((s) => s.bestNet).filter(Number.isFinite);
      surface.push({
        openWindow: label,
        tauBand: tauBand[0],
        n: samples.length,
        winRatePct: r4(
          (samples.filter((s) => s.won).length / samples.length) * 100,
        ),
        openAskP50: r4(q(samples.map((s) => s.openAsk), 0.5)),
        // "bestNet" = the most favourable complete-set cost achievable with
        // perfect hindsight on the hedge timing. An upper bound on the path.
        bestNetP05: r4(q(nets, 0.05)),
        bestNetP25: r4(q(nets, 0.25)),
        bestNetP50: r4(q(nets, 0.5)),
        bestNetP75: r4(q(nets, 0.75)),
        pctBestNetBelow1: r4(
          (nets.filter((x) => x < 1).length / nets.length) * 100,
        ),
        // EV of just holding the open leg to resolution, net of entry fee
        holdEvPerShare: r4(
          samples.reduce(
            (acc, s) =>
              acc +
              ((s.won ? 1 : 0) - s.openAsk - FEE_RATE * s.openAsk * (1 - s.openAsk)),
            0,
          ) / samples.length,
        ),
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    day: DAY,
    ticks: nTicks,
    events: events.size,
    feeRate: FEE_RATE,
    global: {
      sumP001: r4(q(allSums, 0.001)),
      sumP01: r4(q(allSums, 0.01)),
      sumP50: r4(q(allSums, 0.5)),
      netP001: r4(q(allNet, 0.001)),
      netP01: r4(q(allNet, 0.01)),
      netP50: r4(q(allNet, 0.5)),
      sumBelow1Pct: r4((nSumBelow1 / nTicks) * 100),
      netBelow1Pct: r4((nNetBelow1 / nTicks) * 100),
    },
    arb: {
      ticksWithProfitableSize: arbHits.length,
      totalShares: r4(arbHits.reduce((a, h) => a + h.shares, 0)),
      totalProfit: r4(arbHits.reduce((a, h) => a + h.profit, 0)),
      byFavBucket: Object.fromEntries(
        [...new Set(arbHits.map((h) => h.favBucket))].map((b) => [
          b,
          {
            ticks: arbHits.filter((h) => h.favBucket === b).length,
            shares: r4(
              arbHits
                .filter((h) => h.favBucket === b)
                .reduce((a, h) => a + h.shares, 0),
            ),
            profit: r4(
              arbHits
                .filter((h) => h.favBucket === b)
                .reduce((a, h) => a + h.profit, 0),
            ),
          },
        ]),
      ),
      top50: arbHits.sort((a, b) => b.profit - a.profit).slice(0, 50),
    },
    cells: cellRows,
    temporalPayoffSurface: surface,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  console.log('');
  console.log('=== GLOBAL ask-sum structure ===');
  console.log(JSON.stringify(report.global, null, 2));
  console.log('');
  console.log('=== INSTANT complete-set arb (depth walk, net of taker fee) ===');
  console.log(
    `ticks with profitable size: ${report.arb.ticksWithProfitableSize}` +
      ` / ${nTicks}  shares=${report.arb.totalShares}` +
      `  profit=$${report.arb.totalProfit}`,
  );
  console.log(JSON.stringify(report.arb.byFavBucket, null, 2));
  console.log('');
  console.log('=== cheapest cells (netP01 / % below 1) ===');
  console.log(
    'favBucket'.padEnd(12),
    'tau'.padEnd(9),
    'n'.padEnd(7),
    'sumP01'.padEnd(8),
    'netP01'.padEnd(8),
    'netP50'.padEnd(8),
    'sum<1%'.padEnd(8),
    'net<1%'.padEnd(8),
    'arbTk'.padEnd(7),
    'arbProfit',
  );
  for (const cell of cellRows.slice(0, 30)) {
    console.log(
      cell.favBucket.padEnd(12),
      cell.tauBucket.padEnd(9),
      String(cell.n).padEnd(7),
      String(cell.sumP01).padEnd(8),
      String(cell.netP01).padEnd(8),
      String(cell.netP50).padEnd(8),
      String(cell.sumBelow1Pct).padEnd(8),
      String(cell.netBelow1Pct).padEnd(8),
      String(cell.arbTicks).padEnd(7),
      String(cell.arbProfit),
    );
  }
  console.log('');
  console.log('=== temporal path payoff surface (perfect-hindsight hedge) ===');
  console.log(
    'openWin'.padEnd(12),
    'tau'.padEnd(9),
    'n'.padEnd(6),
    'win%'.padEnd(7),
    'bestNetP05'.padEnd(11),
    'bestNetP50'.padEnd(11),
    '%net<1'.padEnd(8),
    'holdEV/sh',
  );
  for (const s of surface) {
    console.log(
      s.openWindow.padEnd(12),
      s.tauBand.padEnd(9),
      String(s.n).padEnd(6),
      String(s.winRatePct).padEnd(7),
      String(s.bestNetP05).padEnd(11),
      String(s.bestNetP50).padEnd(11),
      String(s.pctBestNetBelow1).padEnd(8),
      String(s.holdEvPerShare),
    );
  }
  console.log('');
  console.log('saved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
