/**
 * Seção C — bolsões de perda V5 Practical (train/june).
 *
 * Uso: node --max-old-space-size=6144 labs/sandbox/tfc-v7-diag-loss-pockets.mjs
 * Pré-requisitos: events-v5-practical.json + cubo em labs/mining/cube/
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  FROM, TO, JUNE_CUTOFF, CACHE_DIR, CUBE_DIR,
  binAskFav, binDistAbs, binDistVol, binObi5, binFlips, binHourUtc,
  stats, fmtPct, fmtUsd, loadJson, writeJson, dateRange, v5EntryGates,
} from './tfc-v7-diag-lib.mjs';

const COL = {
  dt: 0, condition_id: 1, ts_ms: 2, tau: 3, dist_abs: 7, fav: 8, ask_fav: 9,
  spread_fav: 11, odds_sum: 14, d_spot_5: 15, sigma_ps_90: 21, flips_60: 22, obi5: 31,
};

function parseNum(s) {
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

async function loadCubeEntries() {
  const firstByCondition = new Map();
  for (const dt of dateRange(FROM, TO)) {
    const filePath = path.join(CUBE_DIR, `dt=${dt}.csv`);
    if (!fs.existsSync(filePath)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo === 1) continue;
      if (!line.trim()) continue;
      const fields = line.split(',');
      const tau = parseNum(fields[COL.tau]);
      const distAbs = parseNum(fields[COL.dist_abs]);
      const askFav = parseNum(fields[COL.ask_fav]);
      const spreadFav = parseNum(fields[COL.spread_fav]);
      const oddsSum = parseNum(fields[COL.odds_sum]);
      const fav = fields[COL.fav];
      const dSpot5 = parseNum(fields[COL.d_spot_5]);
      const obi5 = parseNum(fields[COL.obi5]);
      const row = {
        dt: fields[COL.dt],
        condition_id: fields[COL.condition_id],
        ts_ms: parseNum(fields[COL.ts_ms]),
        tau, dist_abs: distAbs, fav, ask_fav: askFav, spread_fav: spreadFav, odds_sum: oddsSum,
        d_spot_5: dSpot5, obi5,
        sigma_ps_90: parseNum(fields[COL.sigma_ps_90]),
        flips_60: parseNum(fields[COL.flips_60]),
        dist_vol: distAbs / parseNum(fields[COL.sigma_ps_90]),
        hour_utc: new Date(parseNum(fields[COL.ts_ms])).getUTCHours(),
      };
      if (!v5EntryGates({ ...row, obi5 })) continue;
      const cid = fields[COL.condition_id];
      const prev = firstByCondition.get(cid);
      if (!prev || row.ts_ms < prev.ts_ms) firstByCondition.set(cid, row);
    }
  }
  return [...firstByCondition.values()];
}

function reportBinTable(trainRows, juneRows, keyFn, orderFn) {
  const trainGroups = new Map();
  const juneGroups = new Map();
  for (const r of trainRows) {
    const k = keyFn(r);
    if (!trainGroups.has(k)) trainGroups.set(k, []);
    trainGroups.get(k).push(r);
  }
  for (const r of juneRows) {
    const k = keyFn(r);
    if (!juneGroups.has(k)) juneGroups.set(k, []);
    juneGroups.get(k).push(r);
  }
  const keys = [...new Set([...trainGroups.keys(), ...juneGroups.keys()])].sort(orderFn);
  return keys.map((k) => {
    const st = stats(trainGroups.get(k)?.map((r) => ({ finalPnl: r.pnl })) ?? [], 'finalPnl');
    const sj = stats(juneGroups.get(k)?.map((r) => ({ finalPnl: r.pnl })) ?? [], 'finalPnl');
    return { bin: k, train: st, june: sj, avgExp: (st.exp + sj.exp) / 2 };
  });
}

function joinEventsWithCube(events, cubeByCid) {
  return events
    .filter((e) => e.entry)
    .map((e) => {
      const cid = e.eventId?.split('|')?.[0] ?? e.eventId;
      const cube = cubeByCid.get(cid);
      const hadFlip = (e.orders || []).some((o) => String(o.reason || '').includes('late_flip'));
      const missedFloor = Boolean(e.cross?.missedFlipAfterFloor);
      return {
        ...e,
        cube,
        hadFlip,
        missedFloor,
        dist_vol: cube?.dist_vol,
        ask_fav: cube?.ask_fav ?? e.entry?.price,
        dist_abs: cube?.dist_abs ?? e.entryDistanceToPtb,
        obi5: cube?.obi5,
        flips_60: cube?.flips_60,
        hour_utc: cube?.hour_utc,
      };
    });
}

function filterImpact(rows, pred) {
  const kept = rows.filter(pred);
  const removed = rows.filter((r) => !pred(r));
  const stKept = stats(kept);
  const stAll = stats(rows);
  const daily = new Map();
  for (const r of rows) {
    const dt = r.dt;
    daily.set(dt, (daily.get(dt) || 0) + Number(r.finalPnl || 0));
  }
  const dailyKept = new Map();
  for (const r of kept) {
    const dt = r.dt;
    dailyKept.set(dt, (dailyKept.get(dt) || 0) + Number(r.finalPnl || 0));
  }
  const ddAll = maxDd([...daily.values()]);
  const ddKept = maxDd([...dailyKept.values()]);
  return {
    nAll: rows.length,
    nKept: kept.length,
    nRemoved: removed.length,
    pnlAll: stAll.sum,
    pnlKept: stKept.sum,
    deltaPnl: stKept.sum - stAll.sum,
    expAll: stAll.exp,
    expKept: stKept.exp,
    ddAll,
    ddKept,
    removedPnl: stats(removed).sum,
  };
}

function maxDd(dailyPnls) {
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const p of dailyPnls) {
    eq += p;
    if (eq > peak) peak = eq;
    maxDd = Math.max(maxDd, peak - eq);
  }
  return maxDd;
}

function flipCurve(rows) {
  const bins = ['<0.5', '0.5-1.0', '1.0-1.5', '1.5-2.5', '2.5-4.0', '>=4.0', 'NA'];
  const out = {};
  for (const b of bins) out[b] = { n: 0, flips: 0, missed: 0 };
  for (const r of rows) {
    const b = binDistVol(r.dist_vol);
    out[b].n += 1;
    if (r.hadFlip) out[b].flips += 1;
    if (r.missedFloor) out[b].missed += 1;
  }
  return bins.map((b) => ({
    bin: b,
    n: out[b].n,
    pFlip: out[b].n ? out[b].flips / out[b].n : 0,
    pMissed: out[b].n ? out[b].missed / out[b].n : 0,
  }));
}

async function main() {
  const eventsPath = path.join(CACHE_DIR, 'events-v5-practical.json');
  const events = loadJson(eventsPath).events || [];
  const cubeEntries = await loadCubeEntries();
  const cubeByCid = new Map(cubeEntries.map((r) => [r.condition_id, { ...r, pnl: null }]));

  // PnL real por evento do backtest
  for (const e of events) {
    const cid = e.eventId?.split('|')?.[0] ?? e.eventId;
    if (cubeByCid.has(cid)) cubeByCid.get(cid).pnl = Number(e.finalPnl || 0);
  }

  const joined = joinEventsWithCube(events, cubeByCid);
  const train = joined.filter((r) => r.split === 'train');
  const june = joined.filter((r) => r.split === 'june');

  const askBins = reportBinTable(
    train.map((r) => ({ ...r, pnl: r.finalPnl })),
    june.map((r) => ({ ...r, pnl: r.finalPnl })),
    (r) => binAskFav(r.ask_fav),
    (a, b) => ['0.55-0.60', '0.60-0.65', '0.65-0.70', '0.70-0.75', '0.75-0.82', 'NA'].indexOf(a) - ['0.55-0.60', '0.60-0.65', '0.65-0.70', '0.70-0.75', '0.75-0.82', 'NA'].indexOf(b),
  );

  const distVolBins = reportBinTable(
    train.map((r) => ({ ...r, pnl: r.finalPnl })),
    june.map((r) => ({ ...r, pnl: r.finalPnl })),
    (r) => binDistVol(r.dist_vol),
    (a, b) => a.localeCompare(b),
  );

  const weakPockets = askBins.filter((b) => b.train.exp < 0.5 && b.june.exp < 0.5 && b.train.n >= 30 && b.june.n >= 30);

  const flipByDistVol = {
    train: flipCurve(train),
    june: flipCurve(june),
    all: flipCurve(joined),
  };

  const gateDistVolThresholds = [1.0, 1.5, 2.0, 2.5];
  const gateCurves = gateDistVolThresholds.map((t) => ({
    threshold: t,
    train: filterImpact(train, (r) => Number(r.dist_vol) <= t),
    june: filterImpact(june, (r) => Number(r.dist_vol) <= t),
    all: filterImpact(joined, (r) => Number(r.dist_vol) <= t),
  }));

  const filters = {
    minAsk065: {
      train: filterImpact(train, (r) => r.ask_fav >= 0.65),
      june: filterImpact(june, (r) => r.ask_fav >= 0.65),
      all: filterImpact(joined, (r) => r.ask_fav >= 0.65),
    },
    distVolLe1_5: {
      train: filterImpact(train, (r) => Number(r.dist_vol) <= 1.5),
      june: filterImpact(june, (r) => Number(r.dist_vol) <= 1.5),
      all: filterImpact(joined, (r) => Number(r.dist_vol) <= 1.5),
    },
    both: {
      train: filterImpact(train, (r) => r.ask_fav >= 0.65 && Number(r.dist_vol) <= 1.5),
      june: filterImpact(june, (r) => r.ask_fav >= 0.65 && Number(r.dist_vol) <= 1.5),
      all: filterImpact(joined, (r) => r.ask_fav >= 0.65 && Number(r.dist_vol) <= 1.5),
    },
  };

  const output = {
    baseline: { train: stats(train), june: stats(june), all: stats(joined) },
    askBins,
    distVolBins,
    weakPockets,
    flipByDistVol,
    gateCurves,
    filters,
    featureBins: {
      dist_abs: reportBinTable(train.map((r) => ({ pnl: r.finalPnl, dist_abs: r.dist_abs })), june.map((r) => ({ pnl: r.finalPnl, dist_abs: r.dist_abs })), (r) => binDistAbs(r.dist_abs), (a, b) => a.localeCompare(b)),
      obi5: reportBinTable(train.map((r) => ({ pnl: r.finalPnl, obi5: r.obi5 })), june.map((r) => ({ pnl: r.finalPnl, obi5: r.obi5 })), (r) => binObi5(r.obi5), (a, b) => a.localeCompare(b)),
      flips_60: reportBinTable(train.map((r) => ({ pnl: r.finalPnl, flips_60: r.flips_60 })), june.map((r) => ({ pnl: r.finalPnl, flips_60: r.flips_60 })), (r) => binFlips(r.flips_60), (a, b) => a.localeCompare(b)),
    },
  };

  writeJson(path.join(CACHE_DIR, 'loss-pockets.json'), output);
  writeJson(path.join(CACHE_DIR, 'enriched-events.json'), joined);

  console.log('=== C. ask_fav bins (V5 Practical PnL real) ===');
  for (const b of askBins) {
    console.log(`  ${b.bin}: train n=${b.train.n} exp=${fmtUsd(b.train.exp)} | june n=${b.june.n} exp=${fmtUsd(b.june.exp)}`);
  }

  console.log('\n=== C. Filtros combinados ===');
  for (const [name, f] of Object.entries(filters)) {
    console.log(`  ${name}: train Δpnl=${fmtUsd(f.train.pnlKept - f.train.pnlAll)} n=${f.train.nKept}/${f.train.nAll} DD ${fmtUsd(f.train.ddAll)}→${fmtUsd(f.train.ddKept)}`);
    console.log(`           june Δpnl=${fmtUsd(f.june.pnlKept - f.june.pnlAll)} n=${f.june.nKept}/${f.june.nAll} DD ${fmtUsd(f.june.ddAll)}→${fmtUsd(f.june.ddKept)}`);
  }

  console.error('\nSalvo em labs/sandbox/cache/loss-pockets.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
