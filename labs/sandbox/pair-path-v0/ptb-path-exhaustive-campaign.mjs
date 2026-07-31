/**
 * PTB-Path campaign: staged search on 2026-07-29, then retrospective
 * falsification on the earlier lake. Research only; no live orders.
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/ptb-path-exhaustive-campaign.mjs
 *   node labs/sandbox/pair-path-v0/ptb-path-exhaustive-campaign.mjs \
 *     --discoveryFrom=2026-07-29 --discoveryTo=2026-07-29 \
 *     --validationFrom=2026-04-23 --validationTo=2026-07-28
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEE_RATE,
  OPERATIONAL_BUFFER_PER_PAIR,
  buildBaseParams,
  runPtbSweep,
  summarize,
} from './ptb-protect-ab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const DISCOVERY_FROM = arg('discoveryFrom', '2026-07-29');
const DISCOVERY_TO = arg('discoveryTo', '2026-07-29');
const VALIDATION_FROM = arg('validationFrom', '2026-04-23');
const VALIDATION_TO = arg('validationTo', '2026-07-28');
const TAG = arg('tag', 'canonical-v1');
const OUT_DIR = path.join(ROOT, `.tmp/ptb-path-exhaustive-campaign-${TAG}`);
const WINNER_CSV = path.resolve(
  ROOT,
  arg('winnerCsv', 'scratch/canonical-outcomes-v1.csv'),
);
const FINALISTS = Math.max(4, Number(arg('finalists', '6')) || 6);
const BOOTSTRAP_SAMPLES = Math.max(
  200,
  Number(arg('bootstrapSamples', '2000')) || 2000,
);

// CLOB market outcomes for the eight 2026-07-29 events where terminal spot
// was wrong. Six were excluded by spot/book disagreement; two were mislabeled
// by agreement on the wrong side. The other 256 day-29 proxy labels agreed.
const CANONICAL_WINNERS_2026_07_29 = {
  1785295200: 'DOWN',
  1785301200: 'DOWN',
  1785317100: 'DOWN',
  1785327900: 'DOWN',
  1785332100: 'UP',
  1785334800: 'UP',
  1785339600: 'UP',
  1785341700: 'UP',
};

function loadCanonicalWinners(file) {
  if (!fs.existsSync(file)) {
    return {
      winners: CANONICAL_WINNERS_2026_07_29,
      source: 'embedded eight-event day-29 override',
    };
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift()?.split(',') ?? [];
  const epochIndex = header.indexOf('event_epoch');
  const startIndex = header.indexOf('event_start');
  const winnerIndex = header.indexOf('winner');
  if (winnerIndex < 0 || (epochIndex < 0 && startIndex < 0)) {
    throw new Error(
      `winner CSV must contain winner and event_epoch or event_start: ${file}`,
    );
  }
  const winners = {};
  for (const line of lines) {
    if (!line) continue;
    const values = line.split(',');
    const winner = String(values[winnerIndex] ?? '').toUpperCase();
    if (winner !== 'UP' && winner !== 'DOWN') continue;
    const epoch =
      epochIndex >= 0
        ? Number(values[epochIndex])
        : Math.floor(Date.parse(values[startIndex]) / 1000);
    if (Number.isFinite(epoch)) winners[epoch] = winner;
  }
  return {
    winners,
    source: path.relative(ROOT, file).replaceAll('\\', '/'),
  };
}

const CANONICAL = loadCanonicalWinners(WINNER_CSV);

function product(...axes) {
  return axes.reduce(
    (rows, axis) => rows.flatMap((row) => axis.map((value) => [...row, value])),
    [[]],
  );
}

function cents(value) {
  return Math.round(value * 100);
}

function entryId(entry) {
  return [
    `lv${entry.openLeaveUsd}`,
    `tr${cents(entry.openTrigger)}`,
    `cp${cents(entry.openCap)}`,
    `tau${entry.tauOpenMin}-${entry.tauOpenMax}`,
    `cf${entry.openConfirmationTicks}`,
  ].join('-');
}

function baseVariant(entry, overrides = {}) {
  const base = buildBaseParams(entry.openLeaveUsd);
  return {
    ...base,
    id: overrides.id,
    notes: overrides.notes ?? '',
    hedgeId: overrides.hedgeId ?? 'hedge-asap',
    hedgeMode: overrides.hedgeMode ?? 'asap',
    openShares: 10,
    maxEventNotional: 16,
    openAskLo: 0.5,
    openAskHi: 0.65,
    openTrigger: entry.openTrigger,
    openCap: entry.openCap,
    openBookSumMin: 0.95,
    openBookSumMax: 1.05,
    tauOpenMin: entry.tauOpenMin,
    tauOpenMax: entry.tauOpenMax,
    openConfirmationTicks: entry.openConfirmationTicks,
    maxOpenAttempts: 3,
    maxHedgeAttempts: overrides.maxHedgeAttempts ?? 8,
    minimumOrderShares: 5,
    maxSignalGapMs: 1250,
    latencyTicks: overrides.latencyTicks ?? 1,
    openLeaveUsd: entry.openLeaveUsd,
    ptbLeaveUsd: overrides.ptbLeaveUsd ?? entry.openLeaveUsd,
    ptbApproachUsd: overrides.ptbApproachUsd ?? 20,
    hedgeAskMax: overrides.hedgeAskMax ?? 0.42,
    avgSumMax: overrides.avgSumMax ?? 0.96,
    hedgeLevels: overrides.hedgeLevels ?? null,
    emergencyHedge: overrides.emergencyHedge ?? null,
    depthFraction: overrides.depthFraction ?? 1,
    feeRate: overrides.feeRate ?? FEE_RATE,
    winnerPayout: overrides.winnerPayout ?? 1,
    operationalBufferPerPair:
      overrides.operationalBufferPerPair ?? OPERATIONAL_BUFFER_PER_PAIR,
    canonicalWinners: CANONICAL.winners,
    campaign: {
      entry,
      mechanic: overrides.mechanic ?? 'full',
      stress: overrides.stress ?? 'base',
    },
  };
}

function buildStage1() {
  const variants = [];
  const axes = product(
    [15, 20, 25, 30, 35, 40, 50],
    [0.53, 0.55, 0.57],
    [0.01, 0.02, 0.03],
    [
      [40, 240],
      [80, 220],
      [120, 200],
    ],
    [2],
  );
  for (const [leave, trigger, cap, tau, confirm] of axes) {
    const entry = {
      openLeaveUsd: leave,
      openTrigger: trigger,
      openCap: cap,
      tauOpenMin: tau[0],
      tauOpenMax: tau[1],
      openConfirmationTicks: confirm,
    };
    const prefix = entryId(entry);
    variants.push(
      baseVariant(entry, {
        id: `${prefix}|full42-as96`,
        notes: 'stage1 full hedge',
        mechanic: 'full42-as96',
        hedgeAskMax: 0.42,
        avgSumMax: 0.96,
        maxHedgeAttempts: 4,
      }),
      baseVariant(entry, {
        id: `${prefix}|tight2-as95`,
        notes: 'stage1 tight2 clips',
        mechanic: 'tight2-as95',
        hedgeAskMax: 0.4,
        avgSumMax: 0.95,
        hedgeLevels: [
          { askMax: 0.4, frac: 0.5 },
          { askMax: 0.36, frac: 0.5 },
        ],
      }),
    );
  }
  return variants;
}

function chronologicalGroups(rows, hours = 4) {
  const groups = new Map();
  for (const row of rows) {
    const epoch = Number(row.eventKey);
    const date = Number.isFinite(epoch)
      ? new Date(epoch * 1000)
      : new Date(`${row.day}T00:00:00Z`);
    const hour = date.getUTCHours();
    const key = `${row.day}T${String(Math.floor(hour / hours) * hours).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([key, value]) => [key, summarize(value)]),
  );
}

function conservativeSummary(rows) {
  const opened = rows.filter((row) => row.opened);
  const effectivePnls = opened.map((row) =>
    row.guardedRealizedPnl != null
      ? row.guardedRealizedPnl
      : row.guardedWorstPnl,
  );
  const wins = effectivePnls.filter((value) => value > 0);
  const losses = effectivePnls.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + Math.abs(value), 0);
  const pnl = effectivePnls.reduce((sum, value) => sum + value, 0);
  return {
    opened: opened.length,
    unresolvedOpened: opened.filter((row) => row.guardedRealizedPnl == null)
      .length,
    pnl: Math.round(pnl * 1000) / 1000,
    pnlPerOpen:
      opened.length > 0 ? Math.round((pnl / opened.length) * 10000) / 10000 : null,
    worst: effectivePnls.length
      ? Math.round(Math.min(...effectivePnls) * 1000) / 1000
      : null,
    profitFactor:
      grossLoss > 0
        ? Math.round((grossProfit / grossLoss) * 1000) / 1000
        : grossProfit > 0
          ? 'Infinity'
          : 0,
  };
}

function dailyGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.day)) groups.set(row.day, []);
    groups.get(row.day).push(row);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([key, value]) => [key, summarize(value)]),
  );
}

function monthlyGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const month = row.day.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(row);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([key, value]) => [key, summarize(value)]),
  );
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(values, fraction) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.max(
    0,
    Math.min(clean.length - 1, Math.floor((clean.length - 1) * fraction)),
  );
  return clean[index];
}

function bootstrap(rows, samples = BOOTSTRAP_SAMPLES) {
  const pnls = rows
    .filter((row) => row.opened)
    .map((row) =>
      row.guardedRealizedPnl != null
        ? row.guardedRealizedPnl
        : row.guardedWorstPnl,
    );
  if (!pnls.length) {
    return { n: 0, samples, pnlP05: null, pnlP50: null, pnlP95: null };
  }
  const random = mulberry32(0x29b7c5);
  const totals = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < pnls.length; draw += 1) {
      total += pnls[Math.floor(random() * pnls.length)];
    }
    totals.push(total);
  }
  return {
    n: pnls.length,
    samples,
    pnlP05: quantile(totals, 0.05),
    pnlP50: quantile(totals, 0.5),
    pnlP95: quantile(totals, 0.95),
  };
}

function evaluate(variant, rows, { bootstrapEnabled = false } = {}) {
  const summary = summarize(rows);
  const conservative = conservativeSummary(rows);
  const openedResolved = rows.filter((row) => row.opened);
  const block4h = chronologicalGroups(rows);
  const activeBlocks = Object.values(block4h).filter((item) => item.opened > 0);
  const blockConservative = Object.fromEntries(
    Object.entries(
      rows.reduce((groups, row) => {
        const epoch = Number(row.eventKey);
        const date = Number.isFinite(epoch)
          ? new Date(epoch * 1000)
          : new Date(`${row.day}T00:00:00Z`);
        const key = `${row.day}T${String(
          Math.floor(date.getUTCHours() / 4) * 4,
        ).padStart(2, '0')}`;
        (groups[key] ??= []).push(row);
        return groups;
      }, {}),
    ).map(([key, value]) => [key, conservativeSummary(value)]),
  );
  const blockPnls = Object.values(blockConservative)
    .filter((item) => item.opened > 0)
    .map((item) => item.pnl);
  const minBlockPnl = blockPnls.length ? Math.min(...blockPnls) : null;
  const positiveEvents = openedResolved
    .map((row) =>
      row.guardedRealizedPnl != null
        ? row.guardedRealizedPnl
        : row.guardedWorstPnl,
    )
    .filter((value) => value > 0);
  const grossPositive = positiveEvents.reduce((sum, value) => sum + value, 0);
  const maxPositive = positiveEvents.length ? Math.max(...positiveEvents) : 0;
  const maxWinShare =
    grossPositive > 0 ? Math.round((maxPositive / grossPositive) * 10000) / 100 : null;
  const worstResolved = openedResolved.length
    ? Math.min(
        ...openedResolved.map((row) =>
          row.guardedRealizedPnl != null
            ? row.guardedRealizedPnl
            : row.guardedWorstPnl,
        ),
      )
    : null;
  const scarcityPenalty = Math.max(0, 8 - conservative.opened) * 1.5;
  const robustScore =
    conservative.pnl +
    4 * Math.min(0, worstResolved ?? 0) +
    2 * Math.min(0, minBlockPnl ?? 0) -
    scarcityPenalty;
  return {
    id: variant.id,
    notes: variant.notes,
    campaign: variant.campaign,
    params: {
      openLeaveUsd: variant.openLeaveUsd,
      openTrigger: variant.openTrigger,
      openCap: variant.openCap,
      tauOpenMin: variant.tauOpenMin,
      tauOpenMax: variant.tauOpenMax,
      openConfirmationTicks: variant.openConfirmationTicks,
      latencyTicks: variant.latencyTicks,
      hedgeMode: variant.hedgeMode,
      hedgeAskMax: variant.hedgeAskMax,
      avgSumMax: variant.avgSumMax,
      hedgeLevels: variant.hedgeLevels,
      emergencyHedge: variant.emergencyHedge,
      minimumOrderShares: variant.minimumOrderShares,
      depthFraction: variant.depthFraction,
      feeRate: variant.feeRate,
      winnerPayout: variant.winnerPayout,
      operationalBufferPerPair: variant.operationalBufferPerPair,
    },
    summary,
    conservative,
    worstResolved,
    activeBlocks: activeBlocks.length,
    minBlockPnl,
    maxWinSharePct: maxWinShare,
    robustScore: Math.round(robustScore * 1000) / 1000,
    block4h,
    block4hConservative: blockConservative,
    byDay: dailyGroups(rows),
    byMonth: monthlyGroups(rows),
    byMonthConservative: Object.fromEntries(
      Object.entries(
        rows.reduce((groups, row) => {
          const month = row.day.slice(0, 7);
          (groups[month] ??= []).push(row);
          return groups;
        }, {}),
      ).map(([key, value]) => [key, conservativeSummary(value)]),
    ),
    bootstrap: bootstrapEnabled ? bootstrap(rows) : null,
  };
}

function discoverySort(a, b) {
  return (
    b.robustScore - a.robustScore ||
    b.conservative.pnl - a.conservative.pnl ||
    b.conservative.opened - a.conservative.opened
  );
}

function uniqueEntries(evaluations, limit) {
  const entries = [];
  const seen = new Set();
  for (const result of evaluations) {
    const entry = result.campaign.entry;
    const key = entryId(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}

function buildStage2(entries) {
  const variants = [];
  const add = (entry, suffix, overrides) => {
    variants.push(
      baseVariant(entry, {
        ...overrides,
        id: `${entryId(entry)}|${suffix}`,
        notes: `stage2 ${suffix}`,
        mechanic: suffix,
      }),
    );
  };
  for (const entry of entries) {
    for (const [askMax, avgSumMax] of product(
      [0.38, 0.4, 0.42, 0.44, 0.46],
      [0.94, 0.96, 0.98, 1],
    )) {
      add(entry, `full-h${cents(askMax)}-as${cents(avgSumMax)}`, {
        hedgeMode: 'asap',
        hedgeAskMax: askMax,
        avgSumMax,
        maxHedgeAttempts: 4,
      });
    }

    for (const [name, levels, hedgeAskMax] of [
      ['tight42-38', [{ askMax: 0.42, frac: 0.5 }, { askMax: 0.38, frac: 0.5 }], 0.42],
      ['tight40-36', [{ askMax: 0.4, frac: 0.5 }, { askMax: 0.36, frac: 0.5 }], 0.4],
      ['deep40-36-32', [
        { askMax: 0.4, frac: 0.4 },
        { askMax: 0.36, frac: 0.3 },
        { askMax: 0.32, frac: 0.3 },
      ], 0.4],
    ]) {
      for (const avgSumMax of [0.94, 0.96, 0.98]) {
        add(entry, `${name}-as${cents(avgSumMax)}`, {
          hedgeMode: 'asap',
          hedgeAskMax,
          avgSumMax,
          hedgeLevels: levels,
        });
      }
    }

    for (const [triggerDistMaxUsd, askMax, avgSumMax] of product(
      [20, 15, 10, 5, 0, -5],
      [0.45, 0.5, 0.55, 0.6],
      [0.98, 1.02, 1.06, 1.1],
    )) {
      add(
        entry,
        `shot-protect-d${triggerDistMaxUsd}-h${cents(askMax)}-as${cents(avgSumMax)}`,
        {
          hedgeMode: 'never',
          hedgeAskMax: 0,
          avgSumMax: 0,
          emergencyHedge: {
            triggerDistMaxUsd,
            askMax,
            avgSumMax,
          },
        },
      );
    }

    for (const approach of [20, 10, 0]) {
      add(entry, `ptb-delay-a${approach}`, {
        hedgeMode: 'ptb',
        hedgeAskMax: 0.42,
        avgSumMax: 0.96,
        ptbLeaveUsd: entry.openLeaveUsd,
        ptbApproachUsd: approach,
      });
    }
  }
  return variants;
}

function pickFinalists(evaluations, count) {
  const pools = [
    [...evaluations].sort(discoverySort),
    [...evaluations].sort(
      (a, b) =>
        b.conservative.pnl - a.conservative.pnl ||
        (b.worstResolved ?? -Infinity) - (a.worstResolved ?? -Infinity),
    ),
    [...evaluations].sort(
      (a, b) =>
        (b.worstResolved ?? -Infinity) - (a.worstResolved ?? -Infinity) ||
        b.conservative.pnl - a.conservative.pnl,
    ),
    [...evaluations].sort(
      (a, b) =>
        b.summary.equalizeRatePct - a.summary.equalizeRatePct ||
        b.conservative.pnl - a.conservative.pnl,
    ),
  ];
  const picked = [];
  const seen = new Set();
  for (const family of ['full-', 'tight', 'deep', 'shot-protect', 'ptb-delay']) {
    if (picked.length >= count) break;
    const representative = evaluations
      .filter((item) => item.campaign.mechanic.includes(family))
      .sort(discoverySort)
      .find((item) => !seen.has(item.id) && item.summary.opened >= 4);
    if (representative) {
      seen.add(representative.id);
      picked.push(representative);
    }
  }
  let index = 0;
  while (picked.length < count && pools.some((pool) => index < pool.length)) {
    for (const pool of pools) {
      const item = pool[index];
      if (
        item &&
        !seen.has(item.id) &&
        item.summary.opened >= 4
      ) {
        seen.add(item.id);
        picked.push(item);
        if (picked.length >= count) break;
      }
    }
    index += 1;
  }
  return picked;
}

function stressVariants(finalists, stage2ById) {
  const variants = [];
  const stresses = [
    ['base', {}],
    ['lat3', { latencyTicks: 3 }],
    ['lat5', { latencyTicks: 5 }],
    ['depth50', { depthFraction: 0.5 }],
    ['depth25', { depthFraction: 0.25 }],
    ['payout995', { winnerPayout: 0.995 }],
    [
      'fees125-buffer5',
      {
        feeRate: FEE_RATE * 1.25,
        operationalBufferPerPair: 0.005,
      },
    ],
  ];
  for (const finalist of finalists) {
    const original = stage2ById.get(finalist.id);
    for (const [stress, overrides] of stresses) {
      variants.push({
        ...original,
        ...overrides,
        id: `${original.id}|stress=${stress}`,
        notes: `${original.notes}; validation stress ${stress}`,
        campaign: {
          ...original.campaign,
          stress,
          parentId: original.id,
        },
      });
    }
  }
  return variants;
}

function baseValidationVariants(finalists, stage2ById) {
  return finalists.map((finalist) => {
    const original = stage2ById.get(finalist.id);
    return {
      ...original,
      id: `${original.id}|stress=base`,
      notes: `${original.notes}; retrospective base`,
      campaign: {
        ...original.campaign,
        stress: 'base',
        parentId: original.id,
      },
    };
  });
}

function markdown(report) {
  const lines = [
    '# PTB-Path exhaustive campaign',
    '',
    `Generated: ${report.generatedAt}`,
    `Discovery: ${report.discovery.window.from}..${report.discovery.window.to}`,
    `Retrospective validation: ${report.validation.window.from}..${report.validation.window.to}`,
    '',
    '## Discovery funnel',
    '',
    `- Stage 1 variants: ${report.discovery.stage1.nVariants}`,
    `- Stage 2 variants: ${report.discovery.stage2.nVariants}`,
    `- Finalists stress-tested: ${report.validation.nParents}`,
    '',
    '## Day-29 finalists',
    '',
    '| id | pnl | PF | opens | eq% | worst | min4h | score |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...report.discovery.finalists.map((item) =>
      `| \`${item.id}\` | ${item.conservative.pnl} | ${item.conservative.profitFactor} | ${item.summary.opened} | ${item.summary.equalizeRatePct} | ${item.worstResolved} | ${item.minBlockPnl} | ${item.robustScore} |`,
    ),
    '',
    '## Earlier-lake validation (base stress)',
    '',
    '| parent | pnl | PF | opens | eq% | worst | months+ | bootstrap p05 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...report.validation.parents.map((item) => {
      const positiveMonths = Object.values(item.base.byMonthConservative).filter(
        (month) => month.pnl > 0,
      ).length;
      return `| \`${item.parentId}\` | ${item.base.conservative.pnl} | ${item.base.conservative.profitFactor} | ${item.base.summary.opened} | ${item.base.summary.equalizeRatePct} | ${item.base.worstResolved} | ${positiveMonths}/${Object.keys(item.base.byMonthConservative).length} | ${item.base.bootstrap?.pnlP05} |`;
    }),
    '',
    '## Stress matrix',
    '',
    '| parent | stress | pnl | PF | opens | worst |',
    '|---|---|---:|---:|---:|---:|',
    ...report.validation.parents.flatMap((parent) =>
      parent.stresses.map(
        (item) =>
          `| \`${parent.parentId}\` | ${item.campaign.stress} | ${item.conservative.pnl} | ${item.conservative.profitFactor} | ${item.summary.opened} | ${item.worstResolved} |`,
      ),
    ),
    '',
    '## Interpretation boundary',
    '',
    '- Day 29 is discovery/in-sample, not a clean holdout.',
    '- Earlier dates are retrospective falsification, not a future forward test.',
    '- No result in this report authorizes live orders.',
    `- Winner source: ${report.model.settlement}.`,
    '',
  ];
  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const stage1Variants = buildStage1();
  console.log(`stage1 variants=${stage1Variants.length}`);
  const stage1Run = await runPtbSweep({
    variants: stage1Variants,
    from: DISCOVERY_FROM,
    to: DISCOVERY_TO,
    onDayProgress: ({ day, eligibleEvents }) =>
      console.log(`stage1 ${day} eligible=${eligibleEvents}`),
  });
  const stage1Evaluations = stage1Variants
    .map((variant) =>
      evaluate(variant, stage1Run.results.get(variant.id)),
    )
    .sort(discoverySort);
  const entrySeeds = uniqueEntries(stage1Evaluations, 6);

  const stage2Variants = buildStage2(entrySeeds);
  console.log(`stage2 entries=${entrySeeds.length} variants=${stage2Variants.length}`);
  const stage2Run = await runPtbSweep({
    variants: stage2Variants,
    from: DISCOVERY_FROM,
    to: DISCOVERY_TO,
    onDayProgress: ({ day, eligibleEvents }) =>
      console.log(`stage2 ${day} eligible=${eligibleEvents}`),
  });
  const stage2Evaluations = stage2Variants
    .map((variant) =>
      evaluate(variant, stage2Run.results.get(variant.id), {
        bootstrapEnabled: true,
      }),
    )
    .sort(discoverySort);
  const finalists = pickFinalists(stage2Evaluations, FINALISTS);
  const stage2ById = new Map(stage2Variants.map((variant) => [variant.id, variant]));

  const validationBaseVariants = baseValidationVariants(finalists, stage2ById);
  console.log(`validation base variants=${validationBaseVariants.length}`);
  const validationBaseRun = await runPtbSweep({
    variants: validationBaseVariants,
    from: VALIDATION_FROM,
    to: VALIDATION_TO,
    onDayProgress: ({ dayIndex, day, daysTotal, eligibleEvents }) => {
      if (
        dayIndex === 0 ||
        dayIndex === daysTotal - 1 ||
        (dayIndex + 1) % 10 === 0
      ) {
        console.log(
          `validation [${dayIndex + 1}/${daysTotal}] ${day} eligible=${eligibleEvents}`,
        );
      }
    },
  });
  const validationBaseEvaluations = validationBaseVariants.map((variant) =>
    evaluate(variant, validationBaseRun.results.get(variant.id), {
      bootstrapEnabled: true,
    }),
  );
  const survivors = validationBaseEvaluations.filter((item) => {
    const positiveMonths = Object.values(item.byMonthConservative).filter(
      (month) => month.pnl > 0,
    ).length;
    return (
      item.conservative.pnl > 0 &&
      (item.conservative.profitFactor === 'Infinity' ||
        Number(item.conservative.profitFactor) > 1) &&
      positiveMonths >=
        Math.max(1, Object.keys(item.byMonthConservative).length - 1)
    );
  });

  const survivorDiscovery = finalists.filter((item) =>
    survivors.some((survivor) => survivor.campaign.parentId === item.id),
  );
  const validationStressVariants = stressVariants(
    survivorDiscovery,
    stage2ById,
  ).filter((variant) => variant.campaign.stress !== 'base');
  let validationStressEvaluations = [];
  if (validationStressVariants.length) {
    console.log(`validation stress variants=${validationStressVariants.length}`);
    const validationStressRun = await runPtbSweep({
      variants: validationStressVariants,
      from: VALIDATION_FROM,
      to: VALIDATION_TO,
      onDayProgress: ({ dayIndex, day, daysTotal, eligibleEvents }) => {
        if (
          dayIndex === 0 ||
          dayIndex === daysTotal - 1 ||
          (dayIndex + 1) % 10 === 0
        ) {
          console.log(
            `stress [${dayIndex + 1}/${daysTotal}] ${day} eligible=${eligibleEvents}`,
          );
        }
      },
    });
    validationStressEvaluations = validationStressVariants.map((variant) =>
      evaluate(variant, validationStressRun.results.get(variant.id)),
    );
  }
  const validationEvaluations = [
    ...validationBaseEvaluations,
    ...validationStressEvaluations,
  ];

  const parents = finalists.map((finalist) => {
    const stresses = validationEvaluations
      .filter((item) => item.campaign.parentId === finalist.id)
      .sort((a, b) => a.campaign.stress.localeCompare(b.campaign.stress));
    return {
      parentId: finalist.id,
      discovery: finalist,
      base: stresses.find((item) => item.campaign.stress === 'base'),
      stresses,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    model: {
      dataset: 'backtest_ticks BTC 5m depth25',
      feeRate: FEE_RATE,
      operationalBufferPerPair: OPERATIONAL_BUFFER_PER_PAIR,
      fill: 'future-tick limit + depth walk + partial/miss',
      settlement: `${CANONICAL.source} (${Object.keys(CANONICAL.winners).length} Gamma-resolved research labels; not full CLOB/on-chain finality; proxy fallback only when absent)`,
    },
    discovery: {
      window: { from: DISCOVERY_FROM, to: DISCOVERY_TO },
      eligibleEvents: stage1Run.eligibleEvents,
      stage1: {
        nVariants: stage1Variants.length,
        top: stage1Evaluations.slice(0, 50),
      },
      stage2: {
        nVariants: stage2Variants.length,
        entrySeeds,
        top: stage2Evaluations.slice(0, 100),
      },
      finalists,
    },
    validation: {
      window: { from: VALIDATION_FROM, to: VALIDATION_TO },
      eligibleEvents: validationBaseRun.eligibleEvents,
      expectedEventsAt288PerDay: validationBaseRun.days.length * 288,
      nVariants:
        validationBaseVariants.length + validationStressVariants.length,
      nParents: parents.length,
      survivors: survivors.map((item) => item.campaign.parentId),
      parents,
    },
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), markdown(report));
  console.log(`saved ${path.join(OUT_DIR, 'report.json')}`);
  console.log(`saved ${path.join(OUT_DIR, 'REPORT.md')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
