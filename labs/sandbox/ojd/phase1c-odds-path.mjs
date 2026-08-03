/**
 * Pivot C — Odds-Path Barrier Consistency (OPBC)
 *
 * Tests whether inelastic / hyper-reactive odds paths (ΔC vs expected δ·ΔX)
 * leave systematic residual vs terminal outcome — the path-consistency anomaly
 * that survives after level-calibration of p_mkt is already tight.
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase1c-odds-path.mjs \
 *     --underlying BTC --from 2026-05-04 --to 2026-07-15
 *   node labs/sandbox/ojd/phase1c-odds-path.mjs --underlying ETH --from 2026-05-24 --to 2026-07-15
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const OUT_DIR = path.join('labs', 'sandbox', 'ojd', 'reports');

const LOOKBACK_SEC = 8; // path window for ΔX, ΔC
const EVAL_TAUS = [120, 90, 60, 45, 30];
const TAU_TOL = 2.5;
const MIN_BARS = 50;
const VOL_WIN = 30; // 1s bars for local σ

function parseArgs(argv) {
  const out = {
    underlying: 'BTC',
    from: '2026-05-04',
    to: '2026-07-15',
    bookDepth: 25,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--underlying') out.underlying = String(argv[++i]).toUpperCase();
    else if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
    else if (argv[i] === '--book-depth') out.bookDepth = Number(argv[++i]);
  }
  return out;
}

function lakeBase(underlying, bookDepth) {
  return path.join(
    LAKE_ROOT,
    'backtest_ticks',
    `underlying=${underlying}`,
    'interval=5m',
    `book_depth=${bookDepth}`,
  );
}

function listDays(base, from, to) {
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((dt) => dt >= from && dt <= to)
    .sort();
}

function filesFor(base, dt) {
  const dir = path.join(base, `dt=${dt}`);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.parquet'))
    .map((f) => path.resolve(dir, f));
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

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function clip01(x) {
  return Math.min(0.999, Math.max(0.001, x));
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  if (!xs.length) return null;
  const a = xs.slice().sort((u, v) => u - v);
  return a[Math.floor(a.length / 2)];
}

function quantile(xs, q) {
  if (!xs.length) return null;
  const a = xs.slice().sort((u, v) => u - v);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))));
  return a[i];
}

function brier(ps, ys) {
  if (!ps.length) return null;
  let s = 0;
  for (let i = 0; i < ps.length; i++) s += (ps[i] - ys[i]) ** 2;
  return s / ps.length;
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

function toBars(ticks) {
  const first = Math.floor(Number(ticks[0].ts_ms) / 1000);
  const last = Math.floor(Number(ticks[ticks.length - 1].ts_ms) / 1000);
  const n = last - first + 1;
  if (n < MIN_BARS || n > 400) return null;

  const px = new Array(n).fill(null);
  const upAsk = new Array(n).fill(null);
  const upBid = new Array(n).fill(null);
  const downAsk = new Array(n).fill(null);
  const ts = new Array(n);
  for (let i = 0; i < n; i++) ts[i] = (first + i) * 1000;

  for (const t of ticks) {
    const i = Math.floor(Number(t.ts_ms) / 1000) - first;
    if (i < 0 || i >= n) continue;
    const p = Number(t.underlying_price);
    const ua = Number(t.up_best_ask);
    const ub = Number(t.up_best_bid);
    const da = Number(t.down_best_ask);
    if (Number.isFinite(p)) px[i] = p;
    if (Number.isFinite(ua)) upAsk[i] = ua;
    if (Number.isFinite(ub)) upBid[i] = ub;
    if (Number.isFinite(da)) downAsk[i] = da;
  }

  for (let i = 1; i < n; i++) {
    if (px[i] == null && px[i - 1] != null) {
      let gap = 1;
      while (i + gap < n && px[i + gap] == null) gap++;
      if (gap <= 3) px[i] = px[i - 1];
    }
    if (upAsk[i] == null && upAsk[i - 1] != null) upAsk[i] = upAsk[i - 1];
    if (upBid[i] == null && upBid[i - 1] != null) upBid[i] = upBid[i - 1];
    if (downAsk[i] == null && downAsk[i - 1] != null) downAsk[i] = downAsk[i - 1];
  }

  return { px, upAsk, upBid, downAsk, ts };
}

/**
 * Theoretical digital delta ∂P/∂X ≈ φ(z)/(σ√τ)
 * and model p from continuous Gaussian digital.
 */
function modelDigital(x, sigmaPerSqrtSec, tau) {
  const sigT = Math.max(1e-6, sigmaPerSqrtSec * Math.sqrt(Math.max(tau, 1)));
  const z = x / sigT;
  const p = clip01(normalCdf(z));
  const delta = normalPdf(z) / sigT; // dP/dX in probability per $
  return { p, delta, z, sigT };
}

function processDay(rows, underlying) {
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
    const dt = ticks[0].dt;
    if (!Number.isFinite(eventEnd) || !Number.isFinite(ptb) || ptb <= 0) continue;

    const sT = Number(ticks[ticks.length - 1].underlying_price);
    if (!Number.isFinite(sT)) continue;
    const upWins = sT >= ptb ? 1 : 0;

    const bars = toBars(ticks);
    if (!bars) continue;
    const { px, upAsk, upBid, downAsk, ts } = bars;
    const n = px.length;

    // 1s returns for local vol
    const ret = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      if (px[i] != null && px[i - 1] != null) ret[i] = px[i] - px[i - 1];
    }

    for (const targetTau of EVAL_TAUS) {
      let best = -1;
      let bestErr = 1e9;
      for (let i = LOOKBACK_SEC + VOL_WIN; i < n; i++) {
        if (px[i] == null || upAsk[i] == null || px[i - LOOKBACK_SEC] == null || upAsk[i - LOOKBACK_SEC] == null) {
          continue;
        }
        const tau = (eventEnd - ts[i]) / 1000;
        const err = Math.abs(tau - targetTau);
        if (err < bestErr) {
          bestErr = err;
          best = i;
        }
      }
      if (best < 0 || bestErr > TAU_TOL) continue;

      const i0 = best - LOOKBACK_SEC;
      const x0 = px[i0] - ptb;
      const x1 = px[best] - ptb;
      const dX = x1 - x0;
      const c0 = upAsk[i0];
      const c1 = upAsk[best];
      const dC = c1 - c0;

      // mid if bids available
      let mid0 = c0;
      let mid1 = c1;
      if (upBid[i0] != null && upBid[best] != null) {
        mid0 = 0.5 * (upAsk[i0] + upBid[i0]);
        mid1 = 0.5 * (upAsk[best] + upBid[best]);
      }
      const dCmid = mid1 - mid0;

      // local sigma $/sqrt(s) from last VOL_WIN 1s returns
      let ss = 0;
      let cn = 0;
      for (let k = best - VOL_WIN + 1; k <= best; k++) {
        if (px[k] != null && px[k - 1] != null) {
          ss += ret[k] * ret[k];
          cn++;
        }
      }
      if (cn < 10) continue;
      const sigmaPerSqrtSec = Math.sqrt(ss / cn); // $ per sqrt(second) for 1s bars
      if (!(sigmaPerSqrtSec > 1e-6)) continue;

      const tau = Math.max(1, (eventEnd - ts[best]) / 1000);
      const mod = modelDigital(x1, sigmaPerSqrtSec, tau);
      const mod0 = modelDigital(x0, sigmaPerSqrtSec, tau + LOOKBACK_SEC);

      // Expected ΔC from barrier model: use average delta * dX, plus theta-ish via p1-p0 model
      const dC_model_delta = mod.delta * dX;
      const dC_model_full = mod.p - mod0.p;

      // Path residual: how much odds moved vs model-implied move
      const pathGap = dC - dC_model_full; // ask path
      const pathGapMid = dCmid - dC_model_full;

      // Elasticity ratio: realized dC / expected |dC| (sign-aware)
      const expMove = dC_model_full;
      let elast = null;
      if (Math.abs(expMove) >= 0.008) {
        elast = dC / expMove;
      } else if (Math.abs(dX) >= 2 * sigmaPerSqrtSec) {
        // spot moved but model p almost flat (deep ITM/OTM) — use delta form
        const alt = dC_model_delta;
        if (Math.abs(alt) >= 0.005) elast = dC / alt;
      }

      // Inelastic: model says odds should move, book barely does
      // Hyper: book moves more than model
      // Need meaningful expected move
      const meaningful = Math.abs(expMove) >= 0.015 || (Math.abs(dX) >= 3 * sigmaPerSqrtSec && Math.abs(mod.delta * dX) >= 0.01);

      const pM = clip01(c1);
      if (pM <= 0.02 || pM >= 0.98) continue;

      const oddsSum =
        Number.isFinite(downAsk[best]) && downAsk[best] > 0 ? c1 + downAsk[best] : null;

      // Stale physical edge: model p vs ask after path
      const edgePhys = mod.p - pM;

      // Path-consistency edge proxy:
      // if odds under-reacted to move toward UP (dX>0, elast low), UP may be cheap
      // if odds under-reacted to move toward DOWN (dX<0, elast low), UP may be rich
      let pathEdge = 0;
      if (meaningful && elast != null) {
        // under-reaction: elast < 1 → residual correction toward model path end
        pathEdge = (1 - Math.min(Math.max(elast, -1), 2)) * expMove;
        // pathEdge ≈ how much more dC should have been; + means ask should be higher (UP richer fair)
      }

      const pPath = clip01(pM + 0.65 * pathEdge); // blend toward path-implied correction
      const pBlend = clip01(0.5 * pM + 0.5 * mod.p);

      snaps.push({
        underlying,
        conditionId: cid,
        dt,
        tsMs: ts[best],
        tau: targetTau,
        x: x1,
        absX: Math.abs(x1),
        dX,
        dC,
        dCmid,
        dC_model: dC_model_full,
        dC_model_delta,
        pathGap,
        pathGapMid,
        elast,
        meaningful: meaningful ? 1 : 0,
        sigma: sigmaPerSqrtSec,
        pM,
        pPhys: mod.p,
        pPath,
        pBlend,
        edgePhys,
        pathEdge,
        z: mod.z,
        delta: mod.delta,
        oddsSum,
        upWins,
        residM: upWins - pM,
        residPhys: upWins - mod.p,
        residPath: upWins - pPath,
        residBlend: upWins - pBlend,
      });
    }
  }

  return snaps;
}

function elastRegime(e, meaningful) {
  if (!meaningful) return 'noise';
  if (e == null) return 'undef';
  if (e < 0.25) return 'inelastic';
  if (e < 0.7) return 'under';
  if (e <= 1.3) return 'matched';
  if (e <= 2.0) return 'over';
  return 'hyper';
}

function absXBin(x, underlying) {
  // scale bins by asset typical $ distance
  const scale = underlying === 'BTC' ? 1 : underlying === 'ETH' ? 0.05 : underlying === 'SOL' ? 0.002 : 1;
  const d = x / scale; // "BTC-equivalent" rough
  if (d < 5) return 'near';
  if (d < 25) return 'mid';
  if (d < 50) return 'far';
  return 'extreme';
}

function summarize(snaps, keyFn, keyName) {
  const m = new Map();
  for (const s of snaps) {
    const k = keyFn(s);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return [...m.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([k, arr]) => {
      if (arr.length < 60) return { [keyName]: k, n: arr.length, thin: true };
      const y = arr.map((s) => s.upWins);
      const pM = arr.map((s) => s.pM);
      const pPhys = arr.map((s) => s.pPhys);
      const pPath = arr.map((s) => s.pPath);
      const pBlend = arr.map((s) => s.pBlend);
      return {
        [keyName]: k,
        n: arr.length,
        up_rate: mean(y),
        mean_pM: mean(pM),
        mean_pPhys: mean(pPhys),
        resid_m: mean(arr.map((s) => s.residM)),
        resid_phys: mean(arr.map((s) => s.residPhys)),
        resid_path: mean(arr.map((s) => s.residPath)),
        brier_m: brier(pM, y),
        brier_phys: brier(pPhys, y),
        brier_path: brier(pPath, y),
        brier_blend: brier(pBlend, y),
        mean_elast: mean(arr.map((s) => s.elast).filter((x) => x != null && Number.isFinite(x))),
        mean_pathGap: mean(arr.map((s) => s.pathGap)),
        mean_edgePhys: mean(arr.map((s) => s.edgePhys)),
        corr_pathGap_residM: pearson(
          arr.map((s) => s.pathGap),
          arr.map((s) => s.residM),
        ),
        corr_elast_residM: pearson(
          arr.map((s) => (s.elast == null ? 1 : s.elast)),
          arr.map((s) => s.residM),
        ),
      };
    });
}

function gateC1(byRegime, splitName) {
  const inel = byRegime.find((r) => r.regime === 'inelastic' && !r.thin);
  const match = byRegime.find((r) => r.regime === 'matched' && !r.thin);
  const hyper = byRegime.find((r) => r.regime === 'hyper' && !r.thin);
  if (!inel || !match) {
    return { pass: false, split: splitName, reason: 'missing inelastic or matched mass' };
  }
  // C1: inelastic odds show different residual or worse/better brier structure vs matched
  const residGap = Math.abs((inel.resid_m || 0) - (match.resid_m || 0));
  const pathBetter =
    inel.brier_path != null && inel.brier_m != null && inel.brier_path < inel.brier_m - 0.002;
  const corrOk =
    byRegime.find((r) => r.regime === 'inelastic') &&
    Math.abs(inel.corr_pathGap_residM || 0) >= 0.03;

  // actionable: inelastic residual magnitude or path model beats market in inelastic
  const pass = residGap >= 0.02 || pathBetter;
  return {
    pass,
    split: splitName,
    residGap_inel_vs_matched: residGap,
    inel_resid_m: inel.resid_m,
    match_resid_m: match.resid_m,
    inel_brier_m: inel.brier_m,
    inel_brier_path: inel.brier_path,
    path_beats_mkt_inel: pathBetter,
    hyper_resid_m: hyper?.resid_m ?? null,
    corr_pathGap_residM_inel: inel.corr_pathGap_residM,
    reason: pass
      ? 'inelastic path regime differs from matched / path model improves'
      : 'no material residual or calibragem gap in inelastic regime',
  };
}

function decisionFromGates(gAll, gTrain, gValid, global) {
  if (gAll.pass && gValid.pass) {
    return 'PROCEED Phase II: Pivot C inelastic/path anomaly stable on valid. Formalize Ψ_path and style facts.';
  }
  if (gAll.pass && gTrain.pass && !gValid.pass) {
    return 'HOLD: signal in-sample / all but fails valid — tighten filters (tau, absX), do not trade.';
  }
  if (global.brier_path < global.brier_m - 0.003) {
    return 'WEAK-PATH: path blend beats market globally a bit — inspect regimes before theory claim.';
  }
  if (global.brier_phys < global.brier_m - 0.003) {
    return 'UNEXPECTED: physical digital beats market — recheck data/outcome definition.';
  }
  return 'KILL Pivot C (this formulation): odds-path elasticity does not yield stable residual vs market.';
}

async function loadDay(conn, files) {
  if (!files.length) return [];
  const pql = `[${files.map((f) => quotedString(f)).join(', ')}]`;
  const sql = `
    SELECT
      condition_id,
      dt,
      CAST(epoch_ms(try_cast(ts AS TIMESTAMP)) AS BIGINT) AS ts_ms,
      CAST(epoch_ms(try_cast(event_end AS TIMESTAMP)) AS BIGINT) AS event_end_ms,
      underlying_price,
      price_to_beat,
      up_best_ask,
      up_best_bid,
      down_best_ask
    FROM read_parquet(${pql})
    WHERE underlying_price IS NOT NULL
      AND price_to_beat IS NOT NULL
      AND up_best_ask IS NOT NULL
    ORDER BY condition_id, ts_ms
  `;
  const res = await conn.runAndReadAll(sql);
  return res.getRowObjectsJS();
}

function toMarkdown(report) {
  const L = [];
  L.push(`# Pivot C — Odds-Path Barrier Consistency (${report.underlying})`);
  L.push('');
  L.push(`- Range: **${report.from} → ${report.to}**`);
  L.push(`- Snapshots: **${report.n}** (train ${report.n_train} / valid ${report.n_valid})`);
  L.push(`- Lookback path: **${LOOKBACK_SEC}s** | eval τ: ${EVAL_TAUS.join(', ')}s`);
  L.push('');
  L.push('## Global Brier (lower better)');
  L.push('');
  L.push('| Model | Brier |');
  L.push('|---|---:|');
  L.push(`| Market ask UP | ${report.global.brier_m?.toFixed(5)} |`);
  L.push(`| Physical digital Φ | ${report.global.brier_phys?.toFixed(5)} |`);
  L.push(`| Path-corrected | ${report.global.brier_path?.toFixed(5)} |`);
  L.push(`| Blend 50/50 | ${report.global.brier_blend?.toFixed(5)} |`);
  L.push('');
  L.push('## By elasticity regime');
  L.push('');
  L.push('| regime | n | resid_m | brier_m | brier_path | mean_elast | corr(pathGap,resid_m) |');
  L.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of report.by_regime) {
    if (r.thin) {
      L.push(`| ${r.regime} | ${r.n} | thin | | | | |`);
      continue;
    }
    L.push(
      `| ${r.regime} | ${r.n} | ${r.resid_m?.toFixed(4)} | ${r.brier_m?.toFixed(4)} | ${r.brier_path?.toFixed(4)} | ${r.mean_elast?.toFixed(3)} | ${r.corr_pathGap_residM?.toFixed?.(3) ?? r.corr_pathGap_residM} |`,
    );
  }
  L.push('');
  L.push('## Gates');
  L.push('');
  L.push(`- **C1 all:** ${report.gates.all.pass ? 'PASS' : 'FAIL'} — ${report.gates.all.reason}`);
  L.push(`- **C1 train:** ${report.gates.train.pass ? 'PASS' : 'FAIL'}`);
  L.push(`- **C1 valid:** ${report.gates.valid.pass ? 'PASS' : 'FAIL'} — ${report.gates.valid.reason}`);
  L.push('');
  L.push('## Decision');
  L.push('');
  L.push(report.decision);
  L.push('');
  return L.join('\n');
}

async function runOne(args) {
  const base = lakeBase(args.underlying, args.bookDepth);
  const days = listDays(base, args.from, args.to);
  if (!days.length) {
    console.error(`No days for ${args.underlying} in ${base} (${args.from}..${args.to})`);
    return null;
  }

  console.log(`\n=== Pivot C | ${args.underlying} | ${args.from} → ${args.to} | ${days.length} days ===`);

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '6GB'`);

  const all = [];
  for (const dt of days) {
    const files = filesFor(base, dt);
    if (!files.length) continue;
    const t0 = Date.now();
    const rows = await loadDay(conn, files);
    const snaps = processDay(rows, args.underlying);
    all.push(...snaps);
    console.log(`  ${dt}: ticks=${rows.length} snaps=${snaps.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  if (all.length < 300) {
    console.error(`Too few snapshots (${all.length}) for ${args.underlying}`);
    return null;
  }

  all.sort((a, b) => a.tsMs - b.tsMs);
  const cutTs = all[Math.floor(all.length * 0.7)].tsMs;
  const train = all.filter((s) => s.tsMs < cutTs);
  const valid = all.filter((s) => s.tsMs >= cutTs);

  const y = all.map((s) => s.upWins);
  const global = {
    n: all.length,
    up_rate: mean(y),
    brier_m: brier(all.map((s) => s.pM), y),
    brier_phys: brier(all.map((s) => s.pPhys), y),
    brier_path: brier(all.map((s) => s.pPath), y),
    brier_blend: brier(all.map((s) => s.pBlend), y),
    resid_m: mean(all.map((s) => s.residM)),
    corr_pathGap_residM: pearson(all.map((s) => s.pathGap), all.map((s) => s.residM)),
    corr_elast_residM: pearson(
      all.map((s) => (s.elast == null || !Number.isFinite(s.elast) ? 1 : Math.min(3, Math.max(-1, s.elast)))),
      all.map((s) => s.residM),
    ),
    corr_edgePhys_residM: pearson(all.map((s) => s.edgePhys), all.map((s) => s.residM)),
    mean_elast: mean(all.map((s) => s.elast).filter((x) => x != null && Number.isFinite(x))),
    pct_meaningful: mean(all.map((s) => s.meaningful)),
  };

  const by_regime = summarize(all, (s) => elastRegime(s.elast, s.meaningful), 'regime');
  const by_regime_train = summarize(train, (s) => elastRegime(s.elast, s.meaningful), 'regime');
  const by_regime_valid = summarize(valid, (s) => elastRegime(s.elast, s.meaningful), 'regime');
  const by_tau = summarize(all, (s) => String(s.tau), 'tau');
  const by_absX = summarize(all, (s) => absXBin(s.absX, args.underlying), 'absX');
  const by_tau_regime = summarize(
    all.filter((s) => s.meaningful),
    (s) => `${s.tau}|${elastRegime(s.elast, true)}`,
    'tau_regime',
  );

  // Focus pocket: mid distance + inelastic + tau in 45-90
  const pocket = all.filter(
    (s) =>
      s.meaningful &&
      elastRegime(s.elast, true) === 'inelastic' &&
      absXBin(s.absX, args.underlying) === 'mid' &&
      s.tau >= 45 &&
      s.tau <= 90,
  );
  const pocketValid = valid.filter(
    (s) =>
      s.meaningful &&
      elastRegime(s.elast, true) === 'inelastic' &&
      absXBin(s.absX, args.underlying) === 'mid' &&
      s.tau >= 45 &&
      s.tau <= 90,
  );

  function pocketStats(arr, name) {
    if (arr.length < 40) return { name, n: arr.length, thin: true };
    const y0 = arr.map((s) => s.upWins);
    return {
      name,
      n: arr.length,
      resid_m: mean(arr.map((s) => s.residM)),
      brier_m: brier(arr.map((s) => s.pM), y0),
      brier_path: brier(arr.map((s) => s.pPath), y0),
      brier_phys: brier(arr.map((s) => s.pPhys), y0),
      mean_edgePhys: mean(arr.map((s) => s.edgePhys)),
      // naive EV if buy UP when path says underpriced (pPath > pM + 0.03)
      n_signal: arr.filter((s) => s.pPath > s.pM + 0.03).length,
      resid_when_signal: mean(arr.filter((s) => s.pPath > s.pM + 0.03).map((s) => s.residM)),
    };
  }

  const gates = {
    all: gateC1(by_regime, 'all'),
    train: gateC1(by_regime_train, 'train'),
    valid: gateC1(by_regime_valid, 'valid'),
  };

  const decision = decisionFromGates(gates.all, gates.train, gates.valid, global);

  const report = {
    theory: 'PivotC-OPBC',
    underlying: args.underlying,
    from: args.from,
    to: args.to,
    days: days.length,
    lookback_sec: LOOKBACK_SEC,
    eval_taus: EVAL_TAUS,
    n: all.length,
    n_train: train.length,
    n_valid: valid.length,
    cut_ts: cutTs,
    global,
    by_regime,
    by_regime_train,
    by_regime_valid,
    by_tau,
    by_absX,
    by_tau_regime: by_tau_regime.filter((r) => !r.thin).slice(0, 40),
    pocket_all: pocketStats(pocket, 'inel+mid+tau45-90'),
    pocket_valid: pocketStats(pocketValid, 'inel+mid+tau45-90 valid'),
    gates,
    decision,
    generated_at: new Date().toISOString(),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = `${args.underlying.toLowerCase()}-${args.from}_${args.to}`;
  const jsonPath = path.join(OUT_DIR, `phase1c-odds-path-${tag}.json`);
  const mdPath = path.join(OUT_DIR, `phase1c-odds-path-${tag}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, toMarkdown(report));

  console.log('\n=== GLOBAL ===');
  console.log(JSON.stringify(global, null, 2));
  console.log('\n=== BY REGIME ===');
  console.table(
    by_regime.map((r) =>
      r.thin
        ? { regime: r.regime, n: r.n, thin: true }
        : {
            regime: r.regime,
            n: r.n,
            resid_m: r.resid_m?.toFixed(4),
            b_m: r.brier_m?.toFixed(4),
            b_path: r.brier_path?.toFixed(4),
            elast: r.mean_elast?.toFixed(3),
          },
    ),
  );
  console.log('\nPOCKET', report.pocket_all, report.pocket_valid);
  console.log('\nGATES', gates.all.pass, gates.train.pass, gates.valid.pass);
  console.log('DECISION:', decision);
  console.log('Wrote', jsonPath);

  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // If --all-assets flag style: run BTC then ETH SOL
  const multi = process.argv.includes('--multi');
  if (multi) {
    const results = [];
    for (const u of [
      { underlying: 'BTC', from: '2026-05-04', to: '2026-07-15' },
      { underlying: 'ETH', from: '2026-05-24', to: '2026-07-15' },
      { underlying: 'SOL', from: '2026-05-24', to: '2026-07-15' },
    ]) {
      const r = await runOne({ ...args, ...u });
      if (r) results.push({ underlying: r.underlying, decision: r.decision, gates: r.gates, global: r.global, n: r.n });
    }
    const summaryPath = path.join(OUT_DIR, 'phase1c-odds-path-multi-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
    console.log('\n=== MULTI SUMMARY ===');
    console.table(
      results.map((r) => ({
        u: r.underlying,
        n: r.n,
        b_m: r.global.brier_m?.toFixed(4),
        b_path: r.global.brier_path?.toFixed(4),
        c1_valid: r.gates.valid.pass,
        decision: r.decision.slice(0, 40),
      })),
    );
    console.log('Wrote', summaryPath);
    return;
  }

  await runOne(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
