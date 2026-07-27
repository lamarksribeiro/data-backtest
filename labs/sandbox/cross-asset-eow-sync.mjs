/**
 * Compara sincronia de fim de janela BTC/ETH/SOL/XRP (5m):
 * 1) direção final (spot vs PTB) no mesmo event_start
 * 2) flips late (cruzamento spot×PTB nos últimos N s) no mesmo momento
 *
 * Uso:
 *   node --max-old-space-size=8192 labs/sandbox/cross-asset-eow-sync.mjs
 *   node labs/sandbox/cross-asset-eow-sync.mjs --from 2026-05-24 --to 2026-07-25 --late-secs 15
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const OUT_JSON = path.join(ROOT, 'labs/sandbox/cross-asset-eow-sync.json');

function parseArgs(argv) {
  const flags = { from: '2026-05-24', to: '2026-07-25', lateSecs: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'late-secs') {
      flags.lateSecs = Number(next);
      i += 1;
      continue;
    }
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function dayList(from, to) {
  const out = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function parquetForDay(asset, day) {
  const dir = path.join(
    ROOT,
    'lake/backtest_ticks',
    `underlying=${asset}`,
    'interval=5m',
    'book_depth=25',
    `dt=${day}`,
  );
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.parquet'))
    .map((f) => path.join(dir, f));
}

function pairs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = i + 1; j < arr.length; j += 1) out.push([arr[i], arr[j]]);
  }
  return out;
}

function pct(n, d) {
  if (!d) return null;
  return Math.round((1000 * n) / d) / 10;
}

function emptyAgree() {
  const o = {};
  for (const [a, b] of pairs(ASSETS)) o[`${a}_${b}`] = { same: 0, n: 0 };
  o.all4 = { same: 0, n: 0 };
  o.atLeast3 = { same: 0, n: 0 };
  return o;
}

async function analyzeDay(conn, day, lateSecs) {
  const files = [];
  for (const asset of ASSETS) files.push(...parquetForDay(asset, day));
  if (files.length < 4) {
    return { day, skipped: true, reason: 'missing_files', files: files.length };
  }

  const fileList = files.map((f) => quotedString(f)).join(', ');

  // Settlement direction per (underlying, event_start)
  const endsSql = `
    WITH base AS (
      SELECT
        underlying,
        event_start,
        max_by(underlying_price, ts) AS last_spot,
        any_value(price_to_beat) AS ptb,
        count(*) AS n_ticks,
        max(coverage) AS max_cov
      FROM read_parquet([${fileList}], hive_partitioning=true)
      WHERE underlying IN ('BTC','ETH','SOL','XRP')
        AND underlying_price IS NOT NULL
        AND price_to_beat IS NOT NULL
        AND price_to_beat > 0
        AND coverage >= 0.9
      GROUP BY underlying, event_start
    )
    SELECT
      underlying,
      event_start,
      CASE WHEN last_spot > ptb THEN 1 ELSE -1 END AS dir,
      last_spot,
      ptb,
      n_ticks
    FROM base
    WHERE last_spot IS NOT NULL AND ptb IS NOT NULL
  `;
  const endsRes = await conn.runAndReadAll(endsSql);
  const endsRows = endsRes.getRowObjectsJson();

  const bySlot = new Map();
  for (const r of endsRows) {
    const slot = String(r.event_start);
    if (!bySlot.has(slot)) bySlot.set(slot, {});
    bySlot.get(slot)[String(r.underlying)] = Number(r.dir);
  }

  const agree = emptyAgree();
  let completeSlots = 0;
  for (const dirs of bySlot.values()) {
    const present = ASSETS.filter((a) => dirs[a] != null);
    if (present.length < 2) continue;
    for (const [a, b] of pairs(ASSETS)) {
      if (dirs[a] == null || dirs[b] == null) continue;
      const key = `${a}_${b}`;
      agree[key].n += 1;
      if (dirs[a] === dirs[b]) agree[key].same += 1;
    }
    if (present.length === 4) {
      completeSlots += 1;
      agree.all4.n += 1;
      const vals = ASSETS.map((a) => dirs[a]);
      if (vals.every((v) => v === vals[0])) agree.all4.same += 1;
      const up = vals.filter((v) => v === 1).length;
      const dn = vals.filter((v) => v === -1).length;
      if (up >= 3 || dn >= 3) agree.atLeast3.same += 1;
      agree.atLeast3.n += 1;
    }
  }

  // Late spot×PTB flips
  const flipsSql = `
    WITH ordered AS (
      SELECT
        underlying,
        event_start,
        ts,
        EXTRACT(EPOCH FROM (TRY_CAST(event_end AS TIMESTAMP) - TRY_CAST(ts AS TIMESTAMP))) AS secs_left,
        underlying_price - price_to_beat AS dist,
        LAG(underlying_price - price_to_beat)
          OVER (PARTITION BY underlying, event_start ORDER BY ts) AS prev_dist
      FROM read_parquet([${fileList}], hive_partitioning=true)
      WHERE underlying IN ('BTC','ETH','SOL','XRP')
        AND underlying_price IS NOT NULL
        AND price_to_beat IS NOT NULL
        AND price_to_beat > 0
        AND coverage >= 0.9
    ),
    crosses AS (
      SELECT
        underlying,
        event_start,
        ts,
        secs_left,
        CASE WHEN dist > 0 THEN 1 ELSE -1 END AS new_dir
      FROM ordered
      WHERE prev_dist IS NOT NULL
        AND prev_dist * dist < 0
        AND secs_left >= 0
        AND secs_left <= ${Number(lateSecs)}
    )
    SELECT
      underlying,
      event_start,
      min(ts) AS first_flip_ts,
      min(secs_left) AS secs_at_flip,
      any_value(new_dir) AS new_dir
    FROM crosses
    GROUP BY underlying, event_start
  `;
  const flipsRes = await conn.runAndReadAll(flipsSql);
  const flipRows = flipsRes.getRowObjectsJson();

  const flipsBySlot = new Map();
  const flipsByAsset = Object.fromEntries(ASSETS.map((a) => [a, 0]));
  for (const r of flipRows) {
    const asset = String(r.underlying);
    const slot = String(r.event_start);
    flipsByAsset[asset] = (flipsByAsset[asset] || 0) + 1;
    if (!flipsBySlot.has(slot)) flipsBySlot.set(slot, {});
    flipsBySlot.get(slot)[asset] = {
      secs: Number(r.secs_at_flip),
      ts: String(r.first_flip_ts),
      newDir: Number(r.new_dir),
    };
  }

  let slotsWithAnyFlip = 0;
  let multiAssetFlip = 0; // >=2 assets flip late in same slot
  let triplePlusFlip = 0;
  let all4Flip = 0;
  let sameDirectionMulti = 0;
  let oppositeDirectionMulti = 0;
  const pairCoFlip = Object.fromEntries(pairs(ASSETS).map(([a, b]) => [`${a}_${b}`, 0]));
  const syncWindows = { within1s: 0, within3s: 0, within5s: 0 };

  for (const flips of flipsBySlot.values()) {
    const assets = ASSETS.filter((a) => flips[a]);
    if (!assets.length) continue;
    slotsWithAnyFlip += 1;
    if (assets.length >= 2) {
      multiAssetFlip += 1;
      const dirs = assets.map((a) => flips[a].newDir);
      const allSame = dirs.every((d) => d === dirs[0]);
      if (allSame) sameDirectionMulti += 1;
      else oppositeDirectionMulti += 1;

      const times = assets.map((a) => Date.parse(flips[a].ts)).filter(Number.isFinite);
      if (times.length >= 2) {
        const spread = Math.max(...times) - Math.min(...times);
        if (spread <= 1000) syncWindows.within1s += 1;
        if (spread <= 3000) syncWindows.within3s += 1;
        if (spread <= 5000) syncWindows.within5s += 1;
      }

      for (const [a, b] of pairs(ASSETS)) {
        if (flips[a] && flips[b]) pairCoFlip[`${a}_${b}`] += 1;
      }
    }
    if (assets.length >= 3) triplePlusFlip += 1;
    if (assets.length === 4) all4Flip += 1;
  }

  // Late odds X-cross: dominant side mid 15-45s flips in last 8s
  const oddsSql = `
    WITH ticks AS (
      SELECT
        underlying,
        event_start,
        EXTRACT(EPOCH FROM (TRY_CAST(event_end AS TIMESTAMP) - TRY_CAST(ts AS TIMESTAMP))) AS secs_left,
        CASE
          WHEN up_best_ask IS NOT NULL AND up_best_bid IS NOT NULL THEN (up_best_ask + up_best_bid) / 2
          ELSE up_price
        END AS up_mid,
        CASE
          WHEN down_best_ask IS NOT NULL AND down_best_bid IS NOT NULL THEN (down_best_ask + down_best_bid) / 2
          ELSE down_price
        END AS down_mid
      FROM read_parquet([${fileList}], hive_partitioning=true)
      WHERE underlying IN ('BTC','ETH','SOL','XRP')
        AND coverage >= 0.9
    ),
    phases AS (
      SELECT
        underlying,
        event_start,
        avg(CASE WHEN secs_left >= 15 AND secs_left < 45 THEN up_mid END) AS late_up,
        avg(CASE WHEN secs_left >= 15 AND secs_left < 45 THEN down_mid END) AS late_down,
        avg(CASE WHEN secs_left >= 0 AND secs_left < 8 THEN up_mid END) AS final_up,
        avg(CASE WHEN secs_left >= 0 AND secs_left < 8 THEN down_mid END) AS final_down
      FROM ticks
      GROUP BY underlying, event_start
    )
    SELECT
      underlying,
      event_start,
      CASE WHEN late_up >= late_down THEN 'UP' ELSE 'DOWN' END AS late_dom,
      CASE WHEN final_up >= final_down THEN 'UP' ELSE 'DOWN' END AS final_dom,
      abs(late_up - late_down) AS late_edge,
      abs(final_up - final_down) AS final_edge
    FROM phases
    WHERE late_up IS NOT NULL AND late_down IS NOT NULL
      AND final_up IS NOT NULL AND final_down IS NOT NULL
      AND abs(late_up - late_down) >= 0.15
      AND CASE WHEN late_up >= late_down THEN 'UP' ELSE 'DOWN' END
          <> CASE WHEN final_up >= final_down THEN 'UP' ELSE 'DOWN' END
  `;
  const oddsRes = await conn.runAndReadAll(oddsSql);
  const oddsRows = oddsRes.getRowObjectsJson();
  const oddsBySlot = new Map();
  const oddsByAsset = Object.fromEntries(ASSETS.map((a) => [a, 0]));
  for (const r of oddsRows) {
    const asset = String(r.underlying);
    const slot = String(r.event_start);
    oddsByAsset[asset] += 1;
    if (!oddsBySlot.has(slot)) oddsBySlot.set(slot, new Set());
    oddsBySlot.get(slot).add(asset);
  }
  let oddsMulti = 0;
  let oddsTriple = 0;
  let oddsAll4 = 0;
  for (const set of oddsBySlot.values()) {
    if (set.size >= 2) oddsMulti += 1;
    if (set.size >= 3) oddsTriple += 1;
    if (set.size === 4) oddsAll4 += 1;
  }

  return {
    day,
    skipped: false,
    files: files.length,
    slots: bySlot.size,
    completeSlots,
    agree,
    flips: {
      byAsset: flipsByAsset,
      slotsWithAnyFlip,
      multiAssetFlip,
      triplePlusFlip,
      all4Flip,
      sameDirectionMulti,
      oppositeDirectionMulti,
      pairCoFlip,
      syncWindows,
    },
    oddsFlip: {
      byAsset: oddsByAsset,
      slots: oddsBySlot.size,
      multiAsset: oddsMulti,
      triplePlus: oddsTriple,
      all4: oddsAll4,
    },
  };
}

function mergeAgree(acc, day) {
  for (const key of Object.keys(day.agree)) {
    if (!acc[key]) acc[key] = { same: 0, n: 0 };
    acc[key].same += day.agree[key].same;
    acc[key].n += day.agree[key].n;
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const days = dayList(flags.from, flags.to);
  const lateSecs = Number(flags.lateSecs) || 15;

  console.error(`Range ${flags.from} → ${flags.to} | late<=${lateSecs}s | assets ${ASSETS.join(',')}`);
  console.error(`Days: ${days.length}`);

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('SET threads TO 8');
  await conn.run('SET memory_limit = \'6GB\'');

  const daily = [];
  const agreeTot = emptyAgree();
  const flipsTot = {
    byAsset: Object.fromEntries(ASSETS.map((a) => [a, 0])),
    slotsWithAnyFlip: 0,
    multiAssetFlip: 0,
    triplePlusFlip: 0,
    all4Flip: 0,
    sameDirectionMulti: 0,
    oppositeDirectionMulti: 0,
    pairCoFlip: Object.fromEntries(pairs(ASSETS).map(([a, b]) => [`${a}_${b}`, 0])),
    syncWindows: { within1s: 0, within3s: 0, within5s: 0 },
  };
  const oddsTot = {
    byAsset: Object.fromEntries(ASSETS.map((a) => [a, 0])),
    slots: 0,
    multiAsset: 0,
    triplePlus: 0,
    all4: 0,
  };
  let completeSlotsTot = 0;
  let skipped = 0;

  for (const day of days) {
    process.stderr.write(`\n[${day}] `);
    const t0 = Date.now();
    try {
      const r = await analyzeDay(conn, day, lateSecs);
      if (r.skipped) {
        skipped += 1;
        console.error(`skip (${r.reason})`);
        daily.push(r);
        continue;
      }
      daily.push(r);
      mergeAgree(agreeTot, r);
      completeSlotsTot += r.completeSlots;
      for (const a of ASSETS) {
        flipsTot.byAsset[a] += r.flips.byAsset[a];
        oddsTot.byAsset[a] += r.oddsFlip.byAsset[a];
      }
      flipsTot.slotsWithAnyFlip += r.flips.slotsWithAnyFlip;
      flipsTot.multiAssetFlip += r.flips.multiAssetFlip;
      flipsTot.triplePlusFlip += r.flips.triplePlusFlip;
      flipsTot.all4Flip += r.flips.all4Flip;
      flipsTot.sameDirectionMulti += r.flips.sameDirectionMulti;
      flipsTot.oppositeDirectionMulti += r.flips.oppositeDirectionMulti;
      for (const k of Object.keys(flipsTot.pairCoFlip)) {
        flipsTot.pairCoFlip[k] += r.flips.pairCoFlip[k];
      }
      flipsTot.syncWindows.within1s += r.flips.syncWindows.within1s;
      flipsTot.syncWindows.within3s += r.flips.syncWindows.within3s;
      flipsTot.syncWindows.within5s += r.flips.syncWindows.within5s;
      oddsTot.slots += r.oddsFlip.slots;
      oddsTot.multiAsset += r.oddsFlip.multiAsset;
      oddsTot.triplePlus += r.oddsFlip.triplePlus;
      oddsTot.all4 += r.oddsFlip.all4;
      console.error(
        `slots=${r.completeSlots} agree4=${pct(r.agree.all4.same, r.agree.all4.n)}% ` +
          `multiFlip=${r.flips.multiAssetFlip} oddsMulti=${r.oddsFlip.multiAsset} ` +
          `${Date.now() - t0}ms`,
      );
    } catch (err) {
      console.error(`ERR ${err.message}`);
      daily.push({ day, skipped: true, reason: err.message });
      skipped += 1;
    }
  }

  const agreePct = {};
  for (const [k, v] of Object.entries(agreeTot)) {
    agreePct[k] = { ...v, pct: pct(v.same, v.n) };
  }

  const summary = {
    meta: {
      from: flags.from,
      to: flags.to,
      lateSecs,
      assets: ASSETS,
      interval: '5m',
      daysRequested: days.length,
      daysOk: days.length - skipped,
      skipped,
      completeSlots: completeSlotsTot,
      generatedAt: new Date().toISOString(),
    },
    directionAgreement: agreePct,
    lateSpotFlips: {
      ...flipsTot,
      multiOfAnyPct: pct(flipsTot.multiAssetFlip, flipsTot.slotsWithAnyFlip),
      syncOfMulti: {
        within1sPct: pct(flipsTot.syncWindows.within1s, flipsTot.multiAssetFlip),
        within3sPct: pct(flipsTot.syncWindows.within3s, flipsTot.multiAssetFlip),
        within5sPct: pct(flipsTot.syncWindows.within5s, flipsTot.multiAssetFlip),
      },
      sameDirOfMultiPct: pct(flipsTot.sameDirectionMulti, flipsTot.multiAssetFlip),
    },
    lateOddsFlips: {
      ...oddsTot,
      multiOfOddsPct: pct(oddsTot.multiAsset, oddsTot.slots),
    },
    daily: daily.map((d) =>
      d.skipped
        ? d
        : {
            day: d.day,
            completeSlots: d.completeSlots,
            agreeAll4Pct: pct(d.agree.all4.same, d.agree.all4.n),
            agree3Pct: pct(d.agree.atLeast3.same, d.agree.atLeast3.n),
            multiFlip: d.flips.multiAssetFlip,
            tripleFlip: d.flips.triplePlusFlip,
            oddsMulti: d.oddsFlip.multiAsset,
          },
    ),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    meta: summary.meta,
    directionAgreement: summary.directionAgreement,
    lateSpotFlips: {
      byAsset: summary.lateSpotFlips.byAsset,
      slotsWithAnyFlip: summary.lateSpotFlips.slotsWithAnyFlip,
      multiAssetFlip: summary.lateSpotFlips.multiAssetFlip,
      triplePlusFlip: summary.lateSpotFlips.triplePlusFlip,
      all4Flip: summary.lateSpotFlips.all4Flip,
      multiOfAnyPct: summary.lateSpotFlips.multiOfAnyPct,
      sameDirOfMultiPct: summary.lateSpotFlips.sameDirOfMultiPct,
      syncOfMulti: summary.lateSpotFlips.syncOfMulti,
      pairCoFlip: summary.lateSpotFlips.pairCoFlip,
    },
    lateOddsFlips: {
      byAsset: summary.lateOddsFlips.byAsset,
      slots: summary.lateOddsFlips.slots,
      multiAsset: summary.lateOddsFlips.multiAsset,
      triplePlus: summary.lateOddsFlips.triplePlus,
      all4: summary.lateOddsFlips.all4,
      multiOfOddsPct: summary.lateOddsFlips.multiOfOddsPct,
    },
  }, null, 2));
  console.error(`\nWrote ${OUT_JSON}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
