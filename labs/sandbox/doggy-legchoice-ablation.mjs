/**
 * Etapa 9: ablação A/B legChoice min_avg_sum vs chase_momo (both 24–25).
 *
 * Usage:
 *   node labs/sandbox/doggy-legchoice-ablation.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const OUT = path.resolve('.tmp/pair-ladder-re');
const days = ['2026-07-24', '2026-07-25'];
fs.mkdirSync(OUT, { recursive: true });

const code = fs.readFileSync('labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js', 'utf8');
const exp = new Function(`${code}\nreturn __pairLadderCompleteSetExports;`)();

const BASE = {
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
  maxEventNotional: 350,
  maxFillsPerEvent: 12,
  maxSharesPerSide: 500,
  refuseAvgSum: 1.0,
  stopAvgSum: 0.95,
  stopMinBalance: 0.9,
  openMinAsk: 0.45,
  openMaxAsk: 0.58,
  maxSecToOpen: 30,
  openShares: 50,
  hedgeShares: 100,
  clipShares: 100,
  lateClipShares: 50,
  lateStartSec: 180,
  lateMaxAsk: 0.15,
};

function toIso(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}
function q(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))];
}
function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}
function utcDay(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}
function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}

function buildDoggy(activity) {
  const trades = activity.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
  const redeems = activity.filter((r) => r.type === 'REDEEM' && /btc-updown-5m/i.test(r.slug || ''));
  const redeemBy = new Map();
  for (const r of redeems) {
    if (!redeemBy.has(r.slug)) redeemBy.set(r.slug, { usdc: 0 });
    redeemBy.get(r.slug).usdc += r.usdcSize || 0;
  }
  const bySlug = new Map();
  for (const t of trades) {
    if (!days.includes(utcDay(t.timestamp))) continue;
    if (!bySlug.has(t.slug)) bySlug.set(t.slug, { buyUsdc: 0, fills: 0 });
    const e = bySlug.get(t.slug);
    e.buyUsdc += t.usdcSize || 0;
    e.fills += 1;
  }
  const out = new Map();
  for (const [slug, e] of bySlug) {
    const redeem = redeemBy.get(slug);
    out.set(slug, {
      slug,
      start: eventStartFromSlug(slug),
      pnl: redeem ? redeem.usdc - e.buyUsdc : null,
      fills: e.fills,
    });
  }
  return out;
}

async function loadTicks(day) {
  const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.join(dir, f));
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;
  return (await c.runAndReadAll(`
    SELECT ts, event_start, event_end, condition_id, underlying_price, price_to_beat, coverage,
           up_best_ask, up_best_bid, down_best_ask, down_best_bid
    FROM read_parquet(${pql}) WHERE coverage >= 0.99 ORDER BY ts
  `)).getRowObjectsJS();
}

function runLab(ticks, params) {
  const runner = exp.createBacktestRunner({ ...BASE, ...params });
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
    const sources = {};
    for (const f of e.fills || []) {
      const s = f.source || 'unk';
      sources[s] = (sources[s] || 0) + 1;
    }
    bySlug.set(slug, {
      entered: e.reason !== 'no_entry',
      pnl: e.finalPnl ?? null,
      avgSum: e.avgSum ?? null,
      residual: e.residual ?? null,
      fills: e.fillCount ?? (e.fills?.length ?? 0),
      upShares: e.upShares ?? 0,
      downShares: e.downShares ?? 0,
      sources,
    });
  }
  return { summary: res.summary, bySlug };
}

async function main() {
  const activity = JSON.parse(fs.readFileSync(path.join(OUT, 'doggy-activity-fresh.json'), 'utf8'));
  const doggy = buildDoggy(activity);
  const ticksByDay = new Map();
  for (const day of days) {
    process.stdout.write(`load ${day}\n`);
    ticksByDay.set(day, await loadTicks(day));
  }

  const variants = [
    { name: 'min_avg_sum', params: { legChoice: 'min_avg_sum' } },
    { name: 'chase_momo', params: { legChoice: 'chase_momo' } },
    { name: 'chase_momo_rise3', params: { legChoice: 'chase_momo', momoMinRise: 0.03 } },
    { name: 'chase_momo_band4055', params: { legChoice: 'chase_momo', momoMinAsk: 0.40, momoMaxAsk: 0.55 } },
    { name: 'chase_momo_clip50', params: { legChoice: 'chase_momo', clipShares: 50 } },
  ];

  const results = [];
  for (const v of variants) {
    process.stdout.write(`run ${v.name}\n`);
    const merged = new Map();
    let totalPnl = 0;
    let entries = 0;
    const srcAll = {};
    for (const day of days) {
      const { bySlug, summary } = runLab(ticksByDay.get(day), v.params);
      for (const [slug, e] of bySlug) {
        merged.set(slug, e);
        for (const [s, n] of Object.entries(e.sources || {})) srcAll[s] = (srcAll[s] || 0) + n;
      }
      totalPnl += summary.totalPnl || 0;
      entries += summary.totalEntries || 0;
    }

    const both = [];
    for (const [slug, d] of doggy) {
      const lab = merged.get(slug);
      if (!lab?.entered || d.pnl == null || lab.pnl == null) continue;
      both.push({
        slug,
        doggyPnl: d.pnl,
        labPnl: lab.pnl,
        delta: lab.pnl - d.pnl,
        labAvg: lab.avgSum,
        labRes: lab.residual,
        labFills: lab.fills,
        momoFills: lab.sources?.momo || 0,
      });
    }

    results.push({
      name: v.name,
      params: v.params,
      totalPnl,
      entries,
      bothN: both.length,
      bothPnl: both.reduce((s, r) => s + r.labPnl, 0),
      doggyPnl: both.reduce((s, r) => s + r.doggyPnl, 0),
      medDelta: q(both.map((r) => r.delta), 0.5),
      meanDelta: mean(both.map((r) => r.delta)),
      medLabAvg: q(both.map((r) => r.labAvg).filter((x) => x != null), 0.5),
      medLabRes: q(both.map((r) => r.labRes).filter((x) => x != null), 0.5),
      medLabFills: q(both.map((r) => r.labFills), 0.5),
      momoFillTotal: both.reduce((s, r) => s + r.momoFills, 0),
      sources: srcAll,
      wr: both.length ? both.filter((r) => r.labPnl > 0).length / both.length : null,
    });
  }

  results.sort((a, b) => b.bothPnl - a.bothPnl);
  const base = results.find((r) => r.name === 'min_avg_sum');
  const best = results[0];

  const rules = [
    `Baseline min_avg_sum bothPnL=${base?.bothPnl?.toFixed?.(0)} medΔ=${base?.medDelta?.toFixed?.(1)} avgSum med=${base?.medLabAvg?.toFixed?.(3)}.`,
    `Melhor variante: ${best.name} bothPnL=${best.bothPnl.toFixed(0)} (Δ vs baseline ${(best.bothPnl - (base?.bothPnl || 0)).toFixed(0)}) medΔ=${best.medDelta?.toFixed?.(1)}.`,
    `Doggy both Σ=${base?.doggyPnl?.toFixed?.(0)}. Gap restante best→Doggy=${(best.bothPnl - (base?.doggyPnl || 0)).toFixed(0)}.`,
    `momo fills (best): ${best.momoFillTotal}. Sources best: ${JSON.stringify(best.sources)}.`,
    best.bothPnl > (base?.bothPnl || -Infinity) + 100
      ? 'chase_momo material vs min_avg_sum — candidata a preset research.'
      : 'chase_momo não fechou gap material no lake 1Hz — seleção Doggy ainda acima do sinal público.',
  ];

  const summary = {
    asOf: new Date().toISOString(),
    days,
    base: BASE,
    results,
    rules,
  };
  fs.writeFileSync(path.join(OUT, 'doggy-legchoice-ablation.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    results: results.map((r) => ({
      name: r.name,
      bothPnl: Math.round(r.bothPnl),
      totalPnl: Math.round(r.totalPnl),
      medDelta: r.medDelta != null ? Math.round(r.medDelta * 10) / 10 : null,
      medLabAvg: r.medLabAvg != null ? Math.round(r.medLabAvg * 1000) / 1000 : null,
      momoFills: r.momoFillTotal,
      wr: r.wr != null ? Math.round(r.wr * 1000) / 10 : null,
      sources: r.sources,
    })),
    rules,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
