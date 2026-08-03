/**
 * LADM Deep Mathematics — filtration enlargement diagnostics
 *
 * Digs beyond Ψ = a tanh(Z/s):
 *  1) Nested linear/logit models for residual R = Y - C
 *  2) Path catch-up vs terminal residual (orthogonalization)
 *  3) Asymmetry Z+ vs Z-
 *  4) Interaction with barrier moneyness m = X/(σ√τ)
 *  5) Optimal lead lag ℓ ∈ {1..5}
 *  6) Nonparametric E[R|Z] + E[R|Z,m,τ]
 *  7) Information: ΔBrier / Δlogloss vs market C alone
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase3-deep-math.mjs \
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
const DOC_PATH = path.join('docs', 'research', 'ladm-deep-math.md');
const LAKE_BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');

const EVAL_TAUS = [120, 90, 60, 45, 30];
const TAU_TOL = 2.5;

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
    .filter((dt) => dt >= from && dt <= to)
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
function variance(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}
function std(xs) {
  const v = variance(xs);
  return v == null ? null : Math.sqrt(v);
}
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 30) return null;
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
function logLoss(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = clip01(ps[i]);
    s += ys[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / ps.length;
}

/** OLS y = X β, X rows are arrays with intercept first. Returns {beta, se, t, r2, n, rss} */
function ols(X, y) {
  const n = y.length;
  const k = X[0].length;
  // XtX, Xty
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
  const yhat = X.map((row) => dot(row, beta));
  const resid = y.map((yi, i) => yi - yhat[i]);
  const rss = resid.reduce((s, r) => s + r * r, 0);
  const ybar = mean(y);
  const tss = y.reduce((s, yi) => s + (yi - ybar) ** 2, 0);
  const r2 = tss > 0 ? 1 - rss / tss : null;
  const sigma2 = n > k ? rss / (n - k) : null;
  // se via (XtX)^{-1}
  const inv = invert(XtX);
  const se = inv && sigma2 != null ? inv.map((row, j) => Math.sqrt(Math.max(0, row[j] * sigma2))) : null;
  const tstat = se ? beta.map((b, j) => (se[j] > 0 ? b / se[j] : null)) : null;
  return { beta, se, t: tstat, r2, n, k, rss, sigma2, resid, yhat };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function solve(A, b) {
  // Gaussian elimination with partial pivot
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

/** IRLS logistic: P(Y=1) = σ(x·β). Features without transforming C — we use logit(C) as feature. */
function logisticIRLS(X, y, maxIter = 25) {
  const n = y.length;
  const k = X[0].length;
  let beta = Array(k).fill(0);
  for (let it = 0; it < maxIter; it++) {
    const W = [];
    const z = [];
    const Xw = [];
    for (let i = 0; i < n; i++) {
      const eta = dot(X[i], beta);
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, eta))));
      const w = Math.max(p * (1 - p), 1e-6);
      W.push(w);
      z.push(eta + (y[i] - p) / w);
      Xw.push(X[i].map((x) => x * Math.sqrt(w)));
    }
    // weighted least squares: (X'WX)β = X'Wz
    const XtWX = Array.from({ length: k }, () => Array(k).fill(0));
    const XtWz = Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const wi = W[i];
      for (let a = 0; a < k; a++) {
        XtWz[a] += X[i][a] * wi * z[i];
        for (let b = 0; b < k; b++) XtWX[a][b] += X[i][a] * wi * X[i][b];
      }
    }
    const next = solve(XtWX, XtWz);
    if (!next) break;
    let delta = 0;
    for (let j = 0; j < k; j++) delta += (next[j] - beta[j]) ** 2;
    beta = next;
    if (delta < 1e-12) break;
  }
  // loglik
  let ll = 0;
  const pHat = [];
  for (let i = 0; i < n; i++) {
    const eta = dot(X[i], beta);
    const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, eta))));
    pHat.push(p);
    ll += y[i] ? Math.log(clip01(p)) : Math.log(clip01(1 - p));
  }
  return { beta, ll, pHat, n, k };
}

function logit(p) {
  const x = clip01(p);
  return Math.log(x / (1 - x));
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

function loadBinanceCloses(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    let t = Number(parts[0]);
    const close = Number(parts[4]);
    if (!Number.isFinite(t) || !Number.isFinite(close)) continue;
    if (t > 1e14) t = Math.floor(t / 1000);
    map.set(Math.floor(t / 1000), close);
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

  for (const [cid, ticks] of by) {
    if (ticks.length < 40) continue;
    const eventEnd = Number(ticks[0].event_end_ms);
    const ptb = Number(ticks[0].price_to_beat);
    if (!Number.isFinite(eventEnd) || !Number.isFinite(ptb)) continue;
    const sT = Number(ticks[ticks.length - 1].underlying_price);
    if (!Number.isFinite(sT)) continue;
    const Y = sT >= ptb ? 1 : 0;

    const lakeSec = new Map();
    for (const t of ticks) lakeSec.set(Math.floor(Number(t.ts_ms) / 1000), t);

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
      const C = Number(best.up_best_ask);
      const lakePx = Number(best.underlying_price);
      if (!Number.isFinite(C) || C <= 0.03 || C >= 0.97 || !Number.isFinite(lakePx)) continue;

      const bNow = binMap.get(sec);
      if (bNow == null) continue;

      // multi-lag returns
      const lags = {};
      for (let L = 1; L <= 5; L++) {
        const bp = binMap.get(sec - L);
        lags[`binRet${L}`] = bp != null ? bNow - bp : null;
      }
      if (lags.binRet2 == null) continue;

      // local σ from 30s binance 1s
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
      if (sig == null || sig < 1e-9) continue;

      const Z = {};
      for (let L = 1; L <= 5; L++) {
        const r = lags[`binRet${L}`];
        Z[`Z${L}`] = r != null ? r / (sig * Math.sqrt(L)) : null;
      }

      const X = lakePx - ptb;
      const tau = Math.max(1, (eventEnd - tsMs) / 1000);
      const m = X / (sig * Math.sqrt(tau)); // barrier moneyness in σ units of remaining time
      // oracle return over same 2s
      let lakeRet2 = null;
      if (lakeSec.has(sec - 2)) {
        const p0 = Number(lakeSec.get(sec - 2).underlying_price);
        if (Number.isFinite(p0)) lakeRet2 = lakePx - p0;
      }
      const leadGap = lakeRet2 != null ? lags.binRet2 - lakeRet2 : null;

      // path: ask move next 2s and next 5s
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
      const dC2 = C2 != null ? C2 - C : null;
      const dC5 = C5 != null ? C5 - C : null;

      // stale: strong Z, small dC backward
      let dCback = null;
      if (lakeSec.has(sec - 2)) {
        const a0 = Number(lakeSec.get(sec - 2).up_best_ask);
        if (Number.isFinite(a0)) dCback = C - a0;
      }

      snaps.push({
        cid,
        dt: best.dt,
        tsMs,
        tau: target,
        C: clip01(C),
        Y,
        R: Y - clip01(C), // terminal residual of market
        X,
        absX: Math.abs(X),
        m,
        sig,
        Z1: Z.Z1,
        Z2: Z.Z2,
        Z3: Z.Z3,
        Z4: Z.Z4,
        Z5: Z.Z5,
        binRet2: lags.binRet2,
        lakeRet2,
        leadGap,
        dC2,
        dC5,
        dCback,
        hour: new Date(tsMs).getUTCHours(),
      });
    }
  }
  return snaps;
}

async function loadAll(args) {
  const days = listDays(args.from, args.to);
  for (const dt of days) await downloadBinanceDailyZip('BTCUSDT', dt);
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '7GB'`);
  const all = [];
  for (const dt of days) {
    const csv = ensureExtracted(dt);
    if (!csv) continue;
    const binMap = loadBinanceCloses(csv);
    if (binMap.size < 1000) continue;
    const files = filesFor(dt);
    const pql = `[${files.map((f) => quotedString(f)).join(', ')}]`;
    const res = await conn.runAndReadAll(`
      SELECT condition_id, dt,
        CAST(epoch_ms(try_cast(ts AS TIMESTAMP)) AS BIGINT) AS ts_ms,
        CAST(epoch_ms(try_cast(event_end AS TIMESTAMP)) AS BIGINT) AS event_end_ms,
        underlying_price, price_to_beat, up_best_ask
      FROM read_parquet(${pql})
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND up_best_ask IS NOT NULL
      ORDER BY condition_id, ts_ms
    `);
    const snaps = processDay(res.getRowObjectsJS(), binMap);
    all.push(...snaps);
    console.log(`  ${dt}: ${snaps.length}`);
  }
  all.sort((a, b) => a.tsMs - b.tsMs);
  return all;
}

function nonparametricER_Z(snaps, zKey = 'Z2', nBins = 15) {
  const xs = snaps.map((s) => s[zKey]).filter((z) => z != null && Number.isFinite(z));
  const qs = [];
  for (let i = 0; i <= nBins; i++) {
    const sorted = xs.slice().sort((a, b) => a - b);
    qs.push(sorted[Math.min(sorted.length - 1, Math.floor((i / nBins) * (sorted.length - 1)))]);
  }
  // unique edges
  const edges = [...new Set(qs)];
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const arr = snaps.filter((s) => s[zKey] != null && s[zKey] >= lo && s[zKey] < hi + (i === edges.length - 2 ? 1e-12 : 0));
    if (arr.length < 40) continue;
    const R = arr.map((s) => s.R);
    const m = mean(R);
    const se = std(R) / Math.sqrt(arr.length);
    bins.push({
      lo,
      hi,
      mid: mean(arr.map((s) => s[zKey])),
      n: arr.length,
      E_R: m,
      se,
      ci95: [m - 1.96 * se, m + 1.96 * se],
      E_Y: mean(arr.map((s) => s.Y)),
      E_C: mean(arr.map((s) => s.C)),
      corr_Z_dC2: pearson(
        arr.filter((s) => s.dC2 != null).map((s) => s[zKey]),
        arr.filter((s) => s.dC2 != null).map((s) => s.dC2),
      ),
    });
  }
  return bins;
}

function split(all) {
  const n = all.length;
  return {
    train: all.slice(0, Math.floor(0.6 * n)),
    valid: all.slice(Math.floor(0.6 * n), Math.floor(0.8 * n)),
    holdout: all.slice(Math.floor(0.8 * n)),
  };
}

function modelTable(name, rows, featureFn, yFn = (s) => s.R) {
  const X = [];
  const y = [];
  const used = [];
  for (const s of rows) {
    const f = featureFn(s);
    if (!f) continue;
    X.push(f);
    y.push(yFn(s));
    used.push(s);
  }
  const fit = ols(X, y);
  if (!fit) return { name, ok: false };
  return {
    name,
    ok: true,
    n: fit.n,
    k: fit.k,
    r2: fit.r2,
    beta: fit.beta,
    t: fit.t,
    se: fit.se,
    rss: fit.rss,
  };
}

function partialR2(full, reduced) {
  if (!full?.ok || !reduced?.ok || reduced.rss == null || full.rss == null) return null;
  if (reduced.rss <= 0) return null;
  return 1 - full.rss / reduced.rss;
}

function lrTest(llFull, llRed, df) {
  // 2(llF - llR) ~ chi^2_df for nested logit
  const stat = 2 * (llFull - llRed);
  return { stat, df, // p-value approx via chi2 survival rough
    p_approx: chi2sf(stat, df) };
}

function chi2sf(x, k) {
  // rough upper incomplete gamma / regularized — simple series for small k
  if (x <= 0) return 1;
  // Wilson-Hilferty approximation for p-value (very rough)
  const h = 2 / (9 * k);
  const z = ((x / k) ** (1 / 3) - (1 - h)) / Math.sqrt(h);
  // 1 - Φ(z)
  return 1 - normalCdf(z);
}

function normalCdf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return 0.5 * (1 + sign * y);
}

function analyze(all) {
  const { train, valid, holdout } = split(all);
  const report = {
    n: all.length,
    n_train: train.length,
    n_valid: valid.length,
    n_holdout: holdout.length,
  };

  // --- 1) Lag selection: corr(Z_ℓ, R) and corr(Z_ℓ, dC2) on train
  const lagScan = [];
  for (let L = 1; L <= 5; L++) {
    const key = `Z${L}`;
    const rows = train.filter((s) => s[key] != null);
    lagScan.push({
      L,
      corr_Z_R: pearson(
        rows.map((s) => s[key]),
        rows.map((s) => s.R),
      ),
      corr_Z_dC2: pearson(
        rows.filter((s) => s.dC2 != null).map((s) => s[key]),
        rows.filter((s) => s.dC2 != null).map((s) => s.dC2),
      ),
      corr_Z_dC5: pearson(
        rows.filter((s) => s.dC5 != null).map((s) => s[key]),
        rows.filter((s) => s.dC5 != null).map((s) => s.dC5),
      ),
      n: rows.length,
    });
  }
  report.lagScan = lagScan;

  // --- 2) Nested OLS for R on train, evaluate r2 on holdout via frozen beta
  const specs = [
    {
      name: 'M0_intercept',
      f: () => [1],
    },
    {
      name: 'M1_Z2',
      f: (s) => (s.Z2 == null ? null : [1, s.Z2]),
    },
    {
      name: 'M2_Z2_tanh',
      f: (s) => (s.Z2 == null ? null : [1, Math.tanh(s.Z2 / 3)]),
    },
    {
      name: 'M3_Z2_m',
      f: (s) => (s.Z2 == null || !Number.isFinite(s.m) ? null : [1, s.Z2, s.m]),
    },
    {
      name: 'M4_Z2_m_tau',
      f: (s) => (s.Z2 == null || !Number.isFinite(s.m) ? null : [1, s.Z2, s.m, s.tau / 100]),
    },
    {
      name: 'M5_Z2_m_Z2xm',
      f: (s) => (s.Z2 == null || !Number.isFinite(s.m) ? null : [1, s.Z2, s.m, s.Z2 * s.m]),
    },
    {
      name: 'M6_asym',
      f: (s) => {
        if (s.Z2 == null) return null;
        const zp = Math.max(s.Z2, 0);
        const zn = Math.min(s.Z2, 0);
        return [1, zp, zn];
      },
    },
    {
      name: 'M7_Z2_leadGap',
      f: (s) => (s.Z2 == null || s.leadGap == null ? null : [1, s.Z2, s.leadGap / 10]),
    },
    {
      name: 'M8_Z2_m_leadGap_tau',
      f: (s) => {
        if (s.Z2 == null || !Number.isFinite(s.m) || s.leadGap == null) return null;
        return [1, s.Z2, s.m, s.leadGap / 10, s.tau / 100];
      },
    },
    {
      name: 'M9_Z2_stale',
      f: (s) => {
        if (s.Z2 == null || s.dCback == null) return null;
        const stale = Math.abs(s.Z2) >= 1.5 && Math.abs(s.dCback) < 0.02 ? 1 : 0;
        return [1, s.Z2, stale, s.Z2 * stale];
      },
    },
  ];

  const nested = [];
  for (const spec of specs) {
    const fit = modelTable(spec.name, train, spec.f);
    // holdout prediction r2
    let ho = null;
    if (fit.ok) {
      const Xh = [];
      const yh = [];
      for (const s of holdout) {
        const f = spec.f(s);
        if (!f) continue;
        Xh.push(f);
        yh.push(s.R);
      }
      if (Xh.length > 50) {
        const yhat = Xh.map((row) => dot(row, fit.beta));
        const rss = yhat.reduce((s, yhati, i) => s + (yh[i] - yhati) ** 2, 0);
        const ybar = mean(yh);
        const tss = yh.reduce((s, yi) => s + (yi - ybar) ** 2, 0);
        const r2 = 1 - rss / tss;
        const brierM = brier(
          holdout.filter((s) => spec.f(s)).map((s) => s.C),
          holdout.filter((s) => spec.f(s)).map((s) => s.Y),
        );
        // p_model = C + predicted residual
        const pMod = holdout
          .map((s) => {
            const f = spec.f(s);
            if (!f) return null;
            return { p: clip01(s.C + dot(f, fit.beta)), y: s.Y };
          })
          .filter(Boolean);
        ho = {
          n: Xh.length,
          r2_R: r2,
          brier_mkt: brierM,
          brier_model: brier(
            pMod.map((x) => x.p),
            pMod.map((x) => x.y),
          ),
          logloss_mkt: logLoss(
            holdout.filter((s) => spec.f(s)).map((s) => s.C),
            holdout.filter((s) => spec.f(s)).map((s) => s.Y),
          ),
          logloss_model: logLoss(
            pMod.map((x) => x.p),
            pMod.map((x) => x.y),
          ),
        };
      }
    }
    nested.push({ ...fit, holdout: ho, labels: spec.name });
  }
  report.nestedOLS = nested;

  // partial R2: M8 vs M1
  const m1 = nested.find((m) => m.name === 'M1_Z2');
  const m5 = nested.find((m) => m.name === 'M5_Z2_m_Z2xm');
  const m6 = nested.find((m) => m.name === 'M6_asym');
  const m8 = nested.find((m) => m.name === 'M8_Z2_m_leadGap_tau');
  const m9 = nested.find((m) => m.name === 'M9_Z2_stale');
  report.partialR2 = {
    M5_vs_M1: partialR2(m5, m1),
    M6_vs_M1: partialR2(m6, m1),
    M8_vs_M1: partialR2(m8, m1),
    M9_vs_M1: partialR2(m9, m1),
  };

  // --- 3) Path vs terminal: residual after removing path catch-up
  // R_term = Y - C
  // Path explains: project R onto dC2 (and Z)
  // R_orth = R - proj(R | dC2)  — if Z still predicts R_orth, terminal edge beyond path
  const pathRows = train.filter((s) => s.dC2 != null && s.Z2 != null);
  const pathOLS = ols(
    pathRows.map((s) => [1, s.dC2]),
    pathRows.map((s) => s.R),
  );
  let pathOrth = null;
  if (pathOLS) {
    // R_orth = R - (a + b dC2)
    const rOrth = pathRows.map((s, i) => s.R - (pathOLS.beta[0] + pathOLS.beta[1] * s.dC2));
    const z = pathRows.map((s) => s.Z2);
    const corr_Z_Rorth = pearson(z, rOrth);
    // also regress R_orth on Z
    const orthOnZ = ols(
      z.map((zi) => [1, zi]),
      rOrth,
    );
    // holdout
    const hoP = holdout.filter((s) => s.dC2 != null && s.Z2 != null);
    const rOrthHo = hoP.map((s) => s.R - (pathOLS.beta[0] + pathOLS.beta[1] * s.dC2));
    pathOrth = {
      train: {
        corr_Z_R: pearson(
          pathRows.map((s) => s.Z2),
          pathRows.map((s) => s.R),
        ),
        corr_Z_dC2: pearson(
          pathRows.map((s) => s.Z2),
          pathRows.map((s) => s.dC2),
        ),
        corr_dC2_R: pearson(
          pathRows.map((s) => s.dC2),
          pathRows.map((s) => s.R),
        ),
        corr_Z_Rorth,
        r2_R_on_dC2: pathOLS.r2,
        r2_Rorth_on_Z: orthOnZ?.r2,
        beta_Z_on_Rorth: orthOnZ?.beta,
        t_Z_on_Rorth: orthOnZ?.t,
      },
      holdout: {
        corr_Z_R: pearson(
          hoP.map((s) => s.Z2),
          hoP.map((s) => s.R),
        ),
        corr_Z_Rorth: pearson(
          hoP.map((s) => s.Z2),
          rOrthHo,
        ),
        n: hoP.length,
      },
    };
  }
  report.pathVsTerminal = pathOrth;

  // --- 4) Asymmetry: E[R|Z>z] vs -E[R|Z<-z]
  const asym = [];
  for (const thr of [1.0, 1.5, 2.0, 2.5]) {
    const up = holdout.filter((s) => s.Z2 != null && s.Z2 >= thr);
    const dn = holdout.filter((s) => s.Z2 != null && s.Z2 <= -thr);
    const Eu = mean(up.map((s) => s.R));
    const Ed = mean(dn.map((s) => s.R));
    asym.push({
      thr,
      n_up: up.length,
      n_dn: dn.length,
      E_R_up: Eu,
      E_R_dn: Ed,
      // symmetry test: E_up + E_dn ≈ 0 if odd function
      skew_gap: Eu + Ed,
      // magnitude asymmetry
      mag_gap: Math.abs(Eu) - Math.abs(Ed),
    });
  }
  report.asymmetry = asym;

  // --- 5) Interaction moneyness: |m| bins × strong Z
  const mBins = [
    { label: '|m|<0.5', f: (s) => Math.abs(s.m) < 0.5 },
    { label: '0.5≤|m|<1.5', f: (s) => Math.abs(s.m) >= 0.5 && Math.abs(s.m) < 1.5 },
    { label: '1.5≤|m|<3', f: (s) => Math.abs(s.m) >= 1.5 && Math.abs(s.m) < 3 },
    { label: '|m|≥3', f: (s) => Math.abs(s.m) >= 3 },
  ];
  report.moneynessGrid = mBins.map((b) => {
    const base = holdout.filter((s) => s.Z2 != null && Number.isFinite(s.m) && b.f(s));
    const strong = base.filter((s) => Math.abs(s.Z2) >= 1.5);
    return {
      bin: b.label,
      n: base.length,
      corr_Z_R: pearson(
        base.map((s) => s.Z2),
        base.map((s) => s.R),
      ),
      n_strong: strong.length,
      E_R_strong_up: mean(strong.filter((s) => s.Z2 >= 1.5).map((s) => s.R)),
      E_R_strong_dn: mean(strong.filter((s) => s.Z2 <= -1.5).map((s) => s.R)),
      // slope proxy: corr * sd(R)/sd(Z) rough
    };
  });

  // --- 6) Logit nested: Y ~ logit(C) + features  (proper probability model)
  function logitFit(rows, featFn, name) {
    const X = [];
    const y = [];
    for (const s of rows) {
      const f = featFn(s);
      if (!f) continue;
      X.push(f);
      y.push(s.Y);
    }
    if (X.length < 100) return { name, ok: false };
    const fit = logisticIRLS(X, y);
    // holdout
    const ph = [];
    const yh = [];
    for (const s of holdout) {
      const f = featFn(s);
      if (!f) continue;
      const eta = dot(f, fit.beta);
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, eta))));
      ph.push(p);
      yh.push(s.Y);
    }
    return {
      name,
      ok: true,
      n: fit.n,
      k: fit.k,
      ll_train: fit.ll,
      beta: fit.beta,
      holdout: {
        n: ph.length,
        brier: brier(ph, yh),
        logloss: logLoss(ph, yh),
        brier_mkt: brier(
          holdout.filter((s) => featFn(s)).map((s) => s.C),
          holdout.filter((s) => featFn(s)).map((s) => s.Y),
        ),
        logloss_mkt: logLoss(
          holdout.filter((s) => featFn(s)).map((s) => s.C),
          holdout.filter((s) => featFn(s)).map((s) => s.Y),
        ),
      },
    };
  }

  const logitModels = [
    logitFit(train, (s) => [1, logit(s.C)], 'L0_logitC'),
    logitFit(train, (s) => (s.Z2 == null ? null : [1, logit(s.C), s.Z2]), 'L1_logitC_Z'),
    logitFit(
      train,
      (s) => (s.Z2 == null || !Number.isFinite(s.m) ? null : [1, logit(s.C), s.Z2, s.m, s.Z2 * s.m]),
      'L2_logitC_Z_m_Zxm',
    ),
    logitFit(
      train,
      (s) => {
        if (s.Z2 == null || !Number.isFinite(s.m) || s.leadGap == null) return null;
        return [1, logit(s.C), s.Z2, s.m, s.Z2 * s.m, s.leadGap / 10, s.tau / 100];
      },
      'L3_full',
    ),
    logitFit(
      train,
      (s) => {
        if (s.Z2 == null) return null;
        return [1, logit(s.C), Math.max(s.Z2, 0), Math.min(s.Z2, 0)];
      },
      'L4_asym',
    ),
  ];
  report.logitModels = logitModels;

  // LR tests on train between L0 and L1, L1 and L2
  const L0 = logitModels.find((m) => m.name === 'L0_logitC');
  const L1 = logitModels.find((m) => m.name === 'L1_logitC_Z');
  const L2 = logitModels.find((m) => m.name === 'L2_logitC_Z_m_Zxm');
  const L3 = logitModels.find((m) => m.name === 'L3_full');
  report.lrTests = {
    L1_vs_L0: L0?.ok && L1?.ok ? lrTest(L1.ll_train, L0.ll_train, L1.k - L0.k) : null,
    L2_vs_L1: L1?.ok && L2?.ok ? lrTest(L2.ll_train, L1.ll_train, L2.k - L1.k) : null,
    L3_vs_L2: L2?.ok && L3?.ok ? lrTest(L3.ll_train, L2.ll_train, L3.k - L2.k) : null,
  };

  // --- 7) Nonparametric E[R|Z]
  report.np_ER_Z_train = nonparametricER_Z(train, 'Z2', 12);
  report.np_ER_Z_holdout = nonparametricER_Z(holdout, 'Z2', 10);

  // --- 8) Conditional variance: does Z reduce uncertainty? Var(Y|C,Z) vs Var(Y|C)
  // proxy: Brier is proper score; also E[(Y-C)^2 | |Z| high] vs low
  report.conditionalVariance = {
    flat: (() => {
      const a = holdout.filter((s) => s.Z2 != null && Math.abs(s.Z2) < 0.75);
      return { n: a.length, mean_R2: mean(a.map((s) => s.R ** 2)), brier: brier(a.map((s) => s.C), a.map((s) => s.Y)) };
    })(),
    strong: (() => {
      const a = holdout.filter((s) => s.Z2 != null && Math.abs(s.Z2) >= 1.5);
      return { n: a.length, mean_R2: mean(a.map((s) => s.R ** 2)), brier: brier(a.map((s) => s.C), a.map((s) => s.Y)) };
    })(),
  };

  // --- 9) Double machine-learning style: residualize R on (m,τ,C), then corr with Z
  // R = f(m,τ) + e; e ~ Z
  const dmRows = train.filter((s) => s.Z2 != null && Number.isFinite(s.m));
  const dm = ols(
    dmRows.map((s) => [1, s.m, s.tau / 100, s.C]),
    dmRows.map((s) => s.R),
  );
  if (dm) {
    const e = dmRows.map((s, i) => s.R - dot([1, s.m, s.tau / 100, s.C], dm.beta));
    const onZ = ols(
      dmRows.map((s) => [1, s.Z2]),
      e,
    );
    const ho = holdout.filter((s) => s.Z2 != null && Number.isFinite(s.m));
    const eHo = ho.map((s) => s.R - dot([1, s.m, s.tau / 100, s.C], dm.beta));
    report.doubleResidual = {
      train_corr_e_Z: pearson(
        dmRows.map((s) => s.Z2),
        e,
      ),
      train_r2_e_on_Z: onZ?.r2,
      beta_Z: onZ?.beta?.[1],
      t_Z: onZ?.t?.[1],
      holdout_corr_e_Z: pearson(
        ho.map((s) => s.Z2),
        eHo,
      ),
      note: 'R residualized on m,τ,C then regressed on Z — isolates lead beyond barrier state',
    };
  }

  // --- 10) Theoretical implication metrics: information drift estimate μ = E[R|G]/C ≈ β Z
  // Average |drift| when |Z|>=1.5 on holdout
  const strongHo = holdout.filter((s) => s.Z2 != null && Math.abs(s.Z2) >= 1.5);
  const m1fit = nested.find((m) => m.name === 'M1_Z2');
  if (m1fit?.ok) {
    const drifts = strongHo.map((s) => m1fit.beta[1] * s.Z2);
    report.informationDrift = {
      beta_Z: m1fit.beta[1],
      t_Z: m1fit.t?.[1],
      mean_abs_drift_strong: mean(drifts.map(Math.abs)),
      mean_signed_aligned: mean(strongHo.map((s) => Math.sign(s.Z2) * (m1fit.beta[1] * s.Z2))),
      // Kelly fraction proxy for binary: f* ≈ edge / (1-odds asymmetry) rough: edge = drift when buying aligned side
      // if buy UP when Z>0: edge ≈ E[Y-C|Z] = βZ
    };
  }

  // Best model summary for strategy math
  const bestLogit = logitModels
    .filter((m) => m.ok && m.holdout)
    .sort((a, b) => a.holdout.logloss - b.holdout.logloss)[0];
  const bestOLS = nested
    .filter((m) => m.ok && m.holdout)
    .sort((a, b) => a.holdout.brier_model - b.holdout.brier_model)[0];
  report.best = { logit: bestLogit, ols: bestOLS };

  return report;
}

function fmtBeta(m) {
  if (!m?.beta) return '';
  return m.beta.map((b, i) => `β${i}=${b?.toFixed?.(4)} (t=${m.t?.[i]?.toFixed?.(2)})`).join(', ');
}

function writeDoc(report, args) {
  const L = [];
  L.push('# LADM — Matemática profunda (filtração, residual, informação)');
  L.push('');
  L.push(`Gerado a partir de \`phase3-deep-math.mjs\` | range **${args.from} → ${args.to}** | n=${report.n}`);
  L.push('');
  L.push('## 1. Objeto matemático');
  L.push('');
  L.push('Seja o evento de 5 minutos com barreira \(K\) (PTB) e settlement');
  L.push('\\[');
  L.push('Y = \\mathbf{1}_{\\{S_T^{\\mathrm{set}} \\ge K\\}} \\in \\{0,1\\}.');
  L.push('\\]');
  L.push('Preço ask UP no instante \(t\): \(C_t \\in (0,1)\). Residual de mercado:');
  L.push('\\[');
  L.push('R_t := Y - C_t.');
  L.push('\\]');
  L.push('### Filtrações');
  L.push('');
  L.push('- \(\\mathcal{F}_t\): informação do venue (book + oráculo/lake).');
  L.push('- \(\\mathcal{B}_t = \\sigma(S_u^{\\mathrm{Bin}} : u \\le t)\): história Binance.');
  L.push('- \(\\mathcal{G}_t = \\mathcal{F}_t \\vee \\mathcal{B}_t\): filtração ampliada.');
  L.push('');
  L.push('Sob precificação “eficiente” em \(\\mathcal{F}\):');
  L.push('\\[');
  L.push('C_t \\approx \\mathbb{E}[Y \\mid \\mathcal{F}_t] \\quad \\Rightarrow \\quad \\mathbb{E}[R_t \\mid \\mathcal{F}_t] \\approx 0.');
  L.push('\\]');
  L.push('A descoberta empírica é a **falha de eficiência sob \(\\mathcal{G}\)**:');
  L.push('\\[');
  L.push('\\mathbb{E}[R_t \\mid \\mathcal{G}_t] = \\mu_t \\neq 0,');
  L.push('\\]');
  L.push('com *information drift* \(\\mu_t\) mensurável em \(\\mathcal{B}_t\) (impulso de curto prazo).');
  L.push('');
  L.push('### Impulso normalizado');
  L.push('');
  L.push('Para lag \(\\ell\) e vol local \(\\hat\\sigma_t\) (1s, janela 30s):');
  L.push('\\[');
  L.push('Z_t^{(\\ell)} = \\frac{S_t^{\\mathrm{Bin}} - S_{t-\\ell}^{\\mathrm{Bin}}}{\\hat\\sigma_t \\sqrt{\\ell}}.');
  L.push('\\]');
  L.push('Moneyness de barreira (escala do ruído residual):');
  L.push('\\[');
  L.push('m_t = \\frac{S_t^{\\mathrm{oracle}} - K}{\\hat\\sigma_t \\sqrt{\\tau}}, \\quad \\tau = T-t.');
  L.push('\\]');
  L.push('Lead gap (Binance vs oráculo no mesmo \(\\ell=2\)):');
  L.push('\\[');
  L.push('\\Gamma_t = \\Delta^{\\mathrm{Bin}}_{2s} S_t - \\Delta^{\\mathrm{oracle}}_{2s} S_t.');
  L.push('\\]');
  L.push('');
  L.push('## 2. Seleção de lag (evidência)');
  L.push('');
  L.push('| ℓ | corr(Z,R) train | corr(Z,ΔC₂s) | corr(Z,ΔC₅s) |');
  L.push('|--:|---:|---:|---:|');
  for (const r of report.lagScan || []) {
    L.push(`| ${r.L} | ${r.corr_Z_R?.toFixed(4)} | ${r.corr_Z_dC2?.toFixed(4)} | ${r.corr_Z_dC5?.toFixed(4)} |`);
  }
  L.push('');
  L.push('## 3. Modelos aninhados para \(R_t\) (OLS)');
  L.push('');
  L.push('Família: \(R = X\\beta + \\varepsilon\), com features em \(Z,m,\\tau,\\Gamma\), stale.');
  L.push('');
  L.push('| Modelo | R² train | R²(R) holdout | Brier mkt | Brier C+Xβ | ΔBrier |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const m of report.nestedOLS || []) {
    if (!m.ok) continue;
    const d =
      m.holdout?.brier_mkt != null && m.holdout?.brier_model != null
        ? m.holdout.brier_mkt - m.holdout.brier_model
        : null;
    L.push(
      `| ${m.name} | ${m.r2?.toFixed(4)} | ${m.holdout?.r2_R?.toFixed(4)} | ${m.holdout?.brier_mkt?.toFixed(5)} | ${m.holdout?.brier_model?.toFixed(5)} | ${d?.toFixed(5)} |`,
    );
  }
  L.push('');
  L.push('### Partial R² (ganho além de só Z)');
  L.push('');
  L.push('```');
  L.push(JSON.stringify(report.partialR2, null, 2));
  L.push('```');
  if (report.best?.ols) {
    L.push('');
    L.push(`Melhor OLS por Brier holdout: **${report.best.ols.name}** — ${fmtBeta(report.best.ols)}`);
  }
  L.push('');
  L.push('## 4. Path catch-up vs residual terminal');
  L.push('');
  L.push('Decomposição empírica: o book *reage* (\(\\Delta C\\)) e o settlement *realiza* (\(Y\\)).');
  L.push('Se \(Z\) só prevê \(\\Delta C\) e o residual terminal some após ortogonalizar a \(\\Delta C_{2s}\),');
  L.push('o edge seria **apenas latência de path** (scalp). Se \(Z\) ainda prediz \(R_\\perp\), há **edge de settlement**.');
  L.push('');
  L.push('```');
  L.push(JSON.stringify(report.pathVsTerminal, null, 2));
  L.push('```');
  L.push('');
  L.push('## 5. Assimetria ímpar/par de \(\\mu(Z)\)');
  L.push('');
  L.push('Se \(\\mu(Z) = \\mathbb{E}[R|Z]\) for ímpar, \(E[R|Z\\ge z] + E[R|Z\\le -z] \\approx 0\).');
  L.push('');
  L.push('| z | n↑ | n↓ | E[R|Z≥z] | E[R|Z≤−z] | skew_gap (soma) | mag_gap |');
  L.push('|--:|--:|--:|---:|---:|---:|---:|');
  for (const a of report.asymmetry || []) {
    L.push(
      `| ${a.thr} | ${a.n_up} | ${a.n_dn} | ${a.E_R_up?.toFixed(4)} | ${a.E_R_dn?.toFixed(4)} | ${a.skew_gap?.toFixed(4)} | ${a.mag_gap?.toFixed(4)} |`,
    );
  }
  L.push('');
  L.push('## 6. Interação com moneyness \(m\)');
  L.push('');
  L.push('| bin | n | corr(Z,R) | n_strong | E[R\\|Z≥1.5] | E[R\\|Z≤−1.5] |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const g of report.moneynessGrid || []) {
    L.push(
      `| ${g.bin} | ${g.n} | ${g.corr_Z_R?.toFixed(4)} | ${g.n_strong} | ${g.E_R_strong_up?.toFixed(4)} | ${g.E_R_strong_dn?.toFixed(4)} |`,
    );
  }
  L.push('');
  L.push('## 7. Modelo de probabilidade (logit aninhado)');
  L.push('');
  L.push('\\[');
  L.push('\\mathrm{logit}\\,\\mathbb{P}(Y=1\\mid\\mathcal{G}_t) = \\alpha + \\beta_0\\,\\mathrm{logit}(C_t) + \\beta_Z Z_t + \\beta_m m_t + \\beta_{Zm} Z_t m_t + \\cdots');
  L.push('\\]');
  L.push('');
  L.push('| Modelo | ll train | Brier holdout | Logloss holdout | Brier mkt | Δlogloss |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const m of report.logitModels || []) {
    if (!m.ok) continue;
    const d = m.holdout.logloss_mkt - m.holdout.logloss;
    L.push(
      `| ${m.name} | ${m.ll_train?.toFixed(1)} | ${m.holdout.brier?.toFixed(5)} | ${m.holdout.logloss?.toFixed(5)} | ${m.holdout.brier_mkt?.toFixed(5)} | ${d?.toFixed(5)} |`,
    );
  }
  L.push('');
  L.push('LR tests (train):');
  L.push('```');
  L.push(JSON.stringify(report.lrTests, null, 2));
  L.push('```');
  L.push('');
  L.push('## 8. Residualização dupla (além de estado de barreira)');
  L.push('');
  L.push('Resíduo \(e = R - \\Pi_{m,\\tau,C} R\), depois \(e \\sim Z\):');
  L.push('```');
  L.push(JSON.stringify(report.doubleResidual, null, 2));
  L.push('```');
  L.push('');
  L.push('## 9. Information drift e Kelly conceitual');
  L.push('');
  L.push('```');
  L.push(JSON.stringify(report.informationDrift, null, 2));
  L.push('```');
  L.push('');
  L.push('Para aposta unitária no lado alinhado com preço \(C\) e probabilidade real \(p = C + \\mu\):');
  L.push('\\[');
  L.push('f^\\star = \\frac{p - C}{1 - C} \\quad (\\text{lado UP barato}), \\quad \\mu = p - C.');
  L.push('\\]');
  L.push('Com \(\\mu \\approx \\beta_Z Z\) e \(Z\\sim 2\), \(\\mu \\sim 2\\beta_Z\) (ordem dos pp observados).');
  L.push('');
  L.push('## 10. Var condicional');
  L.push('');
  L.push('```');
  L.push(JSON.stringify(report.conditionalVariance, null, 2));
  L.push('```');
  L.push('');
  L.push('## 11. Síntese matemática do que há *a mais*');
  L.push('');
  L.push(synthesis(report));
  L.push('');
  L.push('## 12. Forma canônica recomendada (teoria + prática)');
  L.push('');
  L.push('\\[');
  L.push('p_t^{\\mathcal{G}} = \\sigma\\Big( \\alpha + \\beta_C \\mathrm{logit}(C_t) + \\beta_Z Z_t^{(2)} + \\beta_m m_t + \\beta_{Zm} Z_t^{(2)} m_t + \\beta_\\Gamma \\Gamma_t \\Big)');
  L.push('\\]');
  L.push('ou, em residual linear (mais simples para sizing):');
  L.push('\\[');
  L.push('\\mu_t = \\beta_Z Z_t^{(2)} + \\beta_{Zm} Z_t^{(2)} m_t + \\beta_\\Gamma \\Gamma_t, \\quad p_t = \\mathrm{clip}(C_t + \\mu_t).');
  L.push('\\]');
  L.push('Edge executável no lado alinhado: \(\\mathrm{edge} = \\mathrm{sign}(Z)\\cdot \\mu\) quando se compra o lado do impulso a ask \(C^{\\mathrm{side}}\).');
  L.push('');
  return L.join('\n');
}

function synthesis(report) {
  const lines = [];
  const lags = report.lagScan || [];
  const bestLag = [...lags].sort((a, b) => Math.abs(b.corr_Z_R || 0) - Math.abs(a.corr_Z_R || 0))[0];
  lines.push(`1. **Lag ótimo (corr com R):** ℓ=${bestLag?.L} (corr=${bestLag?.corr_Z_R?.toFixed(4)}). Path ΔC₂s tipicamente mais correlacionado com Z do que R — dualidade path/terminal.`);

  const pvt = report.pathVsTerminal;
  if (pvt?.holdout) {
    lines.push(
      `2. **Path vs terminal:** corr(Z,R)=${pvt.holdout.corr_Z_R?.toFixed(4)}, corr(Z,R⊥dC₂)=${pvt.holdout.corr_Z_Rorth?.toFixed(4)}. ` +
        (Math.abs(pvt.holdout.corr_Z_Rorth || 0) > 0.02
          ? 'Z **ainda** explica residual terminal após remover catch-up de 2s → edge **não** se reduz a scalp de 2s.'
          : 'Z perde força em R⊥ → grande parte é catch-up de path; settlement edge mais fraco.'),
    );
  }

  const a15 = (report.asymmetry || []).find((a) => a.thr === 1.5);
  if (a15) {
    lines.push(
      `3. **Assimetria:** E[R|Z≥1.5]=${a15.E_R_up?.toFixed(4)}, E[R|Z≤-1.5]=${a15.E_R_dn?.toFixed(4)}, skew_gap=${a15.skew_gap?.toFixed(4)}. ` +
        (Math.abs(a15.skew_gap) > 0.02
          ? 'μ(Z) **não** é ímpar pura — UP e DOWN impulsos têm magnitudes diferentes (// usar M6/L4).'
          : 'μ(Z) aproximadamente ímpar — tanh/linear em Z é razoável.'),
    );
  }

  const dr = report.doubleResidual;
  if (dr) {
    lines.push(
      `4. **Além do estado de barreira:** após residualizar R em (m,τ,C), corr(e,Z) holdout=${dr.holdout_corr_e_Z?.toFixed(4)} (t_train≈${dr.t_Z?.toFixed(2)}). ` +
        (Math.abs(dr.holdout_corr_e_Z || 0) > 0.03
          ? 'Lead **não** é só proxy de moneyness/vol.'
          : 'Parte do sinal Z colapsa em estado de barreira — cuidado com confusão.'),
    );
  }

  const L1 = report.lrTests?.L1_vs_L0;
  const L2 = report.lrTests?.L2_vs_L1;
  if (L1) {
    lines.push(`5. **LR L1 vs L0 (Z no logit):** stat=${L1.stat?.toFixed(1)}, p≈${L1.p_approx?.toFixed(4)} — inclusão de Z no logit(C).`);
  }
  if (L2) {
    lines.push(`6. **LR L2 vs L1 (m e Z×m):** stat=${L2.stat?.toFixed(1)}, p≈${L2.p_approx?.toFixed(4)} — interação barreira.`);
  }

  const best = report.best?.logit;
  if (best?.holdout) {
    lines.push(
      `7. **Melhor logit holdout:** ${best.name}, Δlogloss vs mkt=${(best.holdout.logloss_mkt - best.holdout.logloss)?.toFixed(5)}, ΔBrier=${(best.holdout.brier_mkt - best.holdout.brier)?.toFixed(5)}.`,
    );
  }

  lines.push(
    '8. **Implicação estrutural:** o objeto novo não é uma SDE de vol do oráculo; é um **drift de informação** μ_t = E[Y|G_t]−C_t gerado por ampliação de filtração com lead externo, possivelmente **modulado por moneyness** e **lead gap**, com componente de settlement além do catch-up de 2s.',
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Deep math LADM', args.from, '→', args.to);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });

  const all = await loadAll(args);
  console.log('n=', all.length);
  if (all.length < 5000) {
    console.error('too few');
    process.exit(1);
  }

  const report = analyze(all);
  report.from = args.from;
  report.to = args.to;
  report.generated_at = new Date().toISOString();

  const jp = path.join(OUT_DIR, `phase3-deep-math-${args.from}_${args.to}.json`);
  fs.writeFileSync(jp, JSON.stringify(report, null, 2));
  const md = writeDoc(report, args);
  fs.writeFileSync(DOC_PATH, md);

  console.log('\n=== LAG SCAN ===');
  console.table(report.lagScan);
  console.log('\n=== NESTED OLS HOLDOUT BRIER ===');
  console.table(
    report.nestedOLS.filter((m) => m.ok).map((m) => ({
      m: m.name,
      r2tr: m.r2?.toFixed(4),
      b_m: m.holdout?.brier_mkt?.toFixed(5),
      b_mod: m.holdout?.brier_model?.toFixed(5),
      dB: m.holdout ? (m.holdout.brier_mkt - m.holdout.brier_model)?.toFixed(5) : null,
    })),
  );
  console.log('\n=== PATH VS TERMINAL ===');
  console.log(JSON.stringify(report.pathVsTerminal, null, 2));
  console.log('\n=== ASYM ===');
  console.table(report.asymmetry);
  console.log('\n=== MONEYNESS ===');
  console.table(report.moneynessGrid);
  console.log('\n=== LOGIT ===');
  console.table(
    report.logitModels.filter((m) => m.ok).map((m) => ({
      m: m.name,
      b: m.holdout.brier?.toFixed(5),
      ll: m.holdout.logloss?.toFixed(5),
      dLL: (m.holdout.logloss_mkt - m.holdout.logloss)?.toFixed(5),
    })),
  );
  console.log('\n=== DOUBLE RESID ===');
  console.log(report.doubleResidual);
  console.log('\n=== LR ===');
  console.log(report.lrTests);
  console.log('\nSYNTHESIS\n', synthesis(report));
  console.log('Wrote', jp);
  console.log('Wrote', DOC_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
