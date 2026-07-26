/**
 * Agrega shadow-lab / analyze de várias runs live-observer limpas.
 *
 * Usage:
 *   node labs/sandbox/doggy-shadow-lab-aggregate.mjs
 *   node labs/sandbox/doggy-shadow-lab-aggregate.mjs --rebuild
 *
 * --rebuild: re-roda doggy-shadow-lab + analyze em cada run com books-tick.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve('.tmp/pair-ladder-re/live-observer');
const OUT = path.resolve('.tmp/pair-ladder-re/doggy-shadow-lab-aggregate.json');
const rebuild = process.argv.includes('--rebuild');

function listCleanRuns() {
  return fs.readdirSync(ROOT)
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'fills.jsonl')))
    .filter((d) => !fs.existsSync(path.join(ROOT, d, 'CONTAMINATED.md')))
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'books-tick.jsonl')))
    .sort();
}

function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
function sum(a) {
  return a.reduce((s, x) => s + x, 0);
}

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const runs = listCleanRuns();
if (!runs.length) {
  console.error('no clean tick runs');
  process.exit(1);
}

if (rebuild) {
  for (const id of runs) {
    console.log('rebuild', id);
    spawnSync(process.execPath, ['labs/sandbox/doggy-live-analyze.mjs', `--run=${id}`], {
      cwd: path.resolve('.'),
      stdio: 'inherit',
    });
    spawnSync(process.execPath, ['labs/sandbox/doggy-shadow-lab.mjs', `--run=${id}`], {
      cwd: path.resolve('.'),
      stdio: 'inherit',
    });
  }
}

  const perRun = [];
for (const id of runs) {
  const dir = path.join(ROOT, id);
  const shadow = loadJson(path.join(dir, 'shadow-lab.json'));
  const analyze = loadJson(path.join(dir, 'analyze.json'));
  const summary = loadJson(path.join(dir, 'summary.json'));
  if (!shadow && !analyze) continue;
  const fillsN = shadow?.fillsN ?? analyze?.usableN ?? summary?.fillsBookMatchedN ?? 0;
  // Skip in-progress / empty matched runs
  if (!fillsN) continue;
  perRun.push({
    runId: id,
    fillsN,
    ticksN: shadow?.ticksN ?? analyze?.bookTicksN ?? null,
    edgeVsAskUsd: shadow?.doggyCheaperThanAskUsd ?? null,
    edgeVsAskM1Usd: shadow?.doggyCheaperThanAskM1Usd ?? null,
    edgeVsMin500Usd: shadow?.doggyCheaperThanMin500Usd ?? null,
    medFillAskC: shadow?.medFillMinusAskCents ?? analyze?.medFillMinusAskCents ?? null,
    medFillMin500C: shadow?.medFillMinusMin500Cents ?? analyze?.medFillMinusMinAsk500Cents ?? null,
    momoShare: analyze?.momoShare ?? null,
    midMomoPass: shadow?.midMomoPassShare ?? null,
    vacuumShare: analyze?.vacuumShare ?? null,
    spotLeadShare: analyze?.spotLeadShare ?? null,
    byPhase: analyze?.byPhase ?? shadow?.byPhase ?? null,
  });
}

if (!perRun.length) {
  console.error('no runs with matched fills yet');
  process.exit(1);
}

const agg = {
  asOf: new Date().toISOString(),
  runsN: perRun.length,
  runs: perRun,
  totals: {
    fillsN: sum(perRun.map((r) => r.fillsN || 0)),
    ticksN: sum(perRun.map((r) => r.ticksN || 0)),
    edgeVsAskUsd: +sum(perRun.map((r) => r.edgeVsAskUsd || 0)).toFixed(2),
    edgeVsAskM1Usd: +sum(perRun.map((r) => r.edgeVsAskM1Usd || 0)).toFixed(2),
    edgeVsMin500Usd: +sum(perRun.map((r) => r.edgeVsMin500Usd || 0)).toFixed(2),
  },
  medians: {
    medFillAskC: med(perRun.map((r) => r.medFillAskC).filter((x) => x != null)),
    medFillMin500C: med(perRun.map((r) => r.medFillMin500C).filter((x) => x != null)),
    momoShare: med(perRun.map((r) => r.momoShare).filter((x) => x != null)),
    midMomoPass: med(perRun.map((r) => r.midMomoPass).filter((x) => x != null)),
    vacuumShare: med(perRun.map((r) => r.vacuumShare).filter((x) => x != null)),
  },
};

agg.verdict = [
  `${agg.runsN} runs tick · ${agg.totals.fillsN} fills · edge vs minAsk±500ms Σ $${agg.totals.edgeVsMin500Usd}.`,
  `med fill−ask ${agg.medians.medFillAskC?.toFixed?.(2) ?? 'n/a'}¢ · med fill−min500 ${agg.medians.medFillMin500C?.toFixed?.(2) ?? 'n/a'}¢ · momo med ${agg.medians.momoShare != null ? (agg.medians.momoShare * 100).toFixed(0) + '%' : 'n/a'}.`,
  agg.totals.edgeVsMin500Usd > 50 && agg.runsN >= 2
    ? 'Fill quality consistente entre sessões — manter shadow live; lab 2Hz continua insuficiente.'
    : agg.runsN < 2
      ? 'Amostra ainda de 1 sessão — acumular ≥2–3 sessões ≥45min.'
      : 'Amostra ainda pequena/fraca — acumular ≥3 sessões ≥45min.',
];

fs.writeFileSync(OUT, JSON.stringify(agg, null, 2));
console.log(JSON.stringify(agg, null, 2));
console.log('wrote', OUT);
