/**
 * Pivot D — Binance 1s lead vs Polymarket book residual
 *
 * Lake underlying_price is oracle-synced with the book (not pure Binance lead).
 * This joins true Binance spot 1s closes with lake ticks to test whether
 * recent Binance moves not yet reflected in odds leave terminal residual.
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase1d-binance-lead.mjs \
 *     --from 2026-05-15 --to 2026-05-22
 *
 * Requires zips in data/binance-1s/ (auto-download if missing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { get } from 'node:https';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { downloadBinanceDailyZip } from '../../../scripts/download-binance-1s.js';

const LAKE_ROOT = path.resolve(process.env.LAKE_ROOT || 'lake');
const BINANCE_DIR = path.resolve('data/binance-1s');
const EXTRACT_DIR = path.join(BINANCE_DIR, 'extracted');
const OUT_DIR = path.join('labs', 'sandbox', 'ojd', 'reports');
const LAKE_BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');

const EVAL_TAUS = [90, 60, 45, 30];
const TAU_TOL = 2.5;
const LEAD_SEC = 2; // Binance move lookback

function parseArgs(argv) {
  const out = { from: '2026-05-15', to: '2026-05-22' };
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
function brier(ps, ys) {
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

function ensureExtracted(dateStr) {
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  const csv = path.join(EXTRACT_DIR, `BTCUSDT-1s-${dateStr}.csv`);
  if (fs.existsSync(csv) && fs.statSync(csv).size > 1000) return csv;
  const zip = path.join(BINANCE_DIR, `BTCUSDT-1s-${dateStr}.zip`);
  if (!fs.existsSync(zip)) return null;
  // PowerShell Expand-Archive
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${EXTRACT_DIR.replace(/'/g, "''")}' -Force`],
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.warn('extract fail', dateStr, e.message);
    return null;
  }
  return fs.existsSync(csv) ? csv : null;
}

/**
 * Load Binance 1s close by epoch second (UTC).
 * Vision files sometimes use open_time in microseconds.
 */
function loadBinanceCloses(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const map = new Map(); // sec -> close
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    let t = Number(parts[0]);
    const close = Number(parts[4]);
    if (!Number.isFinite(t) || !Number.isFinite(close)) continue;
    // Binance Vision may emit open_time in microseconds (~1e15) or ms (~1e12 for 2026)
    if (t > 1e14) t = Math.floor(t / 1000); // µs → ms
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

    // index lake by second (last tick in second)
    const lakeSec = new Map();
    for (const t of ticks) {
      const sec = Math.floor(Number(t.ts_ms) / 1000);
      lakeSec.set(sec, t);
    }

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
      const ask = Number(best.up_best_ask);
      const lakePx = Number(best.underlying_price);
      if (!Number.isFinite(ask) || ask <= 0.02 || ask >= 0.98) continue;
      if (!Number.isFinite(lakePx)) continue;

      const bNow = binanceBySec.get(sec);
      const bPrev = binanceBySec.get(sec - LEAD_SEC);
      const bPrev1 = binanceBySec.get(sec - 1);
      if (bNow == null || bPrev == null) continue;

      const binRet = bNow - bPrev; // $ over LEAD_SEC
      const binRet1 = bPrev1 != null ? bNow - bPrev1 : null;
      const lakeRet =
        lakeSec.has(sec - LEAD_SEC) && Number.isFinite(Number(lakeSec.get(sec - LEAD_SEC).underlying_price))
          ? lakePx - Number(lakeSec.get(sec - LEAD_SEC).underlying_price)
          : null;

      // Lead residual: Binance moved but lake/oracle (and thus book) moved less
      const leadGap = lakeRet != null ? binRet - lakeRet : null;

      // Future book move (next 2s) for path prediction test
      let futureAsk = null;
      for (let s = sec + 1; s <= sec + 2; s++) {
        if (lakeSec.has(s)) futureAsk = Number(lakeSec.get(s).up_best_ask);
      }
      const dAskFwd = futureAsk != null && Number.isFinite(futureAsk) ? futureAsk - ask : null;

      const x = lakePx - ptb;
      const xBin = bNow - ptb; // barrier distance using Binance spot
      const tau = Math.max(1, (eventEnd - tsMs) / 1000);

      // crude sigma from last 30s binance
      let ss = 0;
      let cn = 0;
      for (let s = sec - 30; s < sec; s++) {
        const a = binanceBySec.get(s);
        const b = binanceBySec.get(s + 1);
        if (a != null && b != null) {
          const r = b - a;
          ss += r * r;
          cn++;
        }
      }
      const sig = cn > 10 ? Math.sqrt(ss / cn) : 1;
      const pLake = clip01(normalCdf(x / (sig * Math.sqrt(tau))));
      const pBin = clip01(normalCdf(xBin / (sig * Math.sqrt(tau))));

      // Lead-adjusted p: nudge market by signed binance impulse scaled
      const impulseZ = binRet / Math.max(sig * Math.sqrt(LEAD_SEC), 1e-6);
      const leadNudge = 0.04 * Math.tanh(impulseZ); // bounded
      const pLead = clip01(ask + leadNudge);
      const pLeadBin = clip01(0.6 * ask + 0.4 * pBin);

      // Stale book hypothesis: large |binRet| and small |dAsk| recently
      let dAskBack = null;
      if (lakeSec.has(sec - LEAD_SEC)) {
        const a0 = Number(lakeSec.get(sec - LEAD_SEC).up_best_ask);
        if (Number.isFinite(a0)) dAskBack = ask - a0;
      }

      snaps.push({
        cid,
        dt: best.dt,
        tsMs,
        tau: target,
        ask,
        lakePx,
        bNow,
        ptb,
        x,
        xBin,
        binRet,
        binRet1,
        lakeRet,
        leadGap,
        dAskBack,
        dAskFwd,
        impulseZ,
        pM: clip01(ask),
        pLake,
        pBin,
        pLead,
        pLeadBin,
        upWins,
        residM: upWins - clip01(ask),
        residLead: upWins - pLead,
        residLeadBin: upWins - pLeadBin,
      });
    }
  }
  return snaps;
}

function impulseBin(z) {
  if (z == null || !Number.isFinite(z)) return 'na';
  if (z <= -2) return 'strong_down';
  if (z <= -0.75) return 'down';
  if (z < 0.75) return 'flat';
  if (z < 2) return 'up';
  return 'strong_up';
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
      if (arr.length < 50) return { [keyName]: k, n: arr.length, thin: true };
      const y = arr.map((s) => s.upWins);
      return {
        [keyName]: k,
        n: arr.length,
        up_rate: mean(y),
        mean_pM: mean(arr.map((s) => s.pM)),
        resid_m: mean(arr.map((s) => s.residM)),
        resid_lead: mean(arr.map((s) => s.residLead)),
        brier_m: brier(arr.map((s) => s.pM), y),
        brier_lead: brier(arr.map((s) => s.pLead), y),
        brier_leadBin: brier(arr.map((s) => s.pLeadBin), y),
        brier_bin: brier(arr.map((s) => s.pBin), y),
        mean_binRet: mean(arr.map((s) => s.binRet)),
        corr_impulse_residM: pearson(arr.map((s) => s.impulseZ), arr.map((s) => s.residM)),
        corr_impulse_dAskFwd: pearson(
          arr.filter((s) => s.dAskFwd != null).map((s) => s.impulseZ),
          arr.filter((s) => s.dAskFwd != null).map((s) => s.dAskFwd),
        ),
        // EV if buy UP when impulse strong up and ask cheapish
      };
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = listDays(args.from, args.to);
  if (!days.length) {
    console.error('No lake days');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(BINANCE_DIR, { recursive: true });

  console.log(`Pivot D Binance lead | ${args.from}→${args.to} | ${days.length} days`);

  // ensure downloads
  for (const dt of days) {
    await downloadBinanceDailyZip('BTCUSDT', dt);
  }

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '6GB'`);

  const all = [];
  for (const dt of days) {
    const zipOk = fs.existsSync(path.join(BINANCE_DIR, `BTCUSDT-1s-${dt}.zip`));
    if (!zipOk) {
      console.log(`  skip ${dt} (no binance zip)`);
      continue;
    }
    const csv = ensureExtracted(dt);
    if (!csv) {
      console.log(`  skip ${dt} (extract fail)`);
      continue;
    }
    const binMap = loadBinanceCloses(csv);
    if (binMap.size < 1000) {
      console.log(`  skip ${dt} (binance map small ${binMap.size})`);
      continue;
    }

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
    const rows = res.getRowObjectsJS();
    const snaps = processDay(rows, binMap);
    all.push(...snaps);
    console.log(`  ${dt}: lake=${rows.length} binSec=${binMap.size} snaps=${snaps.length}`);
  }

  if (all.length < 200) {
    console.error('Too few snaps', all.length);
    process.exit(1);
  }

  all.sort((a, b) => a.tsMs - b.tsMs);
  const cut = all[Math.floor(all.length * 0.7)].tsMs;
  const train = all.filter((s) => s.tsMs < cut);
  const valid = all.filter((s) => s.tsMs >= cut);

  const y = all.map((s) => s.upWins);
  const global = {
    n: all.length,
    brier_m: brier(all.map((s) => s.pM), y),
    brier_lead: brier(all.map((s) => s.pLead), y),
    brier_leadBin: brier(all.map((s) => s.pLeadBin), y),
    brier_bin: brier(all.map((s) => s.pBin), y),
    brier_lakePhys: brier(all.map((s) => s.pLake), y),
    resid_m: mean(all.map((s) => s.residM)),
    corr_impulse_residM: pearson(all.map((s) => s.impulseZ), all.map((s) => s.residM)),
    corr_impulse_dAskFwd: pearson(
      all.filter((s) => s.dAskFwd != null).map((s) => s.impulseZ),
      all.filter((s) => s.dAskFwd != null).map((s) => s.dAskFwd),
    ),
    corr_leadGap_residM: pearson(
      all.filter((s) => s.leadGap != null).map((s) => s.leadGap),
      all.filter((s) => s.leadGap != null).map((s) => s.residM),
    ),
    mean_abs_leadGap: mean(all.filter((s) => s.leadGap != null).map((s) => Math.abs(s.leadGap))),
  };

  const by_impulse = summarize(all, (s) => impulseBin(s.impulseZ), 'impulse');
  const by_impulse_valid = summarize(valid, (s) => impulseBin(s.impulseZ), 'impulse');

  // Stale: strong impulse + small book reaction over lead window
  const stale = all.filter(
    (s) =>
      Math.abs(s.impulseZ) >= 1.5 &&
      s.dAskBack != null &&
      Math.abs(s.dAskBack) < 0.02,
  );
  const staleValid = valid.filter(
    (s) =>
      Math.abs(s.impulseZ) >= 1.5 &&
      s.dAskBack != null &&
      Math.abs(s.dAskBack) < 0.02,
  );

  function pocket(arr, name) {
    if (arr.length < 40) return { name, n: arr.length, thin: true };
    const y0 = arr.map((s) => s.upWins);
    const upImpulse = arr.filter((s) => s.impulseZ >= 1.5);
    const dnImpulse = arr.filter((s) => s.impulseZ <= -1.5);
    return {
      name,
      n: arr.length,
      resid_m: mean(arr.map((s) => s.residM)),
      brier_m: brier(arr.map((s) => s.pM), y0),
      brier_lead: brier(arr.map((s) => s.pLead), y0),
      // If strong UP impulse and book stale, is UP underpriced?
      up_impulse_n: upImpulse.length,
      up_impulse_resid: mean(upImpulse.map((s) => s.residM)),
      dn_impulse_n: dnImpulse.length,
      dn_impulse_resid: mean(dnImpulse.map((s) => s.residM)),
      gap_up_dn:
        upImpulse.length >= 20 && dnImpulse.length >= 20
          ? mean(upImpulse.map((s) => s.residM)) - mean(dnImpulse.map((s) => s.residM))
          : null,
    };
  }

  // Gates
  const strongUp = by_impulse.find((r) => r.impulse === 'strong_up' && !r.thin);
  const strongDn = by_impulse.find((r) => r.impulse === 'strong_down' && !r.thin);
  const flat = by_impulse.find((r) => r.impulse === 'flat' && !r.thin);
  const strongUpV = by_impulse_valid.find((r) => r.impulse === 'strong_up' && !r.thin);
  const strongDnV = by_impulse_valid.find((r) => r.impulse === 'strong_down' && !r.thin);

  let passAll = false;
  let passValid = false;
  if (strongUp && strongDn) {
    const gap = (strongUp.resid_m || 0) - (strongDn.resid_m || 0);
    // expect strong_up residual > strong_down residual (more UP wins than ask when binance pumped)
    passAll = gap >= 0.03;
  }
  if (strongUpV && strongDnV) {
    const gap = (strongUpV.resid_m || 0) - (strongDnV.resid_m || 0);
    passValid = gap >= 0.025;
  }
  const leadBeatsMkt = global.brier_lead < global.brier_m - 0.001 || global.brier_leadBin < global.brier_m - 0.001;

  let decision;
  if (passAll && passValid) {
    decision = 'PROCEED Phase II: Binance impulse residual stable train/valid. Formalize lead-adjusted digital measure.';
  } else if (passAll && !passValid) {
    decision = 'HOLD: impulse residual in-sample only.';
  } else if (leadBeatsMkt) {
    decision = 'WEAK: lead model slightly beats market Brier — inspect before theory claim.';
  } else if (global.corr_impulse_dAskFwd != null && global.corr_impulse_dAskFwd >= 0.05) {
    decision =
      'PATH-ONLY: Binance predicts short-horizon ask moves but not terminal residual enough — edge may be scalp/latency not hold-to-settle.';
  } else {
    decision = 'KILL or narrow Pivot D: no stable terminal residual from Binance impulse in this pilot window.';
  }

  const report = {
    theory: 'PivotD-BinanceLead',
    from: args.from,
    to: args.to,
    n: all.length,
    n_train: train.length,
    n_valid: valid.length,
    lead_sec: LEAD_SEC,
    global,
    by_impulse,
    by_impulse_valid,
    by_tau: summarize(all, (s) => String(s.tau), 'tau'),
    stale_all: pocket(stale, 'stale_book'),
    stale_valid: pocket(staleValid, 'stale_book_valid'),
    gates: {
      passAll,
      passValid,
      leadBeatsMkt,
      strongUp_resid: strongUp?.resid_m,
      strongDn_resid: strongDn?.resid_m,
      strongUpV_resid: strongUpV?.resid_m,
      strongDnV_resid: strongDnV?.resid_m,
    },
    decision,
    note:
      'Lake underlying is oracle; leadGap measures Binance vs oracle co-movement. Terminal residual tests true lead value for settlement.',
    generated_at: new Date().toISOString(),
  };

  const tag = `${args.from}_${args.to}`;
  const jp = path.join(OUT_DIR, `phase1d-binance-lead-${tag}.json`);
  fs.writeFileSync(jp, JSON.stringify(report, null, 2));

  const md = [];
  md.push('# Pivot D — Binance lead pilot');
  md.push('');
  md.push(`Range **${args.from}→${args.to}** n=${all.length}`);
  md.push('');
  md.push('## Global');
  md.push('');
  md.push(`- Brier mkt: ${global.brier_m?.toFixed(5)}`);
  md.push(`- Brier lead nudge: ${global.brier_lead?.toFixed(5)}`);
  md.push(`- Brier lead×Bin digital: ${global.brier_leadBin?.toFixed(5)}`);
  md.push(`- corr(impulse, resid_m): ${global.corr_impulse_residM?.toFixed(4)}`);
  md.push(`- corr(impulse, dAsk 2s): ${global.corr_impulse_dAskFwd?.toFixed(4)}`);
  md.push('');
  md.push('## By impulse');
  md.push('');
  md.push('| impulse | n | resid_m | brier_m | brier_lead |');
  md.push('|---|---:|---:|---:|---:|');
  for (const r of by_impulse) {
    if (r.thin) continue;
    md.push(`| ${r.impulse} | ${r.n} | ${r.resid_m?.toFixed(4)} | ${r.brier_m?.toFixed(4)} | ${r.brier_lead?.toFixed(4)} |`);
  }
  md.push('');
  md.push(`## Decision\n\n${decision}\n`);
  fs.writeFileSync(path.join(OUT_DIR, `phase1d-binance-lead-${tag}.md`), md.join('\n'));

  console.log('\nGLOBAL', global);
  console.table(
    by_impulse
      .filter((r) => !r.thin)
      .map((r) => ({
        impulse: r.impulse,
        n: r.n,
        resid: r.resid_m?.toFixed(4),
        b_m: r.brier_m?.toFixed(4),
        b_lead: r.brier_lead?.toFixed(4),
      })),
  );
  console.log('VALID');
  console.table(
    by_impulse_valid
      .filter((r) => !r.thin)
      .map((r) => ({
        impulse: r.impulse,
        n: r.n,
        resid: r.resid_m?.toFixed(4),
        b_m: r.brier_m?.toFixed(4),
      })),
  );
  console.log('STALE', report.stale_all, report.stale_valid);
  console.log('GATES', report.gates);
  console.log('DECISION', decision);
  console.log('Wrote', jp);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
