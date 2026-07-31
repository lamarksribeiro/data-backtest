/**
 * Maker complete-set simulator.
 *
 * Structural fact measured on this lake (99 days, 227k snapshots):
 *   ask_UP + ask_DOWN = 1.010   (95% of ticks)
 *   bid_UP + bid_DOWN = 0.990   (95% of ticks)
 *   per-leg spread    = 0.010
 *   tick size         = 0.001
 *   P(win) ~= ask + fee   (market is calibrated to the TAKER-net price)
 *
 * Polymarket charges takers only; makers pay 0 and additionally earn 20% of
 * collected taker fees as rebates. So a complete set bought PASSIVELY on both
 * legs costs 0.990 and pays exactly 1.000 at resolution -> +1c/share with NO
 * directional risk whatsoever, because UP+DOWN is worth $1 regardless of who
 * wins.
 *
 * The entire question is therefore NOT "is the edge real" but:
 *   how often do BOTH resting bids get filled, and what does the
 *   one-legged case cost when only one fills?
 *
 * FILL MODEL (deliberately pessimistic — we cannot see trade prints):
 *   A resting bid at price `a` on side X is considered filled only once
 *   best_bid_X drops strictly below `a - slack`. That means the whole visible
 *   queue at and above `a` was consumed or pulled. We assume we sat at the BACK
 *   of that queue. We never infer a fill from a mere touch.
 *
 *   node labs/sandbox/pair-path-v0/maker-pair-sim.mjs --from=2026-07-29 --to=2026-07-29
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

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-07-29');
const TO = arg('to', '2026-07-29');
const TAG = arg('tag', 'd29');
const OUT_DIR = path.join(ROOT, `.tmp/maker-pair-sim-${TAG}`);

function fee(p, shares = 1) {
  const x = Math.min(0.99, Math.max(0.01, p));
  return FEE_RATE * x * (1 - x) * shares;
}
function r4(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000;
}
function r2(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
}
function qf(arr, f) {
  const c = arr.filter(Number.isFinite).sort((a, b) => a - b);
  return c.length ? c[Math.floor((c.length - 1) * f)] : null;
}
function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
}
function clusterBootstrap(clusters, iterations = 1500) {
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

/**
 * Simulate one event under one variant.
 *
 * Returns a per-share P&L for a 1-share-per-leg position, plus diagnostics.
 */
function runEvent(ticks, v, winner) {
  // find entry tick
  let entry = -1;
  for (let i = 0; i < ticks.length; i += 1) {
    if (ticks[i].tau <= v.entryTau) {
      entry = i;
      break;
    }
  }
  if (entry < 0) return null;
  const t0 = ticks[entry];
  if (!Number.isFinite(t0.upBid) || !Number.isFinite(t0.downBid)) return null;

  // --- choose the two resting bid prices ---
  const upMid = (t0.upBid + t0.upAsk) / 2;
  const downMid = (t0.downBid + t0.downAsk) / 2;
  let upPx;
  let downPx;
  if (v.mode === 'join') {
    upPx = t0.upBid;
    downPx = t0.downBid;
  } else if (v.mode === 'improve') {
    upPx = t0.upBid + v.improveTicks * TICK;
    downPx = t0.downBid + v.improveTicks * TICK;
  } else {
    // fixedSum: split the discount proportionally to the mids so both legs
    // stay at a sensible distance from fair value
    const target = v.pairSum;
    upPx = upMid * target;
    downPx = downMid * target;
    upPx = Math.round(upPx / TICK) * TICK;
    downPx = Math.round(downPx / TICK) * TICK;
  }
  if (upPx <= 0 || downPx <= 0 || upPx >= 1 || downPx >= 1) return null;
  // never post above the opposite ask-implied fair (would be a taker)
  if (upPx >= t0.upAsk || downPx >= t0.downAsk) return null;

  const slack = v.slackTicks * TICK;
  let upFillTau = null;
  let downFillTau = null;
  let upFillIdx = null;
  let downFillIdx = null;

  for (let i = entry + 1; i < ticks.length; i += 1) {
    const t = ticks[i];
    if (upFillTau == null && t.upBid < upPx - slack - 1e-12) {
      upFillTau = t.tau;
      upFillIdx = i;
    }
    if (downFillTau == null && t.downBid < downPx - slack - 1e-12) {
      downFillTau = t.tau;
      downFillIdx = i;
    }
    if (upFillTau != null && downFillTau != null) break;
  }

  const bothFilled = upFillTau != null && downFillTau != null;
  const oneFilled = !bothFilled && (upFillTau != null || downFillTau != null);

  let pnl = 0;
  let outcome;
  let takerRescue = false;

  if (bothFilled) {
    // complete set: worth exactly $1.00 at resolution, no fees as maker
    pnl = 1 - upPx - downPx;
    outcome = 'pair';
  } else if (oneFilled) {
    const side = upFillTau != null ? 'UP' : 'DOWN';
    const px = side === 'UP' ? upPx : downPx;
    const fillIdx = side === 'UP' ? upFillIdx : downFillIdx;
    if (v.onOneLeg === 'hold') {
      pnl = (winner === side ? 1 : 0) - px;
      outcome = 'naked_hold';
    } else if (v.onOneLeg === 'takerComplete') {
      // cross the spread on the other leg as soon as doing so still clears $1
      const otherKey = side === 'UP' ? 'downAsk' : 'upAsk';
      let done = false;
      for (let i = fillIdx; i < ticks.length; i += 1) {
        const q = ticks[i][otherKey];
        if (!Number.isFinite(q)) continue;
        const cost = px + q + fee(q);
        if (cost <= v.rescueMaxCost + 1e-12) {
          pnl = 1 - cost;
          outcome = 'pair_taker_rescue';
          takerRescue = true;
          done = true;
          break;
        }
      }
      if (!done) {
        pnl = (winner === side ? 1 : 0) - px;
        outcome = 'naked_hold';
      }
    }
  } else {
    pnl = 0;
    outcome = 'no_fill';
  }

  return {
    outcome,
    pnl,
    upPx,
    downPx,
    postedSum: upPx + downPx,
    bothFilled,
    oneFilled,
    takerRescue,
    upFillTau,
    downFillTau,
    entryTau: t0.tau,
  };
}

function buildVariants() {
  const out = [];
  for (const slackTicks of [0, 1, 2, 5]) {
    for (const entryTau of [280, 240, 180, 120]) {
      out.push({
        id: `join-e${entryTau}-s${slackTicks}-hold`,
        mode: 'join',
        entryTau,
        slackTicks,
        onOneLeg: 'hold',
      });
      out.push({
        id: `join-e${entryTau}-s${slackTicks}-rescue100`,
        mode: 'join',
        entryTau,
        slackTicks,
        onOneLeg: 'takerComplete',
        rescueMaxCost: 1.0,
      });
    }
  }
  for (const pairSum of [0.99, 0.98, 0.96, 0.94, 0.9, 0.85, 0.8]) {
    for (const entryTau of [280, 240, 180]) {
      for (const slackTicks of [0, 2]) {
        out.push({
          id: `sum${String(pairSum).replace('.', '')}-e${entryTau}-s${slackTicks}-hold`,
          mode: 'fixedSum',
          pairSum,
          entryTau,
          slackTicks,
          onOneLeg: 'hold',
        });
        out.push({
          id: `sum${String(pairSum).replace('.', '')}-e${entryTau}-s${slackTicks}-rescue`,
          mode: 'fixedSum',
          pairSum,
          entryTau,
          slackTicks,
          onOneLeg: 'takerComplete',
          rescueMaxCost: 1.0,
        });
      }
    }
  }
  for (const improveTicks of [1, 2]) {
    for (const entryTau of [280, 240]) {
      out.push({
        id: `improve${improveTicks}-e${entryTau}-s0-hold`,
        mode: 'improve',
        improveTicks,
        entryTau,
        slackTicks: 0,
        onOneLeg: 'hold',
      });
    }
  }
  return out;
}

function summarize(rows) {
  const done = rows.filter(Boolean);
  const filled = done.filter((r) => r.outcome !== 'no_fill');
  const pairs = done.filter((r) => r.bothFilled);
  const naked = done.filter((r) => r.outcome === 'naked_hold');
  const rescued = done.filter((r) => r.takerRescue);
  const pnls = done.map((r) => r.pnl);
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 1e-9);
  const losses = pnls.filter((p) => p < -1e-9);
  const gp = wins.reduce((a, b) => a + b, 0);
  const gl = losses.reduce((a, b) => a + Math.abs(b), 0);
  return {
    events: done.length,
    engaged: filled.length,
    engagedPct: r2((filled.length / done.length) * 100),
    pairs: pairs.length,
    pairPct: r2((pairs.length / done.length) * 100),
    pairOfEngagedPct: filled.length
      ? r2((pairs.length / filled.length) * 100)
      : null,
    naked: naked.length,
    nakedPct: r2((naked.length / done.length) * 100),
    rescued: rescued.length,
    totalPnlPerShare: r4(total),
    pnlPerEvent: r4(total / done.length),
    pnlPerEngaged: filled.length ? r4(total / filled.length) : null,
    profitFactor: gl > 0 ? r4(gp / gl) : gp > 0 ? 'Infinity' : 0,
    postedSumP50: r4(qf(done.map((r) => r.postedSum), 0.5)),
    worst: r4(Math.min(...pnls)),
    p05: r4(qf(pnls, 0.05)),
    p50: r4(qf(pnls, 0.5)),
    p95: r4(qf(pnls, 0.95)),
  };
}

function levelCols() {
  return `up_best_bid, up_best_ask, down_best_bid, down_best_ask`;
}

async function main() {
  const days = listDays();
  if (!days.length) throw new Error(`no lake days in ${FROM}..${TO}`);
  const variants = buildVariants();
  console.log(
    `=== maker pair sim === days=${days.length} ${FROM}..${TO}` +
      ` variants=${variants.length}`,
  );

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  const results = new Map(variants.map((v) => [v.id, []]));
  const byDay = new Map(variants.map((v) => [v.id, new Map()]));
  let nEvents = 0;

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
      SELECT
        condition_id,
        epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS ev,
        extract(epoch FROM (
          try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
        ))::DOUBLE AS tau,
        ${levelCols()},
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
      ORDER BY condition_id, ev, tau DESC
    `;
    const rows = (await c.runAndReadAll(query)).getRowObjectsJS();

    let key = null;
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const maxTau = buf[0].tau;
      const minTau = buf[buf.length - 1].tau;
      if (maxTau < 240 || minTau > 15) return;
      const last = buf[buf.length - 1];
      const winner =
        last.spot > last.ptb ? 'UP' : last.spot < last.ptb ? 'DOWN' : null;
      if (!winner) return;
      nEvents += 1;
      for (const v of variants) {
        const res = runEvent(buf, v, winner);
        results.get(v.id).push(res);
        if (res) {
          const m = byDay.get(v.id);
          if (!m.has(day)) m.set(day, []);
          m.get(day).push(res.pnl);
        }
      }
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
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
      });
    }
    flush();
    if (di === 0 || di === days.length - 1 || (di + 1) % 10 === 0) {
      console.log(`[${di + 1}/${days.length}] ${day} events=${nEvents}`);
    }
  }

  const reports = variants.map((v) => {
    const s = summarize(results.get(v.id));
    const [lo, hi] = clusterBootstrap(byDay.get(v.id), 1200);
    return {
      id: v.id,
      params: v,
      ...s,
      evLo95: r4(lo),
      evHi95: r4(hi),
      significantPositive: lo != null && lo > 0,
    };
  });
  reports.sort((a, b) => b.pnlPerEvent - a.pnlPerEvent);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), window: { FROM, TO }, nEvents, reports },
      null,
      2,
    ),
  );

  console.log(`\nevents=${nEvents}\n`);
  console.log(
    'variant'.padEnd(34),
    'eng%'.padEnd(7),
    'pair%'.padEnd(7),
    'naked%'.padEnd(8),
    'sum50'.padEnd(7),
    'PnL/ev'.padEnd(9),
    'lo95'.padEnd(9),
    'hi95'.padEnd(9),
    'PF'.padEnd(7),
    'worst',
  );
  for (const r of reports) {
    console.log(
      r.id.padEnd(34),
      String(r.engagedPct).padEnd(7),
      String(r.pairPct).padEnd(7),
      String(r.nakedPct).padEnd(8),
      String(r.postedSumP50).padEnd(7),
      String(r.pnlPerEvent).padEnd(9),
      String(r.evLo95).padEnd(9),
      String(r.evHi95).padEnd(9),
      String(r.profitFactor).padEnd(7),
      String(r.worst),
      r.significantPositive ? ' ***' : '',
    );
  }
  console.log('\nsaved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
