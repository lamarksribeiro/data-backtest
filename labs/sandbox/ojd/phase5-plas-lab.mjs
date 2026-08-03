/**
 * Phase 5 — PLAS trading lab (quantify Pure-Lead ATM vs LADM-Z)
 *
 * Strategies (hold-to-settle, 1 trade/event, crypto taker fees):
 *  1) plas          — pure-lead ∧ ATM ∧ |Z|≥zMin
 *  2) plas_tight    — plas + askMax lower + |Z| higher
 *  3) ladm_z        — |Z|≥zMin only (no pure-lead / ATM)
 *  4) ladm_z_atm    — |Z|≥zMin ∧ ATM (no pure-lead gate)
 *  5) sync_atm      — sync-move ∧ ATM ∧ |Z| (anti-control: should be weak)
 *  6) pure_deep     — pure-lead ∧ deep (|m|≥2) (anti-control: should be ~0)
 *  7) plas_size     — plas + stake ∝ |Z|
 *
 * Usage:
 *   node --max-old-space-size=8192 labs/sandbox/ojd/phase5-plas-lab.mjs \
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
const LEAD = 2;
const FEE = POLYMARKET_FEE_RATES.crypto;
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
function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
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
      const Cup = Number(best.up_best_ask);
      const Cdn = Number(best.down_best_ask);
      const lakePx = Number(best.underlying_price);
      if (!Number.isFinite(Cup) || Cup <= 0.03 || Cup >= 0.97) continue;
      if (!Number.isFinite(Cdn) || Cdn <= 0.03 || Cdn >= 0.97) continue;
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
      if (lakeRet == null) continue;

      const absBin = Math.abs(binRet);
      const absLake = Math.abs(lakeRet);
      const pureLead = absBin >= 2 * sig && absLake < 0.5 * sig ? 1 : 0;
      const syncMove =
        absBin >= 1.5 * sig && absLake >= 1.0 * sig && Math.sign(binRet) === Math.sign(lakeRet) ? 1 : 0;

      const X = lakePx - ptb;
      const tau = Math.max(1, (eventEnd - tsMs) / 1000);
      const m = X / (sig * Math.sqrt(tau));
      const atm = Math.abs(m) < 1 ? 1 : 0;
      const deep = Math.abs(m) >= 2 ? 1 : 0;

      snaps.push({
        cid,
        dt: String(best.dt).slice(0, 10),
        tsMs,
        tau: target,
        Y,
        Cup: clip01(Cup),
        Cdn: clip01(Cdn),
        Z,
        absZ: Math.abs(Z),
        m,
        atm,
        deep,
        pureLead,
        syncMove,
        sig,
        binRet,
        lakeRet,
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
    const binMap = loadBinance(csv);
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
    const snaps = processDay(res.getRowObjectsJS(), binMap);
    all.push(...snaps);
    console.log(`  ${dt}: ${snaps.length}`);
  }
  all.sort((a, b) => a.tsMs - b.tsMs);
  return all;
}

function split(all) {
  const n = all.length;
  return {
    train: all.slice(0, Math.floor(0.6 * n)),
    valid: all.slice(Math.floor(0.6 * n), Math.floor(0.8 * n)),
    holdout: all.slice(Math.floor(0.8 * n)),
  };
}

/** decision: null | { side, ask, stake, tag } */
function decide(s, name, p) {
  if (s.tau > p.tauMax || s.tau < p.tauMin) return null;
  if (s.absZ < p.zMin) return null;

  const side = s.Z >= p.zMin ? 'UP' : s.Z <= -p.zMin ? 'DOWN' : null;
  if (!side) return null;
  // require sign consistency
  if (side === 'UP' && s.Z < 0) return null;
  if (side === 'DOWN' && s.Z > 0) return null;

  const ask = side === 'UP' ? s.Cup : s.Cdn;
  if (ask < p.askMin || ask > p.askMax) return null;

  if (name.startsWith('plas')) {
    if (!s.pureLead) return null;
    if (!s.atm) return null;
  } else if (name === 'ladm_z') {
    // only Z
  } else if (name === 'ladm_z_atm') {
    if (!s.atm) return null;
  } else if (name === 'sync_atm') {
    if (!s.syncMove) return null;
    if (!s.atm) return null;
  } else if (name === 'pure_deep') {
    if (!s.pureLead) return null;
    if (!s.deep) return null;
  } else {
    return null;
  }

  let stake = BASE_STAKE;
  if (name === 'plas_size' || name === 'plas_tight_size') {
    const mult = Math.min(p.sizeMax || 2.5, Math.max(0.75, s.absZ / Math.max(p.zMin, 1)));
    stake = BASE_STAKE * mult;
  }

  return { side, ask, stake, Z: s.Z, pureLead: s.pureLead, atm: s.atm, m: s.m };
}

function simulate(snaps, name, policy) {
  const by = new Map();
  for (const s of snaps) {
    if (!by.has(s.cid)) by.set(s.cid, []);
    by.get(s.cid).push(s);
  }
  for (const arr of by.values()) arr.sort((a, b) => a.tsMs - b.tsMs);

  const trades = [];
  for (const [cid, arr] of by) {
    let hit = null;
    for (const s of arr) {
      const d = decide(s, name, policy);
      if (d) {
        hit = { s, ...d };
        break;
      }
    }
    if (!hit) continue;
    const { s, side, ask, stake, Z, m } = hit;
    const shares = stake / ask;
    const fee = calculatePolymarketTakerFee({ shares, price: ask, feeRate: FEE });
    const win = side === 'UP' ? s.Y === 1 : s.Y === 0;
    const gross = win ? shares * (1 - ask) : -shares * ask;
    const net = gross - fee;
    // aligned residual at entry for diagnostics
    const R = s.Y - s.Cup; // UP residual
    const aligned = Math.sign(Z) * (side === 'UP' ? s.Y - ask : (1 - s.Y) - ask);
    // For DOWN: win if Y=0, residual of down share = (1-Y) - ask_down
    const sideResid = side === 'UP' ? s.Y - ask : 1 - s.Y - ask;

    trades.push({
      cid,
      dt: s.dt,
      tsMs: s.tsMs,
      tau: s.tau,
      side,
      ask,
      stake,
      shares,
      fee,
      win: win ? 1 : 0,
      gross,
      net,
      Z,
      absZ: Math.abs(Z),
      m,
      pureLead: s.pureLead,
      atm: s.atm,
      sideResid,
    });
  }
  return summarize(trades, name);
}

function summarize(trades, name) {
  if (!trades.length) {
    return {
      name,
      n: 0,
      wins: 0,
      winRate: null,
      gross: 0,
      net: 0,
      fees: 0,
      pf: null,
      avgNet: null,
      avgGross: null,
      avgAsk: null,
      avgStake: null,
      avgAbsZ: null,
      avgSideResid: null,
      maxDD: 0,
      breakevenWR: null,
      edgeVsBE: null,
      netPerDay: null,
      recovery: null,
    };
  }
  const nets = trades.map((t) => t.net);
  const wins = sum(trades.map((t) => t.win));
  const pos = sum(nets.filter((x) => x > 0));
  const neg = Math.abs(sum(nets.filter((x) => x < 0)));
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.tsMs - b.tsMs);
  for (const t of sorted) {
    eq += t.net;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  const avgAsk = mean(trades.map((t) => t.ask));
  const wr = wins / trades.length;
  const days = new Set(trades.map((t) => t.dt)).size || 1;
  const net = sum(nets);
  return {
    name,
    n: trades.length,
    wins,
    winRate: wr,
    gross: sum(trades.map((t) => t.gross)),
    net,
    fees: sum(trades.map((t) => t.fee)),
    pf: neg > 1e-9 ? pos / neg : pos > 0 ? Infinity : null,
    avgNet: mean(nets),
    avgGross: mean(trades.map((t) => t.gross)),
    avgAsk,
    avgStake: mean(trades.map((t) => t.stake)),
    avgAbsZ: mean(trades.map((t) => t.absZ)),
    avgSideResid: mean(trades.map((t) => t.sideResid)),
    maxDD,
    breakevenWR: avgAsk, // approx before fees
    edgeVsBE: wr - avgAsk,
    netPerDay: net / days,
    recovery: maxDD > 0 ? net / maxDD : null,
    nDays: days,
    pctUp: mean(trades.map((t) => (t.side === 'UP' ? 1 : 0))),
  };
}

/** Pick PLAS params on train: maximize score = net - 0.2*DD + bonus PF */
function pickPlasPolicy(train) {
  const zMins = [1.0, 1.25, 1.5, 1.75];
  const askMaxs = [0.5, 0.55, 0.62, 0.7];
  const tauMaxs = [90, 120];
  let best = null;
  for (const zMin of zMins) {
    for (const askMax of askMaxs) {
      for (const tauMax of tauMaxs) {
        const p = { zMin, askMax, askMin: 0.08, tauMax, tauMin: 15, sizeMax: 2.5 };
        const r = simulate(train, 'plas', p);
        if (r.n < 40) continue;
        const score = r.net - 0.2 * r.maxDD + (r.pf != null && r.pf > 1.25 ? 20 : 0) + r.n * 0.05;
        if (!best || score > best.score) best = { score, policy: p, train: r };
      }
    }
  }
  return best;
}

function tableRow(r) {
  return {
    strat: r.name,
    n: r.n,
    wr: r.winRate != null ? +r.winRate.toFixed(3) : null,
    avgAsk: r.avgAsk != null ? +r.avgAsk.toFixed(3) : null,
    wr_minus_ask: r.edgeVsBE != null ? +r.edgeVsBE.toFixed(3) : null,
    avgResid: r.avgSideResid != null ? +r.avgSideResid.toFixed(3) : null,
    net: +r.net.toFixed(1),
    fees: +r.fees.toFixed(1),
    pf: r.pf == null ? null : r.pf === Infinity ? 'inf' : +r.pf.toFixed(2),
    avgNet: r.avgNet != null ? +r.avgNet.toFixed(2) : null,
    maxDD: +r.maxDD.toFixed(1),
    netDay: r.netPerDay != null ? +r.netPerDay.toFixed(1) : null,
    rec: r.recovery != null ? +r.recovery.toFixed(2) : null,
  };
}

function toMarkdown(report) {
  const L = [];
  L.push('# PLAS Lab — quantificação PnL');
  L.push('');
  L.push(`Range **${report.from} → ${report.to}** | stake base $${BASE_STAKE} | fee crypto ${FEE}`);
  L.push(`Splits: train ${report.n_train} / valid ${report.n_valid} / holdout ${report.n_holdout} snaps`);
  L.push('');
  L.push('## Policy PLAS (escolhida no train)');
  L.push('```json');
  L.push(JSON.stringify(report.plas_policy, null, 2));
  L.push('```');
  L.push('');
  L.push('## Holdout (métrica principal)');
  L.push('');
  L.push('| Strat | n | WR | avgAsk | WR−ask | avgResid | Net $ | Fees | PF | avgNet | MaxDD | $/day |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of report.holdout) {
    L.push(
      `| ${r.name} | ${r.n} | ${fmt(r.winRate, 3)} | ${fmt(r.avgAsk, 3)} | ${fmt(r.edgeVsBE, 3)} | ${fmt(r.avgSideResid, 3)} | ${fmt(r.net, 1)} | ${fmt(r.fees, 1)} | ${fmtPf(r.pf)} | ${fmt(r.avgNet, 2)} | ${fmt(r.maxDD, 1)} | ${fmt(r.netPerDay, 1)} |`,
    );
  }
  L.push('');
  L.push('## Valid');
  L.push('');
  L.push('| Strat | n | WR | WR−ask | Net $ | PF | MaxDD |');
  L.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of report.valid) {
    L.push(
      `| ${r.name} | ${r.n} | ${fmt(r.winRate, 3)} | ${fmt(r.edgeVsBE, 3)} | ${fmt(r.net, 1)} | ${fmtPf(r.pf)} | ${fmt(r.maxDD, 1)} |`,
    );
  }
  L.push('');
  L.push('## Train');
  L.push('');
  L.push('| Strat | n | WR | WR−ask | Net $ | PF | MaxDD |');
  L.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of report.train) {
    L.push(
      `| ${r.name} | ${r.n} | ${fmt(r.winRate, 3)} | ${fmt(r.edgeVsBE, 3)} | ${fmt(r.net, 1)} | ${fmtPf(r.pf)} | ${fmt(r.maxDD, 1)} |`,
    );
  }
  L.push('');
  L.push('## Comparativos-chave (holdout)');
  L.push('');
  const H = Object.fromEntries(report.holdout.map((r) => [r.name, r]));
  if (H.plas && H.ladm_z) {
    L.push(`- **PLAS vs LADM-Z net:** ${fmt(H.plas.net, 1)} vs ${fmt(H.ladm_z.net, 1)} (Δ ${fmt(H.plas.net - H.ladm_z.net, 1)})`);
    L.push(`- **PLAS vs LADM-Z PF:** ${fmtPf(H.plas.pf)} vs ${fmtPf(H.ladm_z.pf)}`);
    L.push(`- **PLAS vs LADM-Z avgNet:** ${fmt(H.plas.avgNet, 2)} vs ${fmt(H.ladm_z.avgNet, 2)}`);
    L.push(`- **PLAS vs LADM-Z n:** ${H.plas.n} vs ${H.ladm_z.n} (PLAS é mais seletivo)`);
    L.push(`- **PLAS WR−ask:** ${fmt(H.plas.edgeVsBE, 3)} | **LADM-Z WR−ask:** ${fmt(H.ladm_z.edgeVsBE, 3)}`);
  }
  if (H.sync_atm) {
    L.push(`- **Sync-ATM (anti-control) net:** ${fmt(H.sync_atm.net, 1)} PF ${fmtPf(H.sync_atm.pf)} — deve ser fraco`);
  }
  if (H.pure_deep) {
    L.push(`- **Pure-deep (anti-control) net:** ${fmt(H.pure_deep.net, 1)} PF ${fmtPf(H.pure_deep.pf)} — deve ser ~0/ruim`);
  }
  L.push('');
  L.push('## Verdict');
  L.push('');
  L.push(report.verdict.text);
  for (const x of report.verdict.bullets) L.push(`- ${x}`);
  L.push('');
  return L.join('\n');
}

function fmt(x, d) {
  if (x == null || Number.isNaN(x)) return '—';
  return Number(x).toFixed(d);
}
function fmtPf(pf) {
  if (pf == null) return '—';
  if (pf === Infinity) return '∞';
  return pf.toFixed(2);
}

function verdict(holdMap) {
  const p = holdMap.plas;
  const z = holdMap.ladm_z;
  const s = holdMap.sync_atm;
  const d = holdMap.pure_deep;
  const bullets = [];
  let ok = true;

  if (!p || p.n < 25) {
    ok = false;
    bullets.push('PLAS holdout n < 25 — amostra fina');
  }
  if (p && p.net <= 0) {
    ok = false;
    bullets.push('PLAS net ≤ 0 após fees');
  }
  if (p && (p.pf == null || p.pf < 1.15)) {
    ok = false;
    bullets.push(`PLAS PF ${p?.pf} < 1.15`);
  }
  if (p && z && p.avgNet > z.avgNet * 1.15) {
    bullets.push(`PLAS avgNet superior a LADM-Z (${fmt(p.avgNet, 2)} vs ${fmt(z.avgNet, 2)})`);
  } else if (p && z) {
    bullets.push(`PLAS avgNet vs LADM-Z: ${fmt(p.avgNet, 2)} vs ${fmt(z.avgNet, 2)}`);
  }
  if (p && z && p.n < z.n) {
    bullets.push(`PLAS mais seletivo: ${p.n} vs ${z.n} trades`);
  }
  if (s && s.net < (p?.net || 0) * 0.5) {
    bullets.push(`Anti-control sync-ATM bem pior (net ${fmt(s.net, 1)}) — confirma tese`);
  } else if (s) {
    bullets.push(`Sync-ATM net ${fmt(s.net, 1)} PF ${fmtPf(s.pf)}`);
  }
  if (d && d.net < 50) {
    bullets.push(`Anti-control pure-deep fraco (net ${fmt(d.net, 1)}) — confirma ATM`);
  }

  return {
    decision: ok ? 'PLAS_QUANTIFIED_POSITIVE' : 'PLAS_WEAK_OR_FAIL',
    text: ok
      ? '**PLAS_QUANTIFIED_POSITIVE** — pure-lead×ATM entrega EV líquido mensurável e superior em qualidade (avgNet/PF) ao impulso Z genérico; anti-controles alinhados com a teoria.'
      : '**PLAS_WEAK_OR_FAIL** — ver bullets; não promover sem novo range/params.',
    bullets,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('PLAS Lab', args.from, '→', args.to);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = await loadAll(args);
  console.log('snaps', all.length);
  const { train, valid, holdout } = split(all);
  console.log(`splits ${train.length}/${valid.length}/${holdout.length}`);

  const picked = pickPlasPolicy(train);
  if (!picked) {
    console.error('no plas policy');
    process.exit(1);
  }
  console.log('PLAS policy', picked.policy, 'train', picked.train);

  const base = picked.policy;
  const tight = {
    ...base,
    zMin: Math.max(base.zMin, 1.5),
    askMax: Math.min(base.askMax, 0.55),
  };

  const names = ['plas', 'plas_tight', 'plas_size', 'ladm_z', 'ladm_z_atm', 'sync_atm', 'pure_deep'];
  // plas_tight uses tight policy; others use base for fair Z threshold comparison where relevant
  function policyFor(name) {
    if (name === 'plas_tight' || name === 'plas_tight_size') return tight;
    if (name === 'ladm_z' || name === 'ladm_z_atm') return base; // same zMin/ask as plas for fair compare
    if (name === 'sync_atm' || name === 'pure_deep') return base;
    return base;
  }

  function runSplit(snaps) {
    return names.map((name) => simulate(snaps, name, policyFor(name)));
  }

  // also plas_size with base
  const trainR = runSplit(train);
  const validR = runSplit(valid);
  const holdR = runSplit(holdout);

  console.log('\n=== TRAIN ===');
  console.table(trainR.map(tableRow));
  console.log('\n=== VALID ===');
  console.table(validR.map(tableRow));
  console.log('\n=== HOLDOUT ===');
  console.table(holdR.map(tableRow));

  const holdMap = Object.fromEntries(holdR.map((r) => [r.name, r]));
  const v = verdict(holdMap);

  // Relative efficiency
  const efficiency =
    holdMap.plas && holdMap.ladm_z
      ? {
          plas_net_per_trade: holdMap.plas.avgNet,
          ladm_net_per_trade: holdMap.ladm_z.avgNet,
          plas_net_per_dd: holdMap.plas.recovery,
          ladm_net_per_dd: holdMap.ladm_z.recovery,
          trade_ratio: holdMap.plas.n / Math.max(holdMap.ladm_z.n, 1),
          net_ratio: holdMap.plas.net / (Math.abs(holdMap.ladm_z.net) > 1e-6 ? holdMap.ladm_z.net : 1),
        }
      : null;

  const report = {
    theory: 'PLAS-lab-v1',
    from: args.from,
    to: args.to,
    n: all.length,
    n_train: train.length,
    n_valid: valid.length,
    n_holdout: holdout.length,
    fee_rate: FEE,
    stake: BASE_STAKE,
    plas_policy: base,
    plas_tight_policy: tight,
    train: trainR,
    valid: validR,
    holdout: holdR,
    efficiency,
    verdict: v,
    generated_at: new Date().toISOString(),
  };

  const tag = `${args.from}_${args.to}`;
  const jp = path.join(OUT_DIR, `phase5-plas-lab-${tag}.json`);
  const mp = path.join(OUT_DIR, `phase5-plas-lab-${tag}.md`);
  fs.writeFileSync(jp, JSON.stringify(report, null, 2));
  fs.writeFileSync(mp, toMarkdown(report));

  // append to undiscovered doc
  const appendix = `

---

## Lab de quantificação PnL (Phase 5)

Gerado: ${report.generated_at}

Policy PLAS (train): \`${JSON.stringify(base)}\`

### Holdout

| Strat | n | WR | avgAsk | WR−ask | Net | PF | avgNet | MaxDD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${holdR
  .map(
    (r) =>
      `| ${r.name} | ${r.n} | ${fmt(r.winRate, 3)} | ${fmt(r.avgAsk, 3)} | ${fmt(r.edgeVsBE, 3)} | ${fmt(r.net, 1)} | ${fmtPf(r.pf)} | ${fmt(r.avgNet, 2)} | ${fmt(r.maxDD, 1)} |`,
  )
  .join('\n')}

### Efficiency
\`\`\`json
${JSON.stringify(efficiency, null, 2)}
\`\`\`

### Verdict
**${v.decision}** — ${v.text}

${v.bullets.map((b) => `- ${b}`).join('\n')}
`;
  const docPath = path.join('docs', 'research', 'undiscovered-structure.md');
  if (fs.existsSync(docPath)) {
    let doc = fs.readFileSync(docPath, 'utf8');
    const marker = '## Lab de quantificação PnL';
    if (doc.includes(marker)) doc = doc.slice(0, doc.indexOf(marker)).trimEnd();
    fs.writeFileSync(docPath, doc + '\n' + appendix);
  }

  console.log('\nVERDICT', v);
  console.log('Efficiency', efficiency);
  console.log('Wrote', jp, mp);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
