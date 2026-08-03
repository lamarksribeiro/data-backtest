/**
 * OJD-V0 Phase I — Oriented Jump Decomposition anomaly hunt
 *
 * Tests whether jump-share (RV - BV)/RV explains residual terminal outcomes
 * beyond total vol and distance-to-PTB (the Gaussian digital baseline).
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase1-anomaly.mjs
 *   node labs/sandbox/ojd/phase1-anomaly.mjs --from 2026-05-04 --to 2026-06-15
 *
 * Output: labs/sandbox/ojd/reports/phase1-anomaly.json + .md
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');
const OUT_DIR = path.join('labs', 'sandbox', 'ojd', 'reports');

const WINDOW_SEC = 45;
const BAR_SEC = 1; // resample ticks → 1s bars (kills microstructure noise as "jumps")
const EVAL_TAUS = [120, 90, 60, 45, 30];
const TAU_TOL = 2.5;
const JUMP_Z = 3.5; // Lee–Mykland-ish threshold on 1s returns / rolling sigma
const MIN_RETURNS = 20;
const VERSION = 'phase1-bis-1s';

function parseArgs(argv) {
  const out = { from: '2026-05-04', to: '2026-06-15' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
  }
  return out;
}

function listDayDirs(from, to) {
  if (!fs.existsSync(BASE)) return [];
  return fs
    .readdirSync(BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((dt) => dt >= from && dt <= to)
    .sort();
}

function parquetFilesForDay(dt) {
  const dir = path.join(BASE, `dt=${dt}`);
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

function clip01(x) {
  return Math.min(0.999, Math.max(0.001, x));
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function brier(ps, ys) {
  if (!ps.length) return null;
  let s = 0;
  for (let i = 0; i < ps.length; i++) {
    const e = ps[i] - ys[i];
    s += e * e;
  }
  return s / ps.length;
}

function logLoss(ps, ys) {
  if (!ps.length) return null;
  let s = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = clip01(ps[i]);
    s += ys[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / ps.length;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
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

function etaBin(eta) {
  if (eta == null || !Number.isFinite(eta)) return 'na';
  if (eta < 0.1) return '[0,0.1)';
  if (eta < 0.25) return '[0.1,0.25)';
  if (eta < 0.45) return '[0.25,0.45)';
  if (eta < 0.65) return '[0.45,0.65)';
  return '[0.65,1]';
}

function absXBin(absX) {
  if (absX < 5) return '[0,5)';
  if (absX < 15) return '[5,15)';
  if (absX < 30) return '[15,30)';
  if (absX < 50) return '[30,50)';
  return '[50+)';
}

function hourUtc(tsMs) {
  return new Date(tsMs).getUTCHours();
}

/**
 * Resample irregular ticks to last-price 1s bars inside one event.
 * Returns { tsMs[], px[], book[] } equispaced where possible (gaps allowed).
 */
function toOneSecondBars(ticks) {
  if (!ticks.length) return null;
  const firstTs = Number(ticks[0].ts_ms);
  const lastTs = Number(ticks[ticks.length - 1].ts_ms);
  if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs) || lastTs <= firstTs) return null;

  const startSec = Math.floor(firstTs / 1000);
  const endSec = Math.floor(lastTs / 1000);
  const nBars = endSec - startSec + 1;
  if (nBars < MIN_RETURNS + 5 || nBars > 400) return null;

  const px = new Array(nBars).fill(null);
  const upAsk = new Array(nBars).fill(null);
  const downAsk = new Array(nBars).fill(null);
  const tsMs = new Array(nBars);

  for (let i = 0; i < nBars; i++) tsMs[i] = (startSec + i) * 1000;

  for (const t of ticks) {
    const sec = Math.floor(Number(t.ts_ms) / 1000);
    const idx = sec - startSec;
    if (idx < 0 || idx >= nBars) continue;
    const p = Number(t.underlying_price);
    if (Number.isFinite(p)) px[idx] = p;
    const ua = Number(t.up_best_ask);
    const da = Number(t.down_best_ask);
    if (Number.isFinite(ua)) upAsk[idx] = ua;
    if (Number.isFinite(da)) downAsk[idx] = da;
  }

  // forward-fill short gaps (≤3s)
  for (let i = 1; i < nBars; i++) {
    if (px[i] == null && px[i - 1] != null) {
      // only fill if next real tick within 3s later or previous exists
      let gap = 1;
      while (i + gap < nBars && px[i + gap] == null) gap++;
      if (gap <= 3) px[i] = px[i - 1];
    }
    if (upAsk[i] == null && upAsk[i - 1] != null) upAsk[i] = upAsk[i - 1];
    if (downAsk[i] == null && downAsk[i - 1] != null) downAsk[i] = downAsk[i - 1];
  }

  return { tsMs, px, upAsk, downAsk, startSec };
}

/**
 * Build snapshots from raw tick stream for one day.
 * Resamples to 1s bars, then RV/BV jump-share + oriented jump counts.
 */
function processDayTicks(rows) {
  const byEvent = new Map();
  for (const r of rows) {
    const id = r.condition_id;
    if (!byEvent.has(id)) byEvent.set(id, []);
    byEvent.get(id).push(r);
  }

  const snapshots = [];

  for (const [conditionId, ticks] of byEvent) {
    if (ticks.length < 40) continue;

    const eventEnd = Number(ticks[0].event_end_ms);
    const ptb = Number(ticks[0].price_to_beat);
    const dt = ticks[0].dt;
    if (!Number.isFinite(eventEnd) || !Number.isFinite(ptb) || ptb <= 0) continue;

    const last = ticks[ticks.length - 1];
    const sT = Number(last.underlying_price);
    if (!Number.isFinite(sT)) continue;
    const upWins = sT >= ptb ? 1 : 0;

    const bars = toOneSecondBars(ticks);
    if (!bars) continue;
    const { tsMs, px, upAsk, downAsk } = bars;
    const n = px.length;

    const ret = new Array(n).fill(0);
    const absRet = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      if (px[i] != null && px[i - 1] != null) {
        ret[i] = px[i] - px[i - 1];
        absRet[i] = Math.abs(ret[i]);
      }
    }

    // Event-level robust scale for jump flags on 1s returns
    const absNonZero = absRet.filter((x) => x > 1e-9);
    if (absNonZero.length < MIN_RETURNS) continue;
    const sorted = absNonZero.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 1e-6;
    const localSigma = Math.max(0.05, med * 1.4826); // floor $0.05/s noise

    for (const targetTau of EVAL_TAUS) {
      let bestIdx = -1;
      let bestErr = Infinity;
      for (let i = 0; i < n; i++) {
        if (px[i] == null || upAsk[i] == null) continue;
        const tau = (eventEnd - tsMs[i]) / 1000;
        const err = Math.abs(tau - targetTau);
        if (err < bestErr) {
          bestErr = err;
          bestIdx = i;
        }
      }
      if (bestIdx < 0 || bestErr > TAU_TOL) continue;

      const tEval = tsMs[bestIdx];
      const i0 = Math.max(0, bestIdx - WINDOW_SEC);

      let rv = 0;
      let bv = 0;
      let jumpWith = 0;
      let jumpAgainst = 0;
      let nRet = 0;
      let maxAbsRet = 0;
      const sNow = px[bestIdx];
      const x = sNow - ptb;
      const leadSign = x === 0 ? 0 : x > 0 ? 1 : -1;

      for (let i = i0 + 1; i <= bestIdx; i++) {
        const r = ret[i];
        if (!Number.isFinite(r) || (px[i] == null || px[i - 1] == null)) continue;
        nRet++;
        rv += r * r;
        maxAbsRet = Math.max(maxAbsRet, Math.abs(r));
        const a0 = absRet[i - 1];
        const a1 = absRet[i];
        if (a0 > 0 && a1 > 0) bv += a0 * a1;

        // rolling local sigma from last 15 1s returns
        let ss = 0;
        let cn = 0;
        for (let k = Math.max(i0 + 1, i - 14); k <= i; k++) {
          if (absRet[k] > 0) {
            ss += absRet[k];
            cn++;
          }
        }
        const rollSig = cn > 5 ? Math.max(localSigma * 0.5, (ss / cn) * 1.253) : localSigma;
        if (Math.abs(r) >= JUMP_Z * rollSig) {
          const z = r > 0 ? 1 : -1;
          if (leadSign !== 0) {
            if (z === leadSign) jumpWith++;
            else jumpAgainst++;
          }
        }
      }

      if (nRet < MIN_RETURNS || rv <= 0) continue;

      const bvScaled = (Math.PI / 2) * bv;
      const jv = Math.max(rv - bvScaled, 0);
      const eta = Math.min(1, jv / (rv + 1e-12));

      const tau = Math.max(1, (eventEnd - tEval) / 1000);
      const varRate = rv / Math.max(nRet, 1); // per 1s bar
      const varRateC = Math.max(bvScaled, 1e-9) / Math.max(nRet, 1);
      const sigmaTot = Math.sqrt(Math.max(varRate, 1e-12) * tau);
      const sigmaC = Math.sqrt(Math.max(varRateC, 1e-12) * tau);

      const pTot = clip01(normalCdf(x / Math.max(sigmaTot, 1e-6)));
      const pCont = clip01(normalCdf(x / Math.max(sigmaC, 1e-6)));

      const intensity = (jumpWith + jumpAgainst) / Math.max(WINDOW_SEC / 60, 1e-6);
      let pHyp = pTot;
      if (x > 0) pHyp = clip01(pTot + Math.min(0.15, intensity * 0.02));
      else if (x < 0) pHyp = clip01(pTot - Math.min(0.15, intensity * 0.02));

      const netOrient = (jumpWith - jumpAgainst) / Math.max(jumpWith + jumpAgainst, 1);
      // Ψ exploratory: jump share + orientation + distance decay
      const psi = 0.15 * eta * netOrient * Math.exp(-Math.abs(x) / Math.max(sigmaC, 1));
      const pOjd = clip01(pCont + psi);

      const ua = upAsk[bestIdx];
      if (!Number.isFinite(ua) || ua <= 0.01 || ua >= 0.99) continue;

      snapshots.push({
        conditionId,
        dt,
        tsMs: tEval,
        hour: hourUtc(tEval),
        tau: targetTau,
        x,
        absX: Math.abs(x),
        eta,
        rv,
        bv: bvScaled,
        jv,
        jumpWith,
        jumpAgainst,
        netOrient,
        maxAbsRet,
        sigmaTot,
        sigmaC,
        pTot,
        pCont,
        pHyp,
        pOjd,
        pMkt: clip01(ua),
        downAsk: downAsk[bestIdx],
        upWins,
        residualMkt: upWins - clip01(ua),
        residualCont: upWins - pCont,
        residualTot: upWins - pTot,
      });
    }
  }

  return snapshots;
}

async function loadDayRows(conn, files) {
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
      down_best_ask
    FROM read_parquet(${pql})
    WHERE underlying_price IS NOT NULL
      AND price_to_beat IS NOT NULL
      AND up_best_ask IS NOT NULL
    ORDER BY condition_id, ts_ms
  `;
  const result = await conn.runAndReadAll(sql);
  return result.getRowObjectsJS();
}

function summarizeBy(snaps, keyFn, label) {
  const groups = new Map();
  for (const s of snaps) {
    const k = keyFn(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const rows = [];
  for (const [k, arr] of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const y = arr.map((s) => s.upWins);
    const pMkt = arr.map((s) => s.pMkt);
    const pCont = arr.map((s) => s.pCont);
    const pTot = arr.map((s) => s.pTot);
    const pOjd = arr.map((s) => s.pOjd);
    const pHyp = arr.map((s) => s.pHyp);
    rows.push({
      [label]: k,
      n: arr.length,
      up_rate: mean(y),
      mean_eta: mean(arr.map((s) => s.eta)),
      mean_absX: mean(arr.map((s) => s.absX)),
      mean_pMkt: mean(pMkt),
      mean_pCont: mean(pCont),
      residual_mkt: mean(arr.map((s) => s.residualMkt)),
      residual_cont: mean(arr.map((s) => s.residualCont)),
      brier_mkt: brier(pMkt, y),
      brier_cont: brier(pCont, y),
      brier_tot: brier(pTot, y),
      brier_hyp: brier(pHyp, y),
      brier_ojd: brier(pOjd, y),
      logloss_mkt: logLoss(pMkt, y),
      logloss_cont: logLoss(pCont, y),
      logloss_ojd: logLoss(pOjd, y),
      corr_eta_resid_cont: pearson(
        arr.map((s) => s.eta),
        arr.map((s) => s.residualCont),
      ),
      corr_eta_resid_mkt: pearson(
        arr.map((s) => s.eta),
        arr.map((s) => s.residualMkt),
      ),
    });
  }
  return rows;
}

function gateP1(byEta) {
  // P1: high eta changes residual systematically (monotonic-ish residual_cont vs eta bins)
  const usable = byEta.filter((r) => r.n >= 80 && r['eta_bin'] !== 'na');
  if (usable.length < 3) return { pass: false, reason: 'insufficient bin mass' };
  const corr = pearson(
    usable.map((_, i) => i),
    usable.map((r) => r.residual_cont),
  );
  // Also check spread of residuals
  const resids = usable.map((r) => r.residual_cont);
  const spread = Math.max(...resids) - Math.min(...resids);
  return {
    pass: Math.abs(corr) >= 0.5 && spread >= 0.02,
    corr_bin_index_vs_resid: corr,
    residual_spread: spread,
    reason: Math.abs(corr) >= 0.5 && spread >= 0.02
      ? 'eta bins show systematic residual_cont pattern'
      : 'no strong monotonic residual pattern across eta',
  };
}

function gateP3(globalMetrics) {
  // OJD or at least continuous-vs-total distinction improves vs pTot/pMkt in high-eta
  return {
    pass: globalMetrics.brier_ojd < globalMetrics.brier_tot - 0.0005
      || globalMetrics.brier_cont < globalMetrics.brier_tot - 0.0005,
    delta_brier_ojd_vs_tot: globalMetrics.brier_ojd - globalMetrics.brier_tot,
    delta_brier_cont_vs_tot: globalMetrics.brier_cont - globalMetrics.brier_tot,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# OJD-V0 Phase I — Anomaly Report');
  lines.push('');
  lines.push(`- Range: **${report.from} → ${report.to}**`);
  lines.push(`- Days processed: **${report.days}**`);
  lines.push(`- Snapshots: **${report.n}** (eval taus ${EVAL_TAUS.join(', ')}s, window ${WINDOW_SEC}s)`);
  lines.push('');
  lines.push('## Global calibration (lower Brier / log-loss is better)');
  lines.push('');
  lines.push('| Model | Brier | LogLoss |');
  lines.push('|---|---:|---:|');
  const g = report.global;
  lines.push(`| Market ask UP | ${g.brier_mkt?.toFixed(5)} | ${g.logloss_mkt?.toFixed(5)} |`);
  lines.push(`| Gaussian total RV | ${g.brier_tot?.toFixed(5)} | ${g.logloss_tot?.toFixed(5)} |`);
  lines.push(`| Gaussian continuous BV | ${g.brier_cont?.toFixed(5)} | ${g.logloss_cont?.toFixed(5)} |`);
  lines.push(`| Hyperion-like bump | ${g.brier_hyp?.toFixed(5)} | ${g.logloss_hyp?.toFixed(5)} |`);
  lines.push(`| OJD v0 provisional | ${g.brier_ojd?.toFixed(5)} | ${g.logloss_ojd?.toFixed(5)} |`);
  lines.push('');
  lines.push('## By jump-share η (core of P1)');
  lines.push('');
  lines.push('| η bin | n | up_rate | mean η | resid_mkt | resid_cont | brier_mkt | brier_cont | brier_ojd | corr(η,resid_cont) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of report.by_eta) {
    lines.push(
      `| ${r.eta_bin} | ${r.n} | ${r.up_rate?.toFixed(3)} | ${r.mean_eta?.toFixed(3)} | ${r.residual_mkt?.toFixed(4)} | ${r.residual_cont?.toFixed(4)} | ${r.brier_mkt?.toFixed(4)} | ${r.brier_cont?.toFixed(4)} | ${r.brier_ojd?.toFixed(4)} | ${r.corr_eta_resid_cont?.toFixed?.(3) ?? r.corr_eta_resid_cont} |`,
    );
  }
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  lines.push(`- **P1 (η residual):** ${report.gates.p1.pass ? 'PASS' : 'FAIL'} — ${report.gates.p1.reason}`);
  lines.push(`- **P3 (calibragem):** ${report.gates.p3.pass ? 'PASS' : 'FAIL'} — ΔBrier OJD-tot=${report.gates.p3.delta_brier_ojd_vs_tot?.toFixed(5)}`);
  lines.push(`- **Hour control (anti-SAD):** corr(η, residual_cont) after hour pooling = see by_hour tables in JSON`);
  lines.push('');
  lines.push('## Decision');
  lines.push('');
  lines.push(report.decision);
  lines.push('');
  lines.push('See charter: `docs/research/ojd-v0-research-charter.md`');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = listDayDirs(args.from, args.to);
  if (!days.length) {
    console.error(`No day partitions in ${BASE} for ${args.from}..${args.to}`);
    process.exit(1);
  }

  console.log(`OJD Phase I | ${args.from} → ${args.to} | ${days.length} days`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '6GB'`);

  const all = [];
  for (const dt of days) {
    const files = parquetFilesForDay(dt);
    if (!files.length) {
      console.log(`  skip ${dt} (no parquet)`);
      continue;
    }
    const t0 = Date.now();
    const rows = await loadDayRows(conn, files);
    const snaps = processDayTicks(rows);
    all.push(...snaps);
    console.log(`  ${dt}: ticks=${rows.length} snaps=${snaps.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  if (all.length < 200) {
    console.error(`Too few snapshots (${all.length}). Check data / params.`);
    process.exit(1);
  }

  // Train/valid split by time (70/30)
  all.sort((a, b) => a.tsMs - b.tsMs);
  const cut = all[Math.floor(all.length * 0.7)].tsMs;
  const train = all.filter((s) => s.tsMs < cut);
  const valid = all.filter((s) => s.tsMs >= cut);

  const yAll = all.map((s) => s.upWins);
  const global = {
    n: all.length,
    up_rate: mean(yAll),
    brier_mkt: brier(all.map((s) => s.pMkt), yAll),
    brier_tot: brier(all.map((s) => s.pTot), yAll),
    brier_cont: brier(all.map((s) => s.pCont), yAll),
    brier_hyp: brier(all.map((s) => s.pHyp), yAll),
    brier_ojd: brier(all.map((s) => s.pOjd), yAll),
    logloss_mkt: logLoss(all.map((s) => s.pMkt), yAll),
    logloss_tot: logLoss(all.map((s) => s.pTot), yAll),
    logloss_cont: logLoss(all.map((s) => s.pCont), yAll),
    logloss_hyp: logLoss(all.map((s) => s.pHyp), yAll),
    logloss_ojd: logLoss(all.map((s) => s.pOjd), yAll),
    corr_eta_resid_cont: pearson(all.map((s) => s.eta), all.map((s) => s.residualCont)),
    corr_eta_resid_mkt: pearson(all.map((s) => s.eta), all.map((s) => s.residualMkt)),
    corr_absX_resid_cont: pearson(all.map((s) => s.absX), all.map((s) => s.residualCont)),
  };

  const by_eta = summarizeBy(all, (s) => etaBin(s.eta), 'eta_bin');
  const by_eta_train = summarizeBy(train, (s) => etaBin(s.eta), 'eta_bin');
  const by_eta_valid = summarizeBy(valid, (s) => etaBin(s.eta), 'eta_bin');
  const by_absX = summarizeBy(all, (s) => absXBin(s.absX), 'absX_bin');
  const by_tau = summarizeBy(all, (s) => String(s.tau), 'tau');
  const by_hour = summarizeBy(all, (s) => String(s.hour).padStart(2, '0'), 'hour_utc');

  // Conditional: within mid distance, does eta still matter?
  const midDist = all.filter((s) => s.absX >= 5 && s.absX < 40);
  const by_eta_mid = summarizeBy(midDist, (s) => etaBin(s.eta), 'eta_bin');

  const gates = {
    p1: gateP1(by_eta),
    p1_valid: gateP1(by_eta_valid),
    p3: gateP3(global),
    anti_sad: {
      // If residual is purely hour effect, eta corr should collapse inside hours — rough check:
      hour_corrs: by_hour
        .filter((r) => r.n >= 100)
        .map((r) => ({ hour: r.hour_utc, corr: r.corr_eta_resid_cont, n: r.n })),
    },
  };

  let decision;
  if (gates.p1.pass && gates.p1_valid.pass) {
    decision =
      'PROCEED to Phase II: jump-share shows systematic residual on train and valid. Formalize Ψ and stylized facts.';
  } else if (gates.p1.pass && !gates.p1_valid.pass) {
    decision =
      'HOLD: signal appears in-sample but fails temporal valid. Revisit jump detector / window before Phase II.';
  } else if (global.corr_eta_resid_cont != null && Math.abs(global.corr_eta_resid_cont) >= 0.03) {
    decision =
      'WEAK SIGNAL: global corr(η, residual_cont) non-zero but bin gates failed. Refine thresholds, do not trade yet.';
  } else {
    decision =
      'KILL CANDIDATE (this formulation): no stable η→residual link. Pivot mechanism or archive.';
  }

  const report = {
    theory: 'OJD-V0',
    version: VERSION,
    bar_sec: BAR_SEC,
    from: args.from,
    to: args.to,
    days: days.length,
    n: all.length,
    n_train: train.length,
    n_valid: valid.length,
    window_sec: WINDOW_SEC,
    eval_taus: EVAL_TAUS,
    jump_z: JUMP_Z,
    global,
    by_eta,
    by_eta_train,
    by_eta_valid,
    by_eta_mid_distance: by_eta_mid,
    by_absX,
    by_tau,
    by_hour,
    gates,
    decision,
    generated_at: new Date().toISOString(),
  };

  const jsonPath = path.join(OUT_DIR, `phase1-anomaly-${VERSION}.json`);
  const mdPath = path.join(OUT_DIR, `phase1-anomaly-${VERSION}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, toMarkdown(report));

  console.log('\n=== GLOBAL ===');
  console.log(JSON.stringify(global, null, 2));
  console.log('\n=== BY ETA ===');
  console.table(
    by_eta.map((r) => ({
      eta: r.eta_bin,
      n: r.n,
      up: r.up_rate?.toFixed(3),
      resid_c: r.residual_cont?.toFixed(4),
      b_mkt: r.brier_mkt?.toFixed(4),
      b_cont: r.brier_cont?.toFixed(4),
      b_ojd: r.brier_ojd?.toFixed(4),
    })),
  );
  console.log('\nGATES', gates.p1, gates.p1_valid, gates.p3);
  console.log('\nDECISION:', decision);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
