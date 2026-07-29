/**
 * Offline A/B: openCapCents 1 vs 2 (and 3) on recorded tick journals.
 * Mechanics otherwise = size-fee-v0 (avgSum 0.96, hedge 0.42, band 52-62).
 *
 *   node labs/sandbox/pair-path-v0/cap-ab-offline.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const SERIES = [
  path.join(ROOT, '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8'),
  path.join(ROOT, '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow'),
  path.join(ROOT, '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow'),
];

const MECH = {
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTriggerCents: 55,
  avgSumMax: 0.96,
  eqAvgSumMax: 0.96,
  hedgeAskMax: 0.42,
  tauOpenMin: 40,
  tauOpenMax: 240,
  openShares: 10,
  feeRate: 0.07,
  maxEventNotional: 25,
  legChoice: 'chase',
};

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function listEventDirs(seriesDir) {
  const eventsDir = path.join(seriesDir, 'events');
  if (!fs.existsSync(eventsDir)) return [];
  return fs
    .readdirSync(eventsDir)
    .filter((n) => fs.existsSync(path.join(eventsDir, n, 'ticks.jsonl')))
    .sort()
    .map((n) => path.join(eventsDir, n));
}

function runCap(capCents, eventDirs) {
  const rows = [];
  for (const dir of eventDirs) {
    const slug = path.basename(dir);
    const ticks = readJsonl(path.join(dir, 'ticks.jsonl'));
    if (!ticks.length) continue;
    const eng = createEventEngine(
      { ...DEFAULT_PARAMS, ...MECH, openCapCents: capCents },
      { slug },
    );
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    const r = eng.finish(last);
    rows.push({
      slug,
      mode: r.mode,
      fills: r.nFills,
      avgSum: r.avgSum,
      pnl: r.pnl ?? 0,
      worstPnl: r.worstPnl,
      openAttempts: r.openAttempts,
      blocks: r.blockCounts,
    });
  }
  const traded = rows.filter((r) => r.fills > 0);
  const done = rows.filter((r) => r.mode === 'done');
  const totalPnl = rows.reduce((a, r) => a + (r.pnl || 0), 0);
  const missOpen = rows.reduce((a, r) => a + (r.blocks?.OPEN_MISS_CAP || 0), 0);
  return {
    capCents,
    nEvents: rows.length,
    nTraded: traded.length,
    nDone: done.length,
    nStuck: rows.filter((r) => r.mode === 'opened').length,
    totalPnl: Math.round(totalPnl * 1000) / 1000,
    missOpenBlocks: missOpen,
    avgSumMed: (() => {
      const xs = traded.map((r) => r.avgSum).filter((x) => x != null).sort((a, b) => a - b);
      if (!xs.length) return null;
      return xs[Math.floor(xs.length / 2)];
    })(),
    worstMin: rows.length ? Math.min(...rows.map((r) => r.worstPnl)) : 0,
    events: rows,
  };
}

function main() {
  const eventDirs = [];
  for (const s of SERIES) {
    if (fs.existsSync(s)) eventDirs.push(...listEventDirs(s));
  }
  // unique by slug
  const bySlug = new Map();
  for (const d of eventDirs) bySlug.set(path.basename(d), d);
  const dirs = [...bySlug.values()].sort();

  console.log('=== Cap A/B offline ===');
  console.log(`events=${dirs.length} series=${SERIES.filter((s) => fs.existsSync(s)).length}`);
  console.log(`mech: band 52-62 trig55 avgSumMax0.96 hedge0.42 sh10 fee0.07`);
  console.log('');

  const caps = [1, 2, 3];
  const results = caps.map((c) => runCap(c, dirs));

  for (const r of results) {
    console.log(
      `cap+${r.capCents}¢  traded=${r.nTraded}/${r.nEvents} done=${r.nDone} stuck=${r.nStuck}` +
        ` pnl=${r.totalPnl} avgSumMed=${r.avgSumMed} worst=${r.worstMin} OPEN_MISS_CAP_blocks=${r.missOpenBlocks}`,
    );
  }

  // per-event delta cap1 -> cap2
  const r1 = results[0];
  const r2 = results[1];
  console.log('');
  console.log('--- events where cap2 differs from cap1 ---');
  for (let i = 0; i < r1.events.length; i++) {
    const a = r1.events[i];
    const b = r2.events[i];
    if (a.fills !== b.fills || a.mode !== b.mode || Math.abs((a.pnl || 0) - (b.pnl || 0)) > 1e-6) {
      console.log(
        `  ${a.slug}: cap1 mode=${a.mode} fills=${a.fills} pnl=${a.pnl} miss=${a.blocks?.OPEN_MISS_CAP || 0}` +
          ` | cap2 mode=${b.mode} fills=${b.fills} pnl=${b.pnl} miss=${b.blocks?.OPEN_MISS_CAP || 0}`,
      );
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    nEvents: dirs.length,
    mech: MECH,
    results,
    recommendation:
      results[1].nTraded > results[0].nTraded && results[1].worstMin >= -1 && results[1].nStuck === 0
        ? 'prefer_cap2_for_more_entries'
        : results[1].totalPnl >= results[0].totalPnl && results[1].worstMin >= results[0].worstMin - 0.2
          ? 'cap2_acceptable'
          : 'keep_cap1_or_mixed',
  };

  const outDir = path.join(ROOT, '.tmp/pair-path-v0-cap-ab');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'cap-ab.json'), JSON.stringify(out, null, 2));
  console.log('');
  console.log('recommendation:', out.recommendation);
  console.log('saved', outDir);
}

main();
