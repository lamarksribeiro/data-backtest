/**
 * Calibration probe — the decisive measurement.
 *
 * Every path strategy in this repo (Pair-Path, Clip-Path, Shotandgo) reduces to
 * "buy a leg, exit later". Buying the opposite leg at ask q is economically
 * identical to selling your leg at the synthetic bid (1 - q). Under a martingale
 * price process NO exit rule creates edge: EV is fixed at entry.
 *
 * So the only question that matters is: is the ask a fair probability?
 *
 *   EV_hold(per share) = P(win | ask=a) - a - 0.07*a*(1-a)
 *
 * If P(win | a) - a > fee(a) anywhere, an edge exists there and nowhere else.
 *
 * Clustering: ticks inside an event are ~perfectly autocorrelated, so all
 * confidence intervals are bootstrapped over EVENTS (and reported over DAYS),
 * never over ticks.
 *
 *   node labs/sandbox/pair-path-v0/calibration-probe.mjs
 *   node labs/sandbox/pair-path-v0/calibration-probe.mjs --from=2026-07-29 --to=2026-07-29
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

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-30');
const TAG = arg('tag', 'all');
const OUT_DIR = path.join(ROOT, `.tmp/calibration-probe-${TAG}`);

// snapshot taus (seconds before event end)
const TAUS = [240, 180, 120, 90, 60, 45, 30, 20, 10];

function fee(p) {
  const x = Math.min(0.99, Math.max(0.01, p));
  return FEE_RATE * x * (1 - x);
}
function r4(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000;
}
function r2(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
}

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
}

/** Wilson score interval for a binomial proportion. */
function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

/**
 * Bootstrap the mean of `values` resampling whole CLUSTERS (events/days).
 * Returns [lo, hi] of the 95% percentile interval.
 */
function clusterBootstrap(clusters, iterations = 2000) {
  const keys = [...clusters.keys()];
  if (keys.length < 2) return [null, null];
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const arr = clusters.get(keys[(Math.random() * keys.length) | 0]);
      for (let j = 0; j < arr.length; j += 1) {
        sum += arr[j];
        count += 1;
      }
    }
    if (count) means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return [
    means[Math.floor(means.length * 0.025)],
    means[Math.floor(means.length * 0.975)],
  ];
}

function priceBucket(p) {
  // 2.5c buckets from 0.50 to 1.00
  if (p < 0.5) return null;
  const b = Math.floor((p - 0.5) / 0.025);
  const lo = 0.5 + b * 0.025;
  return `${lo.toFixed(3)}-${(lo + 0.025).toFixed(3)}`;
}

async function main() {
  const days = listDays();
  if (!days.length) throw new Error(`no lake days in ${FROM}..${TO}`);
  console.log(`=== calibration probe === days=${days.length} ${FROM}..${TO}`);

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  /** @type {Array<object>} */
  const snaps = [];
  let nEvents = 0;
  let nEventsAmbiguous = 0;
  let nEventsShortTail = 0;

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    const dayDir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dayDir)
      .filter((n) => n.endsWith('.parquet'))
      .map((n) => path.join(dayDir, n));
    if (!files.length) continue;
    const parquet = `[${files.map((f) => quotedString(f)).join(',')}]`;

    const query = `
      WITH d AS (
        SELECT
          condition_id,
          epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS ev,
          epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
          extract(epoch FROM (
            try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
          ))::DOUBLE AS tau,
          up_best_bid, up_best_ask, down_best_bid, down_best_ask,
          underlying_price, price_to_beat
        FROM read_parquet(${parquet})
        WHERE coverage >= 0.99
          AND coalesce(degraded, false) = false
          AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
          AND up_best_bid IS NOT NULL AND down_best_bid IS NOT NULL
          AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
        QUALIFY row_number() OVER (
          PARTITION BY condition_id, event_start, ts ORDER BY coverage DESC
        ) = 1
      ),
      evagg AS (
        SELECT condition_id, ev,
               min(tau) AS min_tau, max(tau) AS max_tau, count(*) AS n_ticks
        FROM d GROUP BY condition_id, ev
      ),
      lastrow AS (
        SELECT condition_id, ev, tau AS last_tau,
               underlying_price AS last_spot, price_to_beat AS last_ptb,
               up_best_ask AS last_up_ask, down_best_ask AS last_down_ask
        FROM d
        QUALIFY row_number() OVER (
          PARTITION BY condition_id, ev ORDER BY tau ASC
        ) = 1
      ),
      snap AS (
        SELECT d.*, t.target
        FROM d
        CROSS JOIN (SELECT unnest([${TAUS.join(',')}])::DOUBLE AS target) t
        WHERE abs(d.tau - t.target) <= 6
        QUALIFY row_number() OVER (
          PARTITION BY d.condition_id, d.ev, t.target
          ORDER BY abs(d.tau - t.target) ASC
        ) = 1
      )
      SELECT
        s.ev, s.target, s.tau,
        s.up_best_bid, s.up_best_ask, s.down_best_bid, s.down_best_ask,
        s.underlying_price, s.price_to_beat,
        l.last_spot, l.last_ptb, l.last_tau, l.last_up_ask, l.last_down_ask,
        e.min_tau, e.max_tau, e.n_ticks
      FROM snap s
      JOIN lastrow l ON l.condition_id = s.condition_id AND l.ev = s.ev
      JOIN evagg  e ON e.condition_id = s.condition_id AND e.ev = s.ev
      WHERE e.max_tau >= 240 AND e.min_tau <= 15
      ORDER BY s.ev, s.target
    `;
    const rows = (await c.runAndReadAll(query)).getRowObjectsJS();

    const evSeen = new Set();
    for (const row of rows) {
      const key = `${day}:${row.ev}`;
      if (!evSeen.has(key)) {
        evSeen.add(key);
        nEvents += 1;
        if (Number(row.last_tau) > 10) nEventsShortTail += 1;
      }
      const lastSpot = Number(row.last_spot);
      const lastPtb = Number(row.last_ptb);
      const spotWinner =
        lastSpot > lastPtb ? 'UP' : lastSpot < lastPtb ? 'DOWN' : null;
      const bookWinner =
        Number(row.last_up_ask) > Number(row.last_down_ask)
          ? 'UP'
          : Number(row.last_down_ask) > Number(row.last_up_ask)
            ? 'DOWN'
            : null;
      if (spotWinner == null) continue;
      const agree = spotWinner === bookWinner;
      const upAsk = Number(row.up_best_ask);
      const downAsk = Number(row.down_best_ask);
      const upBid = Number(row.up_best_bid);
      const downBid = Number(row.down_best_bid);
      const favSide = upAsk >= downAsk ? 'UP' : 'DOWN';
      const favAsk = favSide === 'UP' ? upAsk : downAsk;
      const favBid = favSide === 'UP' ? upBid : downBid;
      const dogAsk = favSide === 'UP' ? downAsk : upAsk;
      const dogBid = favSide === 'UP' ? downBid : upBid;
      snaps.push({
        day,
        ev: String(row.ev),
        target: Number(row.target),
        tau: Number(row.tau),
        favSide,
        favAsk,
        favBid,
        favMid: (favAsk + favBid) / 2,
        dogAsk,
        dogBid,
        dogMid: (dogAsk + dogBid) / 2,
        askSum: upAsk + downAsk,
        bidSum: upBid + downBid,
        favWon: spotWinner === favSide,
        agree,
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
      });
      if (!agree) nEventsAmbiguous += 1;
    }
    if (di === 0 || di === days.length - 1 || (di + 1) % 20 === 0) {
      console.log(
        `[${di + 1}/${days.length}] ${day} events=${nEvents} snaps=${snaps.length}`,
      );
    }
  }

  console.log(
    `\nevents=${nEvents} snapshots=${snaps.length}` +
      ` shortTail(lastTau>10s)=${nEventsShortTail}`,
  );

  // ---------- calibration by (tau target, ask bucket) ----------
  const table = new Map();
  for (const s of snaps) {
    const bucket = priceBucket(s.favAsk);
    if (!bucket) continue;
    const key = `${s.target}|${bucket}`;
    let cell = table.get(key);
    if (!cell) {
      cell = {
        target: s.target,
        bucket,
        n: 0,
        wins: 0,
        askSum: 0,
        feeSum: 0,
        evPerShare: [],
        byEvent: new Map(),
        byDay: new Map(),
        dogEv: [],
      };
      table.set(key, cell);
    }
    cell.n += 1;
    if (s.favWon) cell.wins += 1;
    cell.askSum += s.favAsk;
    cell.feeSum += fee(s.favAsk);
    const ev = (s.favWon ? 1 : 0) - s.favAsk - fee(s.favAsk);
    const dogEv = (s.favWon ? 0 : 1) - s.dogAsk - fee(s.dogAsk);
    cell.evPerShare.push(ev);
    cell.dogEv.push(dogEv);
    if (!cell.byEvent.has(s.ev)) cell.byEvent.set(s.ev, []);
    cell.byEvent.get(s.ev).push(ev);
    if (!cell.byDay.has(s.day)) cell.byDay.set(s.day, []);
    cell.byDay.get(s.day).push(ev);
  }

  const cells = [...table.values()]
    .filter((cell) => cell.n >= 30)
    .map((cell) => {
      const winRate = cell.wins / cell.n;
      const avgAsk = cell.askSum / cell.n;
      const avgFee = cell.feeSum / cell.n;
      const [wlo, whi] = wilson(cell.wins, cell.n);
      const [blo, bhi] = clusterBootstrap(cell.byDay, 1500);
      const evMean =
        cell.evPerShare.reduce((a, b) => a + b, 0) / cell.evPerShare.length;
      const dogMean = cell.dogEv.reduce((a, b) => a + b, 0) / cell.dogEv.length;
      return {
        target: cell.target,
        bucket: cell.bucket,
        n: cell.n,
        events: cell.byEvent.size,
        days: cell.byDay.size,
        winRatePct: r2(winRate * 100),
        avgAsk: r4(avgAsk),
        avgFee: r4(avgFee),
        // break-even win rate = ask + fee
        breakEvenPct: r2((avgAsk + avgFee) * 100),
        edgePp: r2((winRate - avgAsk - avgFee) * 100),
        winLo95Pct: r2(wlo * 100),
        winHi95Pct: r2(whi * 100),
        evPerShare: r4(evMean),
        evLo95: r4(blo),
        evHi95: r4(bhi),
        significant: blo != null && (blo > 0 || bhi < 0),
        dogEvPerShare: r4(dogMean),
      };
    })
    .sort((a, b) => a.target - b.target || a.bucket.localeCompare(b.bucket));

  // ---------- aggregate by tau ----------
  const byTau = new Map();
  for (const s of snaps) {
    let cell = byTau.get(s.target);
    if (!cell) {
      cell = { target: s.target, n: 0, wins: 0, ev: [], byDay: new Map() };
      byTau.set(s.target, cell);
    }
    cell.n += 1;
    if (s.favWon) cell.wins += 1;
    const ev = (s.favWon ? 1 : 0) - s.favAsk - fee(s.favAsk);
    cell.ev.push(ev);
    if (!cell.byDay.has(s.day)) cell.byDay.set(s.day, []);
    cell.byDay.get(s.day).push(ev);
  }
  const tauRows = [...byTau.values()]
    .map((cell) => {
      const [lo, hi] = clusterBootstrap(cell.byDay, 1500);
      return {
        target: cell.target,
        n: cell.n,
        winRatePct: r2((cell.wins / cell.n) * 100),
        evPerShare: r4(cell.ev.reduce((a, b) => a + b, 0) / cell.ev.length),
        evLo95: r4(lo),
        evHi95: r4(hi),
      };
    })
    .sort((a, b) => b.target - a.target);

  // ---------- book width structure ----------
  const widths = snaps.map((s) => s.askSum - s.bidSum);
  const askSums = snaps.map((s) => s.askSum);
  const bidSums = snaps.map((s) => s.bidSum);
  const qf = (arr, f) => {
    const c2 = arr.filter(Number.isFinite).sort((a, b) => a - b);
    return c2.length ? c2[Math.floor((c2.length - 1) * f)] : null;
  };

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: FROM, to: TO, days: days.length },
    feeRate: FEE_RATE,
    events: nEvents,
    snapshots: snaps.length,
    ambiguousSnapshots: nEventsAmbiguous,
    bookWidth: {
      askSumP05: r4(qf(askSums, 0.05)),
      askSumP50: r4(qf(askSums, 0.5)),
      askSumP95: r4(qf(askSums, 0.95)),
      bidSumP05: r4(qf(bidSums, 0.05)),
      bidSumP50: r4(qf(bidSums, 0.5)),
      bidSumP95: r4(qf(bidSums, 0.95)),
      pairWidthP50: r4(qf(widths, 0.5)),
    },
    byTau: tauRows,
    cells,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  console.log('\n=== book width (pair) ===');
  console.log(JSON.stringify(report.bookWidth, null, 2));

  console.log('\n=== EV of buying the FAVOURITE at ask and holding ===');
  console.log(
    'tau'.padEnd(6),
    'n'.padEnd(8),
    'win%'.padEnd(8),
    'EV/share'.padEnd(10),
    'EV lo95'.padEnd(10),
    'EV hi95',
  );
  for (const t of tauRows) {
    console.log(
      String(t.target).padEnd(6),
      String(t.n).padEnd(8),
      String(t.winRatePct).padEnd(8),
      String(t.evPerShare).padEnd(10),
      String(t.evLo95).padEnd(10),
      String(t.evHi95),
    );
  }

  console.log('\n=== calibration cells (edge in percentage points) ===');
  console.log(
    'tau'.padEnd(6),
    'askBucket'.padEnd(14),
    'n'.padEnd(7),
    'win%'.padEnd(8),
    'BE%'.padEnd(8),
    'edge_pp'.padEnd(9),
    'EV/sh'.padEnd(9),
    'EVlo'.padEnd(9),
    'EVhi'.padEnd(9),
    'sig',
  );
  for (const cell of cells) {
    console.log(
      String(cell.target).padEnd(6),
      cell.bucket.padEnd(14),
      String(cell.n).padEnd(7),
      String(cell.winRatePct).padEnd(8),
      String(cell.breakEvenPct).padEnd(8),
      String(cell.edgePp).padEnd(9),
      String(cell.evPerShare).padEnd(9),
      String(cell.evLo95).padEnd(9),
      String(cell.evHi95).padEnd(9),
      cell.significant ? '***' : '',
    );
  }

  const sig = cells.filter((cell) => cell.significant);
  console.log(`\nsignificant cells: ${sig.length} / ${cells.length}`);
  for (const cell of sig) {
    console.log(
      `  tau=${cell.target} ${cell.bucket} n=${cell.n} EV=${cell.evPerShare}` +
        ` [${cell.evLo95}, ${cell.evHi95}]`,
    );
  }
  console.log('\nsaved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
