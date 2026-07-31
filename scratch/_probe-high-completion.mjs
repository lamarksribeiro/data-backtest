/**
 * Search for sequential pair rules with completion high enough to beat residual toxicity.
 * Target: completion >= 0.90 and EV > 0 after fees.
 */
import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FROM = '2026-05-04 15:00:00';
const FEE = 0.07;

function feeOn(p, q) { return q * FEE * p * (1 - p); }
function round(x) { return Math.round(Number(x) * 1e4) / 1e4; }
function fin(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

async function load() {
  const db = await DuckDBInstance.create(':memory:');
  const conn = await db.connect();
  const reader = await conn.runAndReadAll(`
    SELECT
      condition_id,
      epoch_ms(TRY_CAST(ts AS TIMESTAMP)) AS ts_ms,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      up_ask_px_1 AS ua, down_ask_px_1 AS da,
      up_bid_px_1 AS ub, down_bid_px_1 AS db,
      COALESCE(up_ask_sz_1, 0) AS uas, COALESCE(down_ask_sz_1, 0) AS das,
      underlying_price AS btc, price_to_beat AS ptb
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 3 AND 295
    ORDER BY condition_id, ts_ms
  `);
  const rows = reader.getRowObjectsJson().map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
  );
  conn.closeSync();
  const map = new Map();
  for (const r of rows) {
    const id = String(r.condition_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(r);
  }
  return map;
}

function sim(ticks, v) {
  let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0, cash = 0;
  let opened = false, locked = false;
  let lastBtc = null, lastPtb = null;
  let openSide = null;
  let otherTrail = []; // recent other asks after open for pullback detect
  let openTs = null;
  let preOtherTrail = []; // before open

  for (const t of ticks) {
    const ua = fin(t.ua), da = fin(t.da), ub = fin(t.ub), db = fin(t.db);
    const tau = fin(t.tau), btc = fin(t.btc), ptb = fin(t.ptb);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (ua == null || da == null || ub == null || db == null || tau == null) continue;
    if (ub > ua + 1e-12 || db > da + 1e-12) continue; // inverted
    if (ua - ub > v.maxSpread || da - db > v.maxSpread) continue;

    if (locked) continue;

    if (opened) {
      const needUp = upQ < downQ - 1e-9;
      const needDown = downQ < upQ - 1e-9;
      if (!needUp && !needDown) { locked = true; continue; }

      const ask = needUp ? ua : da;
      const bidOwn = needUp ? db : ub; // bid of inventory side for dump
      const otherAvg = needUp ? (downCost / downQ) : (upCost / upQ);
      const qNeed = Math.abs(upQ - downQ);
      const avail = needUp ? Number(t.uas) || 0 : Number(t.das) || 0;
      const qFill = Math.min(qNeed, avail > 0 ? avail * v.fillFrac : qNeed, qNeed);

      otherTrail.push(ask);
      if (otherTrail.length > 20) otherTrail.shift();

      const feeLeg = FEE * ask * (1 - ask);
      const net = 1 - ask - otherAvg - feeLeg;
      const pullbackOk = !v.requirePullback || (
        otherTrail.length >= 3 && ask <= Math.min(...otherTrail.slice(0, -1)) - v.pullbackMin
      );

      if (qFill >= v.minQty && net >= v.minLockEdge && ask <= v.maxCompleteAsk && tau >= v.minCompleteTau && pullbackOk) {
        if (needUp) { upQ += qFill; upCost += qFill * ask; }
        else { downQ += qFill; downCost += qFill * ask; }
        fees += feeOn(ask, qFill);
        if (Math.abs(upQ - downQ) <= v.minQty * 0.5) locked = true;
        continue;
      }

      // dump residual
      const timeCut = tau <= v.dumpTau;
      const hopeless = ask > v.hopelessAsk && tau <= v.hopelessDumpTau;
      const waited = openTs != null && (Number(t.ts_ms) - openTs) >= v.maxWaitMs;
      if (v.dump && (timeCut || hopeless || (v.maxWaitMs && waited))) {
        if (upQ > downQ && ub >= v.minDumpBid) {
          const q = upQ - downQ;
          cash += q * ub;
          fees += feeOn(ub, q);
          const avg = upCost / upQ;
          upCost -= avg * q; upQ -= q;
          locked = true; // flat residual; may still hold equal pair
        } else if (downQ > upQ && db >= v.minDumpBid) {
          const q = downQ - upQ;
          cash += q * db;
          fees += feeOn(db, q);
          const avg = downCost / downQ;
          downCost -= avg * q; downQ -= q;
          locked = true;
        } else if (timeCut) {
          locked = true; // stop managing
        }
      }
      continue;
    }

    // not opened
    if (tau < v.minOpenTau || tau > v.maxOpenTau) continue;
    const sum = ua + da;
    if (sum < v.minSum || sum > v.maxSum) continue;

    // track pre-open other trails for both sides
    preOtherTrail.push({ ua, da, tau, ts_ms: Number(t.ts_ms) });
    if (preOtherTrail.length > 30) preOtherTrail.shift();

    let side = null, ask = null, other = null;
    if (v.mode === 'cheaper') {
      if (ua <= da) { side = 'UP'; ask = ua; other = da; }
      else { side = 'DOWN'; ask = da; other = ua; }
    } else if (v.mode === 'favorite') {
      side = btc >= ptb ? 'UP' : 'DOWN';
      ask = side === 'UP' ? ua : da;
      other = side === 'UP' ? da : ua;
    } else if (v.mode === 'near_lock') {
      // only open if already close to lock with current other
      if (ua <= da) { side = 'UP'; ask = ua; other = da; }
      else { side = 'DOWN'; ask = da; other = ua; }
      const proj = 1 - ask - other - FEE * ask * (1 - ask) - FEE * other * (1 - other);
      if (proj < v.minProjAtOpen) continue;
    }

    if (!side) continue;
    if (ask < v.minOpenAsk || ask > v.maxOpenAsk) continue;
    if (other < v.minOtherAsk || other > v.maxOtherAsk) continue;

    // projected lock at current other
    const proj = 1 - ask - other - FEE * ask * (1 - ask) - FEE * other * (1 - other);
    if (v.minProjAtOpen != null && proj < v.minProjAtOpen) continue;

    // require other improving recently (falling)
    if (v.requireOtherFalling && preOtherTrail.length >= 5) {
      const series = preOtherTrail.map((x) => (side === 'UP' ? x.da : x.ua));
      const first = series[0];
      const last = series[series.length - 1];
      if (!(last <= first - v.otherFallMin)) continue;
    }

    // dist filter
    const dist = Math.abs(btc - ptb);
    if (dist < v.minDist || dist > v.maxDist) continue;

    const avail = side === 'UP' ? Number(t.uas) || 0 : Number(t.das) || 0;
    let q = v.budget / ask;
    if (avail > 0) q = Math.min(q, avail * v.fillFrac);
    if (q < v.minQty) continue;

    // SAME-TICK hedge if possible and enabled
    if (v.sameTickHedge) {
      const fee1 = FEE * ask * (1 - ask);
      const fee2 = FEE * other * (1 - other);
      const net = 1 - ask - other - fee1 - fee2;
      if (net >= v.minLockEdge && other <= v.maxCompleteAsk) {
        const oAvail = side === 'UP' ? Number(t.das) || 0 : Number(t.uas) || 0;
        let q2 = q;
        if (oAvail > 0) q2 = Math.min(q2, oAvail * v.fillFrac);
        if (q2 >= v.minQty) {
          const qq = Math.min(q, q2);
          if (side === 'UP') {
            upQ = qq; upCost = qq * ask;
            downQ = qq; downCost = qq * other;
          } else {
            downQ = qq; downCost = qq * ask;
            upQ = qq; upCost = qq * other;
          }
          fees += feeOn(ask, qq) + feeOn(other, qq);
          opened = true; locked = true; openSide = side; openTs = Number(t.ts_ms);
          continue;
        }
      }
    }

    if (side === 'UP') { upQ = q; upCost = q * ask; }
    else { downQ = q; downCost = q * ask; }
    fees += feeOn(ask, q);
    opened = true;
    openSide = side;
    openTs = Number(t.ts_ms);
    otherTrail = [other];
  }

  if (!opened) return null;
  if (lastBtc == null || lastPtb == null) return null;

  const winnerUp = lastBtc >= lastPtb;
  const payout = winnerUp ? upQ : downQ;
  const totalCost = upCost + downCost;
  const pnl = cash + payout - totalCost - fees;
  if (!Number.isFinite(pnl)) return null;

  const balanced = Math.abs(upQ - downQ) <= Math.max(0.05, 0.02 * Math.max(upQ, downQ, 1));
  const pnlIfUp = cash + upQ - totalCost - fees;
  const pnlIfDown = cash + downQ - totalCost - fees;

  return {
    pnl,
    fees,
    balanced,
    locked: balanced,
    openSide,
    pnlIfUp,
    pnlIfDown,
    worst: Math.min(pnlIfUp, pnlIfDown),
    best: Math.max(pnlIfUp, pnlIfDown),
    residual: Math.abs(upQ - downQ),
    totalCost,
    upQ, downQ,
  };
}

function summarize(results, name) {
  if (!results.length) return { name, n: 0 };
  const pnls = results.map((r) => r.pnl);
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((x) => x > 0.01).length;
  const losses = pnls.filter((x) => x < -0.01).length;
  const flats = results.length - wins - losses;
  const gp = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  const pf = gl > 1e-9 ? gp / gl : (gp > 0 ? 99 : 0);
  let eq = 0, peak = 0, dd = 0;
  for (const p of pnls) { eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const locked = results.filter((r) => r.balanced).length;
  const lockPnl = results.filter((r) => r.balanced).reduce((a, r) => a + r.pnl, 0);
  const res = results.filter((r) => !r.balanced);
  const resPnl = res.reduce((a, r) => a + r.pnl, 0);
  const fees = results.reduce((a, r) => a + r.fees, 0);
  const sideNeut = results.filter((r) => Math.abs(r.pnlIfUp - r.pnlIfDown) < 0.25).length;
  const nearZeroWorst = results.filter((r) => r.worst >= -0.75).length;
  return {
    name,
    n: results.length,
    total: round(total),
    avg: round(total / results.length),
    wr: round(wins / results.length),
    lr: round(losses / results.length),
    fr: round(flats / results.length),
    pf: round(pf),
    dd: round(dd),
    completion: round(locked / results.length),
    lockAvg: locked ? round(lockPnl / locked) : null,
    resN: res.length,
    resAvg: res.length ? round(resPnl / res.length) : null,
    fees: round(fees),
    sideNeut: round(sideNeut / results.length),
    nearZeroWorst: round(nearZeroWorst / results.length),
    avgWorst: round(results.reduce((a, r) => a + r.worst, 0) / results.length),
  };
}

function run(map, v) {
  const ids = [...map.keys()].sort((a, b) => (map.get(a)[0].ts_ms - map.get(b)[0].ts_ms));
  const results = [];
  for (const id of ids) {
    const r = sim(map.get(id), v);
    if (r) results.push(r);
  }
  const n = results.length;
  const i1 = Math.floor(n * 0.6), i2 = Math.floor(n * 0.8);
  return {
    full: summarize(results, v.id),
    train: summarize(results.slice(0, i1), 'train'),
    val: summarize(results.slice(i1, i2), 'val'),
    hold: summarize(results.slice(i2), 'hold'),
    last72: summarize(results.slice(-Math.min(n, 800)), 'l72'),
    last24: summarize(results.slice(-Math.min(n, 280)), 'l24'),
  };
}

const base = {
  budget: 10,
  fillsFrac: 1.0,
  minQty: 1,
  maxSpread: 0.05,
  minOpenTau: 60,
  maxOpenTau: 200,
  minOpenAsk: 0.15,
  maxOpenAsk: 0.45,
  minOtherAsk: 0.45,
  maxOtherAsk: 0.75,
  minSum: 0.95,
  maxSum: 1.08,
  minLockEdge: 0.01,
  maxCompleteAsk: 0.65,
  minCompleteTau: 10,
  dump: true,
  dumpTau: 18,
  hopelessAsk: 0.78,
  hopelessDumpTau: 35,
  minDumpBid: 0.04,
  minDist: 0,
  maxDist: 100,
  mode: 'cheaper',
  minProjAtOpen: null,
  requirePullback: false,
  pullbackMin: 0.02,
  requireOtherFalling: false,
  otherFallMin: 0.03,
  sameTickHedge: false,
  maxWaitMs: null,
};

const variants = [
  { ...base, id: 'H1-cheaper-base' },
  { ...base, id: 'H1-near-lock-proj0', mode: 'near_lock', minProjAtOpen: 0.0, maxOpenAsk: 0.55, maxOtherAsk: 0.55 },
  { ...base, id: 'H1-near-lock-m1c', mode: 'near_lock', minProjAtOpen: -0.01, maxOpenAsk: 0.52, maxOtherAsk: 0.55, minLockEdge: 0.0 },
  { ...base, id: 'H1-near-lock-m2c', mode: 'near_lock', minProjAtOpen: -0.02, maxOpenAsk: 0.55, maxOtherAsk: 0.58, minLockEdge: 0.0 },
  { ...base, id: 'H1-same-tick-lock', sameTickHedge: true, minLockEdge: 0.005, maxOpenAsk: 0.55, maxOtherAsk: 0.55, minProjAtOpen: 0.005 },
  { ...base, id: 'H1-same-tick-m1c', sameTickHedge: true, minLockEdge: -0.005, maxOpenAsk: 0.55, maxOtherAsk: 0.55, mode: 'near_lock', minProjAtOpen: -0.01 },
  { ...base, id: 'H2-falling-other', requireOtherFalling: true, otherFallMin: 0.02, maxOpenAsk: 0.40, minLockEdge: 0.005 },
  { ...base, id: 'H2-pullback-complete', requirePullback: true, pullbackMin: 0.02, maxOpenAsk: 0.42 },
  { ...base, id: 'H2-tight-other60', maxOtherAsk: 0.60, maxOpenAsk: 0.42, minLockEdge: 0.01 },
  { ...base, id: 'H2-tight-other55', maxOtherAsk: 0.55, maxOpenAsk: 0.48, minLockEdge: 0.005, mode: 'near_lock', minProjAtOpen: -0.02 },
  { ...base, id: 'H3-late-window', minOpenTau: 30, maxOpenTau: 90, maxOpenAsk: 0.48, maxOtherAsk: 0.65, minLockEdge: 0.005 },
  { ...base, id: 'H3-late-nearlock', minOpenTau: 25, maxOpenTau: 80, mode: 'near_lock', minProjAtOpen: -0.015, maxOpenAsk: 0.55, maxOtherAsk: 0.55, minLockEdge: 0.0, dumpTau: 10 },
  { ...base, id: 'H3-micro-probe', budget: 3, maxOpenAsk: 0.40, maxOtherAsk: 0.65, minLockEdge: 0.01 },
  { ...base, id: 'H4-only-same-tick-pos', sameTickHedge: true, minLockEdge: 0.01, maxOpenAsk: 0.50, maxOtherAsk: 0.50, mode: 'near_lock', minProjAtOpen: 0.01, dump: false },
  { ...base, id: 'H4-only-same-tick-0', sameTickHedge: true, minLockEdge: 0.0, maxOpenAsk: 0.52, maxOtherAsk: 0.52, mode: 'near_lock', minProjAtOpen: 0.0, dump: false },
  { ...base, id: 'H5-dist15-cheap', maxDist: 15, maxOpenAsk: 0.40, maxOtherAsk: 0.65, minLockEdge: 0.015 },
  { ...base, id: 'H5-dist25-near', maxDist: 25, mode: 'near_lock', minProjAtOpen: -0.01, maxOpenAsk: 0.52, maxOtherAsk: 0.55 },
  // selective: only open if proj already almost locked; complete immediately preferred
  { ...base, id: 'H6-armed-m5bp', mode: 'near_lock', minProjAtOpen: -0.005, maxOpenAsk: 0.50, maxOtherAsk: 0.52, minLockEdge: 0.0, sameTickHedge: true, dumpTau: 12, maxCompleteAsk: 0.55 },
  { ...base, id: 'H6-armed-0', mode: 'near_lock', minProjAtOpen: 0.0, maxOpenAsk: 0.49, maxOtherAsk: 0.51, minLockEdge: 0.0, sameTickHedge: true, dumpTau: 12 },
  { ...base, id: 'H6-armed-strict', mode: 'near_lock', minProjAtOpen: 0.005, maxOpenAsk: 0.48, maxOtherAsk: 0.50, minLockEdge: 0.005, sameTickHedge: true, dumpTau: 10, maxSpread: 0.03 },
];

console.log('loading...');
const map = await load();
console.log('events', map.size);
for (const v of variants) {
  const out = run(map, v);
  console.log(JSON.stringify(out));
}
