/**
 * Etapa 16c — vacuum shadow no journal live.
 *
 * Uso:
 *   node labs/sandbox/doggy-vacuum-shadow.mjs [--run=<id>|--all]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.tmp/pair-ladder-re/live-observer');
const all = process.argv.includes('--all');
const runArg = process.argv.find((a) => a.startsWith('--run='))?.slice(6);

function listRuns() {
  if (runArg) return [runArg];
  return fs.readdirSync(ROOT)
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'fills.jsonl')))
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'books-tick.jsonl')))
    .filter((d) => !fs.existsSync(path.join(ROOT, d, 'CONTAMINATED.md')))
    .sort();
}

function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}

function analyze(runId) {
  const dir = path.join(ROOT, runId);
  const fills = fs.readFileSync(path.join(dir, 'fills.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((f) => f.bookMatched)
    .sort((a, b) => a.ts - b.ts);

  const vac = fills.filter((f) => f.phase === 'vacuum' || (f.price <= 0.20 && f.secInto >= 120));
  const bySlug = new Map();
  for (const f of fills) {
    if (!bySlug.has(f.slug)) bySlug.set(f.slug, []);
    bySlug.get(f.slug).push(f);
  }

  const eventStats = [];
  for (const [slug, list] of bySlug) {
    const vacs = list.filter((f) => f.phase === 'vacuum' || (f.price <= 0.20 && f.secInto >= 120));
    if (!vacs.length) continue;
    const shares = { up: 0, down: 0 };
    for (const f of list) {
      if (f.outcome === 'Up') shares.up += f.size;
      else shares.down += f.size;
    }
    const beforeVac = list.filter((f) => !(f.phase === 'vacuum' || (f.price <= 0.20 && f.secInto >= 120)));
    const shB = { up: 0, down: 0 };
    for (const f of beforeVac) {
      if (f.outcome === 'Up') shB.up += f.size;
      else shB.down += f.size;
    }
    eventStats.push({
      slug,
      vacN: vacs.length,
      vacShares: vacs.reduce((s, f) => s + f.size, 0),
      medVacPx: med(vacs.map((f) => f.price)),
      firstVacSec: med(vacs.map((f) => f.secInto).filter((x) => x != null)) != null
        ? Math.min(...vacs.map((f) => f.secInto).filter((x) => x != null))
        : null,
      residualBefore: Math.abs(shB.up - shB.down),
      residualAfter: Math.abs(shares.up - shares.down),
      dyingSide: vacs[0]?.outcome,
    });
  }

  return {
    runId,
    fillsN: fills.length,
    vacuumFills: vac.length,
    vacuumShare: fills.length ? +(vac.length / fills.length).toFixed(3) : null,
    eventsWithVac: eventStats.length,
    eventsN: bySlug.size,
    medVacPx: med(vac.map((f) => f.price)),
    medVacSize: med(vac.map((f) => f.size)),
    medFirstVacSec: med(eventStats.map((e) => e.firstVacSec).filter((x) => x != null)),
    medResidualBefore: med(eventStats.map((e) => e.residualBefore)),
    medResidualAfter: med(eventStats.map((e) => e.residualAfter)),
    reducedResidualShare: eventStats.length
      ? +(eventStats.filter((e) => e.residualAfter < e.residualBefore).length / eventStats.length).toFixed(3)
      : null,
  };
}

const runs = listRuns();
const results = runs.map(analyze);
const report = {
  asOf: new Date().toISOString(),
  runs: results,
  verdict: results.map((r) =>
    `${r.runId}: vac ${r.vacuumFills}/${r.fillsN} (${((r.vacuumShare || 0) * 100).toFixed(0)}%) · ` +
    `ev ${r.eventsWithVac}/${r.eventsN} · medPx ${r.medVacPx?.toFixed?.(3)} · ` +
    `res ${r.medResidualBefore}→${r.medResidualAfter} (reduce ${((r.reducedResidualShare || 0) * 100).toFixed(0)}%)`,
  ),
};

const out = path.resolve('.tmp/pair-ladder-re/doggy-vacuum-shadow.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
if (!all && runs.length === 1) {
  fs.writeFileSync(path.join(ROOT, runs[0], 'vacuum-shadow.json'), JSON.stringify(results[0], null, 2));
}
console.log(JSON.stringify(report, null, 2));
console.log('wrote', out);
