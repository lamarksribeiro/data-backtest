/**
 * Deep-underdog passive probe — isolated, honest test of a single hypothesis.
 *
 * HYPOTHESIS: resting a passive bid on the CHEAP leg (<= maxPx, i.e. the deep
 * underdog while the favourite trades 0.94+) and holding to resolution has
 * positive expectancy, with loss structurally capped at the entry price.
 *
 * WHY THIS IS SUSPECT AND MUST BE TESTED HARD:
 *  1. It was found by grid-searching 509 variants over 264 events (one day).
 *     That is precisely the in-sample selection failure this repo's audit warns
 *     about, so day 29 is treated as EXPLORATION ONLY here.
 *  2. The whole P&L rests on the rare wins. A handful of events can carry it.
 *  3. The winner label comes from spot vs price_to_beat at the LAST AVAILABLE
 *     TICK, which can be up to 15s before the true end. Deep underdogs win
 *     precisely by flipping at the very end, so this population is the most
 *     exposed to label error of any in the book. We quantify that directly.
 *
 * Splits: train = 2026-04-23..2026-06-30, test = 2026-07-01..2026-07-30.
 * All intervals are bootstrapped over DAYS (ticks inside an event are ~perfectly
 * autocorrelated, so tick-level or event-level intervals would be fiction).
 *
 *   node labs/sandbox/pair-path-v0/deep-dog-probe.mjs
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
const TICK = 0.001;
const OUT_DIR = path.join(ROOT, '.tmp/deep-dog-probe');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-30');
const TRAIN_END = arg('trainEnd', '2026-06-30');

function r4(x) {
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null;
}
function r2(x) {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}
function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
}
function bootstrapDays(byDay, iterations = 3000) {
  const keys = [...byDay.keys()];
  if (keys.length < 5) return [null, null];
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const arr = byDay.get(keys[(Math.random() * keys.length) | 0]);
      for (let j = 0; j < arr.length; j += 1) {
        sum += arr[j];
        n += 1;
      }
    }
    if (n) means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [
    r4(means[Math.floor(means.length * 0.025)]),
    r4(means[Math.floor(means.length * 0.975)]),
  ];
}

const VARIANTS = [];
for (const maxPx of [0.02, 0.03, 0.04, 0.05, 0.07, 0.1]) {
  for (const [eTau, sTau] of [
    [280, 10],
    [180, 10],
    [120, 10],
    [90, 10],
    [60, 5],
    [45, 5],
  ]) {
    for (const slackTicks of [0, 1, 2]) {
      VARIANTS.push({
        id: `px${String(maxPx).slice(2).padEnd(3, '0')}-t${eTau}_${sTau}-s${slackTicks}`,
        maxPx,
        entryTau: eTau,
        stopTau: sTau,
        slackTicks,
      });
    }
  }
}

/**
 * One passive bid on whichever leg is cheap, resting until filled or the window
 * closes. Fill reference is min(our price, touch at post time) — the level must
 * actually be swept down to us.
 */
function runEvent(ticks, v) {
  let order = null;
  for (let i = 0; i < ticks.length; i += 1) {
    const t = ticks[i];
    if (t.tau > v.entryTau) continue;
    if (t.tau < v.stopTau) break;

    if (order) {
      const bid = order.side === 'UP' ? t.upBid : t.downBid;
      const ref = Math.min(order.px, order.refBid);
      if (bid < ref - v.slackTicks * TICK - 1e-12) {
        return {
          filled: true,
          side: order.side,
          px: order.px,
          fillTau: t.tau,
          dogDepth: order.depth,
        };
      }
      continue;
    }
    // pick the cheap leg
    const side = t.upBid <= t.downBid ? 'UP' : 'DOWN';
    const bid = side === 'UP' ? t.upBid : t.downBid;
    const ask = side === 'UP' ? t.upAsk : t.downAsk;
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
    if (bid <= 0 || bid > v.maxPx + 1e-12) continue;
    order = {
      side,
      px: bid,
      refBid: bid,
      depth: side === 'UP' ? t.upBidSz : t.downBidSz,
    };
  }
  return { filled: false };
}

async function main() {
  const days = listDays();
  console.log(`=== deep-dog probe === days=${days.length} ${FROM}..${TO}`);
  console.log(`train <= ${TRAIN_END} | test > ${TRAIN_END}`);

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  // accumulators: variant -> split -> {byDay, rows}
  const acc = new Map();
  for (const v of VARIANTS) {
    acc.set(v.id, {
      train: { byDay: new Map(), fills: 0, wins: 0, pxSum: 0, events: 0, depth: [] },
      test: { byDay: new Map(), fills: 0, wins: 0, pxSum: 0, events: 0, depth: [] },
    });
  }

  // label-robustness diagnostics
  let evTotal = 0;
  let lateFlip30 = 0; // sign of (spot-ptb) differs between tau=30 and last tick
  let lateFlip10 = 0;
  let dogWinTotal = 0;
  let dogWinLateFlip = 0;

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    const split = day <= TRAIN_END ? 'train' : 'test';
    const dayDir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dayDir)
      .filter((n) => n.endsWith('.parquet'))
      .map((n) => path.join(dayDir, n));
    if (!files.length) continue;
    const parquet = `[${files.map((f) => quotedString(f)).join(',')}]`;
    const rows = (
      await c.runAndReadAll(`
      SELECT condition_id,
        epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS ev,
        extract(epoch FROM (
          try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
        ))::DOUBLE AS tau,
        up_best_bid, up_best_ask, down_best_bid, down_best_ask,
        up_bid_sz_1, down_bid_sz_1,
        underlying_price, price_to_beat
      FROM read_parquet(${parquet})
      WHERE coverage >= 0.99 AND coalesce(degraded, false) = false
        AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
        AND up_best_bid IS NOT NULL AND down_best_bid IS NOT NULL
        AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
      QUALIFY row_number() OVER (
        PARTITION BY condition_id, event_start, ts ORDER BY coverage DESC) = 1
      ORDER BY condition_id, ev, tau DESC
    `)
    ).getRowObjectsJS();

    let key = null;
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      if (buf[0].tau < 240 || buf[buf.length - 1].tau > 15) return;
      const last = buf[buf.length - 1];
      const winner =
        last.spot > last.ptb ? 'UP' : last.spot < last.ptb ? 'DOWN' : null;
      if (!winner) return;
      evTotal += 1;

      // label robustness: did the sign flip between tau~30/~10 and the last tick?
      const at = (target) => {
        let best = null;
        let bestD = Infinity;
        for (const t of buf) {
          const d = Math.abs(t.tau - target);
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        return best;
      };
      const t30 = at(30);
      const t10 = at(10);
      const sign = (t) => (t.spot > t.ptb ? 'UP' : t.spot < t.ptb ? 'DOWN' : null);
      if (t30 && sign(t30) && sign(t30) !== winner) lateFlip30 += 1;
      if (t10 && sign(t10) && sign(t10) !== winner) lateFlip10 += 1;

      for (const v of VARIANTS) {
        const a = acc.get(v.id)[split];
        a.events += 1;
        const res = runEvent(buf, v);
        let pnl = 0;
        if (res.filled) {
          a.fills += 1;
          a.pxSum += res.px;
          if (Number.isFinite(res.dogDepth)) a.depth.push(res.dogDepth);
          const won = res.side === winner;
          if (won) a.wins += 1;
          // maker fill: zero fee under the documented rule
          pnl = (won ? 1 : 0) - res.px;
          if (won && v.id === VARIANTS[0].id) dogWinTotal += 1;
        }
        if (!a.byDay.has(day)) a.byDay.set(day, []);
        a.byDay.get(day).push(pnl);
      }
      buf = [];
    };
    for (const row of rows) {
      const k = `${row.condition_id}:${row.ev}`;
      if (key != null && k !== key) {
        flush();
        buf = [];
      }
      key = k;
      buf.push({
        tau: Number(row.tau),
        upBid: Number(row.up_best_bid),
        upAsk: Number(row.up_best_ask),
        downBid: Number(row.down_best_bid),
        downAsk: Number(row.down_best_ask),
        upBidSz: Number(row.up_bid_sz_1),
        downBidSz: Number(row.down_bid_sz_1),
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
      });
    }
    flush();
    if (di === 0 || di === days.length - 1 || (di + 1) % 20 === 0) {
      console.log(`[${di + 1}/${days.length}] ${day} events=${evTotal}`);
    }
  }

  const med = (a) => {
    const s = a.filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  const stat = (a) => {
    const pnls = [...a.byDay.values()].flat();
    const total = pnls.reduce((x, y) => x + y, 0);
    const [lo, hi] = bootstrapDays(a.byDay);
    const avgPx = a.fills ? a.pxSum / a.fills : null;
    return {
      events: a.events,
      fills: a.fills,
      fillPct: r2((a.fills / a.events) * 100),
      wins: a.wins,
      winPctOfFills: a.fills ? r2((a.wins / a.fills) * 100) : null,
      avgPx: r4(avgPx),
      breakEvenPct: avgPx != null ? r2(avgPx * 100) : null,
      edgePp: a.fills ? r2((a.wins / a.fills - avgPx) * 100) : null,
      pnlTotal: r4(total),
      pnlPerEvent: r4(total / a.events),
      pnlPerFill: a.fills ? r4(total / a.fills) : null,
      evLo95: lo,
      evHi95: hi,
      sig: lo != null && lo > 0,
      medDogDepth: med(a.depth),
    };
  };

  const reports = VARIANTS.map((v) => {
    const a = acc.get(v.id);
    return { id: v.id, params: v, train: stat(a.train), test: stat(a.test) };
  });

  const label = {
    events: evTotal,
    lateFlipFromTau30Pct: r2((lateFlip30 / evTotal) * 100),
    lateFlipFromTau10Pct: r2((lateFlip10 / evTotal) * 100),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), window: { FROM, TO, TRAIN_END }, label, reports },
      null,
      2,
    ),
  );

  console.log('\n=== LABEL ROBUSTNESS ===');
  console.log(JSON.stringify(label, null, 2));
  console.log(
    '  (share of events whose winner differs from the sign observed at that tau;',
  );
  console.log(
    '   a deep underdog wins exactly by flipping late, so this bounds the label error)',
  );

  const sorted = [...reports].sort(
    (a, b) => (b.train.pnlPerEvent ?? -9) - (a.train.pnlPerEvent ?? -9),
  );
  console.log('\n=== ranked by TRAIN, shown with TEST beside it ===');
  console.log(
    'variant'.padEnd(24),
    '| trFill%'.padEnd(9),
    'trWin%'.padEnd(8),
    'trEdge'.padEnd(8),
    'trEV'.padEnd(9),
    'trLo95'.padEnd(9),
    '| teFill%'.padEnd(9),
    'teWin%'.padEnd(8),
    'teEV'.padEnd(9),
    'teLo95'.padEnd(9),
    'depth',
  );
  for (const r of sorted.slice(0, 30)) {
    console.log(
      r.id.padEnd(24),
      `| ${r.train.fillPct}`.padEnd(9),
      String(r.train.winPctOfFills).padEnd(8),
      String(r.train.edgePp).padEnd(8),
      String(r.train.pnlPerEvent).padEnd(9),
      String(r.train.evLo95).padEnd(9),
      `| ${r.test.fillPct}`.padEnd(9),
      String(r.test.winPctOfFills).padEnd(8),
      String(r.test.pnlPerEvent).padEnd(9),
      String(r.test.evLo95).padEnd(9),
      String(r.train.medDogDepth),
      r.train.sig ? ' TRsig' : '',
      r.test.sig ? ' TEsig' : '',
    );
  }

  const bothPos = reports.filter(
    (r) => r.train.pnlPerEvent > 0 && r.test.pnlPerEvent > 0,
  );
  const bothSig = reports.filter((r) => r.train.sig && r.test.sig);
  console.log(
    `\nvariants positive in BOTH train and test: ${bothPos.length}/${reports.length}`,
  );
  console.log(
    `variants day-clustered SIGNIFICANT in BOTH: ${bothSig.length}/${reports.length}`,
  );
  for (const r of bothSig) {
    console.log(
      `  ${r.id} train=${r.train.pnlPerEvent} [${r.train.evLo95},${r.train.evHi95}]` +
        ` test=${r.test.pnlPerEvent} [${r.test.evLo95},${r.test.evHi95}]`,
    );
  }
  console.log('\nsaved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
