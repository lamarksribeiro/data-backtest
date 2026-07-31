/**
 * Exhaustive day-29 lake sweep — Jul 29 2026 only.
 *
 *   node labs/sandbox/pair-path-v0/day29-exhaustive-sweep.mjs
 *   node labs/sandbox/pair-path-v0/day29-exhaustive-sweep.mjs --from=2026-07-29 --to=2026-07-30
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  FEE_RATE,
  OPERATIONAL_BUFFER_PER_PAIR,
  ladder,
  summarize,
  runLakeSweep,
} from './lake-replay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(ROOT, '.tmp/day29-exhaustive-sweep');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const FROM = arg('from', '2026-07-29');
// Exclusive end date: Jul 29 only defaults to to=2026-07-30 (day < to).
const TO = arg('to', '2026-07-30');
const TO_EXCLUSIVE = arg('toExclusive', '1') !== '0';

function sweepEndDay() {
  if (!TO_EXCLUSIVE) return TO;
  const end = new Date(`${TO}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

const SWEEP_FROM = FROM;
const SWEEP_TO = sweepEndDay();

const TIGHT2_ESCAPE = [
  {
    name: 'escape1',
    tauMax: 40,
    askMax: 0.42,
    avgSumMax: 0.98,
    minLockedPnlPerShare: -0.02,
  },
  {
    name: 'escape2',
    tauMax: 12,
    askMax: 0.45,
    avgSumMax: 1,
    minLockedPnlPerShare: -0.04,
  },
];

const DEEP3_ESCAPE = TIGHT2_ESCAPE;
const DEEP4_ESCAPE = TIGHT2_ESCAPE;

const LOSS_CUT_3 = {
  favoriteAskDrop: 0.03,
  askMax: 0.55,
  minLockedPnlPerShare: -0.12,
};

const LOSS_CUT_4 = {
  favoriteAskDrop: 0.04,
  askMax: 0.55,
  minLockedPnlPerShare: -0.15,
};

const MOMO_2C10 = {
  lookbackMs: 10_000,
  minFavoriteAskRise: 0.02,
};

const MOMO_3C15 = {
  lookbackMs: 15_000,
  minFavoriteAskRise: 0.03,
};

function L(...levels) {
  return levels.map(([askMax, frac]) => ({ askMax, frac }));
}

function escapesFromMechanics(opts) {
  const escapes = [];
  if (opts.tauHedgeEscape2 != null) {
    escapes.push({
      name: 'escape2',
      tauMax: opts.tauHedgeEscape2,
      askMax: opts.hedgeEscapeAskMax2 ?? 0.45,
      avgSumMax: opts.escapeAvgSumMax2 ?? 1,
      minLockedPnlPerShare: opts.escapeMinLockedPnlPerShare2 ?? -0.04,
    });
  }
  if (opts.tauHedgeEscape != null) {
    escapes.push({
      name: 'escape1',
      tauMax: opts.tauHedgeEscape,
      askMax: opts.hedgeEscapeAskMax ?? 0.42,
      avgSumMax: opts.escapeAvgSumMax ?? 0.98,
      minLockedPnlPerShare: opts.escapeMinLockedPnlPerShare ?? -0.02,
    });
  }
  return escapes;
}

function baseOpen(overrides = {}) {
  return {
    openAskLo: overrides.openAskLo ?? 0.52,
    openAskHi: overrides.openAskHi ?? 0.62,
    openTrigger: (overrides.openTriggerCents ?? 55) / 100,
    openCap: (overrides.openCapCents ?? 2) / 100,
    openBookSumMin: overrides.openBookSumMin ?? 0.95,
    openBookSumMax: overrides.openBookSumMax ?? 1.05,
    tauOpenMin: overrides.tauOpenMin ?? 40,
    tauOpenMax: overrides.tauOpenMax ?? 240,
    maxOpenAttempts: 3,
    maxSignalGapMs: 1250,
    latencyTicks: overrides.latencyTicks ?? 1,
    openConfirmationTicks: overrides.openConfirmationTicks ?? 1,
    legChoice: overrides.legChoice ?? 'chase',
    openRequireHedgeReady: overrides.openRequireHedgeReady ?? false,
    openHedgeSlackCents: overrides.openHedgeSlackCents ?? 0,
    openPairSumMaxAtOpen: overrides.openPairSumMaxAtOpen ?? null,
    openPtbMinLeaveUsd: overrides.openPtbMinLeaveUsd ?? null,
    openPtbMaxLeaveUsd: overrides.openPtbMaxLeaveUsd ?? null,
    openMomentum: overrides.openMomentum ?? null,
    lossCut: overrides.lossCut ?? null,
  };
}

function makeVariant(name, notes, overrides = {}) {
  const shares = overrides.openShares ?? 10;
  const hedgeLevels = overrides.hedgeLevels ?? null;
  const hedgeAskMax = overrides.hedgeAskMax ?? 0.42;
  const avgSumMax = overrides.avgSumMax ?? 0.95;
  const escapes =
    overrides.escapes ??
  (overrides.tauHedgeEscape != null || overrides.tauHedgeEscape2 != null
      ? escapesFromMechanics(overrides)
      : hedgeLevels
        ? TIGHT2_ESCAPE
        : []);

  return {
    id: name,
    policyName: name,
    notes,
    hedgeAskMax,
    hedgeLevels,
    avgSumMax,
    maxHedgeAttempts:
      overrides.maxHedgeAttempts ?? (hedgeLevels ? 8 : 2),
    escapes,
    openShares: shares,
    maxEventNotional:
      overrides.maxEventNotional ?? Math.max(16, Math.ceil(shares * 1.1)),
    ...baseOpen(overrides),
  };
}

function buildVariants() {
  const out = [];
  const seen = new Set();
  const add = (name, notes, overrides = {}) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(makeVariant(name, notes, overrides));
  };

  // --- baseline policies ---
  add('v0-as95-h42', 'V0 full hedge @42 avg0.95', {
    hedgeLevels: null,
    hedgeAskMax: 0.42,
    avgSumMax: 0.95,
    maxHedgeAttempts: 2,
    escapes: [],
  });
  add('tight2-as95', 'tight2 50%@40 + 50%@36', {
    hedgeAskMax: 0.4,
    hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
    avgSumMax: 0.95,
    escapes: TIGHT2_ESCAPE,
  });
  add('deep3-as94', 'deep3 40/30/30 @40/36/32 avg0.94', {
    hedgeAskMax: 0.4,
    hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    escapes: DEEP3_ESCAPE,
  });
  add('deep4-as94', 'deep4 25% each @42/38/34/30', {
    hedgeAskMax: 0.42,
    hedgeLevels: ladder(
      [0.42, 0.25],
      [0.38, 0.25],
      [0.34, 0.25],
      [0.3, 0.25],
    ),
    avgSumMax: 0.94,
    escapes: DEEP4_ESCAPE,
  });

  // --- clip ladders from mechanics-sweep ---
  const ladders = [
    ['c2-42-38', L([0.42, 0.5], [0.38, 0.5]), 0.42],
    ['c2-40-36', L([0.4, 0.5], [0.36, 0.5]), 0.4],
    ['c2-40-34', L([0.4, 0.5], [0.34, 0.5]), 0.4],
    ['c2-38-34', L([0.38, 0.5], [0.34, 0.5]), 0.38],
    ['c2-42-36', L([0.42, 0.4], [0.36, 0.6]), 0.42],
    ['c2-60-40', L([0.42, 0.6], [0.36, 0.4]), 0.42],
    ['c3-42-38-34', L([0.42, 0.4], [0.38, 0.3], [0.34, 0.3]), 0.42],
    ['c3-40-36-32', L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]), 0.4],
    ['c3-42-36-30', L([0.42, 0.34], [0.36, 0.33], [0.3, 0.33]), 0.42],
    ['c4-42-38-34-30', L([0.42, 0.25], [0.38, 0.25], [0.34, 0.25], [0.3, 0.25]), 0.42],
    ['c3-38-34-30', L([0.38, 0.34], [0.34, 0.33], [0.3, 0.33]), 0.38],
    ['c1-deep36', L([0.36, 1.0]), 0.36],
    ['c1-deep34', L([0.34, 1.0]), 0.34],
    ['hybrid-50at42-50at32', L([0.42, 0.5], [0.32, 0.5]), 0.42],
    ['c5-42-40-38-34-30', L([0.42, 0.2], [0.4, 0.2], [0.38, 0.2], [0.34, 0.2], [0.3, 0.2]), 0.42],
    ['c3-front60', L([0.4, 0.6], [0.36, 0.2], [0.32, 0.2]), 0.4],
    ['c3-deep60', L([0.4, 0.2], [0.36, 0.2], [0.32, 0.6]), 0.4],
  ];

  const avgSums = [0.92, 0.93, 0.94, 0.95, 0.96];
  const escapePresets = [
    { tag: 'noesc', tauHedgeEscape: null },
    { tag: 'e20', tauHedgeEscape: 20, hedgeEscapeAskMax: 0.42, escapeAvgSumMax: 0.98 },
    { tag: 'e40', tauHedgeEscape: 40, hedgeEscapeAskMax: 0.42, escapeAvgSumMax: 0.98 },
    {
      tag: 'e2stage',
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 12,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    },
  ];

  const keyLadders = new Set([
    'c2-40-36',
    'c2-42-38',
    'c3-42-38-34',
    'c3-40-36-32',
    'c4-42-38-34-30',
    'c3-42-36-30',
    'c3-38-34-30',
  ]);

  for (const [ladderName, levels, hMax] of ladders) {
    for (const as of avgSums) {
      for (const esc of escapePresets) {
        const isKey = keyLadders.has(ladderName);
        if (!isKey && esc.tag !== 'e40' && esc.tag !== 'noesc') continue;
        if (!isKey && as !== 0.95 && as !== 0.94) continue;
        add(
          `${ladderName}-as${String(as).slice(2)}-${esc.tag}`,
          `${ladderName} avg${as} ${esc.tag}`,
          {
            hedgeAskMax: hMax,
            hedgeLevels: levels,
            avgSumMax: as,
            ...esc,
          },
        );
      }
    }
  }

  // --- deep3/deep4/tight2 avgSumMax grid ---
  for (const as of [0.92, 0.93, 0.94, 0.95, 0.96]) {
    add(`tight2-as${String(as).slice(2)}-e2stage`, `tight2 avg${as} e2stage`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: as,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 12,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    });
    add(`deep3-as${String(as).slice(2)}-e2stage`, `deep3 avg${as} e2stage`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: as,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 12,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    });
    add(`deep4-as${String(as).slice(2)}-e2stage`, `deep4 avg${as} e2stage`, {
      hedgeAskMax: 0.42,
      hedgeLevels: ladder(
        [0.42, 0.25],
        [0.38, 0.25],
        [0.34, 0.25],
        [0.3, 0.25],
      ),
      avgSumMax: as,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 12,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    });
  }

  // --- momentum filters ---
  const momoBases = [
    ['tight2', {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      escapes: TIGHT2_ESCAPE,
    }],
    ['deep3', {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      escapes: DEEP3_ESCAPE,
    }],
  ];
  for (const [tag, base] of momoBases) {
    add(`${tag}-momo2c10s`, `${tag} + favorito +2c/10s`, {
      ...base,
      openMomentum: MOMO_2C10,
    });
    add(`${tag}-momo3c15s`, `${tag} + favorito +3c/15s`, {
      ...base,
      openMomentum: MOMO_3C15,
    });
    add(`${tag}-momo2c10s-losscut3`, `${tag} momo2c10s + losscut3`, {
      ...base,
      openMomentum: MOMO_2C10,
      lossCut: LOSS_CUT_3,
    });
    add(`${tag}-momo3c15s-losscut3`, `${tag} momo3c15s + losscut3`, {
      ...base,
      openMomentum: MOMO_3C15,
      lossCut: LOSS_CUT_3,
    });
  }

  // --- loss cut variants ---
  for (const [tag, base] of momoBases) {
    add(`${tag}-losscut3`, `${tag} + losscut 3c`, {
      ...base,
      lossCut: LOSS_CUT_3,
    });
    add(`${tag}-losscut4`, `${tag} + losscut 4c`, {
      ...base,
      lossCut: LOSS_CUT_4,
    });
  }

  // --- openRequireHedgeReady slack ---
  const hedgeReadySlacks = [
    { tag: 'hr0', slack: 0, pairMax: 0.95 },
    { tag: 'hr3', slack: 3, pairMax: 0.98 },
    { tag: 'hr5', slack: 5, pairMax: 1.0 },
    { tag: 'hr8', slack: 8, pairMax: 1.02 },
  ];
  for (const { tag, slack, pairMax } of hedgeReadySlacks) {
    add(`tight2-hedgeReady-${tag}`, `tight2 hedge-ready slack${slack}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      escapes: TIGHT2_ESCAPE,
      openRequireHedgeReady: true,
      openHedgeSlackCents: slack,
      openPairSumMaxAtOpen: pairMax,
    });
    add(`deep3-hedgeReady-${tag}`, `deep3 hedge-ready slack${slack}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      escapes: DEEP3_ESCAPE,
      openRequireHedgeReady: true,
      openHedgeSlackCents: slack,
      openPairSumMaxAtOpen: pairMax,
    });
  }

  // --- book sum filters ---
  for (const max of [0.99, 0.98]) {
    add(`tight2-bookMax${String(max).slice(2)}`, `tight2 open book sum ≤${max}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      escapes: TIGHT2_ESCAPE,
      openBookSumMax: max,
    });
    add(`deep3-bookMax${String(max).slice(2)}`, `deep3 open book sum ≤${max}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      escapes: DEEP3_ESCAPE,
      openBookSumMax: max,
    });
  }

  // --- tau windows (narrow open) ---
  const tauWindows = [
    { tag: 'tau60-220', min: 60, max: 220 },
    { tag: 'tau80-200', min: 80, max: 200 },
    { tag: 'tau100-180', min: 100, max: 180 },
  ];
  for (const { tag, min, max } of tauWindows) {
    add(`tight2-${tag}`, `tight2 open tau ${min}-${max}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      escapes: TIGHT2_ESCAPE,
      tauOpenMin: min,
      tauOpenMax: max,
    });
    add(`deep3-${tag}`, `deep3 open tau ${min}-${max}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      escapes: DEEP3_ESCAPE,
      tauOpenMin: min,
      tauOpenMax: max,
    });
  }

  // --- PTB distance filters at open ---
  const ptbFilters = [
    { tag: 'ptbMin10', min: 10 },
    { tag: 'ptbMin20', min: 20 },
    { tag: 'ptbMin30', min: 30 },
    { tag: 'ptbMin40', min: 40 },
    { tag: 'ptbMax60', max: 60 },
    { tag: 'ptbMin20Max50', min: 20, max: 50 },
  ];
  for (const { tag, min, max } of ptbFilters) {
    add(`tight2-${tag}`, `tight2 PTB filter ${tag}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      escapes: TIGHT2_ESCAPE,
      openPtbMinLeaveUsd: min ?? null,
      openPtbMaxLeaveUsd: max ?? null,
    });
    add(`deep3-${tag}`, `deep3 PTB filter ${tag}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      escapes: DEEP3_ESCAPE,
      openPtbMinLeaveUsd: min ?? null,
      openPtbMaxLeaveUsd: max ?? null,
    });
  }

  // --- size variants 5, 10, 15 ---
  const sizeBases = [
    ['tight2-as95', {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      escapes: TIGHT2_ESCAPE,
    }],
    ['deep3-as94-e2stage', {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 12,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    }],
    ['deep4-as93-e2stage', {
      hedgeAskMax: 0.42,
      hedgeLevels: ladder(
        [0.42, 0.25],
        [0.38, 0.25],
        [0.34, 0.25],
        [0.3, 0.25],
      ),
      avgSumMax: 0.93,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 12,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    }],
    ['c3-40-36-32-as94-e2stage', {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 12,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    }],
  ];
  for (const sh of [5, 10, 15]) {
    for (const [baseName, base] of sizeBases) {
      add(`${baseName}-sh${sh}`, `${baseName} size ${sh}`, {
        ...base,
        openShares: sh,
        maxEventNotional: Math.ceil(sh * 0.62 + sh * 0.42) + 2,
      });
    }
  }

  // --- fade leg choice ---
  add('tight2-fade', 'tight2 fade underdog open', {
    hedgeAskMax: 0.4,
    hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
    avgSumMax: 0.95,
    escapes: TIGHT2_ESCAPE,
    legChoice: 'fade',
  });
  add('deep3-fade', 'deep3 fade underdog open', {
    hedgeAskMax: 0.4,
    hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    escapes: DEEP3_ESCAPE,
    legChoice: 'fade',
  });

  // --- latency sensitivity (subset) ---
  for (const latency of [1, 3]) {
    add(`tight2-lat${latency}`, `tight2 latency ${latency} ticks`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      escapes: TIGHT2_ESCAPE,
      latencyTicks: latency,
    });
    add(`deep3-lat${latency}`, `deep3 latency ${latency} ticks`, {
      hedgeAskMax: 0.4,
      hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
      avgSumMax: 0.94,
      escapes: DEEP3_ESCAPE,
      latencyTicks: latency,
    });
  }

  // --- pinned candidates ---
  add('RECOMMENDED-deep3-as94-e2', 'pinned deep3 late escape', {
    hedgeAskMax: 0.4,
    hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('RECOMMENDED-deep4-as93-e20', 'pinned deep4 c4 champion', {
    hedgeAskMax: 0.42,
    hedgeLevels: ladder(
      [0.42, 0.25],
      [0.38, 0.25],
      [0.34, 0.25],
      [0.3, 0.25],
    ),
    avgSumMax: 0.93,
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });

  return out;
}

function pfValue(summary) {
  const pf = summary.realizedProfitFactor;
  if (pf === 'Infinity') return Number.POSITIVE_INFINITY;
  return Number(pf) || 0;
}

function variantReport(variant, rows) {
  const residualWorst = rows
    .filter((row) => row.opened && !row.equalized)
    .sort((a, b) => a.guardedWorstPnl - b.guardedWorstPnl)
    .slice(0, 10);
  return {
    id: variant.id,
    notes: variant.notes,
    params: {
      openShares: variant.openShares,
      latencyTicks: variant.latencyTicks,
      hedgeLevels: variant.hedgeLevels,
      avgSumMax: variant.avgSumMax,
      escapes: variant.escapes,
      openMomentum: variant.openMomentum ?? null,
      lossCut: variant.lossCut ?? null,
      openRequireHedgeReady: variant.openRequireHedgeReady,
      openHedgeSlackCents: variant.openHedgeSlackCents,
      openBookSumMax: variant.openBookSumMax,
      tauOpenMin: variant.tauOpenMin,
      tauOpenMax: variant.tauOpenMax,
      legChoice: variant.legChoice,
      openPtbMinLeaveUsd: variant.openPtbMinLeaveUsd,
      openPtbMaxLeaveUsd: variant.openPtbMaxLeaveUsd,
    },
    summary: summarize(rows),
    residualWorst,
  };
}

function failurePatterns(variants) {
  const patterns = {
    zeroOpens: [],
    highResidual: [],
    negativeWorst: [],
    lowEqualize: [],
    negativeRealized: [],
  };
  for (const v of variants) {
    const s = v.summary;
    if (s.opened === 0) patterns.zeroOpens.push(v.id);
    if (s.residual > 0 && s.equalizeRatePct != null && s.equalizeRatePct < 80) {
      patterns.lowEqualize.push({
        id: v.id,
        eqRate: s.equalizeRatePct,
        residual: s.residual,
      });
    }
    if (s.residual > 0) patterns.highResidual.push({ id: v.id, residual: s.residual });
    if (s.worstEvent != null && s.worstEvent < -0.5) {
      patterns.negativeWorst.push({ id: v.id, worst: s.worstEvent });
    }
    if (s.guardedRealizedPnl < 0) {
      patterns.negativeRealized.push({
        id: v.id,
        pnl: s.guardedRealizedPnl,
        opened: s.opened,
      });
    }
  }
  patterns.lowEqualize.sort((a, b) => a.eqRate - b.eqRate);
  patterns.highResidual.sort((a, b) => b.residual - a.residual);
  patterns.negativeWorst.sort((a, b) => a.worst - b.worst);
  patterns.negativeRealized.sort((a, b) => a.pnl - b.pnl);
  return patterns;
}

function buildLeaderboard(report) {
  const lines = [
    '# Day-29 exhaustive lake sweep',
    '',
    `Generated: ${report.generatedAt}`,
    `Window: ${report.window.from} .. ${report.window.to} (${report.window.days} day(s))`,
    `Eligible events: ${report.eligibleEvents} · Variants: ${report.nVariants}`,
    `Dataset: ${report.dataset}`,
    '',
    '## Top 20 by guarded realized PnL (opened > 0)',
    '',
    '| rank | id | pnl | PF | opened | eq | eqRate% | worst | rocWorst% | pairCostP50 |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.topByPnl.map((v, i) =>
      `| ${i + 1} | \`${v.id}\` | ${v.guardedRealizedPnl} | ${v.realizedProfitFactor} | ${v.opened} | ${v.equalized} | ${v.equalizeRatePct} | ${v.worstEvent} | ${v.rocWorstPct} | ${v.netPairCostP50} |`,
    ),
    '',
    '## Top 20 by profit factor (min 1 open)',
    '',
    '| rank | id | PF | pnl | opened | eq | avgSumP50 |',
    '|---:|---|---:|---:|---:|---:|---:|',
    ...report.topByPf.map((v, i) =>
      `| ${i + 1} | \`${v.id}\` | ${v.realizedProfitFactor} | ${v.guardedRealizedPnl} | ${v.opened} | ${v.equalized} | ${v.avgSumP50} |`,
    ),
    '',
    '## Positive PnL variants',
    '',
    `Count: ${report.positivePnl.length}`,
    '',
    '| id | pnl | PF | opened | eq | notes |',
    '|---|---:|---:|---:|---:|---|',
    ...report.positivePnl.map((v) =>
      `| \`${v.id}\` | ${v.guardedRealizedPnl} | ${v.realizedProfitFactor} | ${v.opened} | ${v.equalized} | ${v.notes} |`,
    ),
    '',
    '## Failure patterns',
    '',
    `### Zero opens (${report.failurePatterns.zeroOpens.length})`,
    '',
    report.failurePatterns.zeroOpens.length
      ? report.failurePatterns.zeroOpens.map((id) => `- \`${id}\``).join('\n')
      : 'None',
    '',
    `### Low equalize rate (<80%, opened) — top 15`,
    '',
    '| id | eqRate% | residual |',
    '|---|---:|---:|',
    ...report.failurePatterns.lowEqualize.slice(0, 15).map(
      (r) => `| \`${r.id}\` | ${r.eqRate} | ${r.residual} |`,
    ),
    '',
    `### Worst event < -0.50 — top 15`,
    '',
    '| id | worst |',
    '|---|---:|',
    ...report.failurePatterns.negativeWorst.slice(0, 15).map(
      (r) => `| \`${r.id}\` | ${r.worst} |`,
    ),
    '',
    `### Negative realized PnL — count ${report.failurePatterns.negativeRealized.length}`,
    '',
    'Top 15 worst:',
    '',
    '| id | pnl | opened |',
    '|---|---:|---:|',
    ...report.failurePatterns.negativeRealized.slice(0, 15).map(
      (r) => `| \`${r.id}\` | ${r.pnl} | ${r.opened} |`,
    ),
    '',
    '## Notes',
    '',
    '- Single-day in-sample sweep; not a promotion gate.',
    '- guardedRealizedPnl subtracts operational buffer per balanced pair.',
    '- PF from resolved events only (winner agreement spot+book).',
    '- **PTB-Path** (`ptb-protect-ab.mjs`) is a separate architecture: open only when spot already left PTB, optional delayed hedge — not part of the variant grid above.',
    '',
  ];

  if (report.ptbPathReference?.length) {
    lines.push(
      '## PTB-Path reference (`ptb-protect-ab` + clip tight2)',
      '',
      'Cross-check: same lake window, `hedge-asap` arm only.',
      '',
      '| openLeave | opens | eq% | realized | worst | PF | avgSumP50 |',
      '|---:|---:|---:|---:|---:|---:|---:|',
      ...report.ptbPathReference.map(
        (r) =>
          `| ${r.openLeaveUsd} | ${r.opened} | ${r.eqRatePct} | ${r.realized} | ${r.worst} | ${r.pf} | ${r.avgSumP50 ?? '—'} |`,
      ),
      '',
      'If this table shows positive realized while the grid above is all negative, the edge is in **selective PTB entry + hedge mode**, not tighter `avgSumMax` on continuous opens.',
      '',
    );
  }

  return lines.join('\n');
}

async function runPtbPathReference() {
  const leaves = [25, 28, 30, 32, 35];
  const rows = [];
  for (const openLeaveUsd of leaves) {
    await execFileAsync(
      process.execPath,
      [
        'labs/sandbox/pair-path-v0/ptb-protect-ab.mjs',
        `--from=${SWEEP_FROM}`,
        `--to=${SWEEP_TO}`,
        '--shares=10',
        `--openLeaveUsd=${openLeaveUsd}`,
        '--clip=tight2',
      ],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
    );
    const reportPath = path.join(
      ROOT,
      `.tmp/ptb-protect-ab-openLeave${openLeaveUsd}-clip-tight2/report.json`,
    );
    if (!fs.existsSync(reportPath)) continue;
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const variant = report.variants?.find((v) =>
      v.id.startsWith('hedge-asap'),
    );
    if (!variant?.summary) continue;
    const s = variant.summary;
    rows.push({
      openLeaveUsd,
      opened: `${s.opened}/${s.events}`,
      eqRatePct: s.equalizeRatePct,
      realized: s.guardedRealizedPnl,
      worst: s.worstRealized,
      pf: s.realizedProfitFactor,
      avgSumP50: s.avgSumP50,
    });
  }
  return rows;
}

async function main() {
  const variants = buildVariants();
  if (variants.length < 200) {
    console.warn(`warning: only ${variants.length} variants (expected 200+)`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('=== Day-29 exhaustive lake sweep ===');
  console.log(`window=${FROM}..${TO} variants=${variants.length}`);

  const { days, eligibleEvents, skippedCoverage, results } = await runLakeSweep({
    variants,
    from: SWEEP_FROM,
    to: SWEEP_TO,
    onDayProgress: ({ day, eligibleEvents: eligible }) => {
      console.log(`${day} eligible=${eligible}`);
    },
  });

  const variantReports = variants.map((variant) =>
    variantReport(variant, results.get(variant.id)),
  );

  const topByPnl = [...variantReports]
    .filter((v) => v.summary.opened > 0)
    .sort(
      (a, b) =>
        b.summary.guardedRealizedPnl - a.summary.guardedRealizedPnl ||
        b.summary.opened - a.summary.opened,
    )
    .slice(0, 20)
    .map((v) => ({ id: v.id, notes: v.notes, ...v.summary }));

  const topByPf = [...variantReports]
    .filter((v) => v.summary.opened > 0)
    .sort(
      (a, b) =>
        pfValue(b.summary) - pfValue(a.summary) ||
        b.summary.guardedRealizedPnl - a.summary.guardedRealizedPnl,
    )
    .slice(0, 20)
    .map((v) => ({ id: v.id, notes: v.notes, ...v.summary }));

  const positivePnl = variantReports
    .filter((v) => v.summary.guardedRealizedPnl > 0)
    .sort((a, b) => b.summary.guardedRealizedPnl - a.summary.guardedRealizedPnl)
    .map((v) => ({
      id: v.id,
      notes: v.notes,
      ...v.summary,
    }));

  const failures = failurePatterns(variantReports);

  console.log('--- PTB-Path reference (ptb-protect + clip tight2) ---');
  const ptbPathReference = await runPtbPathReference();
  for (const row of ptbPathReference) {
    console.log(
      `leave${row.openLeaveUsd} asap realized=${row.realized} worst=${row.worst} opens=${row.opened}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: {
      from: FROM,
      to: TO,
      toExclusive: TO_EXCLUSIVE,
      days: days.length,
    },
    dataset: 'backtest_ticks BTC 5m depth25',
    feeRate: FEE_RATE,
    operationalBufferPerPair: OPERATIONAL_BUFFER_PER_PAIR,
    eligibleEvents,
    skippedCoverage,
    nVariants: variants.length,
    topByPnl,
    topByPf,
    positivePnl,
    failurePatterns: failures,
    ptbPathReference,
    variants: variantReports,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'LEADERBOARD.md'),
    buildLeaderboard(report),
  );

  console.log('');
  console.log('--- TOP 10 by PnL ---');
  for (const v of topByPnl.slice(0, 10)) {
    console.log(
      `${v.id.padEnd(40)} pnl=${v.guardedRealizedPnl} PF=${v.realizedProfitFactor}` +
        ` open=${v.opened} eq=${v.equalized} worst=${v.worstEvent}`,
    );
  }
  console.log('');
  console.log(`positive PnL variants: ${positivePnl.length}`);
  console.log(`zero opens: ${failures.zeroOpens.length}`);
  console.log(`negative realized: ${failures.negativeRealized.length}`);
  console.log('saved', path.join(OUT_DIR, 'report.json'));
  console.log('saved', path.join(OUT_DIR, 'LEADERBOARD.md'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
