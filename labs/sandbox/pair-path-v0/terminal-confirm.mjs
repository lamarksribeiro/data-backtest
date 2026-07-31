/**
 * Terminal Spot-Confirmed Favourite (TSC) — strategy backtest with execution.
 *
 * THESIS (measured, not assumed):
 * In the last ~12 seconds the book's favourite wins more often than its price
 * implies, BUT ONLY when spot confirms the same side. Buying every terminal
 * favourite loses (-2.05c/share, PF 0.85, 0/4 months positive). Requiring the
 * spot to sit at least z sigma on the favourite's side of the strike flips the
 * same population to +1.3 to +2.0c/share, PF 1.14-1.23, positive in all 4 months.
 *
 *   z = (spot - price_to_beat, signed toward the favourite)
 *       / (spot * sigma_per_sqrt_sec * sqrt(tau))
 *
 * z is used ONLY as a threshold, never converted into a probability: the
 * Brownian Phi(z) is measurably biased in this book, so any parametric mapping
 * would import that bias. The empirical win rate does the work.
 *
 * WHAT THIS SCRIPT ADDS OVER THE DISCOVERY RUNS: honest execution.
 *   - signal at tick i, order executes at tick i+latencyTicks, at the ask then
 *     prevailing;
 *   - latencyTicks=0 is retained only as a same-snapshot optimistic diagnostic
 *     and is never execution proof. Tradeable evidence starts at >= 1;
 *   - FAK semantics: if the ask has moved above limit = ask_signal + slip, the
 *     order dies unfilled and is counted as a miss, not a fill at a stale price;
 *   - taker fee 0.07*p*(1-p) charged on the executed price;
 *   - outcomes are the real Gamma resolutions, never the last-tick proxy.
 *
 *   node labs/sandbox/pair-path-v0/terminal-confirm.mjs
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
const OUT_DIR = path.join(ROOT, '.tmp/terminal-confirm');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-30');

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const fee = (p) => {
  const x = Math.min(0.99, Math.max(0.01, p));
  return FEE_RATE * x * (1 - x);
};

function loadCanonical(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  const ci = header.indexOf('condition_id');
  const wi = header.indexOf('winner');
  return new Map(
    lines
      .filter(Boolean)
      .map((l) => l.split(','))
      .filter((v) => ['UP', 'DOWN'].includes(v[wi]))
      .map((v) => [v[ci], v[wi]]),
  );
}
const CANONICAL = loadCanonical(
  path.resolve(ROOT, arg('winnerCsv', 'scratch/canonical-outcomes-v1.csv')),
);

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
}
function bootDays(byDay, iterations = 3000) {
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

const CONFIGS = [];
for (const latencyTicks of [0, 1, 2, 3, 5]) {
  for (const slipCents of [0, 1, 2]) {
    for (const [tauLo, tauHi, zMin, askLo, askHi] of [
      [3, 12, 2, 0.8, 0.925],
      [5, 15, 2, 0.8, 0.925],
      [5, 15, 1, 0.8, 0.925],
      [3, 12, 2, 0.7, 0.925],
    ]) {
      CONFIGS.push({
        id: `t${tauLo}_${tauHi}-z${zMin}-a${String(askLo).slice(2)}_${String(askHi).slice(2)}-lat${latencyTicks}-slip${slipCents}`,
        tauLo,
        tauHi,
        zMin,
        askLo,
        askHi,
        latencyTicks,
        slipCents,
        volLookback: 90,
      });
    }
  }
}

/** Returns {status:'fill'|'miss'|'none', ...} for one event. */
function runEvent(buf, cfg) {
  const norm = [];
  for (let i = 1; i < buf.length; i += 1) {
    const dt = buf[i].ts - buf[i - 1].ts;
    if (!(dt > 0) || !(buf[i].spot > 0) || !(buf[i - 1].spot > 0)) continue;
    norm.push({ ts: buf[i].ts, v: (Math.log(buf[i].spot / buf[i - 1].spot) ** 2) / dt });
  }
  let ni = 0;
  let sum = 0;
  let cnt = 0;
  const win = [];
  for (let i = 0; i < buf.length; i += 1) {
    const t = buf[i];
    while (ni < norm.length && norm[ni].ts <= t.ts) {
      win.push(norm[ni]);
      sum += norm[ni].v;
      cnt += 1;
      ni += 1;
    }
    while (win.length && win[0].ts < t.ts - cfg.volLookback) {
      sum -= win[0].v;
      cnt -= 1;
      win.shift();
    }
    if (t.tau > cfg.tauHi || t.tau < cfg.tauLo) continue;
    if (cnt < 20) continue;
    const favSide = t.upAsk >= t.downAsk ? 'UP' : 'DOWN';
    const ask = favSide === 'UP' ? t.upAsk : t.downAsk;
    if (!(ask >= cfg.askLo && ask < cfg.askHi)) continue;
    const sig = t.spot * Math.sqrt(sum / cnt) * Math.sqrt(t.tau);
    if (!(sig > 0)) continue;
    const raw = t.spot - t.ptb;
    const z = (favSide === 'UP' ? raw : -raw) / sig;
    if (z < cfg.zMin) continue;

    // latencyTicks=0 is a labeled same-snapshot diagnostic. Honest execution
    // configurations use >= 1.
    const j = i + cfg.latencyTicks;
    if (j >= buf.length) return { status: 'miss', reason: 'event_ended' };
    const ex = buf[j];
    const exAsk = favSide === 'UP' ? ex.upAsk : ex.downAsk;
    if (!Number.isFinite(exAsk)) return { status: 'miss', reason: 'no_ask' };
    const limit = ask + cfg.slipCents / 100;
    if (exAsk > limit + 1e-12) return { status: 'miss', reason: 'slipped' };
    return {
      status: 'fill',
      favSide,
      signalAsk: ask,
      fillAsk: exAsk,
      z,
      tau: ex.tau,
    };
  }
  return { status: 'none' };
}

async function main() {
  const days = listDays();
  console.log(`=== Terminal Spot-Confirmed Favourite === days=${days.length}`);
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  const acc = new Map(
    CONFIGS.map((cfg) => [
      cfg.id,
      { months: new Map(), byDay: new Map(), fills: 0, misses: 0, wins: 0, askSum: 0 },
    ]),
  );
  let nEvents = 0;

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    const month = day.slice(0, 7);
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
        up_best_ask, down_best_ask, underlying_price, price_to_beat
      FROM read_parquet(${parquet})
      WHERE coverage >= 0.99 AND coalesce(degraded, false) = false
        AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
        AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
      QUALIFY row_number() OVER (
        PARTITION BY condition_id, event_start, ts ORDER BY coverage DESC) = 1
      ORDER BY condition_id, ev, tau DESC
    `)
    ).getRowObjectsJS();

    let key = null;
    let cond = null;
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      if (buf[0].tau < 240) return;
      const winner = CANONICAL.get(cond);
      if (!winner) return;
      nEvents += 1;
      for (const cfg of CONFIGS) {
        const res = runEvent(buf, cfg);
        const a = acc.get(cfg.id);
        if (res.status === 'miss') a.misses += 1;
        if (res.status !== 'fill') continue;
        const won = res.favSide === winner;
        const pnl = (won ? 1 : 0) - res.fillAsk - fee(res.fillAsk);
        a.fills += 1;
        a.askSum += res.fillAsk;
        if (won) a.wins += 1;
        if (!a.months.has(month)) a.months.set(month, { n: 0, wins: 0, pnl: 0 });
        const m = a.months.get(month);
        m.n += 1;
        if (won) m.wins += 1;
        m.pnl += pnl;
        if (!a.byDay.has(day)) a.byDay.set(day, []);
        a.byDay.get(day).push(pnl);
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
      cond = row.condition_id;
      buf.push({
        ts: Number(row.ts_epoch),
        tau: Number(row.tau),
        upAsk: Number(row.up_best_ask),
        downAsk: Number(row.down_best_ask),
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
      });
    }
    flush();
    if ((di + 1) % 25 === 0 || di === days.length - 1) {
      console.log(`[${di + 1}/${days.length}] ${day} events=${nEvents}`);
    }
  }

  const report = [];
  for (const cfg of CONFIGS) {
    const a = acc.get(cfg.id);
    if (!a.fills) continue;
    const all = [...a.byDay.values()].flat();
    const [lo, hi] = bootDays(a.byDay);
    const gp = all.filter((x) => x > 0).reduce((s, x) => s + x, 0);
    const gl = all.filter((x) => x < 0).reduce((s, x) => s + Math.abs(x), 0);
    const dayPnl = [...a.byDay.entries()].sort().map(([d, v]) => [d, v.reduce((s, x) => s + x, 0)]);
    let eq = 0;
    let peak = 0;
    let dd = 0;
    for (const [, p] of dayPnl) {
      eq += p;
      peak = Math.max(peak, eq);
      dd = Math.min(dd, eq - peak);
    }
    const months = [...a.months.entries()].sort();
    report.push({
      cfg,
      sameSnapshotExecution: cfg.latencyTicks === 0,
      fills: a.fills,
      misses: a.misses,
      fillRatePct: r2((a.fills / (a.fills + a.misses)) * 100),
      winPct: r2((a.wins / a.fills) * 100),
      avgAsk: r4(a.askSum / a.fills),
      ev: r4(all.reduce((s, x) => s + x, 0) / all.length),
      lo95: lo,
      hi95: hi,
      pf: gl > 0 ? r4(gp / gl) : 'Inf',
      totalPnl: r4(eq),
      worstDay: r4(Math.min(...dayPnl.map((x) => x[1]))),
      maxDD: r4(dd),
      tradesPerDay: r2(a.fills / a.byDay.size),
      positiveMonths: months.filter(([, m]) => m.pnl > 0).length,
      months: months.map(([mo, m]) => ({
        month: mo,
        n: m.n,
        winPct: r2((m.wins / m.n) * 100),
        ev: r4(m.pnl / m.n),
      })),
    });
  }
  report.sort((a, b) => b.ev - a.ev);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), nEvents, report }, null, 2),
  );

  console.log(`\nevents=${nEvents}\n`);
  console.log(
    'config'.padEnd(42),
    'fills'.padEnd(7),
    'fill%'.padEnd(7),
    'win%'.padEnd(7),
    'avgAsk'.padEnd(8),
    'EV'.padEnd(9),
    'lo95'.padEnd(9),
    'PF'.padEnd(7),
    'mo+'.padEnd(5),
    'wDay'.padEnd(8),
    'maxDD',
  );
  for (const r of report) {
    console.log(
      r.cfg.id.padEnd(42),
      String(r.fills).padEnd(7),
      String(r.fillRatePct).padEnd(7),
      String(r.winPct).padEnd(7),
      String(r.avgAsk).padEnd(8),
      String(r.ev).padEnd(9),
      String(r.lo95).padEnd(9),
      String(r.pf).padEnd(7),
      `${r.positiveMonths}/4`.padEnd(5),
      String(r.worstDay).padEnd(8),
      String(r.maxDD),
    );
  }
  console.log('\nsaved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
