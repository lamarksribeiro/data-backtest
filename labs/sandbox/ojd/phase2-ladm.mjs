/**
 * LADM Phase II — Lead-Adjusted Digital Measure
 *
 * 1) Fit Ψ(Z) on train only (Binance impulse → residual correction to ask)
 * 2) Conditional calibration / Brier for |Z| ≥ z*
 * 3) Hold-to-settle lab with Polymarket crypto taker fees + baselines
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase2-ladm.mjs \
 *     --from 2026-05-04 --to 2026-06-05
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { downloadBinanceDailyZip } from '../../../scripts/download-binance-1s.js';
import {
  calculatePolymarketTakerFee,
  POLYMARKET_FEE_RATES,
} from '../../../src/backtest/fees.js';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const BINANCE_DIR = path.resolve('data/binance-1s');
const EXTRACT_DIR = path.join(BINANCE_DIR, 'extracted');
const OUT_DIR = path.join('labs', 'sandbox', 'ojd', 'reports');
const LAKE_BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');

const EVAL_TAUS = [120, 90, 60, 45, 30, 20];
const TAU_TOL = 2.5;
const LEAD_SEC = 2;
const FEE_RATE = POLYMARKET_FEE_RATES.crypto;
const STAKE_USD = 10; // notional per trade (shares * ask ≈ stake)

function parseArgs(argv) {
  const out = { from: '2026-05-04', to: '2026-06-05' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
  }
  return out;
}

function listDays(from, to) {
  if (!fs.existsSync(LAKE_BASE)) return [];
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
function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}
function brier(ps, ys) {
  if (!ps.length) return null;
  let s = 0;
  for (let i = 0; i < ps.length; i++) s += (ps[i] - ys[i]) ** 2;
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
    const sec = Math.floor(t / 1000);
    map.set(sec, close);
  }
  return map;
}

function processDay(lakeRows, binanceBySec) {
  const by = new Map();
  for (const r of lakeRows) {
    if (!by.has(r.condition_id)) by.set(r.condition_id, []);
    by.get(r.condition_id).push(r);
  }
  const snaps = [];

  for (const [cid, ticks] of by) {
    if (ticks.length < 30) continue;
    const eventEnd = Number(ticks[0].event_end_ms);
    const ptb = Number(ticks[0].price_to_beat);
    if (!Number.isFinite(eventEnd) || !Number.isFinite(ptb)) continue;
    const sT = Number(ticks[ticks.length - 1].underlying_price);
    if (!Number.isFinite(sT)) continue;
    const upWins = sT >= ptb ? 1 : 0;

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
      const upAsk = Number(best.up_best_ask);
      const downAsk = Number(best.down_best_ask);
      const lakePx = Number(best.underlying_price);
      if (!Number.isFinite(upAsk) || upAsk <= 0.03 || upAsk >= 0.97) continue;
      if (!Number.isFinite(downAsk) || downAsk <= 0.03 || downAsk >= 0.97) continue;
      if (!Number.isFinite(lakePx)) continue;

      const bNow = binanceBySec.get(sec);
      const bPrev = binanceBySec.get(sec - LEAD_SEC);
      if (bNow == null || bPrev == null) continue;
      const binRet = bNow - bPrev;

      let ss = 0;
      let cn = 0;
      for (let s = sec - 30; s < sec; s++) {
        const a = binanceBySec.get(s);
        const b = binanceBySec.get(s + 1);
        if (a != null && b != null) {
          ss += (b - a) ** 2;
          cn++;
        }
      }
      const sig = cn > 10 ? Math.sqrt(ss / cn) : 1;
      const impulseZ = binRet / Math.max(sig * Math.sqrt(LEAD_SEC), 1e-6);

      let dAskBack = null;
      if (lakeSec.has(sec - LEAD_SEC)) {
        const a0 = Number(lakeSec.get(sec - LEAD_SEC).up_best_ask);
        if (Number.isFinite(a0)) dAskBack = upAsk - a0;
      }
      const stale = Math.abs(impulseZ) >= 1.5 && dAskBack != null && Math.abs(dAskBack) < 0.02;

      const x = lakePx - ptb;
      const tau = Math.max(1, (eventEnd - tsMs) / 1000);

      snaps.push({
        cid,
        dt: best.dt,
        tsMs,
        tau: target,
        upAsk: clip01(upAsk),
        downAsk: clip01(downAsk),
        lakePx,
        bNow,
        ptb,
        x,
        absX: Math.abs(x),
        binRet,
        impulseZ,
        sig,
        stale: stale ? 1 : 0,
        dAskBack,
        upWins,
        residM: upWins - clip01(upAsk),
      });
    }
  }
  return snaps;
}

/** Train-only least squares: resid ≈ a * tanh(Z / s) with s fixed grid, pick best Brier on train |Z|>=zMin */
function fitPsi(train, zMinFit = 0.75) {
  const subset = train.filter((s) => Math.abs(s.impulseZ) >= zMinFit);
  if (subset.length < 100) {
    return { a: 0.04, s: 1.0, zMinFit, n: subset.length, method: 'default_fallback' };
  }

  const scales = [0.75, 1.0, 1.5, 2.0, 2.5];
  let best = null;

  for (const s of scales) {
    // closed form for a: minimize sum (resid - a*tanh(Z/s))^2
    let num = 0;
    let den = 0;
    for (const r of subset) {
      const t = Math.tanh(r.impulseZ / s);
      num += r.residM * t;
      den += t * t;
    }
    if (den <= 1e-12) continue;
    let a = num / den;
    // clamp amplitude — avoid insane overfit
    a = Math.max(-0.2, Math.min(0.2, a));

    const ps = subset.map((r) => clip01(r.upAsk + a * Math.tanh(r.impulseZ / s)));
    const ys = subset.map((r) => r.upWins);
    const br = brier(ps, ys);
    const brM = brier(
      subset.map((r) => r.upAsk),
      ys,
    );
    if (!best || br < best.brier) {
      best = { a, s, brier: br, brier_mkt: brM, n: subset.length, method: 'ls_tanh' };
    }
  }

  // isotonic-style bins as backup table for diagnostics
  const edges = [-1e9, -2.5, -1.5, -0.75, 0.75, 1.5, 2.5, 1e9];
  const labels = ['z<=-2.5', '(-2.5,-1.5]', '(-1.5,-0.75]', '(-0.75,0.75)', '[0.75,1.5)', '[1.5,2.5)', 'z>=2.5'];
  const bins = labels.map((label, i) => {
    const lo = edges[i];
    const hi = edges[i + 1];
    const arr = train.filter((r) => r.impulseZ > lo && r.impulseZ <= hi);
    return {
      label,
      n: arr.length,
      mean_resid: mean(arr.map((r) => r.residM)),
      mean_z: mean(arr.map((r) => r.impulseZ)),
    };
  });

  return { ...best, bins, zMinFit };
}

function psi(z, model) {
  return model.a * Math.tanh(z / model.s);
}

function pLeadUp(snap, model) {
  return clip01(snap.upAsk + psi(snap.impulseZ, model));
}

function pLeadDown(snap, model) {
  // DOWN residual ≈ -UP residual under complementary approx; use -psi for down nudge
  return clip01(snap.downAsk - psi(snap.impulseZ, model));
}

function reliabilityBins(snaps, pFn, nBins = 8) {
  const scored = snaps.map((s) => ({ p: pFn(s), y: s.upWins })).sort((a, b) => a.p - b.p);
  if (scored.length < nBins * 20) return [];
  const size = Math.floor(scored.length / nBins);
  const out = [];
  for (let i = 0; i < nBins; i++) {
    const slice = scored.slice(i * size, i === nBins - 1 ? scored.length : (i + 1) * size);
    out.push({
      bin: i,
      n: slice.length,
      mean_p: mean(slice.map((x) => x.p)),
      mean_y: mean(slice.map((x) => x.y)),
      gap: mean(slice.map((x) => x.y)) - mean(slice.map((x) => x.p)),
    });
  }
  return out;
}

function metricsFor(snaps, pFn, label) {
  if (!snaps.length) return { label, n: 0 };
  const ps = snaps.map(pFn);
  const ys = snaps.map((s) => s.upWins);
  return {
    label,
    n: snaps.length,
    brier: brier(ps, ys),
    logloss: logLoss(ps, ys),
    resid: mean(ys.map((y, i) => y - ps[i])),
    corr_z_resid: pearson(
      snaps.map((s) => s.impulseZ),
      snaps.map((s, i) => s.upWins - ps[i]),
    ),
  };
}

/** Simulate hold-to-settle taker entry, one trade max per event */
function simulateLab(snaps, decideFn, opts = {}) {
  const stake = opts.stake ?? STAKE_USD;
  const feeRate = opts.feeRate ?? FEE_RATE;
  // group by event, chronological
  const byEvent = new Map();
  for (const s of snaps) {
    if (!byEvent.has(s.cid)) byEvent.set(s.cid, []);
    byEvent.get(s.cid).push(s);
  }
  for (const arr of byEvent.values()) arr.sort((a, b) => a.tsMs - b.tsMs);

  const trades = [];
  for (const [cid, arr] of byEvent) {
    let chosen = null;
    for (const s of arr) {
      const d = decideFn(s);
      if (d) {
        chosen = { s, ...d };
        break; // first signal in time
      }
    }
    if (!chosen) continue;

    const { s, side, ask, pModel, edge } = chosen;
    const shares = stake / ask;
    const fee = calculatePolymarketTakerFee({ shares, price: ask, feeRate });
    const win = side === 'UP' ? s.upWins === 1 : s.upWins === 0;
    const gross = win ? shares * (1 - ask) : -shares * ask;
    const net = gross - fee;

    trades.push({
      cid,
      dt: s.dt,
      tsMs: s.tsMs,
      tau: s.tau,
      side,
      ask,
      pModel,
      edge,
      impulseZ: s.impulseZ,
      shares,
      fee,
      win: win ? 1 : 0,
      gross,
      net,
      stale: s.stale,
    });
  }

  return summarizeTrades(trades);
}

function summarizeTrades(trades) {
  if (!trades.length) {
    return {
      n: 0,
      wins: 0,
      winRate: null,
      gross: 0,
      net: 0,
      fees: 0,
      pf: null,
      avgNet: null,
      avgEdge: null,
      maxDD: 0,
      avgImpulseAbs: null,
    };
  }
  const nets = trades.map((t) => t.net);
  const grosses = trades.map((t) => t.gross);
  const wins = sum(trades.map((t) => t.win));
  const pos = sum(nets.filter((x) => x > 0));
  const neg = Math.abs(sum(nets.filter((x) => x < 0)));
  // equity DD
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades.sort((a, b) => a.tsMs - b.tsMs)) {
    eq += t.net;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  return {
    n: trades.length,
    wins,
    winRate: wins / trades.length,
    gross: sum(grosses),
    net: sum(nets),
    fees: sum(trades.map((t) => t.fee)),
    pf: neg > 1e-9 ? pos / neg : pos > 0 ? Infinity : null,
    avgNet: mean(nets),
    avgEdge: mean(trades.map((t) => t.edge)),
    maxDD,
    avgImpulseAbs: mean(trades.map((t) => Math.abs(t.impulseZ))),
    pct_stale: mean(trades.map((t) => t.stale)),
  };
}

function pickBestPolicy(train, model) {
  const zMins = [1.0, 1.25, 1.5, 1.75, 2.0];
  const edges = [0.03, 0.04, 0.05, 0.06, 0.08];
  const askMaxs = [0.55, 0.62, 0.7];
  const staleOnly = [false, true];
  const tauMaxs = [90, 120];

  let best = null;
  for (const zMin of zMins) {
    for (const minEdge of edges) {
      for (const askMax of askMaxs) {
        for (const onlyStale of staleOnly) {
          for (const tauMax of tauMaxs) {
            const policy = { zMin, minEdge, askMax, onlyStale, tauMax, askMin: 0.08 };
            const res = simulateLab(train, (s) => decideLadm(s, model, policy));
            if (res.n < 40) continue;
            // objective: net PnL with mild PF and DD penalty
            const score = res.net - 0.15 * res.maxDD + (res.pf != null && res.pf > 1.2 ? 5 : 0);
            if (!best || score > best.score) {
              best = { score, policy, train: res };
            }
          }
        }
      }
    }
  }
  return best;
}

function decideLadm(s, model, policy) {
  if (s.tau > policy.tauMax) return null;
  if (Math.abs(s.impulseZ) < policy.zMin) return null;
  if (policy.onlyStale && !s.stale) return null;

  const pUp = pLeadUp(s, model);
  const pDn = pLeadDown(s, model);
  const edgeUp = pUp - s.upAsk;
  const edgeDn = pDn - s.downAsk;

  // require impulse aligned with side
  if (s.impulseZ >= policy.zMin && edgeUp >= policy.minEdge && s.upAsk >= policy.askMin && s.upAsk <= policy.askMax) {
    return { side: 'UP', ask: s.upAsk, pModel: pUp, edge: edgeUp };
  }
  if (s.impulseZ <= -policy.zMin && edgeDn >= policy.minEdge && s.downAsk >= policy.askMin && s.downAsk <= policy.askMax) {
    return { side: 'DOWN', ask: s.downAsk, pModel: pDn, edge: edgeDn };
  }
  return null;
}

/** Baseline: follow impulse only, buy aligned side if ask cheap */
function decideImpulseOnly(s, policy) {
  if (s.tau > policy.tauMax) return null;
  if (Math.abs(s.impulseZ) < policy.zMin) return null;
  if (policy.onlyStale && !s.stale) return null;
  if (s.impulseZ >= policy.zMin && s.upAsk >= policy.askMin && s.upAsk <= policy.askMax) {
    return { side: 'UP', ask: s.upAsk, pModel: s.upAsk + 0.05, edge: 0.05 };
  }
  if (s.impulseZ <= -policy.zMin && s.downAsk >= policy.askMin && s.downAsk <= policy.askMax) {
    return { side: 'DOWN', ask: s.downAsk, pModel: s.downAsk + 0.05, edge: 0.05 };
  }
  return null;
}

/** Baseline Hyperion-like: distance + fixed bump, ignore Binance */
function decideHyperionLike(s, policy) {
  if (s.tau > policy.tauMax || s.tau < 10) return null;
  const dist = s.x;
  const side = dist >= 15 ? 'UP' : dist <= -15 ? 'DOWN' : null;
  if (!side) return null;
  const ask = side === 'UP' ? s.upAsk : s.downAsk;
  if (ask < policy.askMin || ask > policy.askMax) return null;
  // crude p
  const p = clip01(0.5 + 0.01 * (side === 'UP' ? dist : -dist) / 10);
  const edge = p - ask;
  if (edge < policy.minEdge) return null;
  return { side, ask, pModel: p, edge };
}

/** Baseline: buy favorite (higher of 1-downAsk vs upAsk proxy) when absX large late */
function decideFavLate(s, policy) {
  if (s.tau > 45 || s.tau < 15) return null;
  if (s.absX < 20) return null;
  const side = s.x > 0 ? 'UP' : 'DOWN';
  const ask = side === 'UP' ? s.upAsk : s.downAsk;
  if (ask < 0.55 || ask > 0.85) return null;
  return { side, ask, pModel: ask + 0.02, edge: 0.02 };
}

async function loadAll(args) {
  const days = listDays(args.from, args.to);
  for (const dt of days) await downloadBinanceDailyZip('BTCUSDT', dt);

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '6GB'`);

  const all = [];
  for (const dt of days) {
    const csv = ensureExtracted(dt);
    if (!csv) {
      console.log('skip', dt, 'no binance');
      continue;
    }
    const binMap = loadBinanceCloses(csv);
    if (binMap.size < 1000) continue;
    const files = filesFor(dt);
    const pql = `[${files.map((f) => quotedString(f)).join(', ')}]`;
    const res = await conn.runAndReadAll(`
      SELECT condition_id, dt,
        CAST(epoch_ms(try_cast(ts AS TIMESTAMP)) AS BIGINT) AS ts_ms,
        CAST(epoch_ms(try_cast(event_end AS TIMESTAMP)) AS BIGINT) AS event_end_ms,
        underlying_price, price_to_beat, up_best_ask, down_best_ask
      FROM read_parquet(${pql})
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
        AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
      ORDER BY condition_id, ts_ms
    `);
    const rows = res.getRowObjectsJS();
    const snaps = processDay(rows, binMap);
    all.push(...snaps);
    console.log(`  ${dt}: snaps=${snaps.length}`);
  }
  all.sort((a, b) => a.tsMs - b.tsMs);
  return all;
}

function timeSplits(all) {
  const n = all.length;
  const i1 = Math.floor(n * 0.6);
  const i2 = Math.floor(n * 0.8);
  return {
    train: all.slice(0, i1),
    valid: all.slice(i1, i2),
    holdout: all.slice(i2),
  };
}

function goNoGo(report) {
  const h = report.holdout_lab?.ladm;
  const c = report.calibration?.holdout_strong;
  const reasons = [];
  let go = true;

  if (!h || h.n < 30) {
    go = false;
    reasons.push('holdout trades < 30');
  }
  if (h && h.net <= 0) {
    go = false;
    reasons.push('holdout net ≤ 0 after fees');
  }
  if (h && (h.pf == null || h.pf < 1.15)) {
    go = false;
    reasons.push(`holdout PF ${h.pf} < 1.15`);
  }
  if (c && c.ladm && c.mkt && c.ladm.brier >= c.mkt.brier - 0.0005) {
    // soft: prefer conditional Brier improvement
    reasons.push('holdout strong-|Z| Brier not clearly better than mkt (soft)');
  }
  // beat impulse-only baseline on holdout net
  if (h && report.holdout_lab?.impulse_only && h.net < report.holdout_lab.impulse_only.net) {
    reasons.push('holdout net < impulse-only baseline (soft)');
  }

  const hardFail = reasons.some((r) => !r.includes('soft'));
  return {
    decision: hardFail ? 'NO-GO' : go ? 'GO-CANDIDATE' : 'NO-GO',
    reasons,
    note: hardFail
      ? 'Do not promote to production strategy lab yet.'
      : 'Candidate for formal theory doc + fuller range backtest; still not live capital.',
  };
}

function toMarkdown(report) {
  const L = [];
  L.push('# LADM Phase II — Lead-Adjusted Digital Measure');
  L.push('');
  L.push(`Range: **${report.from} → ${report.to}** | n=${report.n} (train/valid/holdout ${report.n_train}/${report.n_valid}/${report.n_holdout})`);
  L.push('');
  L.push('## Ψ fit (train only)');
  L.push('');
  L.push(`- method: \`${report.psi.method}\`  a=**${report.psi.a?.toFixed(4)}**  s=**${report.psi.s}**  n_fit=${report.psi.n}`);
  L.push(`- train Brier |Z|≥${report.psi.zMinFit}: LADM ${report.psi.brier?.toFixed(5)} vs mkt ${report.psi.brier_mkt?.toFixed(5)}`);
  L.push('');
  L.push('## Conditional calibration (holdout, |Z|≥1.5)');
  L.push('');
  if (report.calibration?.holdout_strong) {
    const c = report.calibration.holdout_strong;
    L.push(`| Model | n | Brier | LogLoss |`);
    L.push(`|---|---:|---:|---:|`);
    L.push(`| Market ask UP | ${c.mkt.n} | ${c.mkt.brier?.toFixed(5)} | ${c.mkt.logloss?.toFixed(5)} |`);
    L.push(`| LADM p_lead | ${c.ladm.n} | ${c.ladm.brier?.toFixed(5)} | ${c.ladm.logloss?.toFixed(5)} |`);
  }
  L.push('');
  L.push('## Lab hold-to-settle (fees crypto 0.07, stake $10, 1 trade/event)');
  L.push('');
  L.push('### Policy (selected on train)');
  L.push('```json');
  L.push(JSON.stringify(report.policy, null, 2));
  L.push('```');
  L.push('');
  L.push('| Split | Strategy | n | WR | Net $ | Fees | PF | MaxDD | avgNet |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const split of ['train_lab', 'valid_lab', 'holdout_lab']) {
    const block = report[split];
    if (!block) continue;
    for (const [name, r] of Object.entries(block)) {
      if (!r || r.n == null) continue;
      L.push(
        `| ${split.replace('_lab', '')} | ${name} | ${r.n} | ${r.winRate?.toFixed?.(3) ?? '—'} | ${r.net?.toFixed?.(2)} | ${r.fees?.toFixed?.(2)} | ${r.pf == null ? '—' : r.pf === Infinity ? '∞' : r.pf.toFixed(2)} | ${r.maxDD?.toFixed?.(2)} | ${r.avgNet?.toFixed?.(3)} |`,
      );
    }
  }
  L.push('');
  L.push('## Decision');
  L.push('');
  L.push(`**${report.verdict.decision}** — ${report.verdict.note}`);
  for (const r of report.verdict.reasons) L.push(`- ${r}`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`LADM Phase II | ${args.from} → ${args.to}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = await loadAll(args);
  if (all.length < 1000) {
    console.error('too few snapshots', all.length);
    process.exit(1);
  }

  const { train, valid, holdout } = timeSplits(all);
  console.log(`splits train=${train.length} valid=${valid.length} holdout=${holdout.length}`);

  const psiModel = fitPsi(train, 0.75);
  console.log('Ψ', psiModel);

  const zStrong = 1.5;
  const calib = {
    train_strong: {
      mkt: metricsFor(
        train.filter((s) => Math.abs(s.impulseZ) >= zStrong),
        (s) => s.upAsk,
        'mkt',
      ),
      ladm: metricsFor(
        train.filter((s) => Math.abs(s.impulseZ) >= zStrong),
        (s) => pLeadUp(s, psiModel),
        'ladm',
      ),
    },
    valid_strong: {
      mkt: metricsFor(
        valid.filter((s) => Math.abs(s.impulseZ) >= zStrong),
        (s) => s.upAsk,
        'mkt',
      ),
      ladm: metricsFor(
        valid.filter((s) => Math.abs(s.impulseZ) >= zStrong),
        (s) => pLeadUp(s, psiModel),
        'ladm',
      ),
    },
    holdout_strong: {
      mkt: metricsFor(
        holdout.filter((s) => Math.abs(s.impulseZ) >= zStrong),
        (s) => s.upAsk,
        'mkt',
      ),
      ladm: metricsFor(
        holdout.filter((s) => Math.abs(s.impulseZ) >= zStrong),
        (s) => pLeadUp(s, psiModel),
        'ladm',
      ),
    },
    holdout_all: {
      mkt: metricsFor(holdout, (s) => s.upAsk, 'mkt'),
      ladm: metricsFor(holdout, (s) => pLeadUp(s, psiModel), 'ladm'),
    },
    reliability_holdout_strong_ladm: reliabilityBins(
      holdout.filter((s) => Math.abs(s.impulseZ) >= zStrong),
      (s) => pLeadUp(s, psiModel),
    ),
    reliability_holdout_strong_mkt: reliabilityBins(
      holdout.filter((s) => Math.abs(s.impulseZ) >= zStrong),
      (s) => s.upAsk,
    ),
  };

  console.log('calib holdout strong', calib.holdout_strong);

  const best = pickBestPolicy(train, psiModel);
  if (!best) {
    console.error('No viable policy on train');
    process.exit(1);
  }
  console.log('best policy', best.policy, best.train);

  const policy = best.policy;
  // freeze hyperion/fav policies with related knobs
  const hypPolicy = { ...policy, minEdge: Math.max(0.04, policy.minEdge), zMin: 0 };
  const favPolicy = { ...policy };

  function labs(splitSnaps) {
    return {
      ladm: simulateLab(splitSnaps, (s) => decideLadm(s, psiModel, policy)),
      impulse_only: simulateLab(splitSnaps, (s) => decideImpulseOnly(s, policy)),
      hyperion_like: simulateLab(splitSnaps, (s) => decideHyperionLike(s, hypPolicy)),
      fav_late: simulateLab(splitSnaps, (s) => decideFavLate(s, favPolicy)),
    };
  }

  const train_lab = labs(train);
  const valid_lab = labs(valid);
  const holdout_lab = labs(holdout);

  console.log('\nTRAIN', train_lab);
  console.log('VALID', valid_lab);
  console.log('HOLDOUT', holdout_lab);

  const report = {
    theory: 'LADM-v0.1',
    from: args.from,
    to: args.to,
    n: all.length,
    n_train: train.length,
    n_valid: valid.length,
    n_holdout: holdout.length,
    fee_rate: FEE_RATE,
    stake_usd: STAKE_USD,
    lead_sec: LEAD_SEC,
    psi: psiModel,
    policy,
    calibration: calib,
    train_lab,
    valid_lab,
    holdout_lab,
    generated_at: new Date().toISOString(),
  };
  report.verdict = goNoGo(report);

  const tag = `${args.from}_${args.to}`;
  const jp = path.join(OUT_DIR, `phase2-ladm-${tag}.json`);
  const mp = path.join(OUT_DIR, `phase2-ladm-${tag}.md`);
  fs.writeFileSync(jp, JSON.stringify(report, null, 2));
  fs.writeFileSync(mp, toMarkdown(report));

  // theory draft
  const theoryPath = path.join('docs', 'estrategias', 'nao-implementadas', 'ladm-v0.md');
  fs.mkdirSync(path.dirname(theoryPath), { recursive: true });
  fs.writeFileSync(theoryPath, theoryDoc(report));

  console.log('\nVERDICT', report.verdict);
  console.log('Wrote', jp);
  console.log('Wrote', mp);
  console.log('Wrote', theoryPath);
}

function theoryDoc(report) {
  return `# LADM v0.1 — Lead-Adjusted Digital Measure

## Status

**${report.verdict.decision}** (${report.generated_at})  
Phase II empirical pack: \`labs/sandbox/ojd/reports/phase2-ladm-${report.from}_${report.to}.*\`

## Hipótese

Seja \(C_t\) o ask UP na Polymarket e \(S^{\\mathrm{Bin}}\) o spot Binance 1s. O book é bem calibrado sob a filtração do venue (oráculo + odds). Sob filtração ampliada com Binance,

\\[
Z_t = \\frac{S^{\\mathrm{Bin}}_t - S^{\\mathrm{Bin}}_{t-\\ell}}{\\hat\\sigma_t \\sqrt{\\ell}}, \\quad \\ell=2\\mathrm{s}
\\]

o residual terminal \(R_t = \\mathbf{1}_{\\{S_T \\ge K\\}} - C_t\) é monotônico em \(Z_t\).

## Modelo

\\[
\\Psi(Z) = a \\tanh(Z / s), \\qquad
p^{\\mathrm{lead}}_{\\mathrm{UP}} = \\mathrm{clip}\\big(C_t + \\Psi(Z_t)\\big)
\\]

Parâmetros **somente train** neste pack:

- \(a = ${report.psi.a?.toFixed(6)}\)
- \(s = ${report.psi.s}\)
- método: ${report.psi.method}

DOWN: \(p^{\\mathrm{lead}}_{\\mathrm{DOWN}} = \\mathrm{clip}(C^{\\mathrm{DN}}_t - \\Psi(Z_t))\).

## Política operacional (selecionada no train)

\`\`\`json
${JSON.stringify(report.policy, null, 2)}
\`\`\`

- Stake: $${report.stake_usd} notional / trade  
- Fees: taker crypto rate ${report.fee_rate} via \`calculatePolymarketTakerFee\`  
- Hold to settlement; 1 trade / evento  

## Resultados holdout

| Strategy | n | WR | Net $ | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| LADM | ${report.holdout_lab.ladm.n} | ${report.holdout_lab.ladm.winRate?.toFixed?.(3)} | ${report.holdout_lab.ladm.net?.toFixed?.(2)} | ${fmtPf(report.holdout_lab.ladm.pf)} | ${report.holdout_lab.ladm.maxDD?.toFixed?.(2)} |
| Impulse only | ${report.holdout_lab.impulse_only.n} | ${report.holdout_lab.impulse_only.winRate?.toFixed?.(3)} | ${report.holdout_lab.impulse_only.net?.toFixed?.(2)} | ${fmtPf(report.holdout_lab.impulse_only.pf)} | ${report.holdout_lab.impulse_only.maxDD?.toFixed?.(2)} |
| Hyperion-like | ${report.holdout_lab.hyperion_like.n} | ${report.holdout_lab.hyperion_like.winRate?.toFixed?.(3)} | ${report.holdout_lab.hyperion_like.net?.toFixed?.(2)} | ${fmtPf(report.holdout_lab.hyperion_like.pf)} | ${report.holdout_lab.hyperion_like.maxDD?.toFixed?.(2)} |
| Fav late | ${report.holdout_lab.fav_late.n} | ${report.holdout_lab.fav_late.winRate?.toFixed?.(3)} | ${report.holdout_lab.fav_late.net?.toFixed?.(2)} | ${fmtPf(report.holdout_lab.fav_late.pf)} | ${report.holdout_lab.fav_late.maxDD?.toFixed?.(2)} |

### Calibração condicional holdout (|Z|≥1.5)

- Brier mkt: ${report.calibration.holdout_strong.mkt.brier?.toFixed?.(5)}
- Brier LADM: ${report.calibration.holdout_strong.ladm.brier?.toFixed?.(5)}

## Decisão

**${report.verdict.decision}**: ${report.verdict.note}

${report.verdict.reasons.map((r) => `- ${r}`).join('\\n')}

## O que LADM não é

- Não é Heston/Merton/jump-share no oráculo do lake (famílias A–C mortas).
- Não substitui depth L2 / ladders / maker.
- Requer **feed Binance (ou lead real)** em live; o lake sozinho não reproduz o edge.

## Próximos passos se GO

1. Range completo com mais dias Binance + holdout de junho/julho.
2. Port para strategy runner SOA com join Binance.
3. Shadow/dry-run Giovanna com latência real.
`;
}

function fmtPf(pf) {
  if (pf == null) return '—';
  if (pf === Infinity) return '∞';
  return pf.toFixed(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
