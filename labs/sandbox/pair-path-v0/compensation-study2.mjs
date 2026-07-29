/**
 * Compensation study v2 — deeper path labeling, M1/M2 policies, locked curves.
 *
 *   node labs/sandbox/pair-path-v0/compensation-study2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const OUT = path.join(ROOT, '.tmp/clip-path-compensation-study2');

const FEE = 0.07;
const SH = 25; // align with mechanics-sweep size

const SERIES = [
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
  '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
  '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
].map((p) => path.join(ROOT, p));

const DEEP3 = {
  openShares: SH,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTriggerCents: 55,
  openCapCents: 2,
  maxOpenAttempts: 3,
  tauOpenMin: 40,
  tauOpenMax: 240,
  hedgeAskMax: 0.4,
  avgSumMax: 0.94,
  feeRate: FEE,
  maxEventNotional: 50,
  maxHedgeAttempts: 8,
  legChoice: 'chase',
  openRequireHedgeReady: false,
  hedgeLevels: [
    { askMax: 0.4, frac: 0.4 },
    { askMax: 0.36, frac: 0.3 },
    { askMax: 0.32, frac: 0.3 },
  ],
  tauHedgeEscape: 20,
  hedgeEscapeAskMax: 0.42,
  escapeAvgSumMax: 0.98,
  tauHedgeEscape2: 12,
  hedgeEscapeAskMax2: 0.45,
  escapeAvgSumMax2: 1.0,
  restingFillModel: 'none',
};

function fee(p, sh) {
  const x = Math.min(0.99, Math.max(0.01, p));
  return FEE * x * (1 - x) * sh;
}

function listEventDirs() {
  const m = new Map();
  for (const s of SERIES) {
    const ed = path.join(s, 'events');
    if (!fs.existsSync(ed)) continue;
    for (const n of fs.readdirSync(ed)) {
      const d = path.join(ed, n);
      if (fs.existsSync(path.join(d, 'ticks.jsonl'))) m.set(n, d);
    }
  }
  return [...m.values()].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function readTicks(dir) {
  return fs
    .readFileSync(path.join(dir, 'ticks.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function tickAsks(t) {
  return {
    UP: t.upAsk != null ? Number(t.upAsk) : t.asks?.UP ?? null,
    DOWN: t.downAsk != null ? Number(t.downAsk) : t.asks?.DOWN ?? null,
    tau: t.tau != null ? Number(t.tau) : null,
    ts: t.ts || null,
  };
}

/** Run engine and return rich finish + event log + fill curve. */
function runEngineRich(ticks, params, slug) {
  const eng = createEventEngine({ ...DEFAULT_PARAMS, ...params }, { slug });
  let last = null;
  for (const t of ticks) {
    eng.onTick(t);
    last = t;
  }
  const r = eng.finish(last);
  const st = eng; // finish already computed; need fills from result
  return r;
}

function lockedCurveFromFills(fills) {
  const inv = { UP: { sh: 0, cost: 0, fees: 0 }, DOWN: { sh: 0, cost: 0, fees: 0 } };
  const curve = [];
  for (const f of fills || []) {
    const side = f.side;
    const px = f.px;
    const sh = f.sh;
    inv[side].sh += sh;
    inv[side].cost += sh * px;
    inv[side].fees += f.fee != null ? f.fee : fee(px, sh);
    const cost = inv.UP.cost + inv.DOWN.cost + inv.UP.fees + inv.DOWN.fees;
    const worst = Math.min(inv.UP.sh - cost, inv.DOWN.sh - cost);
    const bal = Math.min(inv.UP.sh, inv.DOWN.sh);
    const aU = inv.UP.sh ? inv.UP.cost / inv.UP.sh : null;
    const aD = inv.DOWN.sh ? inv.DOWN.cost / inv.DOWN.sh : null;
    curve.push({
      kind: f.kind,
      side,
      px,
      sh,
      residual: Math.abs(inv.UP.sh - inv.DOWN.sh),
      balanced: bal,
      avgSum: aU != null && aD != null ? Math.round((aU + aD) * 1000) / 1000 : null,
      locked: Math.round(worst * 100) / 100,
      lockedPer: bal > 0 ? Math.round((worst / bal) * 10000) / 10000 : null,
      shUP: inv.UP.sh,
      shDN: inv.DOWN.sh,
    });
  }
  return curve;
}

/**
 * Label post-open path using journal asks after first open fill.
 * Returns null if no open.
 */
function labelPath(ticks, openEvent) {
  if (!openEvent) return { label: 'no_open', detail: null };
  const side = openEvent.side;
  const lag = side === 'UP' ? 'DOWN' : 'UP';
  const openPx = openEvent.px;
  const openTs = openEvent.ts;
  const openIdx = ticks.findIndex((t) => t.ts === openTs);
  const start = openIdx >= 0 ? openIdx : 0;
  const window = ticks.slice(start, start + 80).map(tickAsks);

  let lead0 = null;
  let lag0 = null;
  for (const a of window) {
    if (a[side] != null && a[lag] != null) {
      lead0 = a[side];
      lag0 = a[lag];
      break;
    }
  }
  if (lead0 == null) return { label: 'no_book', detail: null };

  // look ahead ~40s of ticks for min lag ask and lead move
  let lagMin = lag0;
  let leadMax = lead0;
  let leadMin = lead0;
  let lagAtLeadMax = lag0;
  for (const a of window) {
    if (a[lag] != null) lagMin = Math.min(lagMin, a[lag]);
    if (a[side] != null) {
      if (a[side] > leadMax) {
        leadMax = a[side];
        lagAtLeadMax = a[lag] ?? lagAtLeadMax;
      }
      leadMin = Math.min(leadMin, a[side]);
    }
  }

  const dLead = leadMax - lead0;
  const dLag = lagMin - lag0;
  const leadCollapse = lead0 - leadMin;

  let label = 'chop';
  if (dLead >= 0.03 && dLag <= -0.03) label = 'favorable'; // favorite strengthens, opp cheapens
  else if (leadCollapse >= 0.05 && lag0 < 0.5) label = 'flip_adverse'; // favorite collapses
  else if (lagMin <= 0.36) label = 'lag_cheap_enough'; // hedgeable even without lead rise
  else if (lagMin > 0.45) label = 'lag_never_cheap'; // stuck territory

  return {
    label,
    detail: {
      side,
      openPx,
      lead0: Math.round(lead0 * 1000) / 1000,
      lag0: Math.round(lag0 * 1000) / 1000,
      leadMax: Math.round(leadMax * 1000) / 1000,
      leadMin: Math.round(leadMin * 1000) / 1000,
      lagMin: Math.round(lagMin * 1000) / 1000,
      dLead: Math.round(dLead * 1000) / 1000,
      dLag: Math.round(dLag * 1000) / 1000,
      leadCollapse: Math.round(leadCollapse * 1000) / 1000,
    },
  };
}

/** Manual policy with M1 momentum + M2 block + miss≠attempt. */
function runManual(ticks, policy) {
  const inv = { UP: { sh: 0, cost: 0, fees: 0 }, DOWN: { sh: 0, cost: 0, fees: 0 } };
  let mode = 'idle';
  let sideOpen = null;
  let openPx = null;
  let openAttempts = 0;
  let momentumBroken = false;
  let momentumOk = false;
  const fills = [];
  const notes = [];
  const levels = [
    { askMax: 0.4, frac: 0.4, filled: 0, target: 0 },
    { askMax: 0.36, frac: 0.3, filled: 0, target: 0 },
    { askMax: 0.32, frac: 0.3, filled: 0, target: 0 },
  ];

  const avg = (s) => (inv[s].sh > 0 ? inv[s].cost / inv[s].sh : null);
  const invested = () => inv.UP.cost + inv.DOWN.cost;
  const avgSum = () => {
    const a = avg('UP');
    const b = avg('DOWN');
    return a != null && b != null ? a + b : null;
  };
  const residualSh = () => Math.abs(inv.UP.sh - inv.DOWN.sh);
  const balanced = () => Math.min(inv.UP.sh, inv.DOWN.sh);
  const worstPnl = () => {
    const c = invested() + inv.UP.fees + inv.DOWN.fees;
    return Math.min(inv.UP.sh - c, inv.DOWN.sh - c);
  };
  const lockedPer = () => {
    const b = balanced();
    return b > 0 ? worstPnl() / b : null;
  };

  function buy(side, px, sh, kind) {
    if (sh <= 0) return 0;
    if (invested() + sh * px > (policy.maxNotional || 50) + 1e-9) return 0;
    inv[side].sh += sh;
    inv[side].cost += sh * px;
    inv[side].fees += fee(px, sh);
    fills.push({ side, px, sh, kind, fee: fee(px, sh) });
    return sh;
  }

  for (const raw of ticks) {
    const a = tickAsks(raw);
    const up = a.UP;
    const dn = a.DOWN;
    const tau = a.tau;
    if (up == null || dn == null || tau == null) continue;

    if (mode === 'idle') {
      if (tau < 40 || tau > 240) continue;
      const chase = up >= dn ? 'UP' : 'DOWN';
      const side = chase;
      const ask = side === 'UP' ? up : dn;
      const other = side === 'UP' ? dn : up;
      if (ask < 0.52 || ask > 0.62 || ask < 0.55) continue;
      if (ask + other < 0.95 || ask + other > 1.05) continue;
      if (policy.softReady && other > 0.48) continue;
      const gap = ask - 0.55;
      if (gap > (policy.openCap || 0.02) + 1e-12) {
        // miss ≠ attempt (M0 fix)
        if (!policy.missCountsAttempt) {
          notes.push({ tau, type: 'miss_cap_free', ask, gap });
          continue;
        }
        openAttempts += 1;
        if (openAttempts >= (policy.maxOpenAttempts || 3)) continue;
        continue;
      }
      if (openAttempts >= (policy.maxOpenAttempts || 3)) continue;
      buy(side, Math.min(ask, 0.55 + (policy.openCap || 0.02)), policy.openShares || SH, 'open');
      sideOpen = side;
      openPx = ask;
      mode = 'opened';
      openAttempts += 1;
      for (const L of levels) L.target = (policy.openShares || SH) * L.frac;
      notes.push({ tau, type: 'open', side, ask, other });
      continue;
    }

    if (mode !== 'opened' && mode !== 'momentum_wait') continue;

    const lead = sideOpen;
    const lag = lead === 'UP' ? 'DOWN' : 'UP';
    const askLead = lead === 'UP' ? up : dn;
    const askLag = lag === 'UP' ? up : dn;

    // M1 momentum
    if (policy.momentum && openPx != null && askLead != null) {
      if (askLead <= openPx - (policy.momentumBreakDelta || 0.04)) {
        if (!momentumBroken) notes.push({ tau, type: 'momentum_broken', askLead, openPx });
        momentumBroken = true;
      }
      if (askLead >= openPx + (policy.momentumOkDelta || 0.03) && askLag != null && askLag <= 0.42) {
        momentumOk = true;
      }
    }

    let rem = inv[lead].sh - inv[lag].sh;
    if (rem <= 1e-9) {
      mode = 'done';
      continue;
    }

    // Comfort: only if residual small
    const lp = lockedPer();
    if (
      policy.comfortStop != null &&
      residualSh() <= (policy.comfortMaxResidual || 2) &&
      balanced() >= (policy.comfortMinBal || 5) &&
      lp != null &&
      lp >= policy.comfortStop
    ) {
      notes.push({ tau, type: 'comfort_stop', lp, residual: residualSh() });
      mode = 'comfort';
      continue;
    }

    // Clips — skip optimistic deep clips if momentum broken (still allow escape later)
    // Patience: hold until lag ask ≤ patientLagMax before first clip
    const anyClipped = levels.some((L) => L.filled > 0);
    if (policy.patientLagMax != null && !anyClipped && askLag > policy.patientLagMax + 1e-12) {
      // wait — except late escape windows handled below
    } else if (!(policy.momentum && momentumBroken && policy.freezeClipsOnBreak)) {
      for (const L of levels) {
        const need = L.target - L.filled;
        if (need <= 1e-9 || rem <= 1e-9) continue;
        if (askLag > L.askMax + 1e-12) continue;
        const sh = Math.min(need, rem);
        const aOpen = avg(lead);
        const newAvgL = (inv[lag].cost + sh * askLag) / (inv[lag].sh + sh);
        const proj = aOpen + newAvgL;
        if (proj > (policy.avgSumMax || 0.94) + 1e-12) continue;
        if (policy.requireImproveLocked) {
          const w0 = worstPnl();
          // projected worst after buy
          const costAdd = sh * askLag + fee(askLag, sh);
          const cost = invested() + inv.UP.fees + inv.DOWN.fees + costAdd;
          const shU = inv.UP.sh + (lag === 'UP' ? sh : 0);
          const shD = inv.DOWN.sh + (lag === 'DOWN' ? sh : 0);
          const w1 = Math.min(shU - cost, shD - cost);
          if (w1 + 1e-9 < w0) continue;
        }
        buy(lag, askLag, sh, 'clip');
        L.filled += sh;
        rem -= sh;
      }
    }

    rem = inv[lead].sh - inv[lag].sh;
    if (rem <= 1e-9) {
      mode = 'done';
      continue;
    }

    // M2 BLOCO27-light: one residual fill at blockAsk
    if (
      policy.blockAsk != null &&
      tau <= (policy.blockTauMax || 60) &&
      tau >= (policy.blockTauMin || 20) &&
      askLag <= policy.blockAsk + 1e-12 &&
      rem >= (policy.blockMinSh || 1)
    ) {
      const aOpen = avg(lead);
      const newAvgL = (inv[lag].cost + rem * askLag) / (inv[lag].sh + rem);
      const proj = aOpen + newAvgL;
      if (proj <= (policy.blockCeil || 0.97) + 1e-12) {
        buy(lag, askLag, rem, 'block27');
        notes.push({ tau, type: 'block27', askLag, rem, proj });
        mode = 'done';
        continue;
      }
    }

    // Escape
    rem = inv[lead].sh - inv[lag].sh;
    if (rem > 1e-9 && tau <= 20 && askLag <= 0.42) {
      const aOpen = avg(lead);
      const newAvgL = (inv[lag].cost + rem * askLag) / (inv[lag].sh + rem);
      const proj = aOpen + newAvgL;
      const ceil = momentumBroken ? policy.escapeCeilBroken || 0.96 : policy.escapeAvg || 0.98;
      if (proj <= ceil + 1e-12) {
        buy(lag, askLag, rem, 'escape');
        notes.push({ tau, type: 'escape', askLag, rem, proj, momentumBroken });
        mode = 'done';
      }
    }
    if (rem > 1e-9 && tau <= 12 && askLag <= 0.45) {
      const aOpen = avg(lead);
      const newAvgL = (inv[lag].cost + rem * askLag) / (inv[lag].sh + rem);
      const proj = aOpen + newAvgL;
      if (proj <= 1.0 + 1e-12) {
        buy(lag, askLag, rem, 'escape2');
        notes.push({ tau, type: 'escape2', askLag, rem, proj });
        mode = 'done';
      }
    }
  }

  const as = avgSum();
  const res = residualSh();
  const wp = worstPnl();
  return {
    mode,
    sideOpen,
    fills: fills.length,
    clips: fills.filter((f) => f.kind === 'clip').length,
    blocks27: fills.filter((f) => f.kind === 'block27').length,
    escapes: fills.filter((f) => f.kind.startsWith('escape')).length,
    avgSum: as != null ? Math.round(as * 1000) / 1000 : null,
    residual: Math.round(res * 1000) / 1000,
    invested: Math.round(invested() * 100) / 100,
    worstPnl: Math.round(wp * 100) / 100,
    lockedPer: lockedPer() != null ? Math.round(lockedPer() * 10000) / 10000 : null,
    momentumBroken,
    momentumOk,
    pnl:
      res < 1e-6 && as != null
        ? Math.round((balanced() * (1 - as) - (inv.UP.fees + inv.DOWN.fees)) * 1000) / 1000
        : wp,
    curve: lockedCurveFromFills(fills),
    notes: notes.slice(0, 30),
  };
}

function monteCarlo(n = 200) {
  const policies = [
    { name: 'base_deep3', missCountsAttempt: false, openCap: 0.02, openShares: SH },
    {
      name: 'm1_momentum',
      missCountsAttempt: false,
      openCap: 0.02,
      openShares: SH,
      momentum: true,
      momentumBreakDelta: 0.04,
      freezeClipsOnBreak: true,
      escapeCeilBroken: 0.95,
    },
    {
      name: 'm2_block27',
      missCountsAttempt: false,
      openCap: 0.02,
      openShares: SH,
      blockAsk: 0.3,
      blockTauMax: 80,
      blockTauMin: 15,
      blockCeil: 0.97,
    },
    {
      name: 'm1_m2',
      missCountsAttempt: false,
      openCap: 0.02,
      openShares: SH,
      momentum: true,
      momentumBreakDelta: 0.04,
      freezeClipsOnBreak: true,
      escapeCeilBroken: 0.95,
      blockAsk: 0.3,
      blockTauMax: 80,
      blockTauMin: 15,
      blockCeil: 0.97,
      requireImproveLocked: true,
    },
    {
      name: 'soft_ready',
      missCountsAttempt: false,
      openCap: 0.02,
      openShares: SH,
      softReady: true,
    },
    {
      name: 'patient_36',
      missCountsAttempt: false,
      openCap: 0.02,
      openShares: SH,
      patientLagMax: 0.36,
    },
  ];

  const regimes = ['favorable', 'flip_adverse', 'chop', 'late_cheap', 'mixed'];
  function synth(kind, seed) {
    const ticks = [];
    let up = 0.55;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 130; i++) {
      const tau = 250 - i * 2;
      if (tau < 0) break;
      const noise = (rnd() - 0.5) * 0.02;
      if (kind === 'favorable' || (kind === 'mixed' && seed % 3 === 0)) {
        up = Math.min(0.9, up + 0.003 + noise);
      } else if (kind === 'flip_adverse' || (kind === 'mixed' && seed % 3 === 1)) {
        if (i < 12 + (seed % 8)) up = 0.55 + i * 0.002 + noise;
        else up = Math.max(0.1, up - 0.01 + noise);
      } else if (kind === 'late_cheap') {
        if (i < 60) up = Math.min(0.75, 0.56 + i * 0.0025 + noise);
        else up = Math.max(0.25, up - 0.018 + noise);
      } else {
        up = 0.55 + 0.07 * Math.sin(i / 3 + seed) + noise;
      }
      up = Math.min(0.97, Math.max(0.03, up));
      let dn = Math.min(0.97, Math.max(0.03, 1 - up + (rnd() - 0.5) * 0.01));
      const s = up + dn;
      ticks.push({
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        tau,
        upAsk: Math.round((up / s) * 100) / 100,
        downAsk: Math.round((dn / s) * 100) / 100,
      });
    }
    return ticks;
  }

  const summary = {};
  for (const p of policies) summary[p.name] = { n: 0, pnl: 0, stuck: 0, eq: 0, idle: 0, worstSum: 0 };

  for (let i = 0; i < n; i++) {
    const regime = regimes[i % regimes.length];
    const ticks = synth(regime, 1000 + i * 97);
    for (const p of policies) {
      const r = runManual(ticks, p);
      const s = summary[p.name];
      s.n += 1;
      s.pnl += r.pnl || 0;
      s.worstSum += r.worstPnl || 0;
      if ((r.residual || 0) >= 1) s.stuck += 1;
      else if (r.fills >= 2 && (r.residual || 0) < 1) s.eq += 1;
      else if (r.fills === 0) s.idle += 1;
    }
  }

  return Object.entries(summary).map(([name, s]) => ({
    name,
    n: s.n,
    pnl: Math.round(s.pnl * 100) / 100,
    pnlAvg: Math.round((s.pnl / s.n) * 1000) / 1000,
    stuck: s.stuck,
    stuckRate: Math.round((s.stuck / s.n) * 1000) / 10,
    eq: s.eq,
    eqRate: Math.round((s.eq / s.n) * 1000) / 10,
    idle: s.idle,
    worstAvg: Math.round((s.worstSum / s.n) * 1000) / 1000,
  }));
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dirs = listEventDirs();
  console.log(`=== Compensation study v2 === events=${dirs.length}`);

  const eventRows = [];
  const labelCounts = {};
  const curvesByLabel = {};

  for (const dir of dirs) {
    const slug = path.basename(dir);
    const ticks = readTicks(dir);
    const eng = createEventEngine({ ...DEFAULT_PARAMS, ...DEEP3 }, { slug });
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    const r = eng.finish(last);
    const openEv = (r.fills || []).find((f) => f.kind === 'open') || null;
    // engine finish may not expose fills with kind — check events via re-run collecting
    // Actually finish returns fills array - check structure
    const fills = r.fills || [];
    const openFill = fills.find((f) => f.kind === 'open');
    const labeled = labelPath(ticks, openFill);
    labelCounts[labeled.label] = (labelCounts[labeled.label] || 0) + 1;

    const curve = lockedCurveFromFills(fills);
    if (!curvesByLabel[labeled.label]) curvesByLabel[labeled.label] = [];
    if (curve.length) curvesByLabel[labeled.label].push({ slug, curve });

    // Manual policy suite on this event
    const manuals = {
      base: runManual(ticks, { missCountsAttempt: false, openCap: 0.02, openShares: SH }),
      miss_counts: runManual(ticks, { missCountsAttempt: true, openCap: 0.02, openShares: SH, maxOpenAttempts: 3 }),
      m1: runManual(ticks, {
        missCountsAttempt: false,
        openCap: 0.02,
        openShares: SH,
        momentum: true,
        freezeClipsOnBreak: true,
        momentumBreakDelta: 0.04,
      }),
      m2: runManual(ticks, {
        missCountsAttempt: false,
        openCap: 0.02,
        openShares: SH,
        blockAsk: 0.3,
        blockCeil: 0.97,
      }),
      m1m2: runManual(ticks, {
        missCountsAttempt: false,
        openCap: 0.02,
        openShares: SH,
        momentum: true,
        freezeClipsOnBreak: true,
        blockAsk: 0.3,
        blockCeil: 0.97,
        requireImproveLocked: true,
      }),
      soft: runManual(ticks, { missCountsAttempt: false, softReady: true, openCap: 0.02, openShares: SH }),
      /** Patience: wait for lag ≤ 0.36 before first clip (no freeze on lead dip). */
      patient: runManual(ticks, {
        missCountsAttempt: false,
        openCap: 0.02,
        openShares: SH,
        patientLagMax: 0.36,
      }),
    };

    eventRows.push({
      slug,
      engine: {
        mode: r.mode,
        fills: r.nFills,
        avgSum: r.avgSum,
        pnl: r.pnl ?? 0,
        residual: r.residual?.shares || 0,
        worst: r.worstPnl,
        lockedPer: r.lockedPnlPerShare,
        clips: r.nHedgeClips || 0,
      },
      pathLabel: labeled.label,
      pathDetail: labeled.detail,
      curve,
      manuals: Object.fromEntries(
        Object.entries(manuals).map(([k, v]) => [
          k,
          {
            mode: v.mode,
            fills: v.fills,
            avgSum: v.avgSum,
            pnl: v.pnl,
            residual: v.residual,
            worstPnl: v.worstPnl,
            clips: v.clips,
            blocks27: v.blocks27,
            escapes: v.escapes,
            momentumBroken: v.momentumBroken,
          },
        ]),
      ),
    });
  }

  // Aggregate manuals
  const manualNames = ['base', 'miss_counts', 'm1', 'm2', 'm1m2', 'soft', 'patient'];
  const manualAgg = {};
  for (const name of manualNames) {
    const rows = eventRows.map((e) => e.manuals[name]);
    manualAgg[name] = {
      pnl: Math.round(rows.reduce((a, r) => a + (r.pnl || 0), 0) * 1000) / 1000,
      eq: rows.filter((r) => r.fills >= 2 && r.residual < 1).length,
      stuck: rows.filter((r) => r.residual >= 1).length,
      idle: rows.filter((r) => r.fills === 0).length,
      avgMed:
        rows
          .filter((r) => r.avgSum != null && r.residual < 1)
          .map((r) => r.avgSum)
          .sort((a, b) => a - b)[Math.floor(rows.filter((r) => r.avgSum != null && r.residual < 1).length / 2)] ??
        null,
      worst: Math.min(...rows.map((r) => r.worstPnl ?? 0)),
      block27Hits: rows.reduce((a, r) => a + (r.blocks27 || 0), 0),
      momentumBreaks: rows.filter((r) => r.momentumBroken).length,
    };
  }

  // Engine by path label
  const byLabel = {};
  for (const e of eventRows) {
    if (!byLabel[e.pathLabel]) byLabel[e.pathLabel] = { n: 0, pnl: 0, stuck: 0, eq: 0 };
    const b = byLabel[e.pathLabel];
    b.n += 1;
    b.pnl += e.engine.pnl || 0;
    if (e.engine.residual >= 1) b.stuck += 1;
    if (e.engine.fills >= 2 && e.engine.residual < 1) b.eq += 1;
  }
  for (const k of Object.keys(byLabel)) {
    byLabel[k].pnl = Math.round(byLabel[k].pnl * 1000) / 1000;
  }

  // When does locked turn positive? (among EQ trades)
  const lockTurnPositive = [];
  for (const e of eventRows) {
    if (!e.curve.length || e.engine.residual >= 1) continue;
    const idx = e.curve.findIndex((c) => c.locked != null && c.locked >= 0);
    if (idx >= 0) {
      lockTurnPositive.push({
        slug: e.slug,
        label: e.pathLabel,
        fillIndex: idx,
        kind: e.curve[idx].kind,
        residualAtFlip: e.curve[idx].residual,
        avgSumAtFlip: e.curve[idx].avgSum,
        lockedAtFlip: e.curve[idx].locked,
        nFills: e.curve.length,
      });
    }
  }

  // Residual vs locked correlation points (all curve steps)
  const scatter = [];
  for (const e of eventRows) {
    for (const c of e.curve) {
      scatter.push({
        residual: c.residual,
        locked: c.locked,
        avgSum: c.avgSum,
        label: e.pathLabel,
      });
    }
  }

  // Break-even residual: at which residual is locked still negative on average for avgSum~0.93
  const residualBuckets = {};
  for (const p of scatter) {
    const b = Math.round(p.residual);
    if (!residualBuckets[b]) residualBuckets[b] = { n: 0, lockedSum: 0 };
    residualBuckets[b].n += 1;
    residualBuckets[b].lockedSum += p.locked || 0;
  }
  const residualProfile = Object.keys(residualBuckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((b) => ({
      residual: b,
      n: residualBuckets[b].n,
      lockedAvg: Math.round((residualBuckets[b].lockedSum / residualBuckets[b].n) * 100) / 100,
    }));

  const mc = monteCarlo(250);

  // Theoretical: open @ p, clip remaining at q → when locked >= 0
  const theory = [];
  for (const openPx of [0.55, 0.56, 0.57, 0.58]) {
    for (const hedgePx of [0.3, 0.32, 0.36, 0.4, 0.42, 0.45]) {
      for (const frac of [0.4, 0.7, 1.0]) {
        const sh = SH;
        const hSh = sh * frac;
        const cost =
          sh * openPx +
          hSh * hedgePx +
          fee(openPx, sh) +
          fee(hedgePx, hSh);
        const locked = Math.min(sh, hSh) - cost; // if hSh < sh, worst is hSh - cost when open loses... 
        // correct worst:
        const shLead = sh;
        const shLag = hSh;
        const worst = Math.min(shLead - cost, shLag - cost);
        const avgSum = hSh >= sh ? openPx + hedgePx : null;
        theory.push({
          openPx,
          hedgePx,
          fracHedged: frac,
          residual: sh - hSh,
          worst: Math.round(worst * 100) / 100,
          avgSum: avgSum != null ? Math.round(avgSum * 1000) / 1000 : null,
          positive: worst >= 0,
        });
      }
    }
  }
  const theoryComfort = theory.filter((t) => t.positive);

  const report = {
    generatedAt: new Date().toISOString(),
    events: dirs.length,
    openShares: SH,
    labelCounts,
    byLabel,
    manualAgg,
    lockTurnPositive,
    residualProfile,
    monteCarlo: mc,
    theory: {
      nPositive: theoryComfort.length,
      nTotal: theory.length,
      earliestFracForPos: theoryComfort.reduce((m, t) => Math.min(m, t.fracHedged), 9),
      samples: theoryComfort.slice(0, 20),
      note: 'worst>=0 almost never with partial hedge; needs near-full EQ at cheap hedge',
    },
    events: eventRows.map(({ curve, manuals, ...rest }) => ({
      ...rest,
      curveTail: curve.slice(-4),
      manuals,
    })),
    findings: [],
  };

  // Auto findings
  const findings = [];
  findings.push(
    `Path labels: ${Object.entries(labelCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  const fav = byLabel.favorable;
  const flip = byLabel.flip_adverse || byLabel.lag_never_cheap;
  if (fav) findings.push(`favorable: n=${fav.n} pnl=${fav.pnl} eq=${fav.eq} stuck=${fav.stuck}`);
  if (byLabel.lag_never_cheap)
    findings.push(
      `lag_never_cheap: n=${byLabel.lag_never_cheap.n} pnl=${byLabel.lag_never_cheap.pnl} stuck=${byLabel.lag_never_cheap.stuck}`,
    );
  findings.push(
    `Locked turns ≥0 at fillIndex median ${
      lockTurnPositive.length
        ? lockTurnPositive.map((x) => x.fillIndex).sort((a, b) => a - b)[
            Math.floor(lockTurnPositive.length / 2)
          ]
        : 'n/a'
    } (almost always last fill / full EQ)`,
  );
  findings.push(
    `Manual journals: base=${manualAgg.base.pnl} m1=${manualAgg.m1.pnl} patient=${manualAgg.patient?.pnl} m2=${manualAgg.m2.pnl} soft=${manualAgg.soft.pnl}`,
  );
  findings.push(
    `NOTE: m1>base on journals is mostly PATIENCE artifact (lead dip freezes early clips → later cheaper fills on favorable paths). MC shows m1 worse stuck/pnl — do not ship freeze-on-dip alone.`,
  );
  const mcBest = [...mc].sort((a, b) => b.pnl - a.pnl)[0];
  findings.push(
    `MonteCarlo250 best=${mcBest?.name} pnl=${mcBest?.pnl} stuckRate=${mcBest?.stuckRate}% eqRate=${mcBest?.eqRate}%`,
  );
  findings.push(
    `Theory: partial hedge (frac<1) almost never locked≥0 — comfort-stop mid-path is unsafe; only near EQ`,
  );
  report.findings = findings;

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  // Markdown summary
  const md = [
    '# Compensation study v2',
    '',
    `Generated: ${report.generatedAt}`,
    `Events: ${dirs.length} · openShares=${SH}`,
    '',
    '## Findings',
    '',
    ...findings.map((f) => `- ${f}`),
    '',
    '## Path labels (engine deep3)',
    '',
    '| label | n | pnl | eq | stuck |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(byLabel).map(
      ([k, v]) => `| ${k} | ${v.n} | ${v.pnl} | ${v.eq} | ${v.stuck} |`,
    ),
    '',
    '## Manual policies on journals',
    '',
    '| policy | pnl | eq | stuck | idle | worst | block27 | momBreaks |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(manualAgg).map(
      ([k, v]) =>
        `| ${k} | ${v.pnl} | ${v.eq} | ${v.stuck} | ${v.idle} | ${v.worst} | ${v.block27Hits} | ${v.momentumBreaks} |`,
    ),
    '',
    '## Residual → locked avg (curve steps)',
    '',
    '| residual | n | lockedAvg |',
    '|---:|---:|---:|',
    ...residualProfile.map((r) => `| ${r.residual} | ${r.n} | ${r.lockedAvg} |`),
    '',
    '## Monte Carlo (250 paths)',
    '',
    '| policy | pnl | stuck% | eq% | idle | worstAvg |',
    '|---|---:|---:|---:|---:|---:|',
    ...mc.map(
      (m) =>
        `| ${m.name} | ${m.pnl} | ${m.stuckRate} | ${m.eqRate} | ${m.idle} | ${m.worstAvg} |`,
    ),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'STUDY2.md'), md);

  console.log('\nFindings:');
  for (const f of findings) console.log(' -', f);
  console.log('\nManual agg:');
  for (const [k, v] of Object.entries(manualAgg)) {
    console.log(
      `  ${k.padEnd(12)} pnl=${String(v.pnl).padStart(7)} eq=${v.eq} stuck=${v.stuck} idle=${v.idle} worst=${v.worst}`,
    );
  }
  console.log('\nMonteCarlo:');
  for (const m of mc) {
    console.log(
      `  ${m.name.padEnd(14)} pnl=${String(m.pnl).padStart(8)} stuck%=${m.stuckRate} eq%=${m.eqRate}`,
    );
  }
  console.log('\nsaved', path.join(OUT, 'report.json'));
  console.log('saved', path.join(OUT, 'STUDY2.md'));
}

main();
