/**
 * Replay Pair-Path V0 against baliza series ticks (offline).
 *
 *   node labs/sandbox/pair-path-v0/replay-series.mjs
 *   node labs/sandbox/pair-path-v0/replay-series.mjs --series .tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const args = process.argv.slice(2);
function argVal(name, fb) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fb;
}

const seriesDefault = path.join(
  ROOT,
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
);
const seriesDir = path.resolve(argVal('series', seriesDefault));
const presetPath = path.resolve(
  argVal('preset', path.join(__dirname, 'presets/v0.json')),
);

function loadPreset() {
  if (!fs.existsSync(presetPath)) return { ...DEFAULT_PARAMS };
  const j = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
  return { ...DEFAULT_PARAMS, ...(j.params || j) };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function listEvents(dir) {
  const eventsDir = path.join(dir, 'events');
  if (!fs.existsSync(eventsDir)) return [];
  return fs
    .readdirSync(eventsDir)
    .filter((n) => fs.existsSync(path.join(eventsDir, n, 'ticks.jsonl')))
    .sort();
}

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const pct = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return {
    n: s.length,
    min: s[0],
    p50: pct(50),
    p90: pct(90),
    max: s[s.length - 1],
    mean: Math.round((sum / s.length) * 1000) / 1000,
    sum: Math.round(sum * 100) / 100,
  };
}

function main() {
  const params = loadPreset();
  const slugs = listEvents(seriesDir);
  if (!slugs.length) {
    console.error(`no events in ${seriesDir}/events`);
    process.exit(1);
  }

  console.log('=== Pair-Path V0 replay ===');
  console.log(`series=${seriesDir}`);
  console.log(`events=${slugs.length}`);
  console.log(`params=${JSON.stringify(params)}`);
  console.log('');

  const rows = [];
  for (const slug of slugs) {
    const ticks = readJsonl(path.join(seriesDir, 'events', slug, 'ticks.jsonl'));
    const eng = createEventEngine(params, { slug });
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    const result = eng.finish(last);
    rows.push({ slug, ticks: ticks.length, ...result });
    console.log(
      `${slug} mode=${result.mode} open=${result.sideOpen || '-'} fills=${result.nFills}` +
        ` inv=${result.inv.UP.shares}/${result.inv.DOWN.shares}` +
        ` avgSum=${result.avgSum ?? '-'} worst=${result.worstPnl}` +
        ` pnl≈${result.pnl ?? 'n/a'} (win=${result.winner || '?'})` +
        ` invested=${result.invested}` +
        ` blocks=${JSON.stringify(result.blockCounts)}`,
    );
  }

  const traded = rows.filter((r) => r.nFills > 0);
  const pnls = traded.map((r) => r.pnl).filter((x) => x != null);
  const worsts = rows.map((r) => r.worstPnl);
  const avgSums = traded.map((r) => r.avgSum).filter((x) => x != null);
  const invested = rows.map((r) => r.invested);

  const report = {
    generatedAt: new Date().toISOString(),
    seriesDir,
    params,
    nEvents: rows.length,
    nTraded: traded.length,
    nSkip: rows.length - traded.length,
    pnl: stats(pnls),
    worstPnl: stats(worsts),
    avgSumWhenTraded: stats(avgSums),
    invested: stats(invested),
    modes: rows.reduce((m, r) => {
      m[r.mode] = (m[r.mode] || 0) + 1;
      return m;
    }, {}),
    events: rows.map((r) => ({
      slug: r.slug,
      mode: r.mode,
      sideOpen: r.sideOpen,
      fills: r.nFills,
      avgSum: r.avgSum,
      worstPnl: r.worstPnl,
      pnl: r.pnl,
      winner: r.winner,
      invested: r.invested,
      residual: r.residual,
      blockCounts: r.blockCounts,
      openAttempts: r.openAttempts,
    })),
  };

  const outDir = path.join(seriesDir, 'pair-path-v0-replay');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log('========== V0 REPLAY SUMMARY ==========');
  console.log(`traded ${report.nTraded}/${report.nEvents}  skip ${report.nSkip}`);
  console.log('modes', report.modes);
  console.log('pnl', report.pnl);
  console.log('worstPnl', report.worstPnl);
  console.log('avgSum (traded)', report.avgSumWhenTraded);
  console.log('invested', report.invested);
  console.log(`saved ${outPath}`);
  console.log('=======================================');
}

main();
