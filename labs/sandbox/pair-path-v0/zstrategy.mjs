/**
 * z-filtered terminal favourite — continuous-threshold test + full backtest.
 *
 * DESIGN CHOICE THAT MATTERS:
 * Slicing into (tau x ask x z) cells produced 160 tiny cells, 3 "winners" at the
 * chance rate, none significant out of sample. That design cannot distinguish
 * signal from selection. Here we instead sweep a CONTINUOUS z threshold over the
 * whole population and look for MONOTONICITY: if z carries information, EV must
 * rise with the threshold in a smooth, ordered way in BOTH train and test. A
 * scatter of significant-looking points without ordering is noise; an ordered
 * curve is signal. This uses every observation instead of fragmenting them.
 *
 * LEAKAGE GUARD (inherited, non-negotiable):
 * the winner label is sign(spot - ptb) at the last tick, a PROXY for resolution.
 * No signal is read closer to the end than MIN_SNAP_TAU, and the label tick must
 * be within LABEL_MAX_TAU, so every measurement has a real forecast horizon.
 *
 * ENTRY: taker buy of the favourite at the ask, once per event, at the first
 * qualifying tick. Held to resolution. Taker fee 0.07*p*(1-p) charged.
 *
 *   node labs/sandbox/pair-path-v0/zstrategy.mjs
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
const OUT_DIR = path.join(ROOT, '.tmp/zstrategy');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-30');
const TRAIN_END = arg('trainEnd', '2026-06-30');
const LABEL_MAX_TAU = Number(arg('labelMaxTau', '10'));
const MIN_SNAP_TAU = Number(arg('minSnapTau', '0'));
const VOL_LOOKBACKS = arg('volLookbacks', '60,90,150')
  .split(',')
  .map(Number);
// CANONICAL OUTCOMES: real resolutions from the Gamma API, keyed by
// condition_id. This replaces the last-tick proxy sign(spot - ptb), which was
// measurably wrong on 7-11% of events and which manufactured a fake edge at low
// tau (a snapshot at tau=10 could BE the labelling tick). With true resolutions
// there is no proxy and no leakage, so the whole tau range becomes measurable.
const WINNER_CSV = path.resolve(
  ROOT,
  arg('winnerCsv', 'scratch/canonical-outcomes-v1.csv'),
);

function loadCanonicalWinners(file) {
  if (!fs.existsSync(file)) return new Map();
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift()?.split(',') ?? [];
  const ci = header.indexOf('condition_id');
  const wi = header.indexOf('winner');
  if (ci < 0 || wi < 0) throw new Error(`winner CSV needs condition_id,winner`);
  return new Map(
    lines
      .filter(Boolean)
      .map((l) => l.split(','))
      .filter((v) => ['UP', 'DOWN'].includes(v[wi]))
      .map((v) => [v[ci], v[wi]]),
  );
}
const CANONICAL = loadCanonicalWinners(WINNER_CSV);

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const fee = (p) => {
  const x = Math.min(0.99, Math.max(0.01, p));
  return FEE_RATE * x * (1 - x);
};

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

/** One candidate entry per event, per (askLo, askHi, tauLo, tauHi, volLookback). */
function scanEvent(buf, cfg, last) {
  const { askLo, askHi, tauLo, tauHi, volLookback } = cfg;
  // precompute normalized squared returns
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
  const win = [];
  for (const t of buf) {
    // roll the vol window forward to this tick
    while (ni < norm.length && norm[ni].ts <= t.ts) {
      win.push(norm[ni]);
      sum += norm[ni].v;
      cnt += 1;
      ni += 1;
    }
    while (win.length && win[0].ts < t.ts - volLookback) {
      sum -= win[0].v;
      cnt -= 1;
      win.shift();
    }
    if (t.tau > tauHi || t.tau < tauLo) continue;
    if (t.tau < MIN_SNAP_TAU) continue;
    if (t.tau - last.tau < MIN_SNAP_TAU / 2) continue;
    if (cnt < 20) continue;

    const favSide = t.upAsk >= t.downAsk ? 'UP' : 'DOWN';
    const ask = favSide === 'UP' ? t.upAsk : t.downAsk;
    if (!(ask >= askLo && ask < askHi)) continue;

    const sigPerSqrtS = Math.sqrt(sum / cnt);
    const sigTau = t.spot * sigPerSqrtS * Math.sqrt(t.tau);
    if (!(sigTau > 0)) continue;
    const rawDist = t.spot - t.ptb;
    const dist = favSide === 'UP' ? rawDist : -rawDist;
    return { favSide, ask, z: dist / sigTau, tau: t.tau };
  }
  return null;
}

async function main() {
  const days = listDays();
  console.log(
    `=== z strategy === days=${days.length} guard: label<=${LABEL_MAX_TAU}s signal>=${MIN_SNAP_TAU}s`,
  );

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  const CONFIGS = [];
  for (const volLookback of VOL_LOOKBACKS) {
    for (const [askLo, askHi] of [
      [0.9, 0.99],
      [0.925, 0.96],
      [0.8, 0.925],
      [0.5, 0.9],
    ]) {
      for (const [tauLo, tauHi] of [
        [30, 150],
        [30, 90],
        [90, 240],
      ]) {
        CONFIGS.push({
          id: `v${volLookback}-a${String(askLo).slice(2)}_${String(askHi).slice(2)}-t${tauLo}_${tauHi}`,
          volLookback,
          askLo,
          askHi,
          tauLo,
          tauHi,
        });
      }
    }
  }
  const Z_GRID = [-99, 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5];

  // cfg -> split -> zIdx -> { n, wins, byDay }
  const acc = new Map();
  for (const cfg of CONFIGS) {
    const mk = () =>
      Z_GRID.map(() => ({ n: 0, wins: 0, pnl: 0, byDay: new Map() }));
    acc.set(cfg.id, { train: mk(), test: mk() });
  }
  let nEvents = 0;
  let missingCanonical = 0;
  let proxyDisagree = 0;

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    const split = day <= TRAIN_END ? 'train' : 'test';
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
      const last = buf[buf.length - 1];
      if (buf[0].tau < 240 || last.tau > LABEL_MAX_TAU) return;
      const winner = CANONICAL.get(cond);
      if (!winner) {
        missingCanonical += 1;
        return;
      }
      const proxy =
        last.spot > last.ptb ? 'UP' : last.spot < last.ptb ? 'DOWN' : null;
      if (proxy && proxy !== winner) proxyDisagree += 1;
      nEvents += 1;
      for (const cfg of CONFIGS) {
        const hit = scanEvent(buf, cfg, last);
        if (!hit) continue;
        const won = hit.favSide === winner;
        const pnl = (won ? 1 : 0) - hit.ask - fee(hit.ask);
        const arr = acc.get(cfg.id)[split];
        for (let zi = 0; zi < Z_GRID.length; zi += 1) {
          if (hit.z < Z_GRID[zi]) continue;
          const s = arr[zi];
          s.n += 1;
          if (won) s.wins += 1;
          s.pnl += pnl;
          if (!s.byDay.has(day)) s.byDay.set(day, []);
          s.byDay.get(day).push(pnl);
        }
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
    if (di === 0 || di === days.length - 1 || (di + 1) % 25 === 0) {
      console.log(`[${di + 1}/${days.length}] ${day} events=${nEvents}`);
    }
  }

  const stat = (s) => {
    if (!s.n) return null;
    const [lo, hi] = bootDays(s.byDay);
    const dayPnl = [...s.byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([d, a]) => [d, a.reduce((x, y) => x + y, 0)]);
    let equity = 0;
    let peak = 0;
    let maxDD = 0;
    for (const [, p] of dayPnl) {
      equity += p;
      peak = Math.max(peak, equity);
      maxDD = Math.min(maxDD, equity - peak);
    }
    const all = [...s.byDay.values()].flat();
    const gp = all.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const gl = all.filter((x) => x < 0).reduce((a, b) => a + Math.abs(b), 0);
    return {
      n: s.n,
      winPct: r2((s.wins / s.n) * 100),
      ev: r4(s.pnl / s.n),
      lo95: lo,
      hi95: hi,
      totalPnl: r4(s.pnl),
      pf: gl > 0 ? r4(gp / gl) : gp > 0 ? 'Inf' : 0,
      worstDay: r4(Math.min(...dayPnl.map((x) => x[1]))),
      maxDD: r4(maxDD),
      tradesPerDay: r2(s.n / s.byDay.size),
    };
  };

  const out = [];
  for (const cfg of CONFIGS) {
    const a = acc.get(cfg.id);
    const curve = Z_GRID.map((z, zi) => ({
      zMin: z,
      train: stat(a.train[zi]),
      test: stat(a.test[zi]),
    })).filter((r) => r.train && r.test && r.train.n >= 100 && r.test.n >= 50);
    if (curve.length >= 4) out.push({ cfg, curve });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), nEvents, out }, null, 2),
  );

  console.log(
    `\nevents=${nEvents} missingCanonical=${missingCanonical}` +
      ` proxyDisagreeWithTruth=${proxyDisagree}` +
      ` (${r2((proxyDisagree / Math.max(1, nEvents)) * 100)}%)\n`,
  );
  // monotonicity: Spearman-style ordering of EV against the z threshold
  const scored = out.map((o) => {
    const trEv = o.curve.map((r) => r.train.ev);
    const teEv = o.curve.map((r) => r.test.ev);
    const mono = (a) => {
      let up = 0;
      for (let i = 1; i < a.length; i += 1) if (a[i] > a[i - 1]) up += 1;
      return a.length > 1 ? up / (a.length - 1) : 0;
    };
    return {
      ...o,
      trMono: r2(mono(trEv)),
      teMono: r2(mono(teEv)),
      lastTrain: o.curve[o.curve.length - 1].train,
      lastTest: o.curve[o.curve.length - 1].test,
    };
  });
  scored.sort((a, b) => b.teMono + b.trMono - (a.teMono + a.trMono));

  for (const s of scored.slice(0, 6)) {
    console.log(
      `--- ${s.cfg.id}  monotonicity train=${s.trMono} test=${s.teMono} ---`,
    );
    console.log(
      '  zMin'.padEnd(8),
      '| trN'.padEnd(8),
      'trWin'.padEnd(7),
      'trEV'.padEnd(9),
      'trLo95'.padEnd(9),
      '| teN'.padEnd(8),
      'teWin'.padEnd(7),
      'teEV'.padEnd(9),
      'teLo95'.padEnd(9),
      'tePF'.padEnd(7),
      'teWorstDay',
    );
    for (const r of s.curve) {
      console.log(
        `  ${r.zMin === -99 ? 'all' : r.zMin}`.padEnd(8),
        `| ${r.train.n}`.padEnd(8),
        String(r.train.winPct).padEnd(7),
        String(r.train.ev).padEnd(9),
        String(r.train.lo95).padEnd(9),
        `| ${r.test.n}`.padEnd(8),
        String(r.test.winPct).padEnd(7),
        String(r.test.ev).padEnd(9),
        String(r.test.lo95).padEnd(9),
        String(r.test.pf).padEnd(7),
        String(r.test.worstDay),
      );
    }
    console.log('');
  }
  console.log('saved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
