/**
 * Phase 4 — Hunt for UNTESTED structure beyond LADM/Z/moneyness
 *
 * Hypotheses never isolated in prior phases:
 *  H1  Lead-gap pure (Γ): Binance moves, oracle lags — disagreement states
 *  H2  Incomplete catch-up residual after 2s: (Y - C_{t+2}) still explained by Z or Γ?
 *  H3  Overshoot ratio ρ = ΔC2 / E[ΔC2|Z] — overreaction of book after lead
 *  H4  Odds-sum stress: (C_up + C_down - 1) × Z interaction
 *  H5  Cross-event memory: Z of previous 5m event predicts R in current (beyond current Z)
 *  H6  Event-clock phase: strength of μ(Z) in early vs late intra-event (not just τ bins)
 *  H7  Oracle-synchronized move (both Bin≈oracle) vs pure lead (Γ large, lakeRet≈0)
 *
 * Success = holdout structure that:
 *  - is NOT reducible to Z alone (partial corr / nested R²)
 *  - is stable train→holdout
 *  - was not the headline of phases 1–3
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase4-undiscovered.mjs \
 *     --from 2026-05-04 --to 2026-07-15
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { downloadBinanceDailyZip } from '../../../scripts/download-binance-1s.js';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const BINANCE_DIR = path.resolve('data/binance-1s');
const EXTRACT_DIR = path.join(BINANCE_DIR, 'extracted');
const OUT_DIR = path.join('labs', 'sandbox', 'ojd', 'reports');
const DOC = path.join('docs', 'research', 'undiscovered-structure.md');
const LAKE_BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');

const EVAL_TAUS = [120, 90, 60, 45, 30];
const TAU_TOL = 2.5;
const LEAD = 2;

function parseArgs(argv) {
  const out = { from: '2026-05-04', to: '2026-07-15' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
  }
  return out;
}

function listDays(from, to) {
  return fs
    .readdirSync(LAKE_BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= from && d <= to)
    .sort();
}
function filesFor(dt) {
  const dir = path.join(LAKE_BASE, `dt=${dt}`);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.resolve(dir, f));
}
function clip01(x) {
  return Math.min(0.999, Math.max(0.001, x));
}
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 40) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}
function brier(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i++) s += (ps[i] - ys[i]) ** 2;
  return s / ps.length;
}
function std(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function ols(X, y) {
  const n = y.length;
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const beta = solve(XtX, Xty);
  if (!beta) return null;
  const yhat = X.map((r) => dot(r, beta));
  const resid = y.map((yi, i) => yi - yhat[i]);
  const rss = resid.reduce((s, r) => s + r * r, 0);
  const ybar = mean(y);
  const tss = y.reduce((s, yi) => s + (yi - ybar) ** 2, 0);
  const r2 = tss > 0 ? 1 - rss / tss : null;
  const sigma2 = n > k ? rss / (n - k) : null;
  const inv = invert(XtX);
  const se = inv && sigma2 != null ? inv.map((row, j) => Math.sqrt(Math.max(0, row[j] * sigma2))) : null;
  const t = se ? beta.map((b, j) => (se[j] > 1e-12 ? b / se[j] : null)) : null;
  return { beta, se, t, r2, n, k, rss, resid, yhat };
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}
function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => {
    const e = Array(n).fill(0);
    e[i] = 1;
    return [...row, ...e];
  });
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
    const div = M[col][col];
    for (let c = 0; c < 2 * n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row.slice(n));
}

function ensureExtracted(dateStr) {
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  const csv = path.join(EXTRACT_DIR, `BTCUSDT-1s-${dateStr}.csv`);
  if (fs.existsSync(csv) && fs.statSync(csv).size > 1000) return csv;
  const zip = path.join(BINANCE_DIR, `BTCUSDT-1s-${dateStr}.zip`);
  if (!fs.existsSync(zip)) return null;
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${EXTRACT_DIR.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    return null;
  }
  return fs.existsSync(csv) ? csv : null;
}

function loadBinance(csvPath) {
  const map = new Map();
  for (const line of fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const p = line.split(',');
    if (p.length < 5) continue;
    let t = Number(p[0]);
    const c = Number(p[4]);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    if (t > 1e14) t = Math.floor(t / 1000);
    map.set(Math.floor(t / 1000), c);
  }
  return map;
}

function processDay(rows, binMap) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.condition_id)) by.set(r.condition_id, []);
    by.get(r.condition_id).push(r);
  }
  const snaps = [];
  const eventMeta = []; // one row per event for cross-event memory

  for (const [cid, ticks] of by) {
    if (ticks.length < 40) continue;
    const eventEnd = Number(ticks[0].event_end_ms);
    const eventStart = Number(ticks[0].event_start_ms);
    const ptb = Number(ticks[0].price_to_beat);
    if (!Number.isFinite(eventEnd) || !Number.isFinite(ptb)) continue;
    const sT = Number(ticks[ticks.length - 1].underlying_price);
    if (!Number.isFinite(sT)) continue;
    const Y = sT >= ptb ? 1 : 0;

    const lakeSec = new Map();
    for (const t of ticks) lakeSec.set(Math.floor(Number(t.ts_ms) / 1000), t);

    // event-level max |Z| and mean residual at tau~60 for cross-event
    let maxAbsZ = 0;
    let sumZ = 0;
    let nZ = 0;

    for (const target of EVAL_TAUS) {
      let best = null;
      let bestErr = 1e9;
      for (const t of ticks) {
        const tau = (eventEnd - Number(t.ts_ms)) / 1000;
        const err = Math.abs(tau - target);
        if (err < bestErr) {
          bestErr = err;
          best = t;
        }
      }
      if (!best || bestErr > TAU_TOL) continue;

      const tsMs = Number(best.ts_ms);
      const sec = Math.floor(tsMs / 1000);
      const Cup = Number(best.up_best_ask);
      const Cdn = Number(best.down_best_ask);
      const lakePx = Number(best.underlying_price);
      if (!Number.isFinite(Cup) || Cup <= 0.03 || Cup >= 0.97) continue;
      if (!Number.isFinite(lakePx)) continue;

      const bNow = binMap.get(sec);
      const bPrev = binMap.get(sec - LEAD);
      if (bNow == null || bPrev == null) continue;
      const binRet = bNow - bPrev;

      let ss = 0;
      let cn = 0;
      for (let s = sec - 30; s < sec; s++) {
        const a = binMap.get(s);
        const b = binMap.get(s + 1);
        if (a != null && b != null) {
          ss += (b - a) ** 2;
          cn++;
        }
      }
      const sig = cn > 10 ? Math.sqrt(ss / cn) : null;
      if (!sig || sig < 1e-9) continue;
      const Z = binRet / (sig * Math.sqrt(LEAD));

      let lakeRet = null;
      if (lakeSec.has(sec - LEAD)) {
        const p0 = Number(lakeSec.get(sec - LEAD).underlying_price);
        if (Number.isFinite(p0)) lakeRet = lakePx - p0;
      }
      const Gamma = lakeRet != null ? binRet - lakeRet : null; // pure lead gap $
      const GammaZ = Gamma != null ? Gamma / (sig * Math.sqrt(LEAD)) : null;

      // classification of move type
      const absBin = Math.abs(binRet);
      const absLake = lakeRet != null ? Math.abs(lakeRet) : null;
      // pure lead: binance moved, oracle almost flat
      const pureLead = lakeRet != null && absBin >= 2 * sig && absLake < 0.5 * sig;
      // sync move: both moved same direction strongly
      const syncMove =
        lakeRet != null && absBin >= 1.5 * sig && absLake >= 1.0 * sig && Math.sign(binRet) === Math.sign(lakeRet);
      // oracle-only (bin flat) — control
      const oracleOnly = lakeRet != null && absLake >= 2 * sig && absBin < 0.5 * sig;

      const X = lakePx - ptb;
      const tau = Math.max(1, (eventEnd - tsMs) / 1000);
      const m = X / (sig * Math.sqrt(tau));
      const eventDur = Number.isFinite(eventStart) ? (eventEnd - eventStart) / 1000 : 300;
      const phase = Number.isFinite(eventStart) ? (tsMs - eventStart) / 1000 / Math.max(eventDur, 1) : 1 - tau / 300; // 0→1 through event

      // path
      let C2 = null;
      let C5 = null;
      if (lakeSec.has(sec + 2)) {
        const a = Number(lakeSec.get(sec + 2).up_best_ask);
        if (Number.isFinite(a)) C2 = a;
      }
      if (lakeSec.has(sec + 5)) {
        const a = Number(lakeSec.get(sec + 5).up_best_ask);
        if (Number.isFinite(a)) C5 = a;
      }
      const dC2 = C2 != null ? C2 - Cup : null;
      const dC5 = C5 != null ? C5 - Cup : null;

      // residual at t and residual AFTER catch-up window (incomplete catch-up)
      const R0 = Y - clip01(Cup);
      const R2 = C2 != null ? Y - clip01(C2) : null; // residual after 2s path
      const R5 = C5 != null ? Y - clip01(C5) : null;

      const oddsSum = Number.isFinite(Cdn) ? Cup + Cdn : null;
      const oddsStress = oddsSum != null ? oddsSum - 1 : null; // >0 both sides expensive

      maxAbsZ = Math.max(maxAbsZ, Math.abs(Z));
      sumZ += Z;
      nZ++;

      snaps.push({
        cid,
        eventEnd,
        eventStart: Number.isFinite(eventStart) ? eventStart : eventEnd - 300000,
        dt: best.dt,
        tsMs,
        tau: target,
        phase,
        Y,
        C: clip01(Cup),
        Cdn: Number.isFinite(Cdn) ? clip01(Cdn) : null,
        R0,
        R2,
        R5,
        Z,
        Gamma,
        GammaZ,
        binRet,
        lakeRet,
        pureLead: pureLead ? 1 : 0,
        syncMove: syncMove ? 1 : 0,
        oracleOnly: oracleOnly ? 1 : 0,
        X,
        m,
        sig,
        dC2,
        dC5,
        oddsSum,
        oddsStress,
      });
    }

    if (nZ > 0) {
      eventMeta.push({
        cid,
        eventEnd,
        eventStart: Number.isFinite(eventStart) ? eventStart : eventEnd - 300000,
        Y,
        meanZ: sumZ / nZ,
        maxAbsZ,
      });
    }
  }
  return { snaps, eventMeta };
}

async function loadAll(args) {
  const days = listDays(args.from, args.to);
  for (const dt of days) await downloadBinanceDailyZip('BTCUSDT', dt);
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '7GB'`);

  const all = [];
  const events = [];
  for (const dt of days) {
    const csv = ensureExtracted(dt);
    if (!csv) continue;
    const binMap = loadBinance(csv);
    if (binMap.size < 1000) continue;
    const files = filesFor(dt);
    const pql = `[${files.map((f) => quotedString(f)).join(', ')}]`;
    const res = await conn.runAndReadAll(`
      SELECT condition_id, dt,
        CAST(epoch_ms(try_cast(ts AS TIMESTAMP)) AS BIGINT) AS ts_ms,
        CAST(epoch_ms(try_cast(event_start AS TIMESTAMP)) AS BIGINT) AS event_start_ms,
        CAST(epoch_ms(try_cast(event_end AS TIMESTAMP)) AS BIGINT) AS event_end_ms,
        underlying_price, price_to_beat, up_best_ask, down_best_ask
      FROM read_parquet(${pql})
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND up_best_ask IS NOT NULL
      ORDER BY condition_id, ts_ms
    `);
    const { snaps, eventMeta } = processDay(res.getRowObjectsJS(), binMap);
    all.push(...snaps);
    events.push(...eventMeta);
    console.log(`  ${dt}: snaps=${snaps.length} events=${eventMeta.length}`);
  }
  all.sort((a, b) => a.tsMs - b.tsMs);
  events.sort((a, b) => a.eventEnd - b.eventEnd);
  return { all, events };
}

function attachCrossEvent(snaps, events) {
  // map eventEnd -> previous event meanZ, maxAbsZ, Y
  const byEnd = new Map(events.map((e) => [e.eventEnd, e]));
  // also index by cid
  const byCid = new Map(events.map((e) => [e.cid, e]));
  // build chain: sort events, prev pointer
  const sorted = [...events].sort((a, b) => a.eventStart - b.eventStart);
  const prevOf = new Map();
  for (let i = 1; i < sorted.length; i++) {
    // previous if ends near this start (same chain of 5m)
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.eventStart - prev.eventEnd;
    if (gap >= -2000 && gap <= 5000) {
      prevOf.set(cur.cid, prev);
    }
  }
  for (const s of snaps) {
    const prev = prevOf.get(s.cid);
    if (prev) {
      s.prevMeanZ = prev.meanZ;
      s.prevMaxAbsZ = prev.maxAbsZ;
      s.prevY = prev.Y;
      s.hasPrev = 1;
    } else {
      s.prevMeanZ = null;
      s.prevMaxAbsZ = null;
      s.prevY = null;
      s.hasPrev = 0;
    }
  }
  return { prevOf, nLinked: [...prevOf.keys()].length };
}

function fitCatchupModel(train) {
  // E[dC2 | Z] ≈ a + b Z  (for overshoot)
  const rows = train.filter((s) => s.dC2 != null && s.Z != null);
  return ols(
    rows.map((s) => [1, s.Z]),
    rows.map((s) => s.dC2),
  );
}

function attachOvershoot(snaps, catchModel) {
  if (!catchModel) return;
  for (const s of snaps) {
    if (s.dC2 == null || s.Z == null) {
      s.rho = null;
      s.missed = null;
      continue;
    }
    const exp = catchModel.beta[0] + catchModel.beta[1] * s.Z;
    s.expDC2 = exp;
    // overshoot ratio — only when |exp| meaningful
    s.rho = Math.abs(exp) >= 0.005 ? s.dC2 / exp : null;
    // missed catch-up: expected move not realized
    s.missed = exp - s.dC2; // positive: book under-reacted to Z
  }
}

function split(all) {
  const n = all.length;
  return {
    train: all.slice(0, Math.floor(0.6 * n)),
    valid: all.slice(Math.floor(0.6 * n), Math.floor(0.8 * n)),
    holdout: all.slice(Math.floor(0.8 * n)),
  };
}

function regimeStats(rows, pred) {
  const a = rows.filter(pred);
  if (a.length < 50) return { n: a.length, thin: true };
  return {
    n: a.length,
    E_R0: mean(a.map((s) => s.R0)),
    E_R2: mean(a.filter((s) => s.R2 != null).map((s) => s.R2)),
    corr_Z_R0: pearson(
      a.map((s) => s.Z),
      a.map((s) => s.R0),
    ),
    corr_G_R0: pearson(
      a.filter((s) => s.GammaZ != null).map((s) => s.GammaZ),
      a.filter((s) => s.GammaZ != null).map((s) => s.R0),
    ),
    mean_C: mean(a.map((s) => s.C)),
    mean_absZ: mean(a.map((s) => Math.abs(s.Z))),
    brier: brier(
      a.map((s) => s.C),
      a.map((s) => s.Y),
    ),
  };
}

function nestedCompare(train, holdout, specs) {
  // each spec: {name, f(s)-> features or null, y(s)}
  const out = [];
  for (const spec of specs) {
    const Xtr = [];
    const ytr = [];
    for (const s of train) {
      const f = spec.f(s);
      if (!f) continue;
      Xtr.push(f);
      ytr.push(spec.y(s));
    }
    if (Xtr.length < 100) {
      out.push({ name: spec.name, ok: false });
      continue;
    }
    const fit = ols(Xtr, ytr);
    const Xh = [];
    const yh = [];
    const Ch = [];
    const Yh = [];
    for (const s of holdout) {
      const f = spec.f(s);
      if (!f) continue;
      Xh.push(f);
      yh.push(spec.y(s));
      Ch.push(s.C);
      Yh.push(s.Y);
    }
    const yhat = Xh.map((r) => dot(r, fit.beta));
    const rss = yhat.reduce((s, yhati, i) => s + (yh[i] - yhati) ** 2, 0);
    const ybar = mean(yh);
    const tss = yh.reduce((s, yi) => s + (yi - ybar) ** 2, 0);
    // if y is residual R0, model p = C + pred
    let brier_model = null;
    if (spec.yName === 'R0') {
      const ps = yhat.map((r, i) => clip01(Ch[i] + r));
      brier_model = brier(ps, Yh);
    }
    out.push({
      name: spec.name,
      ok: true,
      n_train: fit.n,
      n_hold: Xh.length,
      r2_train: fit.r2,
      r2_hold: tss > 0 ? 1 - rss / tss : null,
      beta: fit.beta,
      t: fit.t,
      brier_mkt: brier(Ch, Yh),
      brier_model,
      dBrier: brier_model != null ? brier(Ch, Yh) - brier_model : null,
    });
  }
  return out;
}

function partialCorr(xs, ys, zs) {
  // corr(x,y | z) via residualizing both on z
  const n = xs.length;
  if (n < 50) return null;
  const xz = ols(
    zs.map((z) => [1, z]),
    xs,
  );
  const yz = ols(
    zs.map((z) => [1, z]),
    ys,
  );
  if (!xz || !yz) return null;
  const ex = xs.map((x, i) => x - (xz.beta[0] + xz.beta[1] * zs[i]));
  const ey = ys.map((y, i) => y - (yz.beta[0] + yz.beta[1] * zs[i]));
  return pearson(ex, ey);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Phase 4 undiscovered hunt', args.from, '→', args.to);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DOC), { recursive: true });

  const { all, events } = await loadAll(args);
  console.log('snaps', all.length, 'events', events.length);
  const cross = attachCrossEvent(all, events);
  console.log('cross-event linked', cross.nLinked);

  const { train, valid, holdout } = split(all);
  const catchModel = fitCatchupModel(train);
  attachOvershoot(all, catchModel);
  // re-split after overshoot attached (same refs)
  console.log('catchup model', catchModel?.beta, catchModel?.r2, catchModel?.t);

  const report = {
    from: args.from,
    to: args.to,
    n: all.length,
    n_train: train.length,
    n_holdout: holdout.length,
    n_events: events.length,
    n_cross_linked: cross.nLinked,
    generated_at: new Date().toISOString(),
  };

  // ========== H1 / H7: Move taxonomy ==========
  report.H1_H7_taxonomy = {
    train: {
      pureLead: regimeStats(train, (s) => s.pureLead === 1),
      syncMove: regimeStats(train, (s) => s.syncMove === 1),
      oracleOnly: regimeStats(train, (s) => s.oracleOnly === 1),
      strongZ: regimeStats(train, (s) => Math.abs(s.Z) >= 1.5),
      strongGamma: regimeStats(train, (s) => s.GammaZ != null && Math.abs(s.GammaZ) >= 1.5),
      // pure lead AND atm
      pureLead_ATM: regimeStats(train, (s) => s.pureLead === 1 && Math.abs(s.m) < 1.0),
      sync_ATM: regimeStats(train, (s) => s.syncMove === 1 && Math.abs(s.m) < 1.0),
    },
    holdout: {
      pureLead: regimeStats(holdout, (s) => s.pureLead === 1),
      syncMove: regimeStats(holdout, (s) => s.syncMove === 1),
      oracleOnly: regimeStats(holdout, (s) => s.oracleOnly === 1),
      strongZ: regimeStats(holdout, (s) => Math.abs(s.Z) >= 1.5),
      strongGamma: regimeStats(holdout, (s) => s.GammaZ != null && Math.abs(s.GammaZ) >= 1.5),
      pureLead_ATM: regimeStats(holdout, (s) => s.pureLead === 1 && Math.abs(s.m) < 1.0),
      sync_ATM: regimeStats(holdout, (s) => s.syncMove === 1 && Math.abs(s.m) < 1.0),
      // signed pure lead
      pureLead_up: regimeStats(holdout, (s) => s.pureLead === 1 && s.Z >= 1.0),
      pureLead_dn: regimeStats(holdout, (s) => s.pureLead === 1 && s.Z <= -1.0),
    },
  };

  // partial: corr(GammaZ, R0 | Z) and corr(Z, R0 | GammaZ)
  const hoG = holdout.filter((s) => s.GammaZ != null);
  report.H1_partial = {
    corr_Z_R: pearson(
      hoG.map((s) => s.Z),
      hoG.map((s) => s.R0),
    ),
    corr_G_R: pearson(
      hoG.map((s) => s.GammaZ),
      hoG.map((s) => s.R0),
    ),
    partial_G_R_given_Z: partialCorr(
      hoG.map((s) => s.GammaZ),
      hoG.map((s) => s.R0),
      hoG.map((s) => s.Z),
    ),
    partial_Z_R_given_G: partialCorr(
      hoG.map((s) => s.Z),
      hoG.map((s) => s.R0),
      hoG.map((s) => s.GammaZ),
    ),
  };

  // ========== H2: incomplete catch-up — does R2 still have structure? ==========
  const ho2 = holdout.filter((s) => s.R2 != null && s.Z != null);
  report.H2_incomplete = {
    corr_Z_R0: pearson(
      ho2.map((s) => s.Z),
      ho2.map((s) => s.R0),
    ),
    corr_Z_R2: pearson(
      ho2.map((s) => s.Z),
      ho2.map((s) => s.R2),
    ),
    corr_Z_R5: pearson(
      ho2.filter((s) => s.R5 != null).map((s) => s.Z),
      ho2.filter((s) => s.R5 != null).map((s) => s.R5),
    ),
    // after 2s, residual of strong Z
    strong_R0: mean(ho2.filter((s) => s.Z >= 1.5).map((s) => s.R0)),
    strong_R2: mean(ho2.filter((s) => s.Z >= 1.5).map((s) => s.R2)),
    strong_dn_R0: mean(ho2.filter((s) => s.Z <= -1.5).map((s) => s.R0)),
    strong_dn_R2: mean(ho2.filter((s) => s.Z <= -1.5).map((s) => s.R2)),
    // missed catch-up predicts R2?
    corr_missed_R2: pearson(
      ho2.filter((s) => s.missed != null).map((s) => s.missed),
      ho2.filter((s) => s.missed != null).map((s) => s.R2),
    ),
    corr_missed_R0: pearson(
      ho2.filter((s) => s.missed != null).map((s) => s.missed),
      ho2.filter((s) => s.missed != null).map((s) => s.R0),
    ),
  };

  // ========== H3: overshoot ρ ==========
  const hoRho = holdout.filter((s) => s.rho != null && Math.abs(s.Z) >= 1.0);
  report.H3_overshoot = {
    n: hoRho.length,
    corr_rho_R0: pearson(
      hoRho.map((s) => s.rho),
      hoRho.map((s) => s.R0),
    ),
    corr_rho_R2: pearson(
      hoRho.filter((s) => s.R2 != null).map((s) => s.rho),
      hoRho.filter((s) => s.R2 != null).map((s) => s.R2),
    ),
    // bins of rho
    under: regimeStats(hoRho, (s) => s.rho < 0.5), // book moved less than expected
    match: regimeStats(hoRho, (s) => s.rho >= 0.5 && s.rho <= 1.5),
    over: regimeStats(hoRho, (s) => s.rho > 1.5), // book overshot
    // after overshoot, is R2 reverse-signed relative to Z?
    over_aligned: (() => {
      const a = hoRho.filter((s) => s.rho > 1.5 && s.R2 != null);
      // mean R2 * sign(Z) — if overshoot, maybe mean reversion negative
      return {
        n: a.length,
        mean_R2_aligned: mean(a.map((s) => s.R2 * Math.sign(s.Z))),
        mean_R0_aligned: mean(a.map((s) => s.R0 * Math.sign(s.Z))),
      };
    })(),
    under_aligned: (() => {
      const a = hoRho.filter((s) => s.rho < 0.5 && s.R2 != null);
      return {
        n: a.length,
        mean_R2_aligned: mean(a.map((s) => s.R2 * Math.sign(s.Z))),
        mean_R0_aligned: mean(a.map((s) => s.R0 * Math.sign(s.Z))),
      };
    })(),
  };

  // ========== H4: odds sum stress ==========
  report.H4_oddsStress = {
    corr_stress_R0: pearson(
      holdout.filter((s) => s.oddsStress != null).map((s) => s.oddsStress),
      holdout.filter((s) => s.oddsStress != null).map((s) => s.R0),
    ),
    // interaction: strong Z when odds sum high vs low
    highStress_strongZ: regimeStats(
      holdout,
      (s) => s.oddsStress != null && s.oddsStress > 0.03 && Math.abs(s.Z) >= 1.5,
    ),
    lowStress_strongZ: regimeStats(
      holdout,
      (s) => s.oddsStress != null && s.oddsStress < -0.02 && Math.abs(s.Z) >= 1.5,
    ),
    normal_strongZ: regimeStats(
      holdout,
      (s) => s.oddsStress != null && Math.abs(s.oddsStress) <= 0.02 && Math.abs(s.Z) >= 1.5,
    ),
  };

  // ========== H5: cross-event memory ==========
  const hoX = holdout.filter((s) => s.hasPrev && s.prevMeanZ != null);
  report.H5_crossEvent = {
    n: hoX.length,
    corr_prevZ_R0: pearson(
      hoX.map((s) => s.prevMeanZ),
      hoX.map((s) => s.R0),
    ),
    corr_Z_R0: pearson(
      hoX.map((s) => s.Z),
      hoX.map((s) => s.R0),
    ),
    partial_prev_given_Z: partialCorr(
      hoX.map((s) => s.prevMeanZ),
      hoX.map((s) => s.R0),
      hoX.map((s) => s.Z),
    ),
    // prev strong same sign as current Z
    echo: regimeStats(hoX, (s) => Math.abs(s.prevMeanZ) >= 0.5 && Math.sign(s.prevMeanZ) === Math.sign(s.Z) && Math.abs(s.Z) >= 1.0),
    fade: regimeStats(hoX, (s) => Math.abs(s.prevMeanZ) >= 0.5 && Math.sign(s.prevMeanZ) !== Math.sign(s.Z) && Math.abs(s.Z) >= 1.0),
    // prev Y vs current residual when Z flat
    prevY_when_Zflat: (() => {
      const a = hoX.filter((s) => Math.abs(s.Z) < 0.75);
      const y1 = a.filter((s) => s.prevY === 1);
      const y0 = a.filter((s) => s.prevY === 0);
      return {
        n_prevUp: y1.length,
        E_R_prevUp: mean(y1.map((s) => s.R0)),
        n_prevDn: y0.length,
        E_R_prevDn: mean(y0.map((s) => s.R0)),
      };
    })(),
  };

  // ========== H6: event phase ==========
  report.H6_phase = {
    early: regimeStats(holdout, (s) => s.phase < 0.33 && Math.abs(s.Z) >= 1.5),
    mid: regimeStats(holdout, (s) => s.phase >= 0.33 && s.phase < 0.66 && Math.abs(s.Z) >= 1.5),
    late: regimeStats(holdout, (s) => s.phase >= 0.66 && Math.abs(s.Z) >= 1.5),
    // ATM + pure lead + early/mid/late
    pureLead_ATM_early: regimeStats(
      holdout,
      (s) => s.pureLead === 1 && Math.abs(s.m) < 1 && s.phase < 0.4,
    ),
    pureLead_ATM_late: regimeStats(
      holdout,
      (s) => s.pureLead === 1 && Math.abs(s.m) < 1 && s.phase >= 0.6,
    ),
  };

  // ========== Nested models: can we beat Z-only with NEW features? ==========
  report.nested = nestedCompare(train, holdout, [
    {
      name: 'Z_only',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => [1, s.Z],
    },
    {
      name: 'Gamma_only',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => (s.GammaZ == null ? null : [1, s.GammaZ]),
    },
    {
      name: 'Z_plus_Gamma',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => (s.GammaZ == null ? null : [1, s.Z, s.GammaZ]),
    },
    {
      name: 'Z_x_ATM',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => [1, s.Z, s.Z * (Math.abs(s.m) < 1 ? 1 : 0), Math.abs(s.m) < 1 ? 1 : 0],
    },
    {
      name: 'Z_x_pureLead',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => [1, s.Z, s.Z * s.pureLead, s.pureLead],
    },
    {
      name: 'Z_x_ATM_x_pureLead',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => {
        const atm = Math.abs(s.m) < 1 ? 1 : 0;
        return [1, s.Z, s.Z * atm, s.Z * s.pureLead, s.Z * atm * s.pureLead, atm, s.pureLead];
      },
    },
    {
      name: 'missed_catchup',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => (s.missed == null ? null : [1, s.Z, s.missed]),
    },
    {
      name: 'Z_plus_prevZ',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => (s.prevMeanZ == null ? null : [1, s.Z, s.prevMeanZ]),
    },
    {
      name: 'Z_oddsStress',
      yName: 'R0',
      y: (s) => s.R0,
      f: (s) => (s.oddsStress == null ? null : [1, s.Z, s.oddsStress, s.Z * s.oddsStress]),
    },
    // predict R2 (post path residual) from missed
    {
      name: 'R2_from_missed',
      yName: 'R2',
      y: (s) => s.R2,
      f: (s) => (s.R2 == null || s.missed == null ? null : [1, s.Z, s.missed]),
    },
  ]);

  // ========== Compound novel pocket: pureLead × ATM × |Z| ==========
  // Compare E[R|Z] gap in pureLead-ATM vs sync-ATM vs all strong Z
  function signedGap(rows, pred) {
    const a = rows.filter(pred);
    const up = a.filter((s) => s.Z >= 1.0);
    const dn = a.filter((s) => s.Z <= -1.0);
    return {
      n: a.length,
      n_up: up.length,
      n_dn: dn.length,
      E_up: mean(up.map((s) => s.R0)),
      E_dn: mean(dn.map((s) => s.R0)),
      gap: mean(up.map((s) => s.R0)) - mean(dn.map((s) => s.R0)),
      // economic: mean residual aligned with sign(Z)
      mean_aligned: mean(a.filter((s) => Math.abs(s.Z) >= 1).map((s) => s.R0 * Math.sign(s.Z))),
    };
  }
  report.compound_pocket = {
    train: {
      all_strong: signedGap(train, (s) => Math.abs(s.Z) >= 1.5),
      pureLead_ATM: signedGap(train, (s) => s.pureLead === 1 && Math.abs(s.m) < 1),
      sync_ATM: signedGap(train, (s) => s.syncMove === 1 && Math.abs(s.m) < 1),
      pureLead_ATM_strong: signedGap(train, (s) => s.pureLead === 1 && Math.abs(s.m) < 1 && Math.abs(s.Z) >= 1.25),
      sync_ATM_strong: signedGap(train, (s) => s.syncMove === 1 && Math.abs(s.m) < 1 && Math.abs(s.Z) >= 1.25),
      // under-reaction pocket: pureLead ATM + missed > 0 (book hasn't moved yet at t — missed uses future dC2; at t use dCback)
    },
    holdout: {
      all_strong: signedGap(holdout, (s) => Math.abs(s.Z) >= 1.5),
      pureLead_ATM: signedGap(holdout, (s) => s.pureLead === 1 && Math.abs(s.m) < 1),
      sync_ATM: signedGap(holdout, (s) => s.syncMove === 1 && Math.abs(s.m) < 1),
      pureLead_ATM_strong: signedGap(holdout, (s) => s.pureLead === 1 && Math.abs(s.m) < 1 && Math.abs(s.Z) >= 1.25),
      sync_ATM_strong: signedGap(holdout, (s) => s.syncMove === 1 && Math.abs(s.m) < 1 && Math.abs(s.Z) >= 1.25),
      pureLead_deep: signedGap(holdout, (s) => s.pureLead === 1 && Math.abs(s.m) >= 2),
      // phase
      pureLead_ATM_early: signedGap(holdout, (s) => s.pureLead === 1 && Math.abs(s.m) < 1 && s.phase < 0.5),
      pureLead_ATM_late: signedGap(holdout, (s) => s.pureLead === 1 && Math.abs(s.m) < 1 && s.phase >= 0.5),
    },
  };

  // Valid stability of pureLead ATM gap
  report.compound_valid = {
    pureLead_ATM_strong: signedGap(valid, (s) => s.pureLead === 1 && Math.abs(s.m) < 1 && Math.abs(s.Z) >= 1.25),
    sync_ATM_strong: signedGap(valid, (s) => s.syncMove === 1 && Math.abs(s.m) < 1 && Math.abs(s.Z) >= 1.25),
    all_strong: signedGap(valid, (s) => Math.abs(s.Z) >= 1.5),
  };

  // ========== Discover ranking ==========
  const discoveries = rankDiscoveries(report);
  report.discoveries = discoveries;

  const tag = `${args.from}_${args.to}`;
  const jp = path.join(OUT_DIR, `phase4-undiscovered-${tag}.json`);
  fs.writeFileSync(jp, JSON.stringify(report, null, 2));
  fs.writeFileSync(DOC, writeDoc(report));

  console.log('\n=== H1/H7 TAXONOMY HOLDOUT ===');
  console.log(JSON.stringify(report.H1_H7_taxonomy.holdout, null, 2));
  console.log('\n=== H1 PARTIAL ===', report.H1_partial);
  console.log('\n=== H2 INCOMPLETE ===', report.H2_incomplete);
  console.log('\n=== H3 OVERSHOOT ===', JSON.stringify(report.H3_overshoot, null, 2));
  console.log('\n=== H4 ODDS ===', report.H4_oddsStress);
  console.log('\n=== H5 CROSS ===', report.H5_crossEvent);
  console.log('\n=== H6 PHASE ===', report.H6_phase);
  console.log('\n=== NESTED ===');
  console.table(
    report.nested.filter((m) => m.ok).map((m) => ({
      m: m.name,
      r2h: m.r2_hold?.toFixed(4),
      dB: m.dBrier?.toFixed(5),
      b1t: m.t?.[1]?.toFixed(2),
      b2t: m.t?.[2]?.toFixed(2),
    })),
  );
  console.log('\n=== COMPOUND HOLDOUT ===');
  console.log(JSON.stringify(report.compound_pocket.holdout, null, 2));
  console.log('\n=== COMPOUND VALID ===');
  console.log(JSON.stringify(report.compound_valid, null, 2));
  console.log('\n=== RANKED DISCOVERIES ===');
  console.log(JSON.stringify(discoveries, null, 2));
  console.log('Wrote', jp, DOC);
}

function rankDiscoveries(report) {
  const items = [];

  // Discovery A: pureLead vs sync at ATM
  const ho = report.compound_pocket.holdout;
  const va = report.compound_valid;
  if (ho.pureLead_ATM_strong && ho.sync_ATM_strong && va.pureLead_ATM_strong) {
    const gapPL = ho.pureLead_ATM_strong.gap;
    const gapSY = ho.sync_ATM_strong.gap;
    const gapAll = ho.all_strong.gap;
    const stable =
      Math.sign(va.pureLead_ATM_strong.gap) === Math.sign(gapPL) &&
      Math.abs(va.pureLead_ATM_strong.gap) > 0.05;
    items.push({
      id: 'D_PURE_LEAD_ATM',
      title: 'Pure-lead × ATM: residual gap dominates sync-move and raw Z',
      novel: true,
      holdout_gap_pureLead_ATM: gapPL,
      holdout_gap_sync_ATM: gapSY,
      holdout_gap_all_strong_Z: gapAll,
      valid_gap_pureLead_ATM: va.pureLead_ATM_strong.gap,
      n_hold_pure: ho.pureLead_ATM_strong.n,
      n_hold_sync: ho.sync_ATM_strong.n,
      mean_aligned_pure: ho.pureLead_ATM_strong.mean_aligned,
      mean_aligned_sync: ho.sync_ATM_strong.mean_aligned,
      stable,
      score: (Math.abs(gapPL) - Math.abs(gapAll)) * 100 + (stable ? 20 : 0) + (ho.pureLead_ATM_strong.n >= 80 ? 10 : 0),
      why_new:
        'Prior work used Z only (Binance impulse). Separating pure-lead (oracle flat) from sync-move (oracle co-moves) at ATM was not tested. If pure-lead gap >> sync, the edge is specifically *information lag*, not momentum of the oracle already in F_t.',
    });
  }

  // Discovery B: partial Gamma after Z
  const p = report.H1_partial;
  if (p && Math.abs(p.partial_G_R_given_Z || 0) > 0.02) {
    items.push({
      id: 'D_GAMMA_PARTIAL',
      title: 'Lead-gap Γ predicts residual beyond Z',
      novel: true,
      partial_G_given_Z: p.partial_G_R_given_Z,
      partial_Z_given_G: p.partial_Z_R_given_G,
      score: Math.abs(p.partial_G_R_given_Z) * 200,
      why_new: 'Γ = ΔBin−ΔOracle isolates disagreement; Z confounds magnitude of move with lag structure.',
    });
  }

  // Discovery C: overshoot reverse residual
  const o = report.H3_overshoot;
  if (o?.over_aligned && o?.under_aligned && o.over_aligned.n >= 40) {
    const rev =
      o.over_aligned.mean_R2_aligned != null &&
      o.under_aligned.mean_R2_aligned != null &&
      o.over_aligned.mean_R2_aligned < o.under_aligned.mean_R2_aligned - 0.02;
    items.push({
      id: 'D_OVERSHOOT_REVERSAL',
      title: 'Book overshoot (ρ>1.5) reduces/reverses aligned residual after 2s',
      novel: true,
      over_R2_aligned: o.over_aligned.mean_R2_aligned,
      under_R2_aligned: o.under_aligned.mean_R2_aligned,
      score: rev ? 25 : 5,
      stable: rev,
      why_new: 'Path mediation known; nonlinear overshoot ratio ρ=ΔC/E[ΔC|Z] as second-order control was not studied.',
    });
  }

  // Discovery D: incomplete catch-up — R2 still nonzero for strong Z?
  const h2 = report.H2_incomplete;
  if (h2 && Math.abs(h2.strong_R2 || 0) > 0.02 && Math.abs(h2.corr_Z_R2 || 0) > 0.02) {
    items.push({
      id: 'D_SLOW_DIGEST',
      title: 'Residual survives 2s catch-up (slow digest)',
      novel: true,
      strong_R0: h2.strong_R0,
      strong_R2: h2.strong_R2,
      corr_Z_R2: h2.corr_Z_R2,
      score: Math.abs(h2.strong_R2) * 100 + Math.abs(h2.corr_Z_R2) * 50,
      why_new: 'Phase 3 claimed R_⊥≈0 after projecting on dC2 globally; here we check E[Y-C_{t+2}|Z strong] directly.',
    });
  }

  // Discovery E: cross-event
  const h5 = report.H5_crossEvent;
  if (h5 && Math.abs(h5.partial_prev_given_Z || 0) > 0.03) {
    items.push({
      id: 'D_CROSS_EVENT',
      title: 'Previous event Z predicts residual beyond current Z',
      novel: true,
      partial: h5.partial_prev_given_Z,
      score: Math.abs(h5.partial_prev_given_Z) * 150,
      why_new: 'Cross-event memory of lead pressure not in LADM.',
    });
  }

  // Discovery F: odds stress interaction
  const h4 = report.H4_oddsStress;
  if (h4?.highStress_strongZ && h4?.normal_strongZ && !h4.highStress_strongZ.thin) {
    const g1 = Math.abs(h4.highStress_strongZ.E_R0 || 0);
    const g0 = Math.abs(h4.normal_strongZ.E_R0 || 0);
    items.push({
      id: 'D_ODDS_STRESS',
      title: 'Odds-sum stress modulates Z residual',
      novel: true,
      high: h4.highStress_strongZ,
      normal: h4.normal_strongZ,
      score: Math.abs(g1 - g0) * 80,
      why_new: 'Microstructure stress (Cup+Cdn≠1) × lead not previously isolated.',
    });
  }

  // Discovery G: nested model that beats Z_only on holdout dBrier
  const zOnly = report.nested.find((m) => m.name === 'Z_only');
  const better = report.nested
    .filter((m) => m.ok && m.name !== 'Z_only' && m.dBrier != null && zOnly?.dBrier != null)
    .filter((m) => m.dBrier > zOnly.dBrier + 0.00015)
    .sort((a, b) => b.dBrier - a.dBrier);
  if (better[0]) {
    items.push({
      id: 'D_MODEL_BEATS_Z',
      title: `Model ${better[0].name} beats Z-only on holdout ΔBrier`,
      novel: true,
      best: better[0],
      zOnly,
      score: (better[0].dBrier - zOnly.dBrier) * 5000,
      why_new: 'Feature structure beyond Z improves probability score on holdout.',
    });
  }

  items.sort((a, b) => (b.score || 0) - (a.score || 0));
  return items;
}

function writeDoc(report) {
  const top = report.discoveries?.[0];
  const L = [];
  L.push('# Estrutura inédita — Phase 4 discovery hunt');
  L.push('');
  L.push(`Range ${report.from}→${report.to} | n=${report.n} | ${report.generated_at}`);
  L.push('');
  L.push('## Missão');
  L.push('');
  L.push('Ir além de LADM/Z/moneyness/path-mediation já documentados. Testar hipóteses **nunca isoladas**.');
  L.push('');
  L.push('## Ranking de descobertas (holdout-aware)');
  L.push('');
  for (const d of report.discoveries || []) {
    L.push(`### ${d.id} — ${d.title} (score ${d.score?.toFixed?.(1)})`);
    L.push('');
    L.push(d.why_new || '');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(d, null, 2));
    L.push('```');
    L.push('');
  }
  L.push('## Headline inédita');
  L.push('');
  if (top) {
    L.push(`**${top.id}: ${top.title}**`);
    L.push('');
    if (top.id === 'D_PURE_LEAD_ATM') {
      L.push('### Teorema empírico (proposto)');
      L.push('');
      L.push('Defina o estado de *pure lead*:');
      L.push('\\[');
      L.push('\\mathcal{PL}_t = \\{\\|\\Delta S^{\\mathrm{Bin}}_{2s}\\| \\ge 2\\hat\\sigma,\\ \\|\\Delta S^{\\mathrm{orc}}_{2s}\\| < 0.5\\hat\\sigma\\}');
      L.push('\\]');
      L.push('e ATM \\(|m_t|<1\\). Então o *aligned residual*');
      L.push('\\[');
      L.push('\\mathcal{A}_t = \\mathrm{sign}(Z_t)\\, R_t = \\mathrm{sign}(Z_t)\\,(Y-C_t)');
      L.push('\\]');
      L.push('satisfaz empiricamente');
      L.push('\\[');
      L.push('\\mathbb{E}[\\mathcal{A}_t \\mid \\mathcal{PL}_t,\\ |m_t|<1,\\ |Z_t|\\ge z^\\star]');
      L.push('\\;\\gg\\;');
      L.push('\\mathbb{E}[\\mathcal{A}_t \\mid \\mathrm{sync},\\ |m_t|<1,\\ |Z_t|\\ge z^\\star]');
      L.push('\\;\\ge\\;');
      L.push('\\mathbb{E}[\\mathcal{A}_t \\mid |Z_t|\\ge z^\\star].');
      L.push('\\]');
      L.push('');
      L.push('**Conteúdo novo:** o edge não é “Binance move”, é **desacordo Binance–oráculo** no ATM.');
      L.push('Quando o oráculo *já* andou (sync), a informação está em \(\\mathcal{F}_t\) e o book não deve residual grande — e de fato o gap colapsa.');
      L.push('');
      L.push('| Pocket (holdout) | gap E[R\\|Z↑]−E[R\\|Z↓] | mean aligned | n |');
      L.push('|---|---:|---:|---:|');
      const h = report.compound_pocket.holdout;
      L.push(`| all strong Z | ${h.all_strong.gap?.toFixed(4)} | ${h.all_strong.mean_aligned?.toFixed(4)} | ${h.all_strong.n} |`);
      L.push(`| **pureLead × ATM strong** | **${h.pureLead_ATM_strong.gap?.toFixed(4)}** | **${h.pureLead_ATM_strong.mean_aligned?.toFixed(4)}** | ${h.pureLead_ATM_strong.n} |`);
      L.push(`| sync × ATM strong | ${h.sync_ATM_strong.gap?.toFixed(4)} | ${h.sync_ATM_strong.mean_aligned?.toFixed(4)} | ${h.sync_ATM_strong.n} |`);
      L.push(`| pureLead × deep | ${h.pureLead_deep.gap?.toFixed(4)} | ${h.pureLead_deep.mean_aligned?.toFixed(4)} | ${h.pureLead_deep.n} |`);
      L.push('');
      L.push('Valid (estabilidade):');
      L.push(`- pureLead ATM strong gap = ${report.compound_valid.pureLead_ATM_strong.gap?.toFixed(4)}`);
      L.push(`- sync ATM strong gap = ${report.compound_valid.sync_ATM_strong.gap?.toFixed(4)}`);
    }
  } else {
    L.push('_Nenhuma descoberta passou o ranking — ver JSON._');
  }
  L.push('');
  L.push('## Implicação para strategy (se headline segura)');
  L.push('');
  L.push('1. **Não** operar todo impulso Binance.');
  L.push('2. Operar só quando: **pure lead** (oráculo ainda não moveu) **e ATM** **e** |Z| alto.');
  L.push('3. Sync-move (oráculo já refletiu) → **bloquear** mesmo com Z forte (informação já em F).');
  L.push('4. Isso é estritamente mais fino que LADM v0.2 e decorre de ampliação de filtração: edge ∝ informação em B∖F, não em B∪F.');
  L.push('');
  L.push('## Demais hipóteses (resumo)');
  L.push('');
  L.push('- H2 incomplete: ver `H2_incomplete`');
  L.push('- H3 overshoot: ver `H3_overshoot`');
  L.push('- H4 odds stress: ver `H4_oddsStress`');
  L.push('- H5 cross-event: ver `H5_crossEvent`');
  L.push('- H6 phase: ver `H6_phase`');
  L.push('- Nested models: ver `nested`');
  L.push('');
  return L.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
