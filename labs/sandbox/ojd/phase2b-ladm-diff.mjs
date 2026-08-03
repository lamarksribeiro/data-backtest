/**
 * LADM Phase II+ — expanded range + policies where LADM ≠ impulse-only
 *
 * Modes:
 *  A) impulse_only: |Z|≥zMin, buy aligned side (no Ψ filter)
 *  B) ladm_edge: require edge = |Ψ(Z)| ≥ minEdge (minEdge chosen so it binds)
 *  C) ladm_size: always impulse entry but stake ∝ |Ψ| (same trades, different PnL)
 *  D) ladm_combo: edge filter + size ∝ |Ψ|
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase2b-ladm-diff.mjs \
 *     --from 2026-05-04 --to 2026-07-15
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
const BASE_STAKE = 10;

function parseArgs(argv) {
  const out = { from: '2026-05-04', to: '2026-07-15' };
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
  if (!fs.existsSync(dir)) return [];
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

function processDay(lakeRows, binanceBySec) {
  const by = new Map();
  for (const r of lakeRows) {
    if (!by.has(r.condition_id)) by.set(r.condition_id, []);
    by.get(r.condition_id).push(r);
  }
  const snaps = [];

  for (const [, ticks] of by) {
    if (ticks.length < 30) continue;
    const eventEnd = Number(ticks[0].event_end_ms);
    const ptb = Number(ticks[0].price_to_beat);
    if (!Number.isFinite(eventEnd) || !Number.isFinite(ptb)) continue;
    const sT = Number(ticks[ticks.length - 1].underlying_price);
    if (!Number.isFinite(sT)) continue;
    const upWins = sT >= ptb ? 1 : 0;
    const cid = ticks[0].condition_id;

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

      snaps.push({
        cid,
        dt: best.dt,
        tsMs,
        tau: target,
        upAsk: clip01(upAsk),
        downAsk: clip01(downAsk),
        x: lakePx - ptb,
        absX: Math.abs(lakePx - ptb),
        impulseZ,
        stale: stale ? 1 : 0,
        upWins,
        residM: upWins - clip01(upAsk),
      });
    }
  }
  return snaps;
}

function fitPsi(train, zMinFit = 0.75) {
  const subset = train.filter((s) => Math.abs(s.impulseZ) >= zMinFit);
  if (subset.length < 100) return { a: 0.08, s: 2.5, n: subset.length, method: 'fallback' };

  const scales = [0.75, 1.0, 1.5, 2.0, 2.5, 3.0];
  let best = null;
  for (const s of scales) {
    let num = 0;
    let den = 0;
    for (const r of subset) {
      const t = Math.tanh(r.impulseZ / s);
      num += r.residM * t;
      den += t * t;
    }
    if (den <= 1e-12) continue;
    let a = Math.max(-0.25, Math.min(0.25, num / den));
    const ps = subset.map((r) => clip01(r.upAsk + a * Math.tanh(r.impulseZ / s)));
    const ys = subset.map((r) => r.upWins);
    const br = brier(ps, ys);
    const brM = brier(
      subset.map((r) => r.upAsk),
      ys,
    );
    if (!best || br < best.brier) best = { a, s, brier: br, brier_mkt: brM, n: subset.length, method: 'ls_tanh' };
  }
  return best;
}

function psiAbs(z, model) {
  return Math.abs(model.a * Math.tanh(z / model.s));
}
function psiSigned(z, model) {
  return model.a * Math.tanh(z / model.s);
}

function summarizeTrades(trades) {
  if (!trades.length) {
    return { n: 0, wins: 0, winRate: null, gross: 0, net: 0, fees: 0, pf: null, avgNet: null, maxDD: 0, avgStake: null, avgPsi: null };
  }
  const nets = trades.map((t) => t.net);
  const wins = sum(trades.map((t) => t.win));
  const pos = sum(nets.filter((x) => x > 0));
  const neg = Math.abs(sum(nets.filter((x) => x < 0)));
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.tsMs - b.tsMs)) {
    eq += t.net;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  return {
    n: trades.length,
    wins,
    winRate: wins / trades.length,
    gross: sum(trades.map((t) => t.gross)),
    net: sum(nets),
    fees: sum(trades.map((t) => t.fee)),
    pf: neg > 1e-9 ? pos / neg : pos > 0 ? Infinity : null,
    avgNet: mean(nets),
    maxDD,
    avgStake: mean(trades.map((t) => t.stake)),
    avgPsi: mean(trades.map((t) => t.psiAbs)),
    avgImpulseAbs: mean(trades.map((t) => Math.abs(t.impulseZ))),
    pct_stale: mean(trades.map((t) => t.stale)),
  };
}

/**
 * mode:
 *  - impulse_only
 *  - ladm_edge (filter by psiAbs >= minEdge)
 *  - ladm_size (size ∝ psiAbs)
 *  - ladm_combo (filter + size)
 */
function simulate(snaps, model, policy, mode) {
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
      if (s.tau > policy.tauMax) continue;
      if (Math.abs(s.impulseZ) < policy.zMin) continue;
      if (policy.onlyStale && !s.stale) continue;

      const pAbs = psiAbs(s.impulseZ, model);
      const side = s.impulseZ >= policy.zMin ? 'UP' : s.impulseZ <= -policy.zMin ? 'DOWN' : null;
      if (!side) continue;
      // require alignment: UP needs Z>0, DOWN Z<0 — already by construction
      if (side === 'UP' && s.impulseZ < policy.zMin) continue;
      if (side === 'DOWN' && s.impulseZ > -policy.zMin) continue;

      const ask = side === 'UP' ? s.upAsk : s.downAsk;
      if (ask < policy.askMin || ask > policy.askMax) continue;

      if (mode === 'ladm_edge' || mode === 'ladm_combo') {
        if (pAbs < policy.minEdge) continue;
      }

      // stake
      let stake = BASE_STAKE;
      if (mode === 'ladm_size' || mode === 'ladm_combo') {
        // scale: at psi=minEdge stake=BASE; grow up to 2.5x
        const ref = Math.max(policy.sizeRefPsi || 0.04, 1e-6);
        const mult = Math.min(policy.sizeMaxMult || 2.5, Math.max(0.5, pAbs / ref));
        stake = BASE_STAKE * mult;
      }

      chosen = { s, side, ask, psiAbs: pAbs, stake };
      break;
    }
    if (!chosen) continue;

    const { s, side, ask, psiAbs: pA, stake } = chosen;
    const shares = stake / ask;
    const fee = calculatePolymarketTakerFee({ shares, price: ask, feeRate: FEE_RATE });
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
      stake,
      psiAbs: pA,
      impulseZ: s.impulseZ,
      shares,
      fee,
      win: win ? 1 : 0,
      gross,
      net,
      stale: s.stale,
      mode,
    });
  }
  return summarizeTrades(trades);
}

function tradeSetKey(snaps, model, policy, mode) {
  // identity of event set for equality checks
  const byEvent = new Map();
  for (const s of snaps) {
    if (!byEvent.has(s.cid)) byEvent.set(s.cid, []);
    byEvent.get(s.cid).push(s);
  }
  const keys = [];
  for (const [cid, arr] of byEvent) {
    arr.sort((a, b) => a.tsMs - b.tsMs);
    for (const s of arr) {
      if (s.tau > policy.tauMax) continue;
      if (Math.abs(s.impulseZ) < policy.zMin) continue;
      if (policy.onlyStale && !s.stale) continue;
      const side = s.impulseZ >= policy.zMin ? 'UP' : 'DOWN';
      const ask = side === 'UP' ? s.upAsk : s.downAsk;
      if (ask < policy.askMin || ask > policy.askMax) continue;
      if (mode === 'ladm_edge' || mode === 'ladm_combo') {
        if (psiAbs(s.impulseZ, model) < policy.minEdge) continue;
      }
      keys.push(`${cid}|${side}|${s.tsMs}`);
      break;
    }
  }
  return keys.sort().join(';');
}

function pickPolicies(train, model) {
  // Compute psi at zMin for binding edge thresholds
  const psiAt15 = psiAbs(1.5, model);
  const psiAt20 = psiAbs(2.0, model);
  const psiAt25 = psiAbs(2.5, model);

  const zMins = [1.25, 1.5, 1.75, 2.0, 2.25];
  // minEdges that BIND relative to psi(zMin)
  const edgeCandidates = [0.05, 0.06, 0.07, 0.08, 0.10, 0.12];
  const askMaxs = [0.55, 0.62, 0.7];
  const tauMaxs = [60, 90, 120];
  const staleOpts = [false, true];

  const results = [];

  for (const zMin of zMins) {
    const psiFloor = psiAbs(zMin, model);
    for (const minEdge of edgeCandidates) {
      // skip non-binding edges (would collapse to impulse)
      if (minEdge <= psiFloor + 0.005) continue;
      for (const askMax of askMaxs) {
        for (const tauMax of tauMaxs) {
          for (const onlyStale of staleOpts) {
            const policy = {
              zMin,
              minEdge,
              askMax,
              askMin: 0.08,
              tauMax,
              onlyStale,
              sizeRefPsi: minEdge,
              sizeMaxMult: 2.5,
            };
            const impulse = simulate(train, model, policy, 'impulse_only');
            const edge = simulate(train, model, policy, 'ladm_edge');
            const size = simulate(train, model, policy, 'ladm_size');
            const combo = simulate(train, model, policy, 'ladm_combo');

            if (edge.n < 35 && combo.n < 35) continue;

            const setImp = tradeSetKey(train, model, policy, 'impulse_only');
            const setEdge = tradeSetKey(train, model, policy, 'ladm_edge');
            const differs = setImp !== setEdge;

            // score: prefer holdout-ready train metrics + must differ
            const score =
              (differs ? 50 : 0) +
              combo.net * 0.5 +
              edge.net * 0.5 -
              0.2 * combo.maxDD +
              (combo.pf != null && combo.pf > 1.2 ? 10 : 0) +
              (edge.n >= 50 ? 5 : 0);

            results.push({
              policy,
              psiFloor,
              differs,
              train: { impulse, edge, size, combo },
              score,
            });
          }
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  // top differing + top overall
  const topDiff = results.filter((r) => r.differs).slice(0, 8);
  const topAny = results.slice(0, 5);
  return { topDiff, topAny, psiAt15, psiAt20, psiAt25, nScored: results.length };
}

async function loadAll(args) {
  const days = listDays(args.from, args.to);
  console.log(`days in lake: ${days.length}`);
  for (const dt of days) await downloadBinanceDailyZip('BTCUSDT', dt);

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '7GB'`);

  const all = [];
  let skipped = 0;
  for (const dt of days) {
    const csv = ensureExtracted(dt);
    if (!csv) {
      skipped++;
      console.log(`  skip ${dt} (no binance extract)`);
      continue;
    }
    const binMap = loadBinanceCloses(csv);
    if (binMap.size < 1000) {
      skipped++;
      continue;
    }
    const files = filesFor(dt);
    if (!files.length) {
      skipped++;
      continue;
    }
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
    const snaps = processDay(res.getRowObjectsJS(), binMap);
    all.push(...snaps);
    console.log(`  ${dt}: snaps=${snaps.length}`);
  }
  all.sort((a, b) => a.tsMs - b.tsMs);
  console.log(`total snaps=${all.length} skipped_days=${skipped}`);
  return all;
}

function splits(all) {
  const n = all.length;
  return {
    train: all.slice(0, Math.floor(n * 0.6)),
    valid: all.slice(Math.floor(n * 0.6), Math.floor(n * 0.8)),
    holdout: all.slice(Math.floor(n * 0.8)),
  };
}

function evalPolicy(model, policy, train, valid, holdout) {
  const modes = ['impulse_only', 'ladm_edge', 'ladm_size', 'ladm_combo'];
  const out = {};
  for (const splitName of ['train', 'valid', 'holdout']) {
    const snaps = splitName === 'train' ? train : splitName === 'valid' ? valid : holdout;
    out[splitName] = {};
    for (const mode of modes) {
      out[splitName][mode] = simulate(snaps, model, policy, mode);
    }
    out[splitName].sets_differ_edge_vs_impulse =
      tradeSetKey(snaps, model, policy, 'impulse_only') !== tradeSetKey(snaps, model, policy, 'ladm_edge');
  }
  return out;
}

function verdict(hold) {
  const reasons = [];
  const edge = hold.ladm_edge;
  const combo = hold.ladm_combo;
  const imp = hold.impulse_only;
  let decision = 'NO-GO';

  const edgeOk = edge.n >= 30 && edge.net > 0 && edge.pf != null && edge.pf >= 1.15;
  const comboOk = combo.n >= 30 && combo.net > 0 && combo.pf != null && combo.pf >= 1.15;
  const differs = hold.sets_differ_edge_vs_impulse;
  const betterOrEqual =
    (edgeOk && edge.net >= imp.net * 0.9) || (comboOk && combo.net >= imp.net * 0.85);

  if (!differs) reasons.push('edge filter still same trade set as impulse');
  if (!edgeOk && !comboOk) reasons.push('no LADM mode with n≥30, net>0, PF≥1.15 on holdout');
  if (edgeOk && edge.net < imp.net * 0.7) reasons.push('ladm_edge net << impulse (soft)');
  if (comboOk && combo.net < imp.net * 0.7) reasons.push('ladm_combo net << impulse (soft)');

  if (differs && (edgeOk || comboOk)) {
    decision = betterOrEqual ? 'GO-CANDIDATE' : 'GO-WEAK';
    if (!betterOrEqual) reasons.push('LADM differs but underperforms impulse net (still positive)');
  }

  return {
    decision,
    reasons,
    note:
      decision === 'NO-GO'
        ? 'Do not promote differentiated LADM; impulse-only remains the economic engine.'
        : 'Differentiated LADM survives holdout — candidate for runner with Binance feed.',
  };
}

function row(r) {
  if (!r || !r.n) return { n: 0 };
  return {
    n: r.n,
    wr: r.winRate?.toFixed?.(3),
    net: r.net?.toFixed?.(1),
    pf: r.pf == null ? null : r.pf === Infinity ? 'inf' : +r.pf.toFixed(2),
    dd: r.maxDD?.toFixed?.(1),
    avgStake: r.avgStake?.toFixed?.(2),
    avgPsi: r.avgPsi?.toFixed?.(3),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`LADM Phase II+ | ${args.from} → ${args.to}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = await loadAll(args);
  if (all.length < 2000) {
    console.error('too few', all.length);
    process.exit(1);
  }

  const { train, valid, holdout } = splits(all);
  console.log(`splits ${train.length}/${valid.length}/${holdout.length}`);

  const model = fitPsi(train);
  console.log('Ψ', model);

  // reference: phase2 champion-like non-binding
  const legacy = {
    zMin: 1.5,
    minEdge: 0.03,
    askMax: 0.7,
    askMin: 0.08,
    tauMax: 120,
    onlyStale: false,
    sizeRefPsi: 0.04,
    sizeMaxMult: 2.5,
  };

  const picked = pickPolicies(train, model);
  console.log(
    `scored ${picked.nScored} policies; psi@1.5=${picked.psiAt15?.toFixed(4)} @2.0=${picked.psiAt20?.toFixed(4)}`,
  );

  const champions = [];
  // always include legacy for comparison
  champions.push({ name: 'legacy_nonbinding', policy: legacy, ...evalPolicy(model, legacy, train, valid, holdout) });

  // top 3 differing on train score, re-rank by valid combo/edge net
  const candidates = picked.topDiff.slice(0, 12);
  const ranked = candidates
    .map((c) => {
      const ev = evalPolicy(model, c.policy, train, valid, holdout);
      const validScore =
        (ev.valid.sets_differ_edge_vs_impulse ? 30 : 0) +
        ev.valid.ladm_combo.net +
        ev.valid.ladm_edge.net * 0.5 -
        0.15 * ev.valid.ladm_combo.maxDD;
      return { name: 'cand', policy: c.policy, psiFloor: c.psiFloor, validScore, ...ev };
    })
    .sort((a, b) => b.validScore - a.validScore);

  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    champions.push({ ...ranked[i], name: `diff_top${i + 1}` });
  }

  // also pure size-only with legacy z (differs only in PnL, same set)
  champions.push({
    name: 'size_on_legacy_set',
    policy: legacy,
    ...evalPolicy(model, legacy, train, valid, holdout),
  });

  console.log('\n=== CHAMPIONS HOLDOUT ===');
  for (const c of champions) {
    console.log('\n', c.name, c.policy);
    console.log('  differ', c.holdout.sets_differ_edge_vs_impulse);
    console.table({
      impulse: row(c.holdout.impulse_only),
      edge: row(c.holdout.ladm_edge),
      size: row(c.holdout.ladm_size),
      combo: row(c.holdout.ladm_combo),
    });
  }

  // primary: best ranked differing, else best of champions by holdout combo net among differs
  let primary =
    ranked.find((c) => c.holdout.sets_differ_edge_vs_impulse && (c.holdout.ladm_edge.n >= 30 || c.holdout.ladm_combo.n >= 30)) ||
    ranked[0] ||
    champions[0];

  const v = verdict(primary.holdout);

  // calib on full holdout strong Z
  const strong = holdout.filter((s) => Math.abs(s.impulseZ) >= 1.5);
  const calib = {
    n: strong.length,
    brier_mkt: brier(
      strong.map((s) => s.upAsk),
      strong.map((s) => s.upWins),
    ),
    brier_ladm: brier(
      strong.map((s) => clip01(s.upAsk + psiSigned(s.impulseZ, model))),
      strong.map((s) => s.upWins),
    ),
  };

  const report = {
    theory: 'LADM-v0.2-diff',
    from: args.from,
    to: args.to,
    n: all.length,
    n_train: train.length,
    n_valid: valid.length,
    n_holdout: holdout.length,
    psi: model,
    psi_levels: { at_1_5: picked.psiAt15, at_2_0: picked.psiAt20, at_2_5: picked.psiAt25 },
    primary: {
      name: primary.name,
      policy: primary.policy,
      train: primary.train,
      valid: primary.valid,
      holdout: primary.holdout,
    },
    champions: champions.map((c) => ({
      name: c.name,
      policy: c.policy,
      holdout: c.holdout,
      valid_net_combo: c.valid?.ladm_combo?.net,
      holdout_net_combo: c.holdout?.ladm_combo?.net,
      differ_holdout: c.holdout?.sets_differ_edge_vs_impulse,
    })),
    calibration_holdout_strong: calib,
    verdict: v,
    generated_at: new Date().toISOString(),
  };

  const tag = `${args.from}_${args.to}`;
  const jp = path.join(OUT_DIR, `phase2b-ladm-diff-${tag}.json`);
  const mp = path.join(OUT_DIR, `phase2b-ladm-diff-${tag}.md`);
  fs.writeFileSync(jp, JSON.stringify(report, null, 2));
  fs.writeFileSync(mp, toMarkdown(report));

  // update theory doc section
  updateTheoryDoc(report);

  console.log('\nPRIMARY', primary.name, primary.policy);
  console.log('VERDICT', v);
  console.log('Wrote', jp, mp);
}

function toMarkdown(report) {
  const p = report.primary;
  const L = [];
  L.push('# LADM Phase II+ — expanded range + differentiated policies');
  L.push('');
  L.push(`Range **${report.from} → ${report.to}** n=${report.n}`);
  L.push(`Ψ: a=${report.psi.a?.toFixed(4)} s=${report.psi.s} | ψ(1.5)=${report.psi_levels.at_1_5?.toFixed(4)} ψ(2.0)=${report.psi_levels.at_2_0?.toFixed(4)}`);
  L.push('');
  L.push(`## Primary: \`${p.name}\``);
  L.push('```json');
  L.push(JSON.stringify(p.policy, null, 2));
  L.push('```');
  L.push(`sets_differ edge vs impulse (holdout): **${p.holdout.sets_differ_edge_vs_impulse}**`);
  L.push('');
  L.push('| Split | Mode | n | WR | Net | PF | MaxDD | avgStake |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const split of ['train', 'valid', 'holdout']) {
    for (const mode of ['impulse_only', 'ladm_edge', 'ladm_size', 'ladm_combo']) {
      const r = p[split][mode];
      L.push(
        `| ${split} | ${mode} | ${r.n} | ${r.winRate?.toFixed?.(3) ?? '—'} | ${r.net?.toFixed?.(1)} | ${fmtPf(r.pf)} | ${r.maxDD?.toFixed?.(1)} | ${r.avgStake?.toFixed?.(2) ?? '—'} |`,
      );
    }
  }
  L.push('');
  L.push('## Calib holdout |Z|≥1.5');
  L.push(`- Brier mkt ${report.calibration_holdout_strong.brier_mkt?.toFixed(5)}`);
  L.push(`- Brier LADM ${report.calibration_holdout_strong.brier_ladm?.toFixed(5)}`);
  L.push('');
  L.push(`## Verdict: **${report.verdict.decision}**`);
  L.push(report.verdict.note);
  for (const r of report.verdict.reasons) L.push(`- ${r}`);
  L.push('');
  L.push('## Other champions (holdout snapshot)');
  for (const c of report.champions) {
    L.push(
      `- **${c.name}** differ=${c.differ_holdout} combo_net=${c.holdout_net_combo?.toFixed?.(1)} edge_n=${c.holdout?.ladm_edge?.n} policy=${JSON.stringify(c.policy)}`,
    );
  }
  return L.join('\n');
}

function fmtPf(pf) {
  if (pf == null) return '—';
  if (pf === Infinity) return '∞';
  return pf.toFixed(2);
}

function updateTheoryDoc(report) {
  const p = report.primary;
  const pathDoc = path.join('docs', 'estrategias', 'nao-implementadas', 'ladm-v0.md');
  let base = '';
  if (fs.existsSync(pathDoc)) base = fs.readFileSync(pathDoc, 'utf8');
  const section = `

---

## Phase II+ (${report.from} → ${report.to}) — diferenciação LADM

Gerado: ${report.generated_at}

### Ψ re-fit (train 60%)

- a=${report.psi.a?.toFixed(6)}, s=${report.psi.s}
- ψ(|Z|=1.5)≈${report.psi_levels.at_1_5?.toFixed(4)}, ψ(2.0)≈${report.psi_levels.at_2_0?.toFixed(4)}

### Primary policy (\`${p.name}\`)

\`\`\`json
${JSON.stringify(p.policy, null, 2)}
\`\`\`

sets_differ (holdout): **${p.holdout.sets_differ_edge_vs_impulse}**

| Mode | n | WR | Net $ | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| impulse_only | ${p.holdout.impulse_only.n} | ${p.holdout.impulse_only.winRate?.toFixed?.(3)} | ${p.holdout.impulse_only.net?.toFixed?.(1)} | ${fmtPf(p.holdout.impulse_only.pf)} | ${p.holdout.impulse_only.maxDD?.toFixed?.(1)} |
| ladm_edge | ${p.holdout.ladm_edge.n} | ${p.holdout.ladm_edge.winRate?.toFixed?.(3)} | ${p.holdout.ladm_edge.net?.toFixed?.(1)} | ${fmtPf(p.holdout.ladm_edge.pf)} | ${p.holdout.ladm_edge.maxDD?.toFixed?.(1)} |
| ladm_size | ${p.holdout.ladm_size.n} | ${p.holdout.ladm_size.winRate?.toFixed?.(3)} | ${p.holdout.ladm_size.net?.toFixed?.(1)} | ${fmtPf(p.holdout.ladm_size.pf)} | ${p.holdout.ladm_size.maxDD?.toFixed?.(1)} |
| ladm_combo | ${p.holdout.ladm_combo.n} | ${p.holdout.ladm_combo.winRate?.toFixed?.(3)} | ${p.holdout.ladm_combo.net?.toFixed?.(1)} | ${fmtPf(p.holdout.ladm_combo.pf)} | ${p.holdout.ladm_combo.maxDD?.toFixed?.(1)} |

### Verdict II+

**${report.verdict.decision}** — ${report.verdict.note}

${report.verdict.reasons.map((r) => `- ${r}`).join('\n')}
`;

  // append or replace Phase II+ section
  const marker = '## Phase II+ (';
  if (base.includes(marker)) {
    base = base.slice(0, base.indexOf(marker)).trimEnd() + '\n' + section;
  } else {
    base = base.trimEnd() + '\n' + section;
  }
  fs.writeFileSync(pathDoc, base);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
