/**
 * Etapa 6: seleção — quando Doggy opera vs quando o lab entra.
 * Cruza slugs lake 24–25 + activity Doggy + replay lab path G.
 *
 * Usage:
 *   node labs/sandbox/doggy-selection-filters.mjs [--days=2026-07-24,2026-07-25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const OUT = path.resolve('.tmp/pair-ladder-re');
const args = new Set(process.argv.slice(2));
const daysArg = [...args].find((a) => a.startsWith('--days='));
const days = daysArg
  ? daysArg.slice('--days='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : ['2026-07-24', '2026-07-25'];

fs.mkdirSync(OUT, { recursive: true });

function q(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))];
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function frac(a, b) {
  return b ? a / b : null;
}
function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}
function utcDay(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}
function toIso(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}
function distStats(arr) {
  if (!arr.length) return null;
  return {
    n: arr.length,
    mean: mean(arr),
    med: q(arr, 0.5),
    p10: q(arr, 0.1),
    p90: q(arr, 0.9),
  };
}

const code = fs.readFileSync('labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js', 'utf8');
const exp = new Function(`${code}\nreturn __pairLadderCompleteSetExports;`)();

const LAB_PARAMS = {
  fillMode: 'taker',
  spreadCents: 0,
  slippageCents: -1,
  seedHedgeSameTick: false,
  forbidOverweight: true,
  softLockAllowVacuum: true,
  softLockAllowBuild: true,
  hedgePreferAsk: 0.5,
  minSecToHedge: 5,
  hedgeTargetAvgSum: 0.99,
  maxResidualShares: 150,
  maxEventNotional: 600,
  maxFillsPerEvent: 16,
  maxSharesPerSide: 800,
  refuseAvgSum: 1.0,
  stopAvgSum: 0.95,
  stopMinBalance: 0.9,
  openMinAsk: 0.45,
  openMaxAsk: 0.58,
  maxSecToOpen: 30,
};

function buildDoggyEvents(rows) {
  const trades = rows.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
  const redeems = rows.filter((r) => r.type === 'REDEEM' && /btc-updown-5m/i.test(r.slug || ''));
  const redeemBy = new Map();
  for (const r of redeems) {
    if (!redeemBy.has(r.slug)) redeemBy.set(r.slug, { usdc: 0, outcome: r.outcome });
    const x = redeemBy.get(r.slug);
    x.usdc += r.usdcSize || 0;
    x.outcome = r.outcome || x.outcome;
  }
  const bySlug = new Map();
  for (const t of trades) {
    const d = utcDay(t.timestamp);
    if (!days.includes(d)) continue;
    if (!bySlug.has(t.slug)) bySlug.set(t.slug, []);
    bySlug.get(t.slug).push({
      ts: t.timestamp,
      price: t.price,
      size: t.size,
      outcome: String(t.outcome || '').toLowerCase().includes('up') ? 'Up' : 'Down',
      usdc: t.usdcSize,
    });
  }
  const events = [];
  for (const [slug, fills] of bySlug) {
    fills.sort((a, b) => a.ts - b.ts || a.price - b.price);
    const start = eventStartFromSlug(slug);
    let upS = 0; let downS = 0; let upC = 0; let downC = 0;
    for (const f of fills) {
      if (f.outcome === 'Up') { upS += f.size; upC += f.price * f.size; }
      else { downS += f.size; downC += f.price * f.size; }
    }
    const redeem = redeemBy.get(slug);
    const buyUsdc = fills.reduce((s, f) => s + f.usdc, 0);
    const avgUp = upS > 0 ? upC / upS : null;
    const avgDown = downS > 0 ? downC / downS : null;
    events.push({
      slug,
      start,
      day: start != null ? utcDay(start) : null,
      nFills: fills.length,
      firstPx: fills[0].price,
      firstOutcome: fills[0].outcome,
      secFirst: start != null ? fills[0].ts - start : null,
      hedge: (() => {
        const f0 = fills[0];
        const f1 = fills.find((f) => f.outcome !== f0.outcome);
        if (!f1) return null;
        return { px: f1.price, gap: f1.ts - f0.ts, pairSum: f0.price + f1.price };
      })(),
      avgSum: avgUp != null && avgDown != null ? avgUp + avgDown : null,
      residual: Math.abs(upS - downS),
      buyUsdc,
      redeemUsdc: redeem?.usdc ?? null,
      pnl: redeem ? redeem.usdc - buyUsdc : null,
      fills,
    });
  }
  return events;
}

async function loadLakeOpenFeatures(day) {
  const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
  if (!fs.existsSync(dir)) return { ticks: [], features: new Map() };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.join(dir, f));
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;
  const ticks = (await c.runAndReadAll(`
    SELECT ts, event_start, event_end, condition_id, underlying_price, price_to_beat, coverage,
           up_best_ask, up_best_bid, down_best_ask, down_best_bid
    FROM read_parquet(${pql})
    WHERE coverage >= 0.99
    ORDER BY ts
  `)).getRowObjectsJS();

  // Per event: features in first 30s
  const byStart = new Map();
  for (const t of ticks) {
    const startMs = Date.parse(toIso(t.event_start));
    if (!Number.isFinite(startMs)) continue;
    const start = Math.floor(startMs / 1000);
    const tsMs = Date.parse(toIso(t.ts));
    const sec = (tsMs - startMs) / 1000;
    if (sec < 0 || sec > 30) continue;
    if (!byStart.has(start)) {
      byStart.set(start, {
        start,
        slug: `btc-updown-5m-${start}`,
        samples: 0,
        minUpAsk: Infinity,
        minDownAsk: Infinity,
        minEitherAsk: Infinity,
        maxEitherAsk: -Infinity,
        firstUpAsk: null,
        firstDownAsk: null,
        firstPairSum: null,
        minPairSum: Infinity,
        minSpreadUp: Infinity,
        minSpreadDown: Infinity,
        cheapSideCount: 0, // ticks where min(up,down) in [0.45,0.58]
      });
    }
    const f = byStart.get(start);
    const up = t.up_best_ask != null ? Number(t.up_best_ask) : null;
    const down = t.down_best_ask != null ? Number(t.down_best_ask) : null;
    const upBid = t.up_best_bid != null ? Number(t.up_best_bid) : null;
    const downBid = t.down_best_bid != null ? Number(t.down_best_bid) : null;
    f.samples += 1;
    if (up != null) {
      f.minUpAsk = Math.min(f.minUpAsk, up);
      if (f.firstUpAsk == null) f.firstUpAsk = up;
      if (upBid != null) f.minSpreadUp = Math.min(f.minSpreadUp, up - upBid);
    }
    if (down != null) {
      f.minDownAsk = Math.min(f.minDownAsk, down);
      if (f.firstDownAsk == null) f.firstDownAsk = down;
      if (downBid != null) f.minSpreadDown = Math.min(f.minSpreadDown, down - downBid);
    }
    if (up != null && down != null) {
      const either = Math.min(up, down);
      const eitherMax = Math.max(up, down);
      f.minEitherAsk = Math.min(f.minEitherAsk, either);
      f.maxEitherAsk = Math.max(f.maxEitherAsk, eitherMax);
      f.minPairSum = Math.min(f.minPairSum, up + down);
      if (f.firstPairSum == null) f.firstPairSum = up + down;
      if (either >= 0.45 && either <= 0.58) f.cheapSideCount += 1;
    }
  }

  const features = new Map();
  for (const [start, f] of byStart) {
    features.set(start, {
      ...f,
      minUpAsk: Number.isFinite(f.minUpAsk) ? f.minUpAsk : null,
      minDownAsk: Number.isFinite(f.minDownAsk) ? f.minDownAsk : null,
      minEitherAsk: Number.isFinite(f.minEitherAsk) ? f.minEitherAsk : null,
      maxEitherAsk: Number.isFinite(f.maxEitherAsk) ? f.maxEitherAsk : null,
      minPairSum: Number.isFinite(f.minPairSum) ? f.minPairSum : null,
      minSpreadUp: Number.isFinite(f.minSpreadUp) ? f.minSpreadUp : null,
      minSpreadDown: Number.isFinite(f.minSpreadDown) ? f.minSpreadDown : null,
      fracCheapSide: f.samples ? f.cheapSideCount / f.samples : null,
      openBandAvailable: f.minEitherAsk != null && f.minEitherAsk >= 0.45 && f.minEitherAsk <= 0.58,
      oppAtOpenIfPickCheap: (() => {
        if (f.firstUpAsk == null || f.firstDownAsk == null) return null;
        return f.firstUpAsk <= f.firstDownAsk ? f.firstDownAsk : f.firstUpAsk;
      })(),
    });
  }
  return { ticks, features };
}

function runLabDay(ticks) {
  const runner = exp.createBacktestRunner({ ...LAB_PARAMS });
  for (const t of ticks) {
    runner.processTick({
      ts: toIso(t.ts),
      event_start: toIso(t.event_start),
      event_end: toIso(t.event_end),
      condition_id: t.condition_id,
      btc_price: Number(t.underlying_price),
      price_to_beat: Number(t.price_to_beat),
      coverage: Number(t.coverage),
      degraded: false,
      up_best_ask: Number(t.up_best_ask),
      up_best_bid: Number(t.up_best_bid),
      down_best_ask: Number(t.down_best_ask),
      down_best_bid: Number(t.down_best_bid),
    });
  }
  const res = runner.finish();
  applyPolymarketFeesToBacktestResult(res, { category: 'crypto', takerRebateRate: 0.44 });
  const bySlug = new Map();
  for (const e of res.events) {
    const start = e.eventStart ? Math.floor(Date.parse(e.eventStart) / 1000) : null;
    if (start == null) continue;
    const slug = `btc-updown-5m-${start}`;
    bySlug.set(slug, {
      slug,
      start,
      entered: e.reason !== 'no_entry',
      reason: e.reason,
      avgSum: e.avgSum ?? null,
      residual: e.residual ?? null,
      fills: e.fillCount ?? 0,
      pnl: e.finalPnl ?? null,
      pnlBeforeFees: e.finalPnlBeforeFees ?? null,
      blockedByGate: e.blockedByGate ?? 0,
    });
  }
  return bySlug;
}

function cohortFeatureStats(rows, key) {
  const xs = rows.map((r) => r.feat?.[key]).filter((x) => x != null && Number.isFinite(x));
  return distStats(xs);
}

async function main() {
  const activity = JSON.parse(fs.readFileSync(path.join(OUT, 'doggy-activity-fresh.json'), 'utf8'));
  const doggyEvents = buildDoggyEvents(activity);
  const doggyBySlug = new Map(doggyEvents.map((e) => [e.slug, e]));

  const allRows = [];
  let labPnlAll = 0;
  let labPnlBoth = 0;
  let labPnlLabOnly = 0;

  for (const day of days) {
    process.stdout.write(`day ${day}\n`);
    const { ticks, features } = await loadLakeOpenFeatures(day);
    const labBySlug = runLabDay(ticks);

    const starts = new Set([...features.keys(), ...[...labBySlug.values()].map((e) => e.start)]);
    for (const start of starts) {
      const slug = `btc-updown-5m-${start}`;
      const dog = doggyBySlug.get(slug) || null;
      const lab = labBySlug.get(slug) || null;
      const feat = features.get(start) || null;
      const doggyTraded = Boolean(dog && dog.nFills > 0);
      const labEntered = Boolean(lab && lab.entered);
      let cohort = 'neither';
      if (doggyTraded && labEntered) cohort = 'both';
      else if (doggyTraded && !labEntered) cohort = 'doggy_only';
      else if (!doggyTraded && labEntered) cohort = 'lab_only';

      const row = {
        slug,
        start,
        day,
        cohort,
        doggyTraded,
        labEntered,
        doggy: dog
          ? {
            nFills: dog.nFills,
            firstPx: dog.firstPx,
            secFirst: dog.secFirst,
            avgSum: dog.avgSum,
            residual: dog.residual,
            pnl: dog.pnl,
            hedgeGap: dog.hedge?.gap ?? null,
            pairSum: dog.hedge?.pairSum ?? null,
          }
          : null,
        lab: lab
          ? {
            fills: lab.fills,
            avgSum: lab.avgSum,
            residual: lab.residual,
            pnl: lab.pnl,
            reason: lab.reason,
          }
          : null,
        feat,
      };
      allRows.push(row);
      if (labEntered && lab.pnl != null) {
        labPnlAll += lab.pnl;
        if (cohort === 'both') labPnlBoth += lab.pnl;
        if (cohort === 'lab_only') labPnlLabOnly += lab.pnl;
      }
    }
  }

  const cohorts = {
    both: allRows.filter((r) => r.cohort === 'both'),
    lab_only: allRows.filter((r) => r.cohort === 'lab_only'),
    doggy_only: allRows.filter((r) => r.cohort === 'doggy_only'),
    neither: allRows.filter((r) => r.cohort === 'neither'),
  };

  // Feature comparison: both vs lab_only (Doggy skipped)
  const featureKeys = [
    'minEitherAsk',
    'minPairSum',
    'firstPairSum',
    'oppAtOpenIfPickCheap',
    'fracCheapSide',
    'minSpreadUp',
    'minSpreadDown',
    'maxEitherAsk',
  ];
  const featureCompare = {};
  for (const key of featureKeys) {
    featureCompare[key] = {
      both: cohortFeatureStats(cohorts.both, key),
      lab_only: cohortFeatureStats(cohorts.lab_only, key),
      doggy_only: cohortFeatureStats(cohorts.doggy_only, key),
    };
  }

  // Doggy first-fill band when he trades
  const dogFirstPx = cohorts.both.concat(cohorts.doggy_only).map((r) => r.doggy?.firstPx).filter((x) => x != null);
  const dogSecFirst = cohorts.both.concat(cohorts.doggy_only).map((r) => r.doggy?.secFirst).filter((x) => x != null);
  const dogPairSum = cohorts.both.concat(cohorts.doggy_only).map((r) => r.doggy?.pairSum).filter((x) => x != null);

  // Counterfactual: if lab only entered "both" slugs, what PnL?
  // Also test simple filters on lab_only+both using open features
  const filterTests = [];
  const candidates = allRows.filter((r) => r.labEntered && r.lab?.pnl != null);

  function evalFilter(name, pred) {
    const kept = candidates.filter(pred);
    const skipped = candidates.filter((r) => !pred(r));
    filterTests.push({
      name,
      keptN: kept.length,
      skippedN: skipped.length,
      keptPnl: kept.reduce((s, r) => s + r.lab.pnl, 0),
      skippedPnl: skipped.reduce((s, r) => s + r.lab.pnl, 0),
      keptWr: frac(kept.filter((r) => r.lab.pnl > 0).length, kept.length),
      // alignment: among kept, share that Doggy also traded
      doggyOverlap: frac(kept.filter((r) => r.doggyTraded).length, kept.length),
    });
  }

  evalFilter('baseline_lab_all', () => true);
  evalFilter('only_doggy_slugs', (r) => r.doggyTraded);
  evalFilter('openBand_minEither_45_55', (r) => r.feat?.minEitherAsk != null && r.feat.minEitherAsk >= 0.45 && r.feat.minEitherAsk <= 0.55);
  evalFilter('openBand_minEither_45_58', (r) => r.feat?.openBandAvailable);
  evalFilter('minPairSum_lt_1.05', (r) => r.feat?.minPairSum != null && r.feat.minPairSum < 1.05);
  evalFilter('minPairSum_lt_1.02', (r) => r.feat?.minPairSum != null && r.feat.minPairSum < 1.02);
  evalFilter('oppAtOpen_le_0.55', (r) => r.feat?.oppAtOpenIfPickCheap != null && r.feat.oppAtOpenIfPickCheap <= 0.55);
  evalFilter('oppAtOpen_le_0.50', (r) => r.feat?.oppAtOpenIfPickCheap != null && r.feat.oppAtOpenIfPickCheap <= 0.50);
  evalFilter('fracCheap_ge_0.3', (r) => r.feat?.fracCheapSide != null && r.feat.fracCheapSide >= 0.3);
  evalFilter('fracCheap_ge_0.5', (r) => r.feat?.fracCheapSide != null && r.feat.fracCheapSide >= 0.5);
  evalFilter('band45_55_and_opp_le_55', (r) => (
    r.feat?.minEitherAsk != null && r.feat.minEitherAsk >= 0.45 && r.feat.minEitherAsk <= 0.55
    && r.feat?.oppAtOpenIfPickCheap != null && r.feat.oppAtOpenIfPickCheap <= 0.55
  ));
  evalFilter('band45_55_and_pair_lt_1.05', (r) => (
    r.feat?.minEitherAsk != null && r.feat.minEitherAsk >= 0.45 && r.feat.minEitherAsk <= 0.55
    && r.feat?.minPairSum != null && r.feat.minPairSum < 1.05
  ));

  // Event parity when both traded
  const bothComps = cohorts.both.filter((r) => r.doggy?.pnl != null && r.lab?.pnl != null).map((r) => ({
    slug: r.slug,
    doggyPnl: r.doggy.pnl,
    labPnl: r.lab.pnl,
    delta: r.lab.pnl - r.doggy.pnl,
    doggyAvg: r.doggy.avgSum,
    labAvg: r.lab.avgSum,
    doggyFills: r.doggy.nFills,
    labFills: r.lab.fills,
  }));

  const rules = [];
  rules.push(
    `Cohorts ${days.join('+')}: both=${cohorts.both.length} · lab_only=${cohorts.lab_only.length} · doggy_only=${cohorts.doggy_only.length} · neither=${cohorts.neither.length}.`,
  );
  rules.push(
    `Lab PnL (ask−1¢+Diamond): all=${labPnlAll.toFixed(0)} · on both-slugs=${labPnlBoth.toFixed(0)} · on lab_only=${labPnlLabOnly.toFixed(0)}.`,
  );
  const onlyDoggy = filterTests.find((f) => f.name === 'only_doggy_slugs');
  if (onlyDoggy) {
    rules.push(
      `Counterfactual só slugs Doggy: PnL lab ${onlyDoggy.keptPnl.toFixed(0)} (vs baseline ${filterTests[0].keptPnl.toFixed(0)}); skip lab_only remove ${onlyDoggy.skippedPnl.toFixed(0)}.`,
    );
  }
  // Pick best filter by keptPnl among those with doggyOverlap >= 0.7 and keptN >= 50
  const ranked = [...filterTests]
    .filter((f) => f.name !== 'baseline_lab_all')
    .sort((a, b) => b.keptPnl - a.keptPnl);
  if (ranked[0]) {
    rules.push(
      `Melhor filtro por PnL lab: ${ranked[0].name} → ${ranked[0].keptPnl.toFixed(0)} (n=${ranked[0].keptN}, overlap Doggy ${(ranked[0].doggyOverlap * 100).toFixed(0)}%).`,
    );
  }
  rules.push(
    `Doggy open: firstPx med ${q(dogFirstPx, 0.5)?.toFixed?.(3)} · secFirst med ${q(dogSecFirst, 0.5)} · pairSum med ${q(dogPairSum, 0.5)?.toFixed?.(3)}.`,
  );
  if (bothComps.length) {
    rules.push(
      `Paridade both (n=${bothComps.length}): med Δ lab−Doggy=${q(bothComps.map((c) => c.delta), 0.5)?.toFixed?.(2)} · med Doggy PnL=${q(bothComps.map((c) => c.doggyPnl), 0.5)?.toFixed?.(2)} · med lab=${q(bothComps.map((c) => c.labPnl), 0.5)?.toFixed?.(2)}.`,
    );
  }
  const loPair = featureCompare.minPairSum;
  if (loPair?.both && loPair?.lab_only) {
    rules.push(
      `minPairSum@30s: both med ${loPair.both.med?.toFixed?.(3)} vs lab_only med ${loPair.lab_only.med?.toFixed?.(3)}.`,
    );
  }
  const loOpp = featureCompare.oppAtOpenIfPickCheap;
  if (loOpp?.both && loOpp?.lab_only) {
    rules.push(
      `oppAsk@open (lado caro): both med ${loOpp.both.med?.toFixed?.(3)} vs lab_only med ${loOpp.lab_only.med?.toFixed?.(3)}.`,
    );
  }

  const summary = {
    asOf: new Date().toISOString(),
    days,
    labParams: LAB_PARAMS,
    counts: {
      both: cohorts.both.length,
      lab_only: cohorts.lab_only.length,
      doggy_only: cohorts.doggy_only.length,
      neither: cohorts.neither.length,
      doggyTraded: cohorts.both.length + cohorts.doggy_only.length,
      labEntered: cohorts.both.length + cohorts.lab_only.length,
    },
    labPnl: { all: labPnlAll, both: labPnlBoth, lab_only: labPnlLabOnly },
    doggyOpen: {
      firstPx: distStats(dogFirstPx),
      secFirst: distStats(dogSecFirst),
      pairSum: distStats(dogPairSum),
    },
    featureCompare,
    filterTests: filterTests.sort((a, b) => b.keptPnl - a.keptPnl),
    bothParity: {
      n: bothComps.length,
      medDelta: q(bothComps.map((c) => c.delta), 0.5),
      meanDelta: mean(bothComps.map((c) => c.delta)),
      medDoggyPnl: q(bothComps.map((c) => c.doggyPnl), 0.5),
      medLabPnl: q(bothComps.map((c) => c.labPnl), 0.5),
      doggyPnlSum: bothComps.reduce((s, c) => s + c.doggyPnl, 0),
      labPnlSum: bothComps.reduce((s, c) => s + c.labPnl, 0),
    },
    inferredRules: rules,
    sampleLabOnly: cohorts.lab_only.slice(0, 8).map((r) => ({
      slug: r.slug,
      labPnl: r.lab?.pnl,
      minEitherAsk: r.feat?.minEitherAsk,
      minPairSum: r.feat?.minPairSum,
      oppAtOpen: r.feat?.oppAtOpenIfPickCheap,
    })),
    sampleBoth: bothComps.slice(0, 8),
  };

  const canvas = {
    asOf: summary.asOf,
    days: summary.days,
    counts: summary.counts,
    labPnl: {
      all: Math.round(labPnlAll),
      both: Math.round(labPnlBoth),
      lab_only: Math.round(labPnlLabOnly),
    },
    filterTop: summary.filterTests.slice(0, 8).map((f) => ({
      name: f.name,
      keptN: f.keptN,
      keptPnl: Math.round(f.keptPnl),
      skippedPnl: Math.round(f.skippedPnl),
      overlap: f.doggyOverlap != null ? Math.round(f.doggyOverlap * 1000) / 10 : null,
      wr: f.keptWr != null ? Math.round(f.keptWr * 1000) / 10 : null,
    })),
    featureCompare: {
      minPairSum: {
        both: featureCompare.minPairSum.both?.med ?? null,
        lab_only: featureCompare.minPairSum.lab_only?.med ?? null,
      },
      oppAtOpen: {
        both: featureCompare.oppAtOpenIfPickCheap.both?.med ?? null,
        lab_only: featureCompare.oppAtOpenIfPickCheap.lab_only?.med ?? null,
      },
      minEitherAsk: {
        both: featureCompare.minEitherAsk.both?.med ?? null,
        lab_only: featureCompare.minEitherAsk.lab_only?.med ?? null,
      },
      fracCheap: {
        both: featureCompare.fracCheapSide.both?.med ?? null,
        lab_only: featureCompare.fracCheapSide.lab_only?.med ?? null,
      },
    },
    bothParity: {
      n: summary.bothParity.n,
      medDelta: summary.bothParity.medDelta,
      doggySum: Math.round(summary.bothParity.doggyPnlSum),
      labSum: Math.round(summary.bothParity.labPnlSum),
    },
    doggyOpen: summary.doggyOpen,
    rules,
  };

  fs.writeFileSync(path.join(OUT, 'doggy-selection-filters.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'doggy-selection-filters-canvas.json'), JSON.stringify(canvas, null, 2));
  fs.writeFileSync(path.join(OUT, 'doggy-selection-rows.json'), JSON.stringify(allRows.map((r) => ({
    slug: r.slug,
    day: r.day,
    cohort: r.cohort,
    doggyPnl: r.doggy?.pnl ?? null,
    labPnl: r.lab?.pnl ?? null,
    minEitherAsk: r.feat?.minEitherAsk ?? null,
    minPairSum: r.feat?.minPairSum ?? null,
    oppAtOpen: r.feat?.oppAtOpenIfPickCheap ?? null,
    fracCheap: r.feat?.fracCheapSide ?? null,
  })), null, 2));

  console.log(JSON.stringify({
    counts: summary.counts,
    labPnl: summary.labPnl,
    filterTop: summary.filterTests.slice(0, 10),
    featureCompare: canvas.featureCompare,
    bothParity: summary.bothParity,
    rules,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
