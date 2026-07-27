/**
 * Etapa 16b — quando residual_hedge FADE vale a pena.
 *
 * Para cada fill underweight com dAsk≤−2¢ (ou phase build_fade), mede:
 *  - melhora avgSum? reduz |residual|?
 *  - avg já ≤0.95 (cushion)?
 *  - ask band / secInto
 * Counterfactual simples: se SKIP, inventário fica com residual maior.
 *
 * Usage:
 *   node labs/sandbox/doggy-residual-hedge-rules.mjs [--run=<id>|--latest]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.tmp/pair-ladder-re/live-observer');
const args = process.argv.slice(2);
const runArg = args.find((a) => a.startsWith('--run='))?.slice(6);
const latest = args.includes('--latest') || !runArg;

function pickRun() {
  if (!latest && runArg) return path.join(ROOT, runArg);
  const dirs = fs.readdirSync(ROOT)
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'fills.jsonl')))
    .filter((d) => !fs.existsSync(path.join(ROOT, d, 'CONTAMINATED.md')))
    .sort();
  return path.join(ROOT, dirs[dirs.length - 1]);
}

function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

function avgSum(cost, shares) {
  const u = shares.up;
  const d = shares.down;
  const q = Math.min(u, d);
  if (q <= 0) return null;
  return (cost.up + cost.down) / (u + d) * ((u + d) / q) * (q / (u + d));
  // simpler: total cost / total shares is wrong for pair; use cost per paired share:
  // avgSum ≈ (costUp/up + costDown/down) when both > 0? Doggy uses volume-weighted pair.
  // Use: (avgUp + avgDown) where avgSide = cost/shares
}
function sideAvg(cost, sh) {
  return sh > 0 ? cost / sh : null;
}
function pairAvgSum(cost, shares) {
  if (shares.up <= 0 || shares.down <= 0) return null;
  return sideAvg(cost.up, shares.up) + sideAvg(cost.down, shares.down);
}

function residual(shares) {
  return Math.abs(shares.up - shares.down);
}

const dir = pickRun();
const fills = fs.readFileSync(path.join(dir, 'fills.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((f) => f.bookMatched)
  .sort((a, b) => a.ts - b.ts || String(a.tx).localeCompare(String(b.tx)));

const bySlug = new Map();
for (const f of fills) {
  if (!bySlug.has(f.slug)) bySlug.set(f.slug, []);
  bySlug.get(f.slug).push(f);
}

const hedges = [];
for (const [slug, list] of bySlug) {
  const shares = { up: 0, down: 0 };
  const cost = { up: 0, down: 0 };
  let dual = false;
  for (const f of list) {
    const before = {
      shares: { ...shares },
      cost: { ...cost },
      avg: pairAvgSum(cost, shares),
      res: residual(shares),
      under: shares.up <= shares.down ? 'Up' : 'Down',
    };
    const isFade = (f.dAsk15 != null && f.dAsk15 <= -0.02) || f.phase === 'build_fade';
    const isUnder = dual && f.outcome === before.under && before.res >= 1;

    if (isFade && isUnder) {
      const afterShares = { ...shares };
      const afterCost = { ...cost };
      if (f.outcome === 'Up') {
        afterShares.up += f.size;
        afterCost.up += f.price * f.size;
      } else {
        afterShares.down += f.size;
        afterCost.down += f.price * f.size;
      }
      const afterAvg = pairAvgSum(afterCost, afterShares);
      const afterRes = residual(afterShares);
      const improvesAvg = before.avg != null && afterAvg != null && afterAvg < before.avg - 1e-9;
      const reducesRes = afterRes < before.res - 1e-9;
      const hasCushion = before.avg != null && before.avg <= 0.95;
      const toxic = before.avg != null && before.avg >= 1.0;
      let rule = 'skip_candidate';
      if (improvesAvg && reducesRes) rule = 'must_rebalance';
      else if (improvesAvg) rule = 'avg_improve';
      else if (reducesRes && hasCushion) rule = 'cushion_balance';
      else if (reducesRes && !toxic && f.price <= 0.40) rule = 'cheap_balance';
      else if (reducesRes && toxic) rule = 'toxic_chase';
      else if (reducesRes) rule = 'balance_only';

      hedges.push({
        slug,
        px: f.price,
        size: f.size,
        secInto: f.secInto,
        dAsk15: f.dAsk15,
        beforeAvg: before.avg,
        afterAvg,
        beforeRes: before.res,
        afterRes,
        improvesAvg,
        reducesRes,
        hasCushion,
        toxic,
        rule,
        edgeVsAsk: f.sideAsk != null ? (f.sideAsk - f.price) * f.size : null,
      });
    }

    if (f.outcome === 'Up') {
      shares.up += f.size;
      cost.up += f.price * f.size;
    } else {
      shares.down += f.size;
      cost.down += f.price * f.size;
    }
    if (shares.up > 0 && shares.down > 0) dual = true;
  }
}

const byRule = {};
for (const h of hedges) {
  if (!byRule[h.rule]) byRule[h.rule] = { n: 0, edge: 0, improves: 0, pxs: [], avgs: [] };
  byRule[h.rule].n += 1;
  if (h.edgeVsAsk != null) byRule[h.rule].edge += h.edgeVsAsk;
  if (h.improvesAvg) byRule[h.rule].improves += 1;
  byRule[h.rule].pxs.push(h.px);
  if (h.beforeAvg != null) byRule[h.rule].avgs.push(h.beforeAvg);
}
for (const k of Object.keys(byRule)) {
  byRule[k].edge = +byRule[k].edge.toFixed(2);
  byRule[k].medPx = med(byRule[k].pxs);
  byRule[k].medBeforeAvg = med(byRule[k].avgs);
  byRule[k].improveShare = byRule[k].n ? +(byRule[k].improves / byRule[k].n).toFixed(3) : null;
  delete byRule[k].pxs;
  delete byRule[k].avgs;
}

const keep = hedges.filter((h) => ['must_rebalance', 'avg_improve', 'cushion_balance', 'cheap_balance'].includes(h.rule));
const skip = hedges.filter((h) => ['skip_candidate', 'toxic_chase', 'balance_only'].includes(h.rule));

const report = {
  asOf: new Date().toISOString(),
  dir,
  residualHedgeN: hedges.length,
  byRule,
  keepN: keep.length,
  skipN: skip.length,
  keepEdgeUsd: +keep.reduce((s, h) => s + (h.edgeVsAsk || 0), 0).toFixed(2),
  skipEdgeUsd: +skip.reduce((s, h) => s + (h.edgeVsAsk || 0), 0).toFixed(2),
  proposedLabRule: {
    allowResidualFadeIf: [
      'improvesAvg AND reducesResidual',
      'OR improvesAvg',
      'OR (reducesResidual AND avgSum<=0.95)',
      'OR (reducesResidual AND ask<=0.40 AND avgSum<1.0)',
    ],
    blockOtherwise: 'skip_candidate / toxic_chase / bare balance_only at mid ask',
  },
  verdict: [],
};

report.verdict.push(
  `residual_hedge FADE n=${hedges.length}: keep≈${keep.length} (edge $${report.keepEdgeUsd}) vs skip≈${skip.length} (edge $${report.skipEdgeUsd}).`,
);
report.verdict.push(
  `Por regra: ${Object.entries(byRule).map(([k, v]) => `${k}=${v.n}/$${v.edge}`).join('; ')}.`,
);
if (skip.length && Math.abs(report.skipEdgeUsd) > 20) {
  report.verdict.push(
    'SKIP bucket material — lab deve exigir improvesAvg ou cheap/cushion; não rebalance FADE mid cego.',
  );
}
report.verdict.push(
  'Ação lab: em chase_momo, residual FADE só se improvesAvg|cushion|ask≤40¢ — alinha momoBlockFade + exceção cheap.',
);

const out = path.join(dir, 'residual-hedge-rules.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
fs.writeFileSync(path.resolve('.tmp/pair-ladder-re/doggy-residual-hedge-rules.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('wrote', out);
