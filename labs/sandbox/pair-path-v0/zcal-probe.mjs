/**
 * Non-parametric (ask x z x tau) calibration — strategy discovery.
 *
 * WHY z AND NOT PHI(z):
 * The Brownian Phi(z) is measurably biased in this book (it reports ~0% flip at
 * z>=3 where reality is 3-6%; a prior Flip-Hunt study measured a 10.8pp bias).
 * So we never convert z into a probability. We use z only as a BUCKETING
 * FEATURE and read the realized win rate straight out of the data. That removes
 * the model bias entirely — whatever distortion the Gaussian has is absorbed by
 * the empirical cell.
 *
 * WHY z AT ALL:
 * The book already prices the binary almost perfectly (P(win) ~= ask + fee), and
 * microstructure adds nothing conditional on price. z is different in kind: it
 * compares the market's price against the PHYSICAL position of spot relative to
 * the strike, scaled by realized volatility. It is the one feature that is not a
 * function of the book.
 *
 * DISCIPLINE:
 *   - train = 2026-04-23..2026-06-30, test = 2026-07-01..2026-07-30
 *   - cells are SELECTED on train only, then read once on test
 *   - all CIs bootstrapped over DAYS
 *   - a cell counts only if it is positive in train AND test
 *
 *   node labs/sandbox/pair-path-v0/zcal-probe.mjs
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
const OUT_DIR = path.join(ROOT, '.tmp/zcal-probe');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-30');
const TRAIN_END = arg('trainEnd', '2026-06-30');
const VOL_LOOKBACK_S = Number(arg('volLookback', '90'));
const MIN_N = Number(arg('minN', '150'));
// LEAKAGE GUARD. The winner label is a PROXY: sign(spot - ptb) at the last
// available tick, not the true resolution at tau=0. A snapshot at tau=10 can BE
// that same tick, in which case z>0 predicts the label by construction — which
// is exactly how the first run produced 98.6% win rates at tau=10/20. So we
// force a real forecast horizon: the label tick must be within LABEL_MAX_TAU of
// the end, and no signal may be read closer than MIN_SNAP_TAU.
const LABEL_MAX_TAU = Number(arg('labelMaxTau', '10'));
const MIN_SNAP_TAU = Number(arg('minSnapTau', '30'));

const TAUS = [240, 180, 120, 90, 60, 45, 30, 20, 10].filter(
  (t) => t >= MIN_SNAP_TAU,
);

function fee(p) {
  const x = Math.min(0.99, Math.max(0.01, p));
  return FEE_RATE * x * (1 - x);
}
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
}
function bootDays(byDay, iterations = 2000) {
  const keys = [...byDay.keys()];
  if (keys.length < 5) return [null, null];
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const a = byDay.get(keys[(Math.random() * keys.length) | 0]);
      for (let j = 0; j < a.length; j += 1) {
        s += a[j];
        n += 1;
      }
    }
    if (n) means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [
    r4(means[Math.floor(means.length * 0.025)]),
    r4(means[Math.floor(means.length * 0.975)]),
  ];
}

function askBucket(a) {
  if (a < 0.5) return null;
  const edges = [0.5, 0.6, 0.7, 0.8, 0.875, 0.925, 0.96, 0.99, 1.01];
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (a >= edges[i] && a < edges[i + 1]) {
      return `${edges[i].toFixed(3)}-${edges[i + 1].toFixed(3)}`;
    }
  }
  return null;
}
function zBucket(z) {
  if (!Number.isFinite(z)) return null;
  const edges = [-99, 0, 0.5, 1, 1.5, 2, 3, 5, 99];
  const names = ['neg', '0-0.5', '0.5-1', '1-1.5', '1.5-2', '2-3', '3-5', '5+'];
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (z >= edges[i] && z < edges[i + 1]) return names[i];
  }
  return null;
}

async function main() {
  const days = listDays();
  console.log(
    `=== zcal probe === days=${days.length} volLookback=${VOL_LOOKBACK_S}s minN=${MIN_N}`,
  );
  console.log(`train <= ${TRAIN_END} | test > ${TRAIN_END}`);

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  // cellKey -> split -> { n, wins, askSum, feeSum, byDay:Map }
  const cells = new Map();
  const touch = (key, split, day, won, ask) => {
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        train: { n: 0, wins: 0, askSum: 0, feeSum: 0, byDay: new Map() },
        test: { n: 0, wins: 0, askSum: 0, feeSum: 0, byDay: new Map() },
      };
      cells.set(key, cell);
    }
    const s = cell[split];
    s.n += 1;
    if (won) s.wins += 1;
    s.askSum += ask;
    s.feeSum += fee(ask);
    const ev = (won ? 1 : 0) - ask - fee(ask);
    if (!s.byDay.has(day)) s.byDay.set(day, []);
    s.byDay.get(day).push(ev);
  };

  let nEvents = 0;

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
        epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
        extract(epoch FROM (
          try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
        ))::DOUBLE AS tau,
        up_best_bid, up_best_ask, down_best_bid, down_best_ask,
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
      if (buf[0].tau < 240 || buf[buf.length - 1].tau > LABEL_MAX_TAU) return;
      const last = buf[buf.length - 1];
      const winner =
        last.spot > last.ptb ? 'UP' : last.spot < last.ptb ? 'DOWN' : null;
      if (!winner) return;
      nEvents += 1;

      // rolling realized vol per sqrt(second), from irregular spot samples
      const norm = []; // {ts, r2} normalized squared return
      for (let i = 1; i < buf.length; i += 1) {
        const dt = buf[i].ts - buf[i - 1].ts;
        if (!(dt > 0) || !(buf[i].spot > 0) || !(buf[i - 1].spot > 0)) continue;
        const lr = Math.log(buf[i].spot / buf[i - 1].spot);
        norm.push({ ts: buf[i].ts, v: (lr * lr) / dt });
      }

      for (const target of TAUS) {
        // snapshot closest to target
        let best = null;
        let bestD = Infinity;
        for (const t of buf) {
          const d = Math.abs(t.tau - target);
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        // never read a signal closer to the end than the guard allows, and keep
        // a real gap between the signal tick and the label tick
        if (!best || bestD > 6) continue;
        if (best.tau < MIN_SNAP_TAU) continue;
        if (best.tau - last.tau < MIN_SNAP_TAU / 2) continue;

        const favSide = best.upAsk >= best.downAsk ? 'UP' : 'DOWN';
        const favAsk = favSide === 'UP' ? best.upAsk : best.downAsk;
        const ab = askBucket(favAsk);
        if (!ab) continue;

        // realized vol over the trailing window ending at this snapshot
        let sum = 0;
        let cnt = 0;
        const lo = best.ts - VOL_LOOKBACK_S;
        for (const p of norm) {
          if (p.ts > best.ts) break;
          if (p.ts >= lo) {
            sum += p.v;
            cnt += 1;
          }
        }
        if (cnt < 20) continue;
        const sigPerSqrtS = Math.sqrt(sum / cnt); // log-return units
        const sigTauPrice = best.spot * sigPerSqrtS * Math.sqrt(best.tau);
        if (!(sigTauPrice > 0)) continue;

        const rawDist = best.spot - best.ptb;
        const dist = favSide === 'UP' ? rawDist : -rawDist;
        const z = dist / sigTauPrice;
        const zb = zBucket(z);
        if (!zb) continue;

        touch(`${target}|${ab}|${zb}`, split, day, favSide === winner, favAsk);
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
        ts: Number(row.ts_epoch),
        tau: Number(row.tau),
        upAsk: Number(row.up_best_ask),
        downAsk: Number(row.down_best_ask),
        upBid: Number(row.up_best_bid),
        downBid: Number(row.down_best_bid),
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
      });
    }
    flush();
    if (di === 0 || di === days.length - 1 || (di + 1) % 20 === 0) {
      console.log(`[${di + 1}/${days.length}] ${day} events=${nEvents}`);
    }
  }

  const stat = (s) => {
    if (!s.n) return null;
    const avgAsk = s.askSum / s.n;
    const avgFee = s.feeSum / s.n;
    const win = s.wins / s.n;
    const [lo, hi] = bootDays(s.byDay);
    const pnls = [...s.byDay.values()].flat();
    return {
      n: s.n,
      days: s.byDay.size,
      winPct: r2(win * 100),
      avgAsk: r4(avgAsk),
      bePct: r2((avgAsk + avgFee) * 100),
      edgePp: r2((win - avgAsk - avgFee) * 100),
      ev: r4(pnls.reduce((a, b) => a + b, 0) / pnls.length),
      lo95: lo,
      hi95: hi,
    };
  };

  const out = [];
  for (const [key, cell] of cells) {
    const [tau, ab, zb] = key.split('|');
    const tr = stat(cell.train);
    const te = stat(cell.test);
    if (!tr || !te) continue;
    if (tr.n < MIN_N || te.n < Math.floor(MIN_N / 2)) continue;
    out.push({ tau: Number(tau), askBucket: ab, zBucket: zb, train: tr, test: te });
  }

  // SELECTION IS DONE ON TRAIN ONLY
  const selected = out
    .filter((r) => r.train.lo95 != null && r.train.lo95 > 0)
    .sort((a, b) => b.train.ev - a.train.ev);
  const confirmed = selected.filter((r) => r.test.ev > 0);
  const confirmedSig = selected.filter((r) => r.test.lo95 != null && r.test.lo95 > 0);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        window: { FROM, TO, TRAIN_END },
        volLookbackS: VOL_LOOKBACK_S,
        nEvents,
        cellsEvaluated: out.length,
        selectedOnTrain: selected.length,
        confirmedOnTest: confirmed.length,
        cells: out,
        selected,
      },
      null,
      2,
    ),
  );

  console.log(`\nevents=${nEvents} cells(with min n)=${out.length}`);
  console.log(
    `\n=== cells SELECTED on train (lo95 > 0): ${selected.length} ===`,
  );
  console.log(
    'tau'.padEnd(5),
    'ask'.padEnd(13),
    'z'.padEnd(8),
    '| trN'.padEnd(7),
    'trWin'.padEnd(7),
    'trEdge'.padEnd(8),
    'trEV'.padEnd(8),
    'trLo'.padEnd(8),
    '| teN'.padEnd(7),
    'teWin'.padEnd(7),
    'teEdge'.padEnd(8),
    'teEV'.padEnd(8),
    'teLo',
  );
  for (const r of selected.slice(0, 40)) {
    console.log(
      String(r.tau).padEnd(5),
      r.askBucket.padEnd(13),
      r.zBucket.padEnd(8),
      `| ${r.train.n}`.padEnd(7),
      String(r.train.winPct).padEnd(7),
      String(r.train.edgePp).padEnd(8),
      String(r.train.ev).padEnd(8),
      String(r.train.lo95).padEnd(8),
      `| ${r.test.n}`.padEnd(7),
      String(r.test.winPct).padEnd(7),
      String(r.test.edgePp).padEnd(8),
      String(r.test.ev).padEnd(8),
      String(r.test.lo95),
      r.test.ev > 0 ? ' OK' : ' FAIL',
    );
  }
  console.log(
    `\nconfirmed on test (ev>0): ${confirmed.length}/${selected.length}`,
  );
  console.log(
    `confirmed on test with lo95>0: ${confirmedSig.length}/${selected.length}`,
  );
  for (const r of confirmedSig) {
    console.log(
      `  tau=${r.tau} ask=${r.askBucket} z=${r.zBucket}` +
        ` train ev=${r.train.ev} [${r.train.lo95},${r.train.hi95}] n=${r.train.n}` +
        ` | test ev=${r.test.ev} [${r.test.lo95},${r.test.hi95}] n=${r.test.n}`,
    );
  }
  console.log('\nsaved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
