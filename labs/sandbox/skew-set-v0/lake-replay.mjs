/**
 * Skew-Set V0 replay against the local BTC 5m depth-25 lake (top-of-book).
 *
 * Feeds createEventEngine with ask/bid/btc/ptb per tick. Settlement winner =
 * last underlying_price vs price_to_beat.
 *
 * Usage (from data-backtest root or this folder):
 *   node labs/sandbox/skew-set-v0/lake-replay.mjs
 *   node labs/sandbox/skew-set-v0/lake-replay.mjs --from=2026-07-01 --to=2026-07-26
 *   node labs/sandbox/skew-set-v0/lake-replay.mjs --preset=presets/v0.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);
const OUT_DIR = path.join(ROOT, '.tmp/skew-set-lake-replay');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-26');
const PRESET_PATH = path.resolve(
  __dirname,
  arg('preset', 'presets/v0.json'),
);
const MAX_DAYS = Number(arg('max-days', '0')) || 0;

function loadPreset() {
  if (!fs.existsSync(PRESET_PATH)) return { ...DEFAULT_PARAMS };
  const raw = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
  return { ...DEFAULT_PARAMS, ...(raw.params || raw) };
}

function listDays() {
  let days = fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dt='))
    .map((entry) => entry.name.slice(3))
    .filter((day) => day >= FROM && day <= TO)
    .sort();
  if (MAX_DAYS > 0) days = days.slice(0, MAX_DAYS);
  return days;
}

function normalizeTick(row) {
  return {
    tau: Number(row.tau),
    ts: Number(row.ts_epoch),
    askUp: Number(row.up_best_ask),
    askDown: Number(row.down_best_ask),
    bidUp: row.up_best_bid != null ? Number(row.up_best_bid) : null,
    bidDown: row.down_best_bid != null ? Number(row.down_best_bid) : null,
    btc: Number(row.underlying_price),
    ptb: Number(row.price_to_beat),
  };
}

function settleWinner(ticks) {
  if (!ticks.length) return null;
  const last = ticks[ticks.length - 1];
  if (!Number.isFinite(last.btc) || !Number.isFinite(last.ptb)) return null;
  return last.btc > last.ptb ? 'UP' : 'DOWN';
}

function runEvent(ticks, params, eventKey) {
  const eng = createEventEngine(params, { eventKey });
  for (const tick of ticks) {
    eng.onTick(tick);
  }
  const result = eng.finish();
  const opened = result.fills.some((f) => f.kind === 'open');
  const residualSh = result.residual.shares;
  const equalized = opened && residualSh <= (params.eqMinShares ?? 0.5) + 1e-9;
  const winner = settleWinner(ticks);
  const cost = result.invested + result.fees;
  let realizedPnl = null;
  if (opened && winner) {
    const paid =
      winner === 'UP' ? result.inv.UP.shares : result.inv.DOWN.shares;
    realizedPnl = paid - cost;
  }
  return {
    eventKey,
    opened,
    equalized,
    mode: result.mode,
    invested: Math.round(result.invested * 1000) / 1000,
    fees: Math.round(result.fees * 1000) / 1000,
    avgSum: result.avgSum != null ? Math.round(result.avgSum * 10000) / 10000 : null,
    residual: Math.round(residualSh * 1000) / 1000,
    skewFrac: Math.round(result.skewFrac * 1000) / 1000,
    rebalanceCount: result.rebalanceCount,
    worstPnl: Math.round(result.worstPnl * 1000) / 1000,
    lockedPnlPerShare:
      result.lockedPnlPerShare != null
        ? Math.round(result.lockedPnlPerShare * 10000) / 10000
        : null,
    winner,
    realizedPnl:
      realizedPnl != null ? Math.round(realizedPnl * 1000) / 1000 : null,
    fills: result.fills.length,
    skewBuys: result.fills.filter((f) => f.kind === 'skew_buy').length,
    skewSells: result.fills.filter((f) => f.kind === 'skew_sell').length,
    eqs: result.fills.filter((f) => f.kind === 'eq').length,
    blockCounts: result.blockCounts,
    fillKinds: result.fills.map((f) => f.kind),
  };
}

function mergeBlockCounts(rows) {
  const counts = {};
  for (const row of rows) {
    for (const [reason, n] of Object.entries(row.blockCounts || {})) {
      counts[reason] = (counts[reason] || 0) + n;
    }
  }
  return counts;
}

function summarize(rows) {
  const opened = rows.filter((r) => r.opened);
  const equalized = opened.filter((r) => r.equalized);
  const residual = opened.filter((r) => !r.equalized);
  const resolved = opened.filter((r) => r.realizedPnl != null);
  const investedSum = opened.reduce((s, r) => s + r.invested, 0);
  const worstSum = opened.reduce((s, r) => s + r.worstPnl, 0);
  const realizedSum = resolved.reduce((s, r) => s + r.realizedPnl, 0);
  const wins = resolved.filter((r) => r.realizedPnl > 0);
  const losses = resolved.filter((r) => r.realizedPnl < 0);
  const grossProfit = wins.reduce((s, r) => s + r.realizedPnl, 0);
  const grossLoss = losses.reduce((s, r) => s + Math.abs(r.realizedPnl), 0);
  const avgSums = opened.map((r) => r.avgSum).filter((x) => x != null).sort((a, b) => a - b);
  const p50 = (xs) =>
    xs.length
      ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * 0.5))]
      : null;

  return {
    events: rows.length,
    opened: opened.length,
    openRatePct: rows.length
      ? Math.round((opened.length / rows.length) * 10000) / 100
      : null,
    equalized: equalized.length,
    residual: residual.length,
    equalizeRatePct: opened.length
      ? Math.round((equalized.length / opened.length) * 10000) / 100
      : null,
    investedSum: Math.round(investedSum * 100) / 100,
    worstPnlSum: Math.round(worstSum * 1000) / 1000,
    realizedPnlSum: Math.round(realizedSum * 1000) / 1000,
    realizedWins: wins.length,
    realizedLosses: losses.length,
    profitFactor:
      grossLoss > 0
        ? Math.round((grossProfit / grossLoss) * 100) / 100
        : grossProfit > 0
          ? null
          : 0,
    worstEvent: opened.length
      ? Math.round(Math.min(...opened.map((r) => r.realizedPnl ?? r.worstPnl)) * 1000) /
        1000
      : null,
    bestEvent: opened.length
      ? Math.round(Math.max(...opened.map((r) => r.realizedPnl ?? r.worstPnl)) * 1000) /
        1000
      : null,
    avgSumP50: p50(avgSums),
    skewBuys: opened.reduce((s, r) => s + r.skewBuys, 0),
    skewSells: opened.reduce((s, r) => s + r.skewSells, 0),
    eqs: opened.reduce((s, r) => s + r.eqs, 0),
    rebalances: opened.reduce((s, r) => s + r.rebalanceCount, 0),
    blockCounts: mergeBlockCounts(rows),
  };
}

function monthOf(day) {
  return day.slice(0, 7);
}

async function main() {
  const params = loadPreset();
  const days = listDays();
  if (!days.length) throw new Error(`no lake days in ${FROM}..${TO}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('=== Skew-Set V0 lake replay ===');
  console.log(`window=${FROM}..${TO} days=${days.length}`);
  console.log(`preset=${PRESET_PATH}`);
  console.log(`model=top-of-book ask/bid + engine fees; research only`);
  console.log(`params openPairSumMax=${params.openPairSumMax} avgSumMax=${params.avgSumMax} maxSkew=${params.maxSkew}`);

  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  await connection.run('SET threads TO 6');

  const eventRows = [];
  let eligibleEvents = 0;
  let skippedCoverage = 0;

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const day = days[dayIndex];
    const dayDir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dayDir)
      .filter((name) => name.endsWith('.parquet'))
      .map((name) => path.join(dayDir, name));
    if (!files.length) continue;
    const parquet = `[${files.map((file) => quotedString(file)).join(',')}]`;
    const query = `
      SELECT
        epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS event_epoch,
        epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
        extract(epoch FROM (
          try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
        ))::DOUBLE AS tau,
        up_best_ask,
        down_best_ask,
        up_best_bid,
        down_best_bid,
        underlying_price,
        price_to_beat
      FROM read_parquet(${parquet})
      WHERE coverage >= 0.99
        AND coalesce(degraded, false) = false
        AND up_best_ask IS NOT NULL
        AND down_best_ask IS NOT NULL
        AND underlying_price IS NOT NULL
        AND price_to_beat IS NOT NULL
      QUALIFY row_number() OVER (
        PARTITION BY event_start, ts
        ORDER BY coverage DESC
      ) = 1
      ORDER BY event_start, ts
    `;
    const rows = (await connection.runAndReadAll(query)).getRowObjectsJS();
    let eventKey = null;
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const maxTau = Math.max(...buffer.map((t) => t.tau));
      const minTau = Math.min(...buffer.map((t) => t.tau));
      if (maxTau < 240 || minTau > 15) {
        skippedCoverage += 1;
        return;
      }
      eligibleEvents += 1;
      eventRows.push({
        day,
        ...runEvent(buffer, params, eventKey),
      });
    };
    for (const row of rows) {
      const key = String(row.event_epoch);
      if (eventKey != null && key !== eventKey) {
        flush();
        buffer = [];
      }
      eventKey = key;
      buffer.push(normalizeTick(row));
    }
    flush();
    if (
      dayIndex === 0 ||
      dayIndex === days.length - 1 ||
      (dayIndex + 1) % 10 === 0
    ) {
      console.log(
        `[${dayIndex + 1}/${days.length}] ${day} eligible=${eligibleEvents} opened=${eventRows.filter((r) => r.opened).length}`,
      );
    }
  }

  const summary = summarize(eventRows);
  const monthly = {};
  for (const month of [...new Set(eventRows.map((r) => monthOf(r.day)))]) {
    monthly[month] = summarize(eventRows.filter((r) => monthOf(r.day) === month));
  }

  const worstOpened = eventRows
    .filter((r) => r.opened && r.realizedPnl != null)
    .sort((a, b) => a.realizedPnl - b.realizedPnl)
    .slice(0, 15)
    .map((r) => ({
      day: r.day,
      eventKey: r.eventKey,
      realizedPnl: r.realizedPnl,
      worstPnl: r.worstPnl,
      avgSum: r.avgSum,
      residual: r.residual,
      skewBuys: r.skewBuys,
      eqs: r.eqs,
    }));

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: FROM, to: TO, days: days.length },
    dataset: 'backtest_ticks BTC 5m depth25 top-of-book',
    preset: PRESET_PATH,
    params,
    eligibleEvents,
    skippedCoverage,
    summary,
    monthly,
    worstOpened,
    status: 'research / proibido live',
  };

  const reportPath = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const s = summary;
  console.log('');
  console.log(
    `events=${s.events} open=${s.opened} (${s.openRatePct}%) eq=${s.equalized} residual=${s.residual}` +
      ` eqRate=${s.equalizeRatePct}%`,
  );
  console.log(
    `invested=${s.investedSum} worstSum=${s.worstPnlSum} realized=${s.realizedPnlSum}` +
      ` PF=${s.profitFactor} avgSumP50=${s.avgSumP50}`,
  );
  console.log(
    `skewBuys=${s.skewBuys} skewSells=${s.skewSells} eqs=${s.eqs} rebalances=${s.rebalances}`,
  );
  console.log('top blocks:', JSON.stringify(s.blockCounts));
  console.log('');
  console.log('saved', reportPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
