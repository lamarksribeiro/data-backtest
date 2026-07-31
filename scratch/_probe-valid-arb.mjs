/**
 * Valid-book atomic pair floor opportunities + causal execution sim.
 */
import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FROM = '2026-05-04 15:00:00';
const FEE = 0.07;

function feePs(p, rate = FEE) { return rate * p * (1 - p); }
function feeOn(p, q, rate = FEE) { return q * feePs(p, rate); }
function round(x) { return Math.round(Number(x) * 1e4) / 1e4; }
function n(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }

async function q(conn, sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJson().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)])),
  );
}

const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();

console.log('=== VALID BOOK atomic floors ===');
const summary = await q(conn, `
  WITH base AS (
    SELECT
      condition_id,
      TRY_CAST(ts AS TIMESTAMP) AS ts,
      up_ask_px_1 AS ua, down_ask_px_1 AS da,
      up_bid_px_1 AS ub, down_bid_px_1 AS db,
      up_ask_sz_1 AS uas, down_ask_sz_1 AS das,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      abs(underlying_price - price_to_beat) AS dist
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND up_bid_px_1 BETWEEN 0.01 AND 0.99 AND down_bid_px_1 BETWEEN 0.01 AND 0.99
      AND up_bid_px_1 <= up_ask_px_1 AND down_bid_px_1 <= down_ask_px_1
      AND up_ask_px_1 - up_bid_px_1 <= 0.04
      AND down_ask_px_1 - down_bid_px_1 <= 0.04
      AND up_ask_sz_1 >= 5 AND down_ask_sz_1 >= 5
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 8 AND 280
  ),
  scored AS (
    SELECT *,
      ua + da AS ask_sum,
      1 - ua - da - ${FEE}*ua*(1-ua) - ${FEE}*da*(1-da) AS floor_net,
      1 - ua - da - 0.07*0.56*ua*(1-ua) - 0.07*0.56*da*(1-da) AS floor_net_rebate44,
      least(uas, das) AS pair_sz
    FROM base
  )
  SELECT
    count(*) AS ticks,
    count(*) FILTER (WHERE floor_net > 0) AS ticks_pos,
    count(DISTINCT condition_id) FILTER (WHERE floor_net > 0) AS events_pos,
    count(*) FILTER (WHERE floor_net >= 0.005) AS ticks_5bp,
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= 0.005) AS events_5bp,
    count(*) FILTER (WHERE floor_net >= 0.01) AS ticks_1c,
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= 0.01) AS events_1c,
    count(*) FILTER (WHERE floor_net_rebate44 > 0) AS ticks_rebate_pos,
    count(DISTINCT condition_id) FILTER (WHERE floor_net_rebate44 > 0) AS events_rebate_pos,
    count(*) FILTER (WHERE floor_net >= -0.01 AND floor_net < 0) AS ticks_wc1c,
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= -0.01 AND floor_net < 0) AS events_wc1c,
    max(floor_net) AS best,
    avg(floor_net) FILTER (WHERE floor_net > 0) AS avg_pos,
    quantile_cont(floor_net, 0.999) AS p999
  FROM scored
`);
console.log(JSON.stringify(summary[0], null, 2));

console.log('\n=== Top valid positive floors ===');
const tops = await q(conn, `
  WITH base AS (
    SELECT
      condition_id, ts::VARCHAR AS ts,
      up_ask_px_1 AS ua, down_ask_px_1 AS da,
      up_bid_px_1 AS ub, down_bid_px_1 AS db,
      up_ask_sz_1 AS uas, down_ask_sz_1 AS das,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      1 - up_ask_px_1 - down_ask_px_1
        - ${FEE}*up_ask_px_1*(1-up_ask_px_1)
        - ${FEE}*down_ask_px_1*(1-down_ask_px_1) AS floor_net
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND up_bid_px_1 <= up_ask_px_1 AND down_bid_px_1 <= down_ask_px_1
      AND up_ask_px_1 - up_bid_px_1 <= 0.04
      AND down_ask_px_1 - down_bid_px_1 <= 0.04
      AND up_ask_sz_1 >= 5 AND down_ask_sz_1 >= 5
      AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
  )
  SELECT * FROM base WHERE floor_net > 0
  ORDER BY floor_net DESC LIMIT 25
`);
console.log(JSON.stringify(tops, null, 2));

// Load events for causal sims — sample lighter: only columns needed, filter tau
console.log('\n=== Loading for causal sims ===');
const rows = await q(conn, `
  SELECT
    condition_id,
    epoch_ms(TRY_CAST(ts AS TIMESTAMP)) AS ts_ms,
    epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
    up_ask_px_1 AS ua, down_ask_px_1 AS da,
    up_bid_px_1 AS ub, down_bid_px_1 AS db,
    COALESCE(up_ask_sz_1,0) AS uas, COALESCE(down_ask_sz_1,0) AS das,
    underlying_price AS btc, price_to_beat AS ptb
  FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
  WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
    AND COALESCE(degraded, false) = false AND coverage >= 0.99
    AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
    AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
    AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 5 AND 290
  ORDER BY condition_id, ts_ms
`);
conn.closeSync();

const map = new Map();
for (const r of rows) {
  const id = String(r.condition_id);
  if (!map.has(id)) map.set(id, []);
  map.get(id).push(r);
}
const eventOrder = [...map.keys()].sort((a, b) => Number(map.get(a)[0].ts_ms) - Number(map.get(b)[0].ts_ms));
console.log('events', eventOrder.length, 'rows', rows.length);

/** Walk ask book levels L1 only with slip cap and size fraction */
function buy(ask, sz, budget, slipMax, fillFrac, feeRate) {
  if (!(ask > 0) || !(budget > 0)) return null;
  const px = ask; // L1; slip checked by caller via max price
  const avail = Math.max(0, (sz || 1e9) * fillFrac);
  const q = Math.min(budget / px, avail);
  if (q < 0.5) return null;
  const fee = feeOn(px, q, feeRate);
  return { q, px, cost: q * px, fee };
}

function simAtomic(ticks, v) {
  let done = false;
  let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0;
  let lastBtc = null, lastPtb = null;
  let entry = null;
  const feeRate = v.feeRate ?? FEE;
  const rebate = v.rebateRate ?? 0;

  for (const t of ticks) {
    const ua = n(t.ua), da = n(t.da), ub = n(t.ub), db = n(t.db);
    const tau = n(t.tau), btc = n(t.btc), ptb = n(t.ptb);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (done) continue;
    if (ua == null || da == null || ub == null || db == null || tau == null) continue;
    if (ub > ua || db > da) continue;
    if (ua - ub > v.maxSpread || da - db > v.maxSpread) continue;
    if (tau < v.minTau || tau > v.maxTau) continue;
    if (ua < v.minAsk || ua > v.maxAsk || da < v.minAsk || da > v.maxAsk) continue;
    const floor = 1 - ua - da - feePs(ua, feeRate) - feePs(da, feeRate);
    // after rebate on fees (optimistic cashback)
    const floorReb = floor + rebate * (feePs(ua, feeRate) + feePs(da, feeRate));
    const edge = v.useRebate ? floorReb : floor;
    if (edge < v.minEdge) continue;
    if (ua + da < v.minSum || ua + da > v.maxSum) continue;

    const bUp = buy(ua, n(t.uas), v.budget, v.slipMax, v.fillFrac, feeRate);
    const bDn = buy(da, n(t.das), v.budget, v.slipMax, v.fillFrac, feeRate);
    if (!bUp || !bDn) continue;
    const qq = Math.min(bUp.q, bDn.q);
    if (qq < v.minQty) continue;
    // scale to equal qty
    const up = buy(ua, n(t.uas), qq * ua, v.slipMax, v.fillFrac, feeRate);
    const dn = buy(da, n(t.das), qq * da, v.slipMax, v.fillFrac, feeRate);
    if (!up || !dn) continue;
    const q = Math.min(up.q, dn.q);
    upQ = q; downQ = q;
    upCost = q * ua; downCost = q * da;
    fees = feeOn(ua, q, feeRate) + feeOn(da, q, feeRate);
    const rebateCash = rebate * fees;
    fees = fees - rebateCash; // net fee after rebate
    entry = { ua, da, tau, edge, floor, q, askSum: ua + da };
    done = true;
  }
  if (!done || lastBtc == null || lastPtb == null) return null;
  const winnerUp = lastBtc >= lastPtb;
  const payout = winnerUp ? upQ : downQ;
  const totalCost = upCost + downCost;
  const pnl = payout - totalCost - fees;
  const pnlIfUp = upQ - totalCost - fees;
  const pnlIfDown = downQ - totalCost - fees;
  return {
    kind: 'atomic',
    pnl, fees, totalCost, upQ, downQ,
    pnlIfUp, pnlIfDown,
    worst: Math.min(pnlIfUp, pnlIfDown),
    best: Math.max(pnlIfUp, pnlIfDown),
    balanced: true,
    locked: true,
    entry,
    winnerUp,
  };
}

function simSequential(ticks, v) {
  let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0, cash = 0;
  let opened = false, finished = false;
  let lastBtc = null, lastPtb = null;
  let status = 'none';
  const feeRate = v.feeRate ?? FEE;

  for (const t of ticks) {
    const ua = n(t.ua), da = n(t.da), ub = n(t.ub), db = n(t.db);
    const tau = n(t.tau), btc = n(t.btc), ptb = n(t.ptb);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (ua == null || da == null || ub == null || db == null || tau == null) continue;
    if (ub > ua || db > da) continue;
    if (ua - ub > v.maxSpread || da - db > v.maxSpread) continue;

    if (finished) continue;

    if (opened && Math.abs(upQ - downQ) > 1e-6) {
      const needUp = upQ < downQ;
      const ask = needUp ? ua : da;
      const otherAvg = needUp ? downCost / downQ : upCost / upQ;
      const qNeed = Math.abs(upQ - downQ);
      const avail = needUp ? (n(t.uas) ?? 0) : (n(t.das) ?? 0);
      const qFill = Math.min(qNeed, avail > 0 ? avail * v.fillFrac : qNeed);
      const net = 1 - ask - otherAvg - feePs(ask, feeRate);
      if (qFill >= v.minQty && net >= v.minLockEdge && ask <= v.maxCompleteAsk && tau >= v.minCompleteTau) {
        if (needUp) { upQ += qFill; upCost += qFill * ask; }
        else { downQ += qFill; downCost += qFill * ask; }
        fees += feeOn(ask, qFill, feeRate);
        if (Math.abs(upQ - downQ) < 0.05) { finished = true; status = 'locked'; }
        continue;
      }
      if (v.dump && tau <= v.dumpTau) {
        if (upQ > downQ && ub >= v.minDumpBid) {
          const q = upQ - downQ;
          cash += q * ub; fees += feeOn(ub, q, feeRate);
          const avg = upCost / upQ; upCost -= avg * q; upQ -= q;
          finished = true; status = 'dumped';
        } else if (downQ > upQ && db >= v.minDumpBid) {
          const q = downQ - upQ;
          cash += q * db; fees += feeOn(db, q, feeRate);
          const avg = downCost / downQ; downCost -= avg * q; downQ -= q;
          finished = true; status = 'dumped';
        } else if (tau <= 5) {
          finished = true; status = 'residual';
        }
      }
      continue;
    }

    if (opened) continue;
    if (tau < v.minOpenTau || tau > v.maxOpenTau) continue;
    const ask = Math.min(ua, da);
    const other = Math.max(ua, da);
    const sideUp = ua <= da;
    if (ask < v.minOpenAsk || ask > v.maxOpenAsk) continue;
    if (other < v.minOtherAsk || other > v.maxOtherAsk) continue;
    const sum = ua + da;
    if (sum < v.minSum || sum > v.maxSum) continue;
    const proj = 1 - ask - other - feePs(ask, feeRate) - feePs(other, feeRate);
    if (proj < v.minProj) continue;

    // same-tick complete if enabled and proj ok
    if (v.preferSameTick && proj >= v.minLockEdge) {
      const q = Math.min(v.budget / ask, v.budget / other, (n(t.uas) || 1e9) * v.fillFrac, (n(t.das) || 1e9) * v.fillFrac);
      if (q >= v.minQty) {
        upQ = q; downQ = q;
        upCost = q * ua; downCost = q * da;
        fees = feeOn(ua, q, feeRate) + feeOn(da, q, feeRate);
        opened = true; finished = true; status = 'same_tick_lock';
        continue;
      }
    }

    const avail = sideUp ? (n(t.uas) || 0) : (n(t.das) || 0);
    let q = v.budget / ask;
    if (avail > 0) q = Math.min(q, avail * v.fillFrac);
    if (q < v.minQty) continue;
    if (sideUp) { upQ = q; upCost = q * ask; }
    else { downQ = q; downCost = q * ask; }
    fees = feeOn(ask, q, feeRate);
    opened = true; status = 'opened';
  }

  if (!opened || lastBtc == null || lastPtb == null) return null;
  const winnerUp = lastBtc >= lastPtb;
  const payout = winnerUp ? upQ : downQ;
  const totalCost = upCost + downCost;
  const pnl = cash + payout - totalCost - fees;
  if (!Number.isFinite(pnl)) return null;
  const pnlIfUp = cash + upQ - totalCost - fees;
  const pnlIfDown = cash + downQ - totalCost - fees;
  const balanced = Math.abs(upQ - downQ) <= 0.05;
  return {
    kind: 'seq',
    status,
    pnl, fees, totalCost, upQ, downQ,
    pnlIfUp, pnlIfDown,
    worst: Math.min(pnlIfUp, pnlIfDown),
    best: Math.max(pnlIfUp, pnlIfDown),
    balanced, locked: balanced,
    winnerUp,
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
  const bal = results.filter((r) => r.balanced).length;
  const fees = results.reduce((a, r) => a + r.fees, 0);
  const neut = results.filter((r) => Math.abs(r.pnlIfUp - r.pnlIfDown) < 0.2).length;
  return {
    name, n: results.length,
    total: round(total), avg: round(total / results.length),
    wr: round(wins / results.length), lr: round(losses / results.length), fr: round(flats / results.length),
    pf: round(pf), dd: round(dd),
    bal: round(bal / results.length),
    fees: round(fees),
    neut: round(neut / results.length),
    avgWorst: round(results.reduce((a, r) => a + r.worst, 0) / results.length),
    avgBest: round(results.reduce((a, r) => a + r.best, 0) / results.length),
  };
}

function run(simFn, v) {
  const results = [];
  for (const id of eventOrder) {
    const r = simFn(map.get(id), v);
    if (r) results.push({ ...r, id, ts: map.get(id)[0].ts_ms });
  }
  const n = results.length;
  const i1 = Math.floor(n * 0.6), i2 = Math.floor(n * 0.8);
  // last 72h / 24h by timestamp
  const maxTs = Math.max(...eventOrder.map((id) => Number(map.get(id)[0].ts_ms)));
  const h72 = maxTs - 72 * 3600 * 1000;
  const h24 = maxTs - 24 * 3600 * 1000;
  return {
    full: summarize(results, v.id),
    train: summarize(results.slice(0, i1), 'train'),
    val: summarize(results.slice(i1, i2), 'val'),
    hold: summarize(results.slice(i2), 'hold'),
    last72: summarize(results.filter((r) => Number(r.ts) >= h72), 'l72'),
    last24: summarize(results.filter((r) => Number(r.ts) >= h24), 'l24'),
  };
}

// baselines
function simOnlySide(ticks, side, v) {
  let q = 0, cost = 0, fees = 0, done = false;
  let lastBtc = null, lastPtb = null;
  for (const t of ticks) {
    const ua = n(t.ua), da = n(t.da), ub = n(t.ub), db = n(t.db);
    const tau = n(t.tau), btc = n(t.btc), ptb = n(t.ptb);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (done) continue;
    if (ua == null || da == null || tau == null) continue;
    if (tau < v.minTau || tau > v.maxTau) continue;
    const ask = side === 'UP' ? ua : da;
    const bid = side === 'UP' ? ub : db;
    if (ask == null || ask < v.minAsk || ask > v.maxAsk) continue;
    if (bid != null && bid > ask) continue;
    const qq = Math.min(v.budget / ask, ((side === 'UP' ? n(t.uas) : n(t.das)) || 1e9) * v.fillFrac);
    if (qq < v.minQty) continue;
    q = qq; cost = qq * ask; fees = feeOn(ask, qq);
    done = true;
  }
  if (!done || lastBtc == null) return null;
  const winnerUp = lastBtc >= lastPtb;
  const win = (side === 'UP' && winnerUp) || (side === 'DOWN' && !winnerUp);
  const pnl = (win ? q : 0) - cost - fees;
  return { pnl, fees, balanced: false, pnlIfUp: (side === 'UP' ? q : 0) - cost - fees, pnlIfDown: (side === 'DOWN' ? q : 0) - cost - fees, worst: -cost - fees, best: q - cost - fees };
}

function simRandomDual(ticks, v) {
  // random entry time in window, buy both at asks
  const candidates = ticks.filter((t) => {
    const tau = n(t.tau);
    return tau != null && tau >= v.minTau && tau <= v.maxTau && n(t.ua) > 0 && n(t.da) > 0;
  });
  if (!candidates.length) return null;
  const t = candidates[Math.floor(candidates.length * 0.3)]; // deterministic pseudo-random mid
  const ua = n(t.ua), da = n(t.da);
  const q = Math.min(v.budget / ua, v.budget / da);
  const fees = feeOn(ua, q) + feeOn(da, q);
  const cost = q * (ua + da);
  let lastBtc = n(ticks[ticks.length - 1].btc), lastPtb = n(ticks[ticks.length - 1].ptb);
  const winnerUp = lastBtc >= lastPtb;
  const pnl = q - cost - fees;
  return { pnl, fees, balanced: true, pnlIfUp: pnl, pnlIfDown: pnl, worst: pnl, best: pnl };
}

const variants = [
  { id: 'A-atomic-5bp', minEdge: 0.005, minTau: 10, maxTau: 250, minAsk: 0.05, maxAsk: 0.95, maxSpread: 0.04, minSum: 0.5, maxSum: 1.05, budget: 15, fillsFrac: 0.5, minQty: 2, feeRate: 0.07, rebateRate: 0, useRebate: false },
  { id: 'A-atomic-0', minEdge: 0.0, minTau: 10, maxTau: 250, minAsk: 0.05, maxAsk: 0.95, maxSpread: 0.04, minSum: 0.5, maxSum: 1.05, budget: 15, fillsFrac: 0.5, minQty: 2, feeRate: 0.07, rebateRate: 0, useRebate: false },
  { id: 'A-atomic-1c', minEdge: 0.01, minTau: 10, maxTau: 250, minAsk: 0.05, maxAsk: 0.95, maxSpread: 0.04, minSum: 0.5, maxSum: 1.05, budget: 15, fillsFrac: 0.5, minQty: 2 },
  { id: 'A-atomic-rebate44-0', minEdge: 0.0, minTau: 10, maxTau: 250, minAsk: 0.05, maxAsk: 0.95, maxSpread: 0.04, budget: 15, fillsFrac: 0.5, minQty: 2, feeRate: 0.07, rebateRate: 0.44, useRebate: true, minSum: 0.5, maxSum: 1.05 },
  { id: 'A-atomic-tight-spread', minEdge: 0.005, minTau: 15, maxTau: 200, minAsk: 0.1, maxAsk: 0.9, maxSpread: 0.02, budget: 10, fillsFrac: 0.5, minQty: 2, minSum: 0.5, maxSum: 1.02 },
  { id: 'B-seq-armed-0', minOpenTau: 40, maxOpenTau: 200, minOpenAsk: 0.2, maxOpenAsk: 0.52, minOtherAsk: 0.45, maxOtherAsk: 0.55, minSum: 0.95, maxSum: 1.06, minProj: -0.005, minLockEdge: 0.0, maxCompleteAsk: 0.55, minCompleteTau: 8, dump: true, dumpTau: 15, minDumpBid: 0.05, budget: 10, fillsFrac: 0.7, minQty: 1, maxSpread: 0.04, preferSameTick: true },
  { id: 'B-seq-armed-5bp', minOpenTau: 40, maxOpenTau: 200, minOpenAsk: 0.2, maxOpenAsk: 0.50, minOtherAsk: 0.45, maxOtherAsk: 0.52, minSum: 0.96, maxSum: 1.04, minProj: 0.0, minLockEdge: 0.005, maxCompleteAsk: 0.52, minCompleteTau: 8, dump: true, dumpTau: 12, minDumpBid: 0.05, budget: 10, fillsFrac: 0.7, minQty: 1, maxSpread: 0.03, preferSameTick: true },
  { id: 'B-seq-cheaper-dump', minOpenTau: 60, maxOpenTau: 180, minOpenAsk: 0.15, maxOpenAsk: 0.40, minOtherAsk: 0.50, maxOtherAsk: 0.80, minSum: 0.95, maxSum: 1.10, minProj: -1, minLockEdge: 0.02, maxCompleteAsk: 0.70, minCompleteTau: 10, dump: true, dumpTau: 20, minDumpBid: 0.04, budget: 10, fillsFrac: 1, minQty: 1, maxSpread: 0.06, preferSameTick: false },
  { id: 'C-quasi-floor-hold', minEdge: -0.01, minTau: 30, maxTau: 180, minAsk: 0.25, maxAsk: 0.70, maxSpread: 0.03, minSum: 0.98, maxSum: 1.015, budget: 10, fillsFrac: 0.5, minQty: 2, feeRate: 0.07, rebateRate: 0, useRebate: false },
];

for (const v of variants) {
  const sim = v.id.startsWith('B-') ? simSequential : simAtomic;
  console.log(JSON.stringify(run(sim, v)));
}

// baselines on same events
console.log('BASELINES');
console.log(JSON.stringify(run((ticks) => simOnlySide(ticks, 'UP', { minTau: 60, maxTau: 180, minAsk: 0.2, maxAsk: 0.55, budget: 10, fillsFrac: 0.5, minQty: 1 }), { id: 'base-only-UP' })));
console.log(JSON.stringify(run((ticks) => simOnlySide(ticks, 'DOWN', { minTau: 60, maxTau: 180, minAsk: 0.2, maxAsk: 0.55, budget: 10, fillsFrac: 0.5, minQty: 1 }), { id: 'base-only-DOWN' })));
console.log(JSON.stringify(run((ticks) => simRandomDual(ticks, { minTau: 60, maxTau: 180, budget: 10 }), { id: 'base-random-dual' })));
