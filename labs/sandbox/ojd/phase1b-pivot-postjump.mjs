/**
 * OJD pivot B — Post-Jump Regenerative Hazard (not jump-share η)
 *
 * Question: after a large 1s move in the last W seconds, does the market ask
 * (or Gaussian digital) leave a systematic residual vs terminal UP outcome?
 *
 * Usage: node labs/sandbox/ojd/phase1b-pivot-postjump.mjs --from 2026-05-04 --to 2026-05-25
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');
const OUT_DIR = path.join('labs', 'sandbox', 'ojd', 'reports');
const WINDOW = 20;
const EVAL_TAUS = [90, 60, 45, 30];
const TAU_TOL = 2.5;

function parseArgs(argv) {
  const out = { from: '2026-05-04', to: '2026-05-25' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
  }
  return out;
}

function listDays(from, to) {
  return fs
    .readdirSync(BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((dt) => dt >= from && dt <= to)
    .sort();
}

function filesFor(dt) {
  const dir = path.join(BASE, `dt=${dt}`);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.resolve(dir, f));
}

function normalCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return 0.5 * (1 + sign * y);
}

function clip01(x) { return Math.min(0.999, Math.max(0.001, x)); }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function brier(ps, ys) {
  let s = 0; for (let i = 0; i < ps.length; i++) s += (ps[i] - ys[i]) ** 2; return s / ps.length;
}
function pearson(xs, ys) {
  const n = xs.length; if (n < 30) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

function toBars(ticks) {
  const first = Math.floor(Number(ticks[0].ts_ms) / 1000);
  const last = Math.floor(Number(ticks[ticks.length - 1].ts_ms) / 1000);
  const n = last - first + 1;
  if (n < 40 || n > 400) return null;
  const px = new Array(n).fill(null);
  const ask = new Array(n).fill(null);
  const ts = new Array(n);
  for (let i = 0; i < n; i++) ts[i] = (first + i) * 1000;
  for (const t of ticks) {
    const i = Math.floor(Number(t.ts_ms) / 1000) - first;
    if (i < 0 || i >= n) continue;
    const p = Number(t.underlying_price);
    const a = Number(t.up_best_ask);
    if (Number.isFinite(p)) px[i] = p;
    if (Number.isFinite(a)) ask[i] = a;
  }
  for (let i = 1; i < n; i++) {
    if (px[i] == null && px[i - 1] != null) px[i] = px[i - 1];
    if (ask[i] == null && ask[i - 1] != null) ask[i] = ask[i - 1];
  }
  return { px, ask, ts };
}

function processDay(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.condition_id)) by.set(r.condition_id, []);
    by.get(r.condition_id).push(r);
  }
  const out = [];
  for (const [cid, ticks] of by) {
    if (ticks.length < 40) continue;
    const eventEnd = Number(ticks[0].event_end_ms);
    const ptb = Number(ticks[0].price_to_beat);
    if (!Number.isFinite(eventEnd) || !Number.isFinite(ptb)) continue;
    const sT = Number(ticks[ticks.length - 1].underlying_price);
    if (!Number.isFinite(sT)) continue;
    const upWins = sT >= ptb ? 1 : 0;
    const bars = toBars(ticks);
    if (!bars) continue;
    const { px, ask, ts } = bars;
    const n = px.length;
    const ret = new Array(n).fill(0);
    for (let i = 1; i < n; i++) if (px[i] != null && px[i - 1] != null) ret[i] = px[i] - px[i - 1];

    const abs = ret.map(Math.abs).filter((x) => x > 1e-9).sort((a, b) => a - b);
    if (abs.length < 20) continue;
    const med = abs[Math.floor(abs.length / 2)] || 0.1;
    const sig = Math.max(0.08, med * 1.4826);

    for (const target of EVAL_TAUS) {
      let best = -1, bestErr = 1e9;
      for (let i = 0; i < n; i++) {
        if (px[i] == null || ask[i] == null) continue;
        const err = Math.abs((eventEnd - ts[i]) / 1000 - target);
        if (err < bestErr) { bestErr = err; best = i; }
      }
      if (best < 0 || bestErr > TAU_TOL) continue;

      const i0 = Math.max(1, best - WINDOW);
      let maxR = 0, arg = best;
      let sumR = 0, sumSq = 0, cn = 0;
      for (let i = i0; i <= best; i++) {
        if (px[i] == null || px[i - 1] == null) continue;
        const r = ret[i];
        sumR += r; sumSq += r * r; cn++;
        if (Math.abs(r) >= Math.abs(maxR)) { maxR = r; arg = i; }
      }
      if (cn < 10) continue;

      const x = px[best] - ptb;
      const tau = Math.max(1, (eventEnd - ts[best]) / 1000);
      const varRate = sumSq / cn;
      const sigma = Math.sqrt(Math.max(varRate, 1e-12) * tau);
      const pG = clip01(normalCdf(x / Math.max(sigma, 1e-6)));
      const pM = clip01(ask[best]);
      if (pM <= 0.01 || pM >= 0.99) continue;

      const zJump = maxR / sig;
      const secsSinceJump = (ts[best] - ts[arg]) / 1000;
      const jumpDir = maxR > 0 ? 1 : maxR < 0 ? -1 : 0;
      const withLead = (x > 0 && jumpDir > 0) || (x < 0 && jumpDir < 0) ? 1 : 0;
      const againstLead = (x > 0 && jumpDir < 0) || (x < 0 && jumpDir > 0) ? 1 : 0;
      const large = Math.abs(zJump) >= 4;

      out.push({
        cid, tau: target, x, absX: Math.abs(x),
        zJump, secsSinceJump, large: large ? 1 : 0,
        withLead, againstLead, jumpDir,
        pG, pM, upWins,
        residM: upWins - pM,
        residG: upWins - pG,
        edgeM: upWins - pM, // same
      });
    }
  }
  return out;
}

function bucket(snaps, keyFn, name) {
  const m = new Map();
  for (const s of snaps) {
    const k = keyFn(s);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, arr]) => {
    const y = arr.map((s) => s.upWins);
    return {
      [name]: k,
      n: arr.length,
      up_rate: mean(y),
      mean_pM: mean(arr.map((s) => s.pM)),
      mean_pG: mean(arr.map((s) => s.pG)),
      resid_m: mean(arr.map((s) => s.residM)),
      resid_g: mean(arr.map((s) => s.residG)),
      brier_m: brier(arr.map((s) => s.pM), y),
      brier_g: brier(arr.map((s) => s.pG), y),
      // edge if we trusted residual sign of market: mean (upWins - pM) when condition holds
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = listDays(args.from, args.to);
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '6GB'`);

  const all = [];
  for (const dt of days) {
    const files = filesFor(dt);
    if (!files.length) continue;
    const pql = `[${files.map((f) => quotedString(f)).join(', ')}]`;
    const res = await conn.runAndReadAll(`
      SELECT condition_id,
        CAST(epoch_ms(try_cast(ts AS TIMESTAMP)) AS BIGINT) AS ts_ms,
        CAST(epoch_ms(try_cast(event_end AS TIMESTAMP)) AS BIGINT) AS event_end_ms,
        underlying_price, price_to_beat, up_best_ask
      FROM read_parquet(${pql})
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND up_best_ask IS NOT NULL
      ORDER BY condition_id, ts_ms
    `);
    const rows = res.getRowObjectsJS();
    const snaps = processDay(rows);
    all.push(...snaps);
    console.log(dt, 'snaps', snaps.length);
  }

  all.sort((a, b) => a.tau - b.tau);
  const cut = Math.floor(all.length * 0.7);
  // time order not guaranteed after tau sort — re-sort by nothing; use random isn't good.
  // Use absX as weak control. For split use condition hash:
  const train = all.filter((s) => (String(s.cid).charCodeAt(4) % 10) < 7);
  const valid = all.filter((s) => (String(s.cid).charCodeAt(4) % 10) >= 7);

  const regimes = [
    { key: 'all', f: () => true },
    { key: 'large_jump', f: (s) => s.large },
    { key: 'no_large', f: (s) => !s.large },
    { key: 'large_with_lead', f: (s) => s.large && s.withLead },
    { key: 'large_against_lead', f: (s) => s.large && s.againstLead },
    { key: 'large_recent_<=5s', f: (s) => s.large && s.secsSinceJump <= 5 },
    { key: 'large_against_midX', f: (s) => s.large && s.againstLead && s.absX >= 5 && s.absX < 40 },
    { key: 'large_with_midX', f: (s) => s.large && s.withLead && s.absX >= 5 && s.absX < 40 },
  ];

  function regimeTable(snaps) {
    return regimes.map((r) => {
      const arr = snaps.filter(r.f);
      if (arr.length < 50) return { regime: r.key, n: arr.length, note: 'thin' };
      const y = arr.map((s) => s.upWins);
      return {
        regime: r.key,
        n: arr.length,
        up_rate: mean(y),
        mean_pM: mean(arr.map((s) => s.pM)),
        resid_m: mean(arr.map((s) => s.residM)),
        resid_g: mean(arr.map((s) => s.residG)),
        brier_m: brier(arr.map((s) => s.pM), y),
        brier_g: brier(arr.map((s) => s.pG), y),
        // If market underprices UP when residual>0
        abs_resid_m: mean(arr.map((s) => Math.abs(s.residM))),
      };
    });
  }

  // zJump signed bins among large
  const large = all.filter((s) => s.large);
  const byZ = bucket(large, (s) => {
    if (s.zJump <= -6) return 'z<=-6';
    if (s.zJump <= -4) return 'z(-6,-4]';
    if (s.zJump < 4) return '|z|<4';
    if (s.zJump < 6) return 'z[4,6)';
    return 'z>=6';
  }, 'z_bin');

  const byAgainst = bucket(
    all.filter((s) => s.large && s.againstLead),
    (s) => (s.absX < 10 ? 'absX<10' : s.absX < 25 ? 'absX10-25' : 'absX>=25'),
    'absX_bin',
  );

  const report = {
    theory: 'PostJump-Regenerative-Hazard-pivot',
    from: args.from,
    to: args.to,
    n: all.length,
    n_large: large.length,
    global: {
      brier_m: brier(all.map((s) => s.pM), all.map((s) => s.upWins)),
      brier_g: brier(all.map((s) => s.pG), all.map((s) => s.upWins)),
      corr_z_resid_m: pearson(all.map((s) => s.zJump), all.map((s) => s.residM)),
      corr_z_resid_g: pearson(all.map((s) => s.zJump), all.map((s) => s.residG)),
      corr_against_resid_m: pearson(all.map((s) => s.againstLead), all.map((s) => s.residM)),
    },
    regimes_all: regimeTable(all),
    regimes_train: regimeTable(train),
    regimes_valid: regimeTable(valid),
    by_z_large: byZ,
    against_lead_by_absX: byAgainst,
    generated_at: new Date().toISOString(),
  };

  // Decision heuristic
  const against = report.regimes_all.find((r) => r.regime === 'large_against_lead');
  const withL = report.regimes_all.find((r) => r.regime === 'large_with_lead');
  const againstV = report.regimes_valid.find((r) => r.regime === 'large_against_lead');
  let decision = 'KILL pivot B: no actionable market residual after large oriented jumps.';
  if (against && withL && against.n >= 100 && withL.n >= 100) {
    const gap = Math.abs((against.resid_m || 0) - (withL.resid_m || 0));
    const validGap = againstV && withL ? Math.abs((againstV.resid_m || 0) - ((report.regimes_valid.find((r) => r.regime === 'large_with_lead') || {}).resid_m || 0)) : 0;
    if (gap >= 0.03 && validGap >= 0.02) {
      decision = 'PROCEED Phase II on post-jump oriented residual: market residual differs with vs against lead after large jumps.';
    } else if (gap >= 0.02) {
      decision = 'WEAK: small residual gap with/against lead — refine tau/distance filters before theory.';
    }
  }

  report.decision = decision;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'phase1b-postjump.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log('\n=== REGIMES ===');
  console.table(report.regimes_all);
  console.log('\n=== VALID ===');
  console.table(report.regimes_valid);
  console.log('\n=== BY Z (large) ===');
  console.table(byZ);
  console.log('\nDECISION:', decision);
  console.log('Wrote', out);
}

main().catch((e) => { console.error(e); process.exit(1); });
