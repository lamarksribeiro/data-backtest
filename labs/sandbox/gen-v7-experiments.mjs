import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join('labs', 'strategies', 'terminal', 'tfc', 'experiments');

const V5 = {
  walletSize: 100,
  entryBudget: 10,
  minSecondsLeft: 5,
  maxSecondsLeft: 30,
  maxDistAbs: 20,
  minAsk: 0.55,
  maxAsk: 0.82,
  maxSpread: 0.03,
  minOddsSum: 0.98,
  maxOddsSum: 1.06,
  minFlips: 0,
  flipWindowSecs: 60,
  stopIfCrossed: false,
  stopCrossDist: 0,
  stopMinBid: 0.05,
  lateFlipExitEnabled: true,
  lateFlipExitSec: 8,
  lateFlipExitCrossDist: 0,
  lateFlipMinSec: 4,
  lateFlipReverseEnabled: true,
  lateFlipReverseMaxAsk: 0.95,
  lateFlipReverseMinAsk: 0.0,
  lateFlipConfirmEnabled: false,
  velocityLookbackSecs: 5,
  maxAdverseSpotChange: 8.0,
  minObi: 0.0,
  obiLevels: 5,
  entryMakerEnabled: false,
  dangerExitEnabled: false,
};

function shell(name, from, to, variants) {
  return {
    name,
    strategyId: 'tfc',
    strategyFamily: 'terminal',
    dataset: 'backtest_ticks',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    from,
    to,
    engine: 'soa',
    glsExecution: 'compiled-soa',
    fastRun: true,
    dailyMetrics: true,
    variantWorkers: 4,
    defaults: '../defaults.json',
    searchSpace: { variants },
  };
}

function write(name, from, to, variants) {
  const file = path.join(OUT, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(shell(name, from, to, variants), null, 2)}\n`);
  return file;
}

function m1Variants() {
  const variants = [{ id: 'v5-practical-baseline', params: { ...V5 } }];
  for (const delta of [0.01, 0.02]) {
    for (const deadline of [8, 10, 12]) {
      for (const fallback of [true, false]) {
        variants.push({
          id: `m1-d${delta}-dl${deadline}-fb${fallback ? 1 : 0}`,
          params: {
            ...V5,
            entryMakerEnabled: true,
            entryMakerDelta: delta,
            entryMakerDeadlineSec: deadline,
            entryMakerChase: 0.02,
            entryMakerFallbackTaker: fallback,
          },
        });
      }
    }
  }
  return variants;
}

function m1bVariants() {
  const variants = [{ id: 'v5-practical-baseline', params: { ...V5 } }];
  for (const maxSec of [12, 15, 20, 30]) {
    variants.push({
      id: `m1b-maxsec-${maxSec}`,
      params: { ...V5, maxSecondsLeft: maxSec },
    });
  }
  return variants;
}

function m2Variants() {
  const variants = [{ id: 'v5-practical-baseline', params: { ...V5 } }];
  for (const maxAsk of [0.80, 0.85, 0.88, 0.95]) {
    for (const minRevAsk of [0.0, 0.55]) {
      variants.push({
        id: `m2-rev-${maxAsk}-c0-m${String(minRevAsk).replace('.', '')}`,
        params: {
          ...V5,
          lateFlipReverseMaxAsk: maxAsk,
          lateFlipConfirmEnabled: false,
          lateFlipReverseMinAsk: minRevAsk,
        },
      });
      variants.push({
        id: `m2-rev-${maxAsk}-c1-m${String(minRevAsk).replace('.', '')}`,
        params: {
          ...V5,
          lateFlipReverseMaxAsk: maxAsk,
          lateFlipConfirmEnabled: true,
          lateFlipVelLookbackSecs: 5,
          lateFlipMinAdverseMove: 2,
          lateFlipReverseMinAsk: minRevAsk,
        },
      });
    }
  }
  return variants;
}

function m3Variants() {
  const variants = [{ id: 'v5-practical-baseline', params: { ...V5 } }];
  for (const k of [0.3, 0.5, 0.8]) {
    variants.push({
      id: `m3-danger-k${String(k).replace('.', '')}`,
      params: {
        ...V5,
        dangerExitEnabled: true,
        dangerExitK: k,
        dangerExitFloorSec: 4,
      },
    });
  }
  return variants;
}

function m4Variants() {
  const variants = [{ id: 'v5-practical-baseline', params: { ...V5 } }];
  for (const budget of [10, 15, 20, 25]) {
    variants.push({
      id: `m4-budget-${budget}`,
      params: {
        ...V5,
        walletSize: budget === 10 ? 100 : 250,
        entryBudget: budget,
      },
    });
  }
  return variants;
}

const windows = [
  ['train', '2026-05-04', '2026-05-31'],
  ['june', '2026-06-01', '2026-07-01'],
];

const files = [];
for (const [split, from, to] of windows) {
  files.push(write(`v7-m1-maker-${split}`, from, to, m1Variants()));
  files.push(write(`v7-m1b-late-entry-${split}`, from, to, m1bVariants()));
  files.push(write(`v7-m2-reverse-${split}`, from, to, m2Variants()));
  files.push(write(`v7-m3-danger-${split}`, from, to, m3Variants()));
  files.push(write(`v7-m4-sizing-${split}`, from, to, m4Variants()));
}

console.log(files.join('\n'));
