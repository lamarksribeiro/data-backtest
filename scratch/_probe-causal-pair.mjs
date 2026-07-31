/**
 * Causal sequential pair-floor probe (honest, no lookahead).
 * Open one leg → complete when lock_net >= threshold → else dump residual.
 */
import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FROM = '2026-05-04 15:00:00';
const FEE = 0.07;

function feeOn(p, q) {
  return q * FEE * p * (1 - p);
}
function round4(x) {
  return Math.round(Number(x) * 10000) / 10000;
}

async function q(conn, sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJson().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
  );
}

function groupByEvent(rows) {
  const map = new Map();
  for (const r of rows) {
    const id = String(r.condition_id);
    let arr = map.get(id);
    if (!arr) {
      arr = [];
      map.set(id, arr);
    }
    arr.push(r);
  }
  return map;
}

function sim(ticks, v) {
  let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0, cash = 0;
  let opened = false, locked = false, dumped = false;
  let openSide = null, openAsk = 0, openTau = 0;
  let lastBtc = null, lastPtb = null;
  let status = 'none';
  let lockNet = null;
  let entryTs = null;

  for (const t of ticks) {
    const ua = Number(t.ua), da = Number(t.da);
    const ub = Number(t.ub), db = Number(t.db);
    const tau = Number(t.tau);
    const btc = Number(t.btc), ptb = Number(t.ptb);
    lastBtc = btc; lastPtb = ptb;
    if (!(ua > 0 && da > 0 && ub > 0 && db > 0)) continue;
    // reject inverted books
    if (ub > ua + 1e-9 || db > da + 1e-9) continue;
    if (ua - ub > v.maxSpread || da - db > v.maxSpread) continue;

    if (locked || dumped) continue;

    // try complete residual
    if (opened && Math.abs(upQ - downQ) > 1e-9) {
      const needUp = upQ < downQ;
      const ask = needUp ? ua : da;
      const bid = needUp ? ub : db;
      const otherAvg = needUp ? downCost / downQ : upCost / upQ;
      const qNeed = Math.abs(upQ - downQ);
      // size limited by available? use best ask only with partial fill ratio
      const avail = needUp ? Number(t.uas) : Number(t.das);
      const qFill = Math.min(qNeed, avail * v.fillFraction, v.budget / Math.max(ask, 0.01));
      if (qFill <= 0.01) {
        // dump path below
      } else {
        const feeLeg = FEE * ask * (1 - ask);
        const net = 1 - ask - otherAvg - feeLeg;
        if (net >= v.minLockEdge && ask <= v.maxCompleteAsk && tau >= v.minCompleteTau) {
          if (needUp) { upQ += qFill; upCost += qFill * ask; }
          else { downQ += qFill; downCost += qFill * ask; }
          fees += feeOn(ask, qFill);
          if (Math.abs(upQ - downQ) <= 0.05) {
            locked = true;
            lockNet = net;
            status = 'locked';
          }
          continue;
        }
      }

      // dump residual
      const hopeless = ask > v.hopelessAsk;
      const timeCut = tau <= v.dumpTau;
      if (v.dump && (timeCut || (hopeless && tau <= v.hopelessDumpTau))) {
        if (upQ > downQ && ub > v.minDumpBid) {
          const q = upQ - downQ;
          const avg = upCost / upQ;
          // sell residual: cash gets bid*q, reduce inventory; fees on sell
          cash += q * ub;
          fees += feeOn(ub, q);
          upCost -= avg * q;
          upQ -= q;
          dumped = true;
          status = 'dumped';
        } else if (downQ > upQ && db > v.minDumpBid) {
          const q = downQ - upQ;
          const avg = downCost / downQ;
          cash += q * db;
          fees += feeOn(db, q);
          downCost -= avg * q;
          downQ -= q;
          dumped = true;
          status = 'dumped';
        } else if (timeCut) {
          // forced hold residual to settlement
          dumped = true;
          status = 'residual_hold';
        }
      }
      continue;
    }

    if (opened) continue;
    if (tau < v.minOpenTau || tau > v.maxOpenTau) continue;

    const sum = ua + da;
    if (sum < v.minOddsSum || sum > v.maxOddsSum) continue;

    // choose open side by mode
    let side = null, ask = null;
    if (v.mode === 'cheaper') {
      if (ua <= da) { side = 'UP'; ask = ua; }
      else { side = 'DOWN'; ask = da; }
    } else if (v.mode === 'favorite') {
      side = btc >= ptb ? 'UP' : 'DOWN';
      ask = side === 'UP' ? ua : da;
    } else if (v.mode === 'underdog') {
      side = btc >= ptb ? 'DOWN' : 'UP';
      ask = side === 'UP' ? ua : da;
    } else if (v.mode === 'balanced_dual') {
      // simultaneous dual if both mid-range and sum cheap enough after fee floor
      const feeU = FEE * ua * (1 - ua);
      const feeD = FEE * da * (1 - da);
      const floor = 1 - ua - da - feeU - feeD;
      if (floor < v.minFloorAtDual) continue;
      if (ua < v.minOpenAsk || ua > v.maxOpenAsk || da < v.minOpenAsk || da > v.maxOpenAsk) continue;
      const q = Math.min(v.budget / ua, v.budget / da, Number(t.uas) * v.fillFraction, Number(t.das) * v.fillFraction);
      if (q < v.minQty) continue;
      upQ = q; downQ = q;
      upCost = q * ua; downCost = q * da;
      fees += feeOn(ua, q) + feeOn(da, q);
      opened = true;
      locked = true;
      lockNet = floor;
      status = 'dual_locked';
      entryTs = t.ts;
      continue;
    }

    if (!side) continue;
    if (ask < v.minOpenAsk || ask > v.maxOpenAsk) continue;
    const other = side === 'UP' ? da : ua;
    if (other < v.minOtherAsk || other > v.maxOtherAsk) continue;

    // optional: require projected lock possibility (other not hopeless)
    const projected = 1 - ask - other - FEE * ask * (1 - ask) - FEE * other * (1 - other);
    if (v.requireProjectable && projected < v.minProjectedAtOpen) continue;

    const avail = side === 'UP' ? Number(t.uas) : Number(t.das);
    const q = Math.min(v.budget / ask, avail * v.fillFraction);
    if (q < v.minQty) continue;

    if (side === 'UP') { upQ = q; upCost = q * ask; }
    else { downQ = q; downCost = q * ask; }
    fees += feeOn(ask, q);
    opened = true;
    openSide = side;
    openAsk = ask;
    openTau = tau;
    entryTs = t.ts;
    status = 'opened';
  }

  if (!opened) return null;

  const winnerUp = lastBtc >= lastPtb;
  const payout = (winnerUp ? upQ : downQ) * 1.0;
  const totalCost = upCost + downCost;
  const pnl = cash + payout - totalCost - fees;
  const pnlIfUp = cash + upQ - totalCost - fees;
  const pnlIfDown = cash + downQ - totalCost - fees;
  const worst = Math.min(pnlIfUp, pnlIfDown);
  const best = Math.max(pnlIfUp, pnlIfDown);

  return {
    status,
    openSide,
    openAsk,
    openTau,
    lockNet,
    upQ: round4(upQ),
    downQ: round4(downQ),
    totalCost: round4(totalCost),
    fees: round4(fees),
    cash: round4(cash),
    pnl: round4(pnl),
    pnlIfUp: round4(pnlIfUp),
    pnlIfDown: round4(pnlIfDown),
    worst: round4(worst),
    best: round4(best),
    winnerUp,
    balanced: Math.abs(upQ - downQ) < 0.05,
  };
}

function summarize(results, name) {
  if (!results.length) return { name, n: 0 };
  const pnls = results.map((r) => r.pnl);
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((x) => x > 0.01).length;
  const losses = pnls.filter((x) => x < -0.01).length;
  const flats = pnls.length - wins - losses;
  const gp = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  const pf = gl > 1e-9 ? gp / gl : gp > 0 ? Infinity : 0;
  // equity dd
  let eq = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  const locked = results.filter((r) => r.status === 'locked' || r.status === 'dual_locked').length;
  const dumped = results.filter((r) => r.status === 'dumped').length;
  const residual = results.filter((r) => r.status === 'residual_hold' || r.status === 'opened').length;
  const nearZeroWorst = results.filter((r) => r.worst >= -0.5).length;
  const sideNeutral = results.filter((r) => Math.abs(r.pnlIfUp - r.pnlIfDown) < 0.5).length;
  const avgWorst = results.reduce((a, r) => a + r.worst, 0) / results.length;
  const avgBest = results.reduce((a, r) => a + r.best, 0) / results.length;
  const feeSum = results.reduce((a, r) => a + r.fees, 0);
  return {
    name,
    n: results.length,
    totalPnl: round4(total),
    avgPnl: round4(total / results.length),
    winRate: round4(wins / results.length),
    lossRate: round4(losses / results.length),
    flatRate: round4(flats / results.length),
    pf: round4(pf),
    maxDd: round4(maxDd),
    lockedPct: round4(locked / results.length),
    dumpedPct: round4(dumped / results.length),
    residualPct: round4(residual / results.length),
    sideNeutralPct: round4(sideNeutral / results.length),
    nearZeroWorstPct: round4(nearZeroWorst / results.length),
    avgWorst: round4(avgWorst),
    avgBest: round4(avgBest),
    feeSum: round4(feeSum),
    feeDragPct: total !== 0 ? round4(100 * feeSum / (Math.abs(total) + feeSum)) : null,
  };
}

function splitResults(results, eventsOrder) {
  // results already in event order
  const n = results.length;
  const i1 = Math.floor(n * 0.6);
  const i2 = Math.floor(n * 0.8);
  return {
    train: summarize(results.slice(0, i1), 'train'),
    val: summarize(results.slice(i1, i2), 'val'),
    hold: summarize(results.slice(i2), 'hold'),
  };
}

const variants = [
  {
    name: 'cheaper-lock5bp-dump',
    mode: 'cheaper',
    budget: 10,
    fillsFraction: 0.5,
    minQty: 2,
    minOpenTau: 70,
    maxOpenTau: 200,
    minOpenAsk: 0.20,
    maxOpenAsk: 0.48,
    minOtherAsk: 0.48,
    maxOtherAsk: 0.72,
    minOddsSum: 0.95,
    maxOddsSum: 1.08,
    maxSpread: 0.05,
    minLockEdge: 0.005,
    maxCompleteAsk: 0.70,
    minCompleteTau: 12,
    dump: true,
    dumpTau: 20,
    hopelessAsk: 0.75,
    hopelessDumpTau: 40,
    minDumpBid: 0.05,
    requireProjectable: false,
    minProjectedAtOpen: -0.05,
  },
  {
    name: 'cheaper-lock1c-strict',
    mode: 'cheaper',
    budget: 10,
    fillsFraction: 0.5,
    minQty: 2,
    minOpenTau: 80,
    maxOpenTau: 180,
    minOpenAsk: 0.25,
    maxOpenAsk: 0.45,
    minOtherAsk: 0.50,
    maxOtherAsk: 0.70,
    minOddsSum: 0.98,
    maxOddsSum: 1.05,
    maxSpread: 0.04,
    minLockEdge: 0.01,
    maxCompleteAsk: 0.60,
    minCompleteTau: 15,
    dump: true,
    dumpTau: 25,
    hopelessAsk: 0.70,
    hopelessDumpTau: 45,
    minDumpBid: 0.08,
    requireProjectable: true,
    minProjectedAtOpen: -0.08,
  },
  {
    name: 'underdog-lock5bp',
    mode: 'underdog',
    budget: 10,
    fillsFraction: 0.5,
    minQty: 2,
    minOpenTau: 70,
    maxOpenTau: 200,
    minOpenAsk: 0.20,
    maxOpenAsk: 0.48,
    minOtherAsk: 0.48,
    maxOtherAsk: 0.75,
    minOddsSum: 0.95,
    maxOddsSum: 1.08,
    maxSpread: 0.05,
    minLockEdge: 0.005,
    maxCompleteAsk: 0.70,
    minCompleteTau: 12,
    dump: true,
    dumpTau: 20,
    hopelessAsk: 0.75,
    hopelessDumpTau: 40,
    minDumpBid: 0.05,
    requireProjectable: false,
  },
  {
    name: 'favorite-lock5bp',
    mode: 'favorite',
    budget: 10,
    fillsFraction: 0.5,
    minQty: 2,
    minOpenTau: 70,
    maxOpenTau: 200,
    minOpenAsk: 0.35,
    maxOpenAsk: 0.58,
    minOtherAsk: 0.40,
    maxOtherAsk: 0.65,
    minOddsSum: 0.95,
    maxOddsSum: 1.08,
    maxSpread: 0.05,
    minLockEdge: 0.005,
    maxCompleteAsk: 0.70,
    minCompleteTau: 12,
    dump: true,
    dumpTau: 20,
    hopelessAsk: 0.75,
    hopelessDumpTau: 40,
    minDumpBid: 0.05,
    requireProjectable: false,
  },
  {
    name: 'dual-only-true-floor',
    mode: 'balanced_dual',
    budget: 10,
    fillsFraction: 0.5,
    minQty: 2,
    minOpenTau: 30,
    maxOpenTau: 250,
    minOpenAsk: 0.15,
    maxOpenAsk: 0.80,
    minOddsSum: 0.5,
    maxOddsSum: 1.2,
    maxSpread: 0.04,
    minFloorAtDual: 0.005,
    dump: false,
  },
  {
    name: 'cheaper-no-dump-hold',
    mode: 'cheaper',
    budget: 10,
    fillsFraction: 0.5,
    minQty: 2,
    minOpenTau: 70,
    maxOpenTau: 200,
    minOpenAsk: 0.20,
    maxOpenAsk: 0.48,
    minOtherAsk: 0.48,
    maxOtherAsk: 0.72,
    minOddsSum: 0.95,
    maxOddsSum: 1.08,
    maxSpread: 0.05,
    minLockEdge: 0.005,
    maxCompleteAsk: 0.70,
    minCompleteTau: 12,
    dump: false,
    dumpTau: 0,
    hopelessAsk: 1,
    hopelessDumpTau: 0,
    minDumpBid: 0.05,
  },
];

const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
console.log('Loading ticks...');
const rows = await q(conn, `
  SELECT
    condition_id,
    ts,
    up_ask_px_1 AS ua,
    down_ask_px_1 AS da,
    up_bid_px_1 AS ub,
    down_bid_px_1 AS db,
    up_ask_sz_1 AS uas,
    down_ask_sz_1 AS das,
    underlying_price AS btc,
    price_to_beat AS ptb,
    epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
  FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
  WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
    AND COALESCE(degraded, false) = false
    AND coverage >= 0.99
    AND up_ask_px_1 IS NOT NULL AND down_ask_px_1 IS NOT NULL
    AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
  ORDER BY condition_id, ts
`);
console.log('rows', rows.length);
const byEvent = groupByEvent(rows);
const eventIds = [...byEvent.keys()];
console.log('events', eventIds.length);
conn.closeSync();

// time-ordered events by first ts
const eventMeta = eventIds.map((id) => ({ id, ts: byEvent.get(id)[0]?.ts })).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

for (const v of variants) {
  const results = [];
  for (const { id } of eventMeta) {
    const r = sim(byEvent.get(id), v);
    if (r) results.push(r);
  }
  const full = summarize(results, v.name);
  const splits = splitResults(results);
  // recent windows by event order approx last 72h ~ 72*12=864 events, 24h~288
  const last72 = summarize(results.slice(-Math.min(results.length, 800)), 'last72ish');
  const last24 = summarize(results.slice(-Math.min(results.length, 280)), 'last24ish');
  console.log(JSON.stringify({ full, splits, last72, last24 }, null, 2));
}
