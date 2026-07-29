/**
 * Compensation / path-regime lab for Clip-Path.
 *
 * Models "top" (open/chase) vs "bottom" (hedge clips) dynamics and policies
 * that keep favorable imbalance or exit when locked PnL is comfortable.
 *
 *   node labs/sandbox/pair-path-v0/compensation-path-lab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const OUT = path.join(ROOT, '.tmp/clip-path-compensation-lab');

const FEE = 0.07;
const SH = 10;

function fee(p, sh) {
  const x = Math.min(0.99, Math.max(0.01, p));
  return FEE * x * (1 - x) * sh;
}

/** Synthetic UP ask path; DOWN ≈ 1 - UP + noise clipped. */
function synthPath(kind, n = 120) {
  const ticks = [];
  let up = 0.55;
  for (let i = 0; i < n; i++) {
    const tau = 240 - i * 2;
    if (tau < 0) break;
    if (kind === 'favorable') {
      // favorite strengthens → opposite cheapens (hedge heaven)
      up = Math.min(0.92, up + 0.0035 + (i % 7 === 0 ? 0.01 : 0));
    } else if (kind === 'flip_adverse') {
      // looks openable then flips against open side
      if (i < 15) up = 0.55 + i * 0.002;
      else up = Math.max(0.08, up - 0.012);
    } else if (kind === 'chop') {
      up = 0.55 + 0.08 * Math.sin(i / 4);
    } else if (kind === 'late_cheap') {
      // stays expensive hedge until late, then dumps
      if (i < 70) up = Math.min(0.78, 0.56 + i * 0.003);
      else up = Math.max(0.3, up - 0.02);
    } else if (kind === 'open_miss') {
      // always too far above trigger+cap
      up = 0.61 + 0.02 * Math.sin(i / 5);
    } else if (kind === 'dry_success') {
      // mirrors …6400: DN favorite ~0.57 then UP dumps to 0.36/0.32
      if (i < 8) up = 0.44 - i * 0.005; // UP cheap, DN chase ~0.56
      else if (i < 20) up = 0.36;
      else up = Math.max(0.28, 0.36 - (i - 20) * 0.004);
    } else if (kind === 'dry_stuck') {
      // mirrors stuck UP@0.56 then DN vanishes/expensive
      if (i < 10) up = 0.55 + i * 0.001;
      else up = Math.min(0.95, up + 0.008);
    }
    up = Math.min(0.98, Math.max(0.02, up));
    const dn = Math.min(0.98, Math.max(0.02, 1 - up + ((i % 3) - 1) * 0.005));
    // normalize soft sum ~1
    const s = up + dn;
    const upN = up / s;
    const dnN = dn / s;
    ticks.push({
      ts: new Date(Date.UTC(2026, 6, 29, 3, 0, i)).toISOString(),
      tau,
      asks: { UP: Math.round(upN * 100) / 100, DOWN: Math.round(dnN * 100) / 100 },
    });
  }
  return ticks;
}

const DEEP3 = {
  openShares: SH,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTriggerCents: 55,
  openCapCents: 3,
  maxOpenAttempts: 8, // don't starve on miss
  tauOpenMin: 40,
  tauOpenMax: 240,
  hedgeAskMax: 0.4,
  avgSumMax: 0.94,
  feeRate: FEE,
  maxEventNotional: 20,
  maxHedgeAttempts: 12,
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

/** Soft: only open if opposite already ≤ 0.48 (clipable zone), no pair≤1. */
const SOFT_READY = {
  ...DEEP3,
  openRequireHedgeReady: true,
  openHedgeSlackCents: 8, // 40+8=48¢
  openPairSumMaxAtOpen: 1.05, // NOT 1.0 — avoid OPEN_PAIR_NOT_CHEAP death
};

/** Comfort: escape only if locked pnl/share stays ≥ 0.02 after fill. */
const COMFORT_ESC = {
  ...DEEP3,
  escapeMinLockedPnlPerShare: 0.02,
  escapeMinLockedPnlPerShare2: 0.0,
  escapeAvgSumMax: 0.96,
  escapeAvgSumMax2: 0.99,
};

/** Tight clips only — no escape (refuse bad EQ). */
const NO_ESCAPE = {
  ...DEEP3,
  tauHedgeEscape: null,
  tauHedgeEscape2: null,
};

/** Fade open (buy underdog) — opposite thesis. */
const FADE = { ...DEEP3, legChoice: 'fade' };

/**
 * Manual policy simulator: after open, decide clip / comfort-stop / top-add.
 * "Top compensation": if opposite is cheap AND residual large, optionally
 * skip deepening and lock partial if locked PnL already comfortable.
 */
function runManualPolicy(ticks, policy) {
  const inv = { UP: { sh: 0, cost: 0, fees: 0 }, DOWN: { sh: 0, cost: 0, fees: 0 } };
  let mode = 'idle';
  let sideOpen = null;
  let openAttempts = 0;
  const fills = [];
  const decisions = [];
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
  const residual = () => Math.abs(inv.UP.sh - inv.DOWN.sh);
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
    inv[side].sh += sh;
    inv[side].cost += sh * px;
    inv[side].fees += fee(px, sh);
    fills.push({ side, px, sh, kind });
    return sh;
  }

  for (const t of ticks) {
    const up = t.asks.UP;
    const dn = t.asks.DOWN;
    const tau = t.tau;
    if (mode === 'idle') {
      if (tau < 40 || tau > 240) continue;
      const chase = up >= dn ? 'UP' : 'DOWN';
      const fade = chase === 'UP' ? 'DOWN' : 'UP';
      const side = policy.openStyle === 'fade' ? fade : chase;
      const ask = side === 'UP' ? up : dn;
      const other = side === 'UP' ? dn : up;
      if (ask < 0.52 || ask > 0.62 || ask < 0.55) continue;
      if (ask + other < 0.95 || ask + other > 1.05) continue;
      if (policy.softReady && other > 0.48) {
        decisions.push({ tau, type: 'skip_not_ready', ask, other });
        continue;
      }
      const gap = ask - 0.55;
      if (gap > 0.03) {
        openAttempts += 1;
        if (openAttempts >= 8) continue;
        decisions.push({ tau, type: 'miss_cap', ask, gap });
        continue;
      }
      buy(side, ask, SH, 'open');
      sideOpen = side;
      mode = 'opened';
      for (const L of levels) L.target = SH * L.frac;
      decisions.push({ tau, type: 'open', side, ask, other });
      continue;
    }

    if (mode !== 'opened') continue;
    const hedgeSide = sideOpen === 'UP' ? 'DOWN' : 'UP';
    const askH = hedgeSide === 'UP' ? up : dn;
    if (askH == null) continue;
    let rem = inv[sideOpen].sh - inv[hedgeSide].sh;
    if (rem <= 1e-9) {
      mode = 'done';
      continue;
    }

    // Comfort lock: if balanced portion already pays ≥ comfort $/sh, stop
    // chasing expensive residual (leave residual OR escape only if improves).
    const lp = lockedPer();
    if (
      policy.comfortStop != null &&
      balanced() >= policy.comfortMinBalanced &&
      lp != null &&
      lp >= policy.comfortStop
    ) {
      decisions.push({
        tau,
        type: 'comfort_stop',
        lockedPer: lp,
        avgSum: avgSum(),
        residual: rem,
        balanced: balanced(),
      });
      mode = 'comfort';
      continue;
    }

    // Favorable imbalance rule (Phil DESC_SO_ATRAS analog):
    // only buy bottom when it IMPROVES projected avgSum OR is below next clip.
    for (const L of levels) {
      const need = L.target - L.filled;
      if (need <= 1e-9 || rem <= 1e-9) continue;
      if (askH > L.askMax + 1e-12) continue;
      const sh = Math.min(need, rem);
      const aOpen = avg(sideOpen);
      const newAvgH =
        (inv[hedgeSide].cost + sh * askH) / (inv[hedgeSide].sh + sh);
      const proj = aOpen + newAvgH;
      if (proj > (policy.avgSumMax ?? 0.94) + 1e-12) {
        decisions.push({ tau, type: 'refuse_avg', proj, askH, sh });
        continue;
      }
      // "always favorable": require proj strictly better than current avgSum if any
      const cur = avgSum();
      if (policy.requireImprove && cur != null && proj > cur - 1e-12) {
        decisions.push({ tau, type: 'refuse_no_improve', proj, cur });
        continue;
      }
      buy(hedgeSide, askH, sh, 'clip');
      L.filled += sh;
      rem -= sh;
      decisions.push({ tau, type: 'clip', askH, sh, askMax: L.askMax, proj, lockedPer: lockedPer() });
    }

    rem = inv[sideOpen].sh - inv[hedgeSide].sh;
    if (rem <= 1e-9) {
      mode = 'done';
      continue;
    }

    // Late escape with order: buy bottom only (never top-add)
    if (tau <= 20 && askH <= 0.42) {
      const aOpen = avg(sideOpen);
      const newAvgH =
        (inv[hedgeSide].cost + rem * askH) / (inv[hedgeSide].sh + rem);
      const proj = aOpen + newAvgH;
      if (proj <= (policy.escapeAvg ?? 0.98)) {
        buy(hedgeSide, askH, rem, 'escape');
        decisions.push({ tau, type: 'escape', askH, rem, proj });
        mode = 'done';
      }
    }
  }

  const as = avgSum();
  const res = residual();
  const wp = worstPnl();
  return {
    policy: policy.name,
    mode,
    sideOpen,
    fills: fills.length,
    clips: fills.filter((f) => f.kind === 'clip').length,
    avgSum: as != null ? Math.round(as * 1000) / 1000 : null,
    residual: res,
    invested: Math.round(invested() * 100) / 100,
    worstPnl: Math.round(wp * 100) / 100,
    lockedPer: lockedPer() != null ? Math.round(lockedPer() * 10000) / 10000 : null,
    pnlIfEq: as != null ? Math.round((balanced() * (1 - as) - (inv.UP.fees + inv.DOWN.fees)) * 100) / 100 : null,
    decisions: decisions.slice(0, 40),
    decisionTypes: decisions.reduce((m, d) => {
      m[d.type] = (m[d.type] || 0) + 1;
      return m;
    }, {}),
  };
}

function runEngine(ticks, params, name) {
  const eng = createEventEngine({ ...DEFAULT_PARAMS, ...params }, { slug: name });
  let last = null;
  for (const t of ticks) {
    eng.onTick({
      ts: t.ts,
      tau: t.tau,
      asks: t.asks,
      upAsk: t.asks.UP,
      downAsk: t.asks.DOWN,
    });
    last = t;
  }
  const r = eng.finish(last);
  return {
    policy: name,
    mode: r.mode,
    fills: r.nFills,
    clips: r.nHedgeClips || 0,
    avgSum: r.avgSum,
    residual: r.residual?.shares || 0,
    invested: Math.round((r.invested || 0) * 100) / 100,
    worstPnl: r.worstPnl,
    lockedPer: r.lockedPnlPerShare,
    pnl: r.pnl,
    blocks: r.blockCounts,
  };
}

function replayJournals(params, name) {
  const SERIES = [
    '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
    '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
    '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
  ].map((p) => path.join(ROOT, p));

  const dirs = [];
  for (const s of SERIES) {
    const ed = path.join(s, 'events');
    if (!fs.existsSync(ed)) continue;
    for (const n of fs.readdirSync(ed)) {
      const d = path.join(ed, n);
      if (fs.existsSync(path.join(d, 'ticks.jsonl'))) dirs.push(d);
    }
  }

  const rows = [];
  for (const dir of dirs) {
    const ticks = fs
      .readFileSync(path.join(dir, 'ticks.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const eng = createEventEngine({ ...DEFAULT_PARAMS, ...params }, { slug: path.basename(dir) });
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    const r = eng.finish(last);
    rows.push({
      slug: path.basename(dir),
      mode: r.mode,
      fills: r.nFills,
      avgSum: r.avgSum,
      pnl: r.pnl ?? 0,
      residual: r.residual?.shares || 0,
      worst: r.worstPnl,
      lockedPer: r.lockedPnlPerShare,
    });
  }
  const traded = rows.filter((r) => r.fills > 0);
  const eq = rows.filter((r) => r.fills >= 2 && r.residual < 1e-6);
  const stuck = rows.filter((r) => r.residual >= 1);
  return {
    policy: name,
    n: rows.length,
    traded: traded.length,
    equalized: eq.length,
    stuck: stuck.length,
    pnl: Math.round(rows.reduce((a, r) => a + r.pnl, 0) * 1000) / 1000,
    avgMed:
      eq.map((r) => r.avgSum).filter((x) => x != null).sort((a, b) => a - b)[
        Math.floor(eq.length / 2)
      ] ?? null,
    residualMax: Math.max(0, ...rows.map((r) => r.residual)),
    worst: Math.min(...rows.map((r) => r.worst)),
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const regimes = [
    'favorable',
    'flip_adverse',
    'chop',
    'late_cheap',
    'open_miss',
    'dry_success',
    'dry_stuck',
  ];

  const enginePolicies = [
    ['engine_deep3', DEEP3],
    ['engine_soft_ready', SOFT_READY],
    ['engine_comfort_esc', COMFORT_ESC],
    ['engine_no_escape', NO_ESCAPE],
    ['engine_fade', FADE],
  ];

  const manualPolicies = [
    {
      name: 'manual_deep3',
      openStyle: 'chase',
      softReady: false,
      comfortStop: null,
      comfortMinBalanced: 0,
      requireImprove: false,
      avgSumMax: 0.94,
      escapeAvg: 0.98,
    },
    {
      name: 'manual_soft_ready',
      openStyle: 'chase',
      softReady: true,
      comfortStop: null,
      comfortMinBalanced: 0,
      requireImprove: false,
      avgSumMax: 0.94,
      escapeAvg: 0.98,
    },
    {
      name: 'manual_comfort_lock',
      openStyle: 'chase',
      softReady: false,
      comfortStop: 0.04, // $0.04 / balanced share ≈ avgSum≲0.96 after fees
      comfortMinBalanced: 4,
      requireImprove: false,
      avgSumMax: 0.94,
      escapeAvg: 0.98,
    },
    {
      name: 'manual_improve_only',
      openStyle: 'chase',
      softReady: true,
      comfortStop: 0.03,
      comfortMinBalanced: 3,
      requireImprove: true,
      avgSumMax: 0.94,
      escapeAvg: 0.97,
    },
  ];

  const synthMatrix = [];
  for (const regime of regimes) {
    const ticks = synthPath(regime);
    for (const [name, params] of enginePolicies) {
      synthMatrix.push({ regime, ...runEngine(ticks, params, name) });
    }
    for (const pol of manualPolicies) {
      synthMatrix.push({ regime, ...runManualPolicy(ticks, pol) });
    }
  }

  // Journal A/B of compensation variants
  const journal = enginePolicies.map(([name, params]) => replayJournals(params, name));

  // Narrative math on real dry fills
  const drySuccess = {
    open: { side: 'DOWN', px: 0.57, sh: 10 },
    clips: [
      { side: 'UP', px: 0.36, sh: 4 },
      { side: 'UP', px: 0.36, sh: 3 },
      { side: 'UP', px: 0.32, sh: 3 },
    ],
  };
  const dryStuck = {
    open: { side: 'UP', px: 0.56, sh: 10 },
    clips: [],
  };

  function pathAccounting(label, pathSpec) {
    const inv = { UP: { sh: 0, cost: 0, fees: 0 }, DOWN: { sh: 0, cost: 0, fees: 0 } };
    const steps = [];
    const apply = (leg) => {
      inv[leg.side].sh += leg.sh;
      inv[leg.side].cost += leg.sh * leg.px;
      inv[leg.side].fees += fee(leg.px, leg.sh);
      const bal = Math.min(inv.UP.sh, inv.DOWN.sh);
      const cost = inv.UP.cost + inv.DOWN.cost + inv.UP.fees + inv.DOWN.fees;
      const worst = Math.min(inv.UP.sh - cost, inv.DOWN.sh - cost);
      const aU = inv.UP.sh ? inv.UP.cost / inv.UP.sh : null;
      const aD = inv.DOWN.sh ? inv.DOWN.cost / inv.DOWN.sh : null;
      steps.push({
        after: leg.kind || (steps.length ? 'clip' : 'open'),
        side: leg.side,
        px: leg.px,
        sh: leg.sh,
        shUP: inv.UP.sh,
        shDN: inv.DOWN.sh,
        residual: Math.abs(inv.UP.sh - inv.DOWN.sh),
        avgSum: aU != null && aD != null ? Math.round((aU + aD) * 1000) / 1000 : null,
        lockedPnL: Math.round(worst * 100) / 100,
        lockedPerBalanced: bal > 0 ? Math.round((worst / bal) * 10000) / 10000 : null,
        imbalanceSide: inv.UP.sh > inv.DOWN.sh ? 'UP' : inv.DOWN.sh > inv.UP.sh ? 'DOWN' : 'EQ',
      });
    };
    apply({ ...pathSpec.open, kind: 'open' });
    for (const c of pathSpec.clips) apply({ ...c, kind: 'clip' });
    return { label, steps };
  }

  const accounting = [
    pathAccounting('dry_success_6400', drySuccess),
    pathAccounting('dry_stuck_5500', dryStuck),
    // Hypothetical: stuck open then comfort partial if DN had hit 0.38 for 5sh
    pathAccounting('hyp_partial_comfort', {
      open: { side: 'UP', px: 0.56, sh: 10 },
      clips: [{ side: 'DOWN', px: 0.38, sh: 5 }],
    }),
    // Hypothetical: add TOP after bottom cheap (wrong order) vs bottom-first
    pathAccounting('hyp_bottom_then_done', {
      open: { side: 'DOWN', px: 0.57, sh: 10 },
      clips: [
        { side: 'UP', px: 0.4, sh: 5 },
        { side: 'UP', px: 0.34, sh: 5 },
      ],
    }),
  ];

  // Score synth: prefer done/eq, positive worst, low residual
  function score(row) {
    let s = 0;
    if (row.mode === 'done' || row.mode === 'hedged' || row.mode === 'comfort') s += 5;
    if ((row.residual || 0) < 1) s += 3;
    else s -= 4;
    if ((row.worstPnl ?? row.worst ?? 0) >= 0) s += 2;
    else s -= 3;
    if (row.avgSum != null && row.avgSum < 0.95) s += 2;
    if (row.pnl != null) s += row.pnl;
    if (row.pnlIfEq != null) s += row.pnlIfEq;
    return Math.round(s * 100) / 100;
  }

  for (const r of synthMatrix) r.score = score(r);

  // Best policy per regime
  const byRegime = {};
  for (const r of synthMatrix) {
    if (!byRegime[r.regime]) byRegime[r.regime] = [];
    byRegime[r.regime].push(r);
  }
  const winners = Object.entries(byRegime).map(([regime, rows]) => {
    const sorted = [...rows].sort((a, b) => b.score - a.score);
    return {
      regime,
      best: sorted[0]?.policy,
      bestScore: sorted[0]?.score,
      bestAvg: sorted[0]?.avgSum,
      bestResidual: sorted[0]?.residual,
      top3: sorted.slice(0, 3).map((x) => ({
        policy: x.policy,
        score: x.score,
        mode: x.mode,
        avgSum: x.avgSum,
        residual: x.residual,
        worstPnl: x.worstPnl,
      })),
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    thesis: {
      top: 'Open/chase = perna de cima (cara). Compra só se banda+cap.',
      bottom: 'Clips DESC = perna de baixo (barata). Compensa avgSum.',
      favorableImbalance:
        'Após open no favorito, se o favorito FORTALECE, o oposto barateia → clips → avgSum cai. Desbalanceamento residual no lado vencedor é temporário e favorável.',
      adverseImbalance:
        'Se o favorito ENFRAQUECE/flip, o oposto encarece → residual preso no lado perdedor. Escape cedo queima edge; comfort-stop preserva locked PnL parcial.',
      exitOrder:
        'Ordem correta: (1) nunca adicionar TOP para “consertar”; (2) só comprar BOTTOM se proj avgSum melhora ou ≤ teto; (3) se lockedPer ≥ conforto e balanced≥mín, PARAR (não forçar residual caro); (4) escape só no fim e só se locked não fica negativo.',
    },
    accounting,
    winners,
    journal,
    synthMatrix,
  };

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));

  console.log('=== Compensation path lab ===');
  console.log('\nJournal policies:');
  for (const j of journal) {
    console.log(
      `  ${j.policy.padEnd(22)} pnl=${String(j.pnl).padStart(7)} eq=${j.equalized} stuck=${j.stuck} avgMed=${j.avgMed} worst=${j.worst}`,
    );
  }
  console.log('\nSynth winners by regime:');
  for (const w of winners) {
    console.log(`  ${w.regime.padEnd(14)} → ${w.best} (score=${w.bestScore}) avg=${w.bestAvg} res=${w.bestResidual}`);
    for (const t of w.top3) {
      console.log(`      ${t.policy}: mode=${t.mode} avg=${t.avgSum} res=${t.residual} worst=${t.worstPnl} score=${t.score}`);
    }
  }
  console.log('\nDry success accounting:');
  for (const s of accounting[0].steps) {
    console.log(
      `  ${s.after} ${s.side}@${s.px}×${s.sh} → res=${s.residual} avgSum=${s.avgSum} locked=${s.lockedPnL} per=${s.lockedPerBalanced} imb=${s.imbalanceSide}`,
    );
  }
  console.log('\nsaved', path.join(OUT, 'report.json'));
}

main();
