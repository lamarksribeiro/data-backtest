/**
 * Refino Pair-Lock: maximizar completion rate e cortar residual tóxico.
 * Uso: node --max-old-space-size=8192 scratch/mine-pair-lock.mjs
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

function sim(ticks, v) {
  let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0, cash = 0, entries = 0;
  let opened = false, locked = false;
  let lastBtc = null, lastPtb = null;
  let openDist = null, openTau = null, openAsk = null, openSide = null;
  let minOtherSinceOpen = 1;
  let flipsAfterOpen = 0;
  let prevFav = null;

  for (const t of ticks) {
    const ua = Number(t.ua), da = Number(t.da);
    const ub = Number(t.ub), db = Number(t.db);
    const tau = Number(t.tau);
    const btc = Number(t.btc), ptb = Number(t.ptb);
    lastBtc = btc; lastPtb = ptb;
    if (!(ua > 0 && da > 0)) continue;
    const dist = Math.abs(btc - ptb);
    const favUp = btc >= ptb;
    if (opened && !locked && prevFav != null && prevFav !== favUp) flipsAfterOpen += 1;
    prevFav = favUp;

    if (locked) continue;

    if (opened && Math.abs(upQ - downQ) > 1e-9) {
      const needUp = upQ < downQ;
      const ask = needUp ? ua : da;
      const otherAvg = needUp ? downCost / downQ : upCost / upQ;
      const qNeed = Math.abs(upQ - downQ);
      const feeLeg = FEE * ask * (1 - ask);
      const net = 1 - ask - otherAvg - feeLeg;
      minOtherSinceOpen = Math.min(minOtherSinceOpen, ask);

      if (net >= v.minLockEdge && ask <= v.maxCompleteAsk && tau >= v.minCompleteTau) {
        if (needUp) { upQ += qNeed; upCost += qNeed * ask; }
        else { downQ += qNeed; downCost += qNeed * ask; }
        fees += feeOn(ask, qNeed);
        entries += 1;
        locked = true;
        continue;
      }

      // early dump if other side became hopeless (too expensive) and time short
      const hopeless = ask > v.hopelessAsk;
      const timeCut = tau <= v.dumpTau;
      const noFlipCut = v.maxWaitWithoutFlip != null
        && flipsAfterOpen === 0
        && openTau != null
        && (openTau - tau) >= v.maxWaitWithoutFlip;

      if (v.dump && (timeCut || (hopeless && tau <= v.hopelessDumpTau) || noFlipCut)) {
        // cash receives only net vs cost basis so final pnl = cash + payout - remainingCost - fees
        if (upQ > downQ && ub > 0.01) {
          const q = upQ - downQ;
          const avg = upCost / upQ;
          cash += q * (ub - avg);
          fees += feeOn(ub, q);
          upCost -= avg * q;
          upQ -= q;
          entries += 1;
          locked = true;
        } else if (downQ > upQ && db > 0.01) {
          const q = downQ - upQ;
          const avg = downCost / downQ;
          cash += q * (db - avg);
          fees += feeOn(db, q);
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
    if (dist > v.maxOpenDist) continue;
    if (dist < v.minOpenDist) continue;

    // both sides must show "two-way potential": other side not already dead
    let side = null, ask = null;
    const upOk = ua <= v.maxFirstAsk;
    const downOk = da <= v.maxFirstAsk;
    if (upOk && downOk) {
      if (ua <= da) { side = 'UP'; ask = ua; }
      else { side = 'DOWN'; ask = da; }
    } else if (upOk) { side = 'UP'; ask = ua; }
    else if (downOk) { side = 'DOWN'; ask = da; }
    if (!side) continue;

    const otherAsk = side === 'UP' ? da : ua;
    if (otherAsk < v.minOtherAsk || otherAsk > v.maxOtherAsk) continue;

    // require near-balance odds sum (market not one-sided dead)
    const sum = ua + da;
    if (sum < v.minOddsSum || sum > v.maxOddsSum) continue;

    // spread filter
    if (side === 'UP' && ua - ub > v.maxSpread) continue;
    if (side === 'DOWN' && da - db > v.maxSpread) continue;

    const q = (v.budget || BUDGET) / ask;
    if (side === 'UP') { upQ += q; upCost += q * ask; }
    else { downQ += q; downCost += q * ask; }
    fees += feeOn(ask, q);
    entries += 1;
    opened = true;
    openDist = dist;
    openTau = tau;
    openAsk = ask;
    openSide = side;
    minOtherSinceOpen = otherAsk;
  }

  if (entries === 0) return null;
  const winnerUp = lastBtc >= lastPtb;
  const payout = winnerUp ? upQ : downQ;
  const pnl = cash + payout - upCost - downCost - fees;
  const residual = Math.abs(upQ - downQ);
  const isLockedPair = Math.min(upQ, downQ) > 0 && residual < 1e-6;
  return {
    pnl, entries, residual, locked: isLockedPair, openDist, openTau, openAsk, openSide,
    flipsAfterOpen, minOtherSinceOpen,
  };
}

function runGrid(eventMap, variants) {
  for (const v of variants) {
    let totalPnl = 0, trades = 0, wins = 0, gw = 0, gl = 0;
    let lockN = 0, lockPnl = 0, resN = 0, resPnl = 0;
    let june = 0, july = 0;
    for (const [, ticks] of eventMap) {
      const r = sim(ticks, v);
      if (!r) continue;
      trades += 1;
      totalPnl += r.pnl;
      if (r.pnl > 0) { wins += 1; gw += r.pnl; } else gl += -r.pnl;
      if (r.locked) { lockN += 1; lockPnl += r.pnl; }
      else { resN += 1; resPnl += r.pnl; }
      if (String(ticks[0].dt).startsWith('2026-06')) june += r.pnl;
      else july += r.pnl;
    }
    console.log(JSON.stringify({
      id: v.id,
      trades,
      pnl: round(totalPnl),
      wr: trades ? round(wins / trades) : 0,
      pf: gl > 0 ? round(gw / gl) : (gw > 0 ? 99 : 0),
      exp: trades ? round(totalPnl / trades) : 0,
      lockN,
      lockExp: lockN ? round(lockPnl / lockN) : 0,
      resN,
      resExp: resN ? round(resPnl / resN) : 0,
      completion: trades ? round(lockN / trades) : 0,
      june: round(june),
      july: round(july),
    }));
  }
}

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  console.log('loading...');
  const rows = await query(conn, `
    SELECT
      condition_id, dt,
      epoch_ms(TRY_CAST(ts AS TIMESTAMP)) AS ts_ms,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      up_ask_px_1 AS ua, down_ask_px_1 AS da,
      up_bid_px_1 AS ub, down_bid_px_1 AS db,
      underlying_price AS btc, price_to_beat AS ptb
    FROM read_parquet('${GLOB}', hive_partitioning=true)
    WHERE COALESCE(degraded, false) = false AND coverage >= 0.99
      AND dt IN (
        '2026-06-01','2026-06-02','2026-06-03','2026-06-04','2026-06-05',
        '2026-06-06','2026-06-07','2026-06-08','2026-06-09','2026-06-10',
        '2026-06-11','2026-06-12','2026-06-13','2026-06-14',
        '2026-07-01','2026-07-02','2026-07-03','2026-07-04','2026-07-05',
        '2026-07-06','2026-07-07'
      )
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 5 AND 290
    ORDER BY condition_id, ts_ms
  `);
  const eventMap = groupByEvent(rows);
  console.log('events', eventMap.size);

  const base = {
    minOpenTau: 50,
    maxOpenTau: 240,
    minOpenDist: 0,
    maxOpenDist: 80,
    maxFirstAsk: 0.30,
    minOtherAsk: 0.45,
    maxOtherAsk: 0.95,
    minOddsSum: 0.95,
    maxOddsSum: 1.12,
    maxSpread: 0.06,
    minLockEdge: 0.02,
    maxCompleteAsk: 0.80,
    minCompleteTau: 10,
    dump: true,
    dumpTau: 15,
    hopelessAsk: 0.92,
    hopelessDumpTau: 40,
    maxWaitWithoutFlip: null,
    budget: 10,
  };

  const variants = [
    { ...base, id: 'base-dump' },
    { ...base, id: 'near-ptb-d25', maxOpenDist: 25 },
    { ...base, id: 'near-ptb-d15', maxOpenDist: 15 },
    { ...base, id: 'near-ptb-d35', maxOpenDist: 35 },
    { ...base, id: 'mid-dist-10-40', minOpenDist: 10, maxOpenDist: 40 },
    { ...base, id: 'cheap22-near25', maxFirstAsk: 0.22, maxOpenDist: 25 },
    { ...base, id: 'cheap25-near20', maxFirstAsk: 0.25, maxOpenDist: 20 },
    { ...base, id: 'cheap28-near30', maxFirstAsk: 0.28, maxOpenDist: 30 },
    { ...base, id: 'lock04-near25', maxFirstAsk: 0.28, maxOpenDist: 25, minLockEdge: 0.04 },
    { ...base, id: 'early-dump25', dumpTau: 25, maxOpenDist: 25 },
    { ...base, id: 'early-dump40', dumpTau: 40, maxOpenDist: 25 },
    { ...base, id: 'no-flip-abort60', maxOpenDist: 25, maxWaitWithoutFlip: 60 },
    { ...base, id: 'no-flip-abort40', maxOpenDist: 25, maxWaitWithoutFlip: 40 },
    { ...base, id: 'tight-other-50-85', maxOpenDist: 25, minOtherAsk: 0.50, maxOtherAsk: 0.85 },
    { ...base, id: 'tight-sum', maxOpenDist: 25, minOddsSum: 0.98, maxOddsSum: 1.06 },
    { ...base, id: 'micro-budget5', maxOpenDist: 25, budget: 5 },
    { ...base, id: 'select-c22-d20-lock03-dump30', maxFirstAsk: 0.22, maxOpenDist: 20, minLockEdge: 0.03, dumpTau: 30, maxWaitWithoutFlip: 50 },
    { ...base, id: 'select-c25-d18-lock025-nf45', maxFirstAsk: 0.25, maxOpenDist: 18, minLockEdge: 0.025, dumpTau: 20, maxWaitWithoutFlip: 45 },
    { ...base, id: 'select-c20-d15-lock04', maxFirstAsk: 0.20, maxOpenDist: 15, minLockEdge: 0.04, dumpTau: 25, maxWaitWithoutFlip: 40 },
    { ...base, id: 'hold-near25', maxOpenDist: 25, dump: false },
    { ...base, id: 'hold-select', maxFirstAsk: 0.22, maxOpenDist: 18, dump: false, minLockEdge: 0.03 },
    // require OTHER side also eventually buyable: open only if other currently <= 0.70 (not dead)
    { ...base, id: 'live-other70-d25', maxOpenDist: 25, maxOtherAsk: 0.70 },
    { ...base, id: 'live-other65-d20', maxOpenDist: 20, maxOtherAsk: 0.65, maxFirstAsk: 0.28 },
    { ...base, id: 'live-other60-c25-d20', maxOpenDist: 20, maxOtherAsk: 0.60, maxFirstAsk: 0.25, minOtherAsk: 0.40 },
    { ...base, id: 'balanced-both-cheap', maxFirstAsk: 0.40, maxOpenDist: 30, minOtherAsk: 0.20, maxOtherAsk: 0.40, minLockEdge: 0.02 },
  ];

  console.log('\n=== grid ===');
  runGrid(eventMap, variants);

  // Second idea: buy BOTH when each is under threshold at same tick (soft pair)
  console.log('\n=== soft simultaneous (both asks under cap, not necessarily sum lock) ===');
  // already covered by equal sum

  // Third: multi-tranche pair builder — buy small on each side whenever below threshold, rebalance
  console.log('\n=== continuous rebalance builder ===');
  for (const cfg of [
    { id: 'rb-c40-q2', maxAsk: 0.40, tranche: 2, maxPairs: 5, minLock: 0.0 },
    { id: 'rb-c35-q3', maxAsk: 0.35, tranche: 3, maxPairs: 4, minLock: 0.0 },
    { id: 'rb-c30-q2', maxAsk: 0.30, tranche: 2, maxPairs: 5, minLock: 0.0 },
    { id: 'rb-c45-q2-lock', maxAsk: 0.45, tranche: 2, maxPairs: 8, minLock: 0.01 },
  ]) {
    let totalPnl = 0, trades = 0, wins = 0, gw = 0, gl = 0, june = 0, july = 0;
    for (const [, ticks] of eventMap) {
      let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0;
      let lastBtc = null, lastPtb = null;
      let bought = false;
      for (const t of ticks) {
        const ua = Number(t.ua), da = Number(t.da), tau = Number(t.tau);
        lastBtc = Number(t.btc); lastPtb = Number(t.ptb);
        if (tau < 20 || tau > 250) continue;
        const pairs = Math.min(upQ, downQ);
        if (pairs >= cfg.maxPairs * cfg.tranche) continue;

        // buy lagging cheap side
        if (upQ <= downQ && ua <= cfg.maxAsk && upQ < cfg.maxPairs * cfg.tranche) {
          const q = cfg.tranche;
          // check if this increases imbalance too much without lock path
          const newUp = upQ + q;
          if (newUp - downQ <= cfg.tranche * 1.01 || da <= cfg.maxAsk + 0.15) {
            upQ = newUp; upCost += q * ua; fees += feeOn(ua, q); bought = true;
          }
        } else if (downQ <= upQ && da <= cfg.maxAsk && downQ < cfg.maxPairs * cfg.tranche) {
          const q = cfg.tranche;
          const newDown = downQ + q;
          if (newDown - upQ <= cfg.tranche * 1.01 || ua <= cfg.maxAsk + 0.15) {
            downQ = newDown; downCost += q * da; fees += feeOn(da, q); bought = true;
          }
        }
      }
      if (!bought) continue;
      // optional: only keep locked pairs, dump residual free? hold residual
      const winnerUp = lastBtc >= lastPtb;
      const payout = winnerUp ? upQ : downQ;
      const pnl = payout - upCost - downCost - fees;
      // locked value check
      const paired = Math.min(upQ, downQ);
      const pairCost = paired > 0
        ? (upCost * (paired / upQ) + downCost * (paired / downQ))
        : 0;
      const pairFeesApprox = fees * (2 * paired / Math.max(upQ + downQ, 1e-9));
      const lockedNet = paired - pairCost - pairFeesApprox;
      // if minLock required and not met on pairs, skip event entirely (look-ahead free? this is post-hoc filter - invalid)
      // instead filter during: only buy if projected
      trades += 1;
      totalPnl += pnl;
      if (pnl > 0) { wins += 1; gw += pnl; } else gl += -pnl;
      if (String(ticks[0].dt).startsWith('2026-06')) june += pnl; else july += pnl;
    }
    console.log(JSON.stringify({
      id: cfg.id, trades, pnl: round(totalPnl), wr: trades ? round(wins / trades) : 0,
      pf: gl > 0 ? round(gw / gl) : 0, exp: trades ? round(totalPnl / trades) : 0,
      june: round(june), july: round(july),
    }));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
