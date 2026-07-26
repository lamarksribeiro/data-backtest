/**
 * Mineração de edge side-neutral (PnL ~idêntico se UP ou DOWN vencer quando pareado).
 * Uso: node --max-old-space-size=8192 scratch/mine-side-neutral.mjs
 */
import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FEE = 0.07;
const BUDGET = 10;

function feeOn(p, q) {
  return q * FEE * p * (1 - p);
}

function round(x) {
  return Math.round(Number(x) * 10000) / 10000;
}

async function query(conn, sql) {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJson();
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

/**
 * Causal completion:
 * - compra 1ª perna quando ask <= maxFirstAsk e tau alto
 * - completa a 2ª só se 1 - ask2 - avg1 - fee2 >= minLockEdge
 * - residual: hold to settlement OU dump no bid se dump=true
 */
function simCompletion(ticks, v) {
  let upQ = 0;
  let downQ = 0;
  let upCost = 0;
  let downCost = 0;
  let fees = 0;
  let cash = 0;
  let entries = 0;
  let opened = false;
  let locked = false;
  let lastBtc = null;
  let lastPtb = null;
  let upPeak = 0;
  let downPeak = 0;

  for (const t of ticks) {
    const ua = Number(t.ua);
    const da = Number(t.da);
    const ub = Number(t.ub);
    const db = Number(t.db);
    const tau = Number(t.tau);
    lastBtc = Number(t.btc);
    lastPtb = Number(t.ptb);
    if (!(ua > 0 && da > 0)) continue;
    upPeak = Math.max(upPeak, ua);
    downPeak = Math.max(downPeak, da);

    if (locked) continue;

    // try complete
    if (opened && Math.abs(upQ - downQ) > 1e-9) {
      const needUp = upQ < downQ;
      const ask = needUp ? ua : da;
      const otherAvg = needUp ? downCost / downQ : upCost / upQ;
      const qNeed = Math.abs(upQ - downQ);
      const feeLeg = FEE * ask * (1 - ask);
      const net = 1 - ask - otherAvg - feeLeg;
      const pullOk = !v.onlyPullback
        || (needUp ? upPeak - ua >= v.pullbackFrom : downPeak - da >= v.pullbackFrom);
      if (net >= v.minLockEdge && ask <= v.maxCompleteAsk && tau >= v.minCompleteTau && pullOk) {
        if (needUp) {
          upQ += qNeed;
          upCost += qNeed * ask;
        } else {
          downQ += qNeed;
          downCost += qNeed * ask;
        }
        fees += feeOn(ask, qNeed);
        entries += 1;
        locked = true;
        continue;
      }
      if (v.dump && tau <= v.dumpTau) {
        if (upQ > downQ && ub > 0.01) {
          const q = upQ - downQ;
          cash += q * ub;
          fees += feeOn(ub, q);
          const avg = upCost / upQ;
          upCost -= avg * q;
          upQ -= q;
          entries += 1;
          locked = true; // flat residual
        } else if (downQ > upQ && db > 0.01) {
          const q = downQ - upQ;
          cash += q * db;
          fees += feeOn(db, q);
          const avg = downCost / downQ;
          downCost -= avg * q;
          downQ -= q;
          entries += 1;
          locked = true;
        }
      }
      continue;
    }

    if (opened) continue;
    if (tau < v.minOpenTau || tau > v.maxOpenTau) continue;

    let side = null;
    let ask = null;
    const upOk = ua <= v.maxFirstAsk && (!v.onlyPullback || upPeak - ua >= v.pullbackFrom);
    const downOk = da <= v.maxFirstAsk && (!v.onlyPullback || downPeak - da >= v.pullbackFrom);
    if (upOk && downOk) {
      if (ua <= da) {
        side = 'UP';
        ask = ua;
      } else {
        side = 'DOWN';
        ask = da;
      }
    } else if (upOk) {
      side = 'UP';
      ask = ua;
    } else if (downOk) {
      side = 'DOWN';
      ask = da;
    }
    if (!side) continue;

    // optional: require other side expensive enough that a future flip can complete
    if (v.minOtherAsk != null) {
      const other = side === 'UP' ? da : ua;
      if (other < v.minOtherAsk) continue;
    }

    const q = BUDGET / ask;
    if (side === 'UP') {
      upQ += q;
      upCost += q * ask;
    } else {
      downQ += q;
      downCost += q * ask;
    }
    fees += feeOn(ask, q);
    entries += 1;
    opened = true;
  }

  if (entries === 0) return null;
  const winnerUp = lastBtc >= lastPtb;
  const payout = winnerUp ? upQ : downQ;
  const pnl = cash + payout - upCost - downCost - fees;
  return {
    pnl,
    entries,
    residual: Math.abs(upQ - downQ),
    pairs: Math.min(upQ, downQ),
    locked: locked && Math.min(upQ, downQ) > 0 && Math.abs(upQ - downQ) < 1e-6,
  };
}

function simEqualSum(ticks, v) {
  let upQ = 0;
  let downQ = 0;
  let upCost = 0;
  let downCost = 0;
  let fees = 0;
  let entries = 0;
  let lastBtc = null;
  let lastPtb = null;
  for (const t of ticks) {
    const ua = Number(t.ua);
    const da = Number(t.da);
    const tau = Number(t.tau);
    lastBtc = Number(t.btc);
    lastPtb = Number(t.ptb);
    if (entries > 0) continue;
    if (tau < 15 || tau > 240) continue;
    const sum = ua + da;
    const feePair = FEE * ua * (1 - ua) + FEE * da * (1 - da);
    const net = 1 - sum - feePair;
    if (sum <= v.maxSum && net >= v.minLockEdge) {
      const q = BUDGET / Math.max(sum, 0.01);
      upQ = q;
      downQ = q;
      upCost = q * ua;
      downCost = q * da;
      fees = feeOn(ua, q) + feeOn(da, q);
      entries = 2;
    }
  }
  if (entries === 0) return null;
  const winnerUp = lastBtc >= lastPtb;
  const payout = winnerUp ? upQ : downQ;
  return {
    pnl: payout - upCost - downCost - fees,
    entries,
    residual: 0,
    pairs: upQ,
    locked: true,
  };
}

function summarize(eventMap, runOne, label) {
  let totalPnl = 0;
  let trades = 0;
  let wins = 0;
  let gw = 0;
  let gl = 0;
  let residuals = 0;
  let locked = 0;
  let june = 0;
  let july = 0;
  for (const [, ticks] of eventMap) {
    const r = runOne(ticks);
    if (!r) continue;
    trades += 1;
    totalPnl += r.pnl;
    if (r.pnl > 0) {
      wins += 1;
      gw += r.pnl;
    } else {
      gl += -r.pnl;
    }
    if (r.residual > 1e-6) residuals += 1;
    if (r.locked) locked += 1;
    const dt = String(ticks[0].dt);
    if (dt.startsWith('2026-06')) june += r.pnl;
    else july += r.pnl;
  }
  return {
    id: label,
    trades,
    pnl: round(totalPnl),
    wr: trades ? round(wins / trades) : 0,
    pf: gl > 0 ? round(gw / gl) : (gw > 0 ? 99 : 0),
    exp: trades ? round(totalPnl / trades) : 0,
    locked,
    residuals,
    june: round(june),
    july: round(july),
  };
}

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  console.log('Loading ticks (21d sample)...');
  const rows = await query(conn, `
    SELECT
      condition_id,
      dt,
      epoch_ms(TRY_CAST(ts AS TIMESTAMP)) AS ts_ms,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      underlying_price AS btc,
      price_to_beat AS ptb
    FROM read_parquet('${GLOB}', hive_partitioning=true)
    WHERE COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND dt IN (
        '2026-06-01','2026-06-02','2026-06-03','2026-06-04','2026-06-05',
        '2026-06-06','2026-06-07','2026-06-08','2026-06-09','2026-06-10',
        '2026-06-11','2026-06-12','2026-06-13','2026-06-14',
        '2026-07-01','2026-07-02','2026-07-03','2026-07-04','2026-07-05',
        '2026-07-06','2026-07-07'
      )
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99
      AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 5 AND 290
    ORDER BY condition_id, ts_ms
  `);
  console.log('ticks', rows.length);
  const eventMap = groupByEvent(rows);
  console.log('events', eventMap.size);

  const base = {
    minOpenTau: 40,
    maxOpenTau: 250,
    maxCompleteAsk: 0.85,
    minCompleteTau: 12,
    dumpTau: 12,
    onlyPullback: false,
    pullbackFrom: 0.10,
    minOtherAsk: null,
  };

  const variants = [
    { ...base, id: 'c30-lock02-hold', maxFirstAsk: 0.30, minLockEdge: 0.02, dump: false },
    { ...base, id: 'c30-lock02-dump', maxFirstAsk: 0.30, minLockEdge: 0.02, dump: true },
    { ...base, id: 'c25-lock03-hold', maxFirstAsk: 0.25, minLockEdge: 0.03, dump: false },
    { ...base, id: 'c25-lock03-dump', maxFirstAsk: 0.25, minLockEdge: 0.03, dump: true },
    { ...base, id: 'c35-lock02-hold', maxFirstAsk: 0.35, minLockEdge: 0.02, dump: false },
    { ...base, id: 'c35-lock02-dump', maxFirstAsk: 0.35, minLockEdge: 0.02, dump: true },
    { ...base, id: 'c20-lock05-hold', maxFirstAsk: 0.20, minLockEdge: 0.05, dump: false },
    { ...base, id: 'c20-lock05-dump', maxFirstAsk: 0.20, minLockEdge: 0.05, dump: true },
    { ...base, id: 'c30-lock02-pull', maxFirstAsk: 0.30, minLockEdge: 0.02, dump: false, onlyPullback: true, pullbackFrom: 0.10 },
    { ...base, id: 'c30-lock02-other55', maxFirstAsk: 0.30, minLockEdge: 0.02, dump: false, minOtherAsk: 0.55 },
    { ...base, id: 'c30-lock02-other65', maxFirstAsk: 0.30, minLockEdge: 0.02, dump: false, minOtherAsk: 0.65 },
    { ...base, id: 'c28-lock03-other60-dump', maxFirstAsk: 0.28, minLockEdge: 0.03, dump: true, minOtherAsk: 0.60 },
    { ...base, id: 'c22-lock04-hold', maxFirstAsk: 0.22, minLockEdge: 0.04, dump: false, minOpenTau: 50 },
    { ...base, id: 'c22-lock04-dump', maxFirstAsk: 0.22, minLockEdge: 0.04, dump: true, minOpenTau: 50 },
  ];

  console.log('\n=== Causal completion ===');
  for (const v of variants) {
    console.log(JSON.stringify(summarize(eventMap, (ticks) => simCompletion(ticks, v), v.id)));
  }

  console.log('\n=== Simultaneous equal sum ===');
  for (const maxSum of [0.92, 0.94, 0.95, 0.96, 0.97, 0.98]) {
    const v = { maxSum, minLockEdge: 0.01 };
    console.log(JSON.stringify(summarize(eventMap, (ticks) => simEqualSum(ticks, v), `sum<=${maxSum}`)));
  }

  // Locked-only accounting: only count events that fully locked; residual = 0 contribution? 
  // Better: measure locked subset PnL vs residual subset
  console.log('\n=== Locked-only PnL breakdown (c30-lock02-hold) ===');
  const v = variants[0];
  let lockPnl = 0;
  let lockN = 0;
  let resPnl = 0;
  let resN = 0;
  for (const [, ticks] of eventMap) {
    const r = simCompletion(ticks, v);
    if (!r) continue;
    if (r.locked) {
      lockPnl += r.pnl;
      lockN += 1;
    } else {
      resPnl += r.pnl;
      resN += 1;
    }
  }
  console.log(JSON.stringify({
    locked: { n: lockN, pnl: round(lockPnl), exp: lockN ? round(lockPnl / lockN) : 0 },
    residual: { n: resN, pnl: round(resPnl), exp: resN ? round(resPnl / resN) : 0 },
  }));

  // Only-enter-if-we-require eventual lock: abort open if no lock by tau threshold without dump - already in sim
  // Stricter: only open first leg if current other ask is high AND first is cheap enough that 
  // theoretical complete at current other is still bad (we need a flip) - mean reversion pair
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
