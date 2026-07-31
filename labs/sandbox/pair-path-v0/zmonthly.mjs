/**
 * Month-by-month stability test for the z-filtered terminal favourite.
 *
 * THE QUESTION THIS SETTLES:
 * With true canonical resolutions the z filter is NEGATIVE across the Apr-Jun
 * training span and POSITIVE across July. That pattern has two possible causes,
 * and they demand opposite actions:
 *   (a) a real edge that the training span happened to under-sample, or
 *   (b) a July regime effect, in which case the "edge" is a property of one
 *       month and must never be traded.
 * Only a per-month decomposition separates them. A tradeable edge should be
 * positive in most months; an artefact concentrates in one.
 *
 * Outcomes are the real Gamma resolutions (scratch/canonical-outcomes-v1.csv),
 * never the last-tick proxy — the proxy disagrees with truth on 2.24% of events
 * and was measurably inflating the training EV.
 *
 *   node labs/sandbox/pair-path-v0/zmonthly.mjs
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
const OUT_DIR = path.join(ROOT, '.tmp/zmonthly');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-30');
const VOL_LOOKBACK = Number(arg('volLookback', '90'));

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
function bootDays(byDay, iterations = 2000) {
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

// LOW TAU IS NOW MEASURABLE. The earlier runs excluded tau < 30 to stop the
// last-tick proxy label from leaking into the signal. With true canonical
// resolutions that guard is unnecessary — and tau 5-30s is exactly where this
// repo's live strategies make their money (tau[5,10) exp +$0.79). Excluding it
// was my error, not a property of the market.
// `entry: 'last'` takes the LAST qualifying tick instead of the first, i.e. it
// enters as late as possible, leaving the price less time to flip.
// SENSITIVITY around the surviving candidate (tau 5-15, ask 0.80-0.925, z>=2).
// A real effect degrades smoothly as each knob is perturbed; an artefact
// collapses off a knife edge. Every axis is varied one at a time around the
// centre so the failure mode is visible rather than averaged away.
const CONFIGS = [];
const CENTRE = { tauLo: 5, tauHi: 15, askLo: 0.8, askHi: 0.925, zMin: 2, volLookback: 90 };
const push = (o) => {
  const c = { ...CENTRE, ...o, entry: 'first' };
  c.id =
    `t${c.tauLo}_${c.tauHi}-a${String(c.askLo).slice(2)}_${String(c.askHi).slice(2)}` +
    `-z${c.zMin === -99 ? 'Any' : c.zMin}-v${c.volLookback}`;
  if (!CONFIGS.some((x) => x.id === c.id)) CONFIGS.push(c);
};
push({});
for (const volLookback of [45, 60, 120, 150]) push({ volLookback });
for (const zMin of [1, 1.5, 2.5, 3, 4]) push({ zMin });
for (const [tauLo, tauHi] of [
  [3, 12],
  [4, 14],
  [5, 20],
  [8, 18],
  [5, 25],
  [10, 20],
]) {
  push({ tauLo, tauHi });
}
for (const [askLo, askHi] of [
  [0.78, 0.94],
  [0.82, 0.9],
  [0.75, 0.9],
  [0.85, 0.95],
  [0.7, 0.925],
]) {
  push({ askLo, askHi });
}

function scanEvent(buf, cfg) {
  const norm = [];
  for (let i = 1; i < buf.length; i += 1) {
    const dt = buf[i].ts - buf[i - 1].ts;
    if (!(dt > 0) || !(buf[i].spot > 0) || !(buf[i - 1].spot > 0)) continue;
    const lr = Math.log(buf[i].spot / buf[i - 1].spot);
    norm.push({ ts: buf[i].ts, v: (lr * lr) / dt });
  }
  let ni = 0;
  let sum = 0;
  let cnt = 0;
  let hit = null;
  const win = [];
  for (const t of buf) {
    while (ni < norm.length && norm[ni].ts <= t.ts) {
      win.push(norm[ni]);
      sum += norm[ni].v;
      cnt += 1;
      ni += 1;
    }
    while (win.length && win[0].ts < t.ts - (cfg.volLookback ?? VOL_LOOKBACK)) {
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
    if (cfg.entry === 'last') {
      hit = { favSide, ask, z, tau: t.tau };
      continue;
    }
    return { favSide, ask, z, tau: t.tau };
  }
  return hit;
}

async function main() {
  const days = listDays();
  console.log(`=== z monthly stability === days=${days.length} vol=${VOL_LOOKBACK}s`);
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  const acc = new Map(
    CONFIGS.map((cfg) => [cfg.id, { months: new Map(), byDay: new Map() }]),
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
        const hit = scanEvent(buf, cfg);
        if (!hit) continue;
        const won = hit.favSide === winner;
        const pnl = (won ? 1 : 0) - hit.ask - fee(hit.ask);
        const a = acc.get(cfg.id);
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
  console.log(`\nevents=${nEvents}\n`);
  for (const cfg of CONFIGS) {
    const a = acc.get(cfg.id);
    const all = [...a.byDay.values()].flat();
    const [lo, hi] = bootDays(a.byDay);
    const gp = all.filter((x) => x > 0).reduce((s, x) => s + x, 0);
    const gl = all.filter((x) => x < 0).reduce((s, x) => s + Math.abs(x), 0);
    const months = [...a.months.entries()].sort();
    const posMonths = months.filter(([, m]) => m.pnl > 0).length;
    console.log(
      `--- ${cfg.id} --- n=${all.length} EV=${r4(all.reduce((s, x) => s + x, 0) / all.length)}` +
        ` IC95[${lo}, ${hi}] PF=${gl > 0 ? r4(gp / gl) : 'Inf'}` +
        `  meses positivos: ${posMonths}/${months.length}`,
    );
    console.log(
      '   mês'.padEnd(10),
      'n'.padEnd(7),
      'win%'.padEnd(8),
      'EV/share'.padEnd(10),
      'PnL total',
    );
    for (const [mo, m] of months) {
      console.log(
        `   ${mo}`.padEnd(10),
        String(m.n).padEnd(7),
        String(r2((m.wins / m.n) * 100)).padEnd(8),
        String(r4(m.pnl / m.n)).padEnd(10),
        String(r4(m.pnl)),
      );
    }
    console.log('');
    report.push({
      cfg,
      n: all.length,
      ev: r4(all.reduce((s, x) => s + x, 0) / all.length),
      lo95: lo,
      hi95: hi,
      positiveMonths: posMonths,
      months: months.map(([mo, m]) => ({
        month: mo,
        n: m.n,
        winPct: r2((m.wins / m.n) * 100),
        ev: r4(m.pnl / m.n),
        pnl: r4(m.pnl),
      })),
    });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), nEvents, report }, null, 2),
  );
  console.log('saved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
