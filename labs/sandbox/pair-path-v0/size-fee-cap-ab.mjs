/**
 * size-fee-v0 × openCapCents A/B (sh20, avgSum 0.96, hedge 0.42).
 *
 *   node labs/sandbox/pair-path-v0/size-fee-cap-ab.mjs
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

const PRESET = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'presets/size-fee-v0.json'), 'utf8'),
);
const MECH = { ...PRESET.params };
delete MECH.openCapCents;

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

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    med: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
    mean: Math.round((sum / s.length) * 1000) / 1000,
    sum: Math.round(sum * 1000) / 1000,
  };
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
      sideOpen: r.sideOpen,
      fills: r.nFills,
      avgSum: r.avgSum,
      pnl: r.pnl ?? 0,
      worstPnl: r.worstPnl,
      invested: r.invested,
      openAttempts: r.openAttempts,
      blocks: r.blockCounts,
    });
  }
  const traded = rows.filter((r) => r.fills > 0);
  const pnls = traded.map((r) => r.pnl);
  const avgSums = traded.map((r) => r.avgSum).filter((x) => x != null);
  const missOpen = rows.reduce((a, r) => a + (r.blocks?.OPEN_MISS_CAP || 0), 0);
  return {
    capCents,
    nEvents: rows.length,
    nTraded: traded.length,
    nDone: rows.filter((r) => r.mode === 'done').length,
    nStuck: rows.filter((r) => r.mode === 'opened').length,
    nIdle: rows.filter((r) => r.mode === 'idle').length,
    totalPnl: Math.round(rows.reduce((a, r) => a + (r.pnl || 0), 0) * 1000) / 1000,
    pnlTraded: stats(pnls),
    avgSum: stats(avgSums),
    worstMin: rows.length ? Math.min(...rows.map((r) => r.worstPnl)) : 0,
    missOpenBlocks: missOpen,
    investedSum: Math.round(rows.reduce((a, r) => a + (r.invested || 0), 0) * 100) / 100,
    events: rows,
  };
}

function collectDirs() {
  const bySlug = new Map();
  for (const s of SERIES) {
    if (!fs.existsSync(s)) continue;
    for (const d of listEventDirs(s)) bySlug.set(path.basename(d), d);
  }
  return [...bySlug.values()].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function printDiff(r1, r2) {
  console.log(`--- deltas cap+${r1.capCents} → cap+${r2.capCents} ---`);
  let gained = 0;
  let lost = 0;
  let pnlDelta = 0;
  for (let i = 0; i < r1.events.length; i++) {
    const a = r1.events[i];
    const b = r2.events[i];
    const dPnl = (b.pnl || 0) - (a.pnl || 0);
    pnlDelta += dPnl;
    if (a.fills === 0 && b.fills > 0) gained += 1;
    if (a.fills > 0 && b.fills === 0) lost += 1;
    if (a.fills !== b.fills || a.mode !== b.mode || Math.abs(dPnl) > 1e-6) {
      console.log(
        `  ${a.slug}: +${r1.capCents} mode=${a.mode} fills=${a.fills} pnl=${a.pnl} avg=${a.avgSum ?? '-'} miss=${a.blocks?.OPEN_MISS_CAP || 0}` +
          ` | +${r2.capCents} mode=${b.mode} fills=${b.fills} pnl=${b.pnl} avg=${b.avgSum ?? '-'} miss=${b.blocks?.OPEN_MISS_CAP || 0}` +
          ` | Δpnl=${Math.round(dPnl * 1000) / 1000}`,
      );
    }
  }
  console.log(
    `new entries=${gained} lost entries=${lost} Δpnl_total=${Math.round(pnlDelta * 1000) / 1000}`,
  );
}

function main() {
  const dirs = collectDirs();
  console.log('=== size-fee-v0 × Cap A/B ===');
  console.log(`events=${dirs.length}`);
  console.log(
    `mech: sh${MECH.openShares} band ${MECH.openAskLo}-${MECH.openAskHi} trig${MECH.openTriggerCents}` +
      ` avgSumMax${MECH.avgSumMax} hedge${MECH.hedgeAskMax} fee${MECH.feeRate} notional${MECH.maxEventNotional}`,
  );
  console.log('');

  const results = [1, 2, 3].map((c) => runCap(c, dirs));
  for (const r of results) {
    console.log(
      `cap+${r.capCents}¢  traded=${r.nTraded}/${r.nEvents} done=${r.nDone} stuck=${r.nStuck} idle=${r.nIdle}` +
        ` pnl=${r.totalPnl} avgSumMed=${r.avgSum?.med ?? '-'} worst=${r.worstMin}` +
        ` OPEN_MISS=${r.missOpenBlocks} invested=${r.investedSum}`,
    );
  }
  console.log('');
  printDiff(results[0], results[1]);
  console.log('');
  printDiff(results[1], results[2]);

  const r1 = results[0];
  const r2 = results[1];
  const recommendation =
    r2.nStuck === 0 &&
    r2.worstMin >= Math.min(0, r1.worstMin) - 0.05 &&
    r2.nTraded > r1.nTraded &&
    r2.totalPnl >= r1.totalPnl - 0.25
      ? 'prefer_size_fee_cap2'
      : r2.totalPnl > r1.totalPnl && r2.nStuck === 0
        ? 'cap2_better_pnl'
        : r2.nTraded > r1.nTraded && r2.worstMin >= -0.2
          ? 'cap2_more_entries_ok'
          : 'keep_size_fee_cap1';

  const out = {
    generatedAt: new Date().toISOString(),
    preset: PRESET.id,
    nEvents: dirs.length,
    mech: MECH,
    results: results.map(({ events, ...sum }) => ({
      ...sum,
      events,
    })),
    deltaCap1to2: {
      traded: r2.nTraded - r1.nTraded,
      pnl: Math.round((r2.totalPnl - r1.totalPnl) * 1000) / 1000,
      missOpen: r2.missOpenBlocks - r1.missOpenBlocks,
      worstMin: r2.worstMin - r1.worstMin,
    },
    recommendation,
  };

  const outDir = path.join(ROOT, '.tmp/pair-path-v0-size-fee-cap-ab');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(out, null, 2));
  console.log('');
  console.log('recommendation:', recommendation);
  console.log('saved', path.join(outDir, 'report.json'));
}

main();
