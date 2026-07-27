/**
 * Taxonomia dos fills FADE (dAsk15≤−2¢) / build_fade — Etapa 16 prep.
 *
 * Classes:
 *  - residual_hedge: compra underweight após dual (balanceia)
 *  - early_open: secInto < 30
 *  - pre_vacuum: px≤0.25 e secInto≥120 (quase vacuum)
 *  - mid_error: mid-band 20–70 sem ser hedge residual óbvio
 *  - rich_chase: px > 0.70 caindo
 *
 * Usage:
 *   node labs/sandbox/doggy-fade-taxonomy.mjs [--run=<id>|--latest]
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

function classify(f, inv) {
  const px = f.price;
  const sec = f.secInto;
  const dAsk = f.dAsk15;
  const isFade = (dAsk != null && dAsk <= -0.02) || f.phase === 'build_fade';
  if (!isFade) return null;

  const under = inv.up <= inv.down ? 'Up' : 'Down';
  const isUnder = f.outcome === under && Math.abs(inv.up - inv.down) >= 1;

  if (sec != null && sec < 30) return 'early_open';
  if (px <= 0.25 && sec != null && sec >= 120) return 'pre_vacuum';
  if (isUnder) return 'residual_hedge';
  if (px > 0.70) return 'rich_chase';
  if (px >= 0.20 && px <= 0.70) return 'mid_error';
  return 'other';
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

const rows = [];
for (const [, list] of bySlug) {
  const inv = { up: 0, down: 0 };
  for (const f of list) {
    const cls = classify(f, inv);
    if (cls) {
      const edge = f.sideAsk != null ? (f.sideAsk - f.price) * f.size : null;
      rows.push({
        slug: f.slug,
        phase: f.phase,
        cls,
        px: f.price,
        size: f.size,
        secInto: f.secInto,
        dAsk15: f.dAsk15,
        edgeVsAsk: edge,
      });
    }
    if (f.outcome === 'Up') inv.up += f.size;
    else inv.down += f.size;
  }
}

const byCls = {};
for (const r of rows) {
  if (!byCls[r.cls]) byCls[r.cls] = { n: 0, size: 0, edge: 0, pxs: [] };
  byCls[r.cls].n += 1;
  byCls[r.cls].size += r.size;
  if (r.edgeVsAsk != null) byCls[r.cls].edge += r.edgeVsAsk;
  byCls[r.cls].pxs.push(r.px);
}
for (const k of Object.keys(byCls)) {
  byCls[k].edge = +byCls[k].edge.toFixed(2);
  byCls[k].medPx = med(byCls[k].pxs);
  delete byCls[k].pxs;
}

const report = {
  asOf: new Date().toISOString(),
  dir,
  fadeN: rows.length,
  fillsN: fills.length,
  fadeShare: fills.length ? +(rows.length / fills.length).toFixed(3) : null,
  byCls,
  verdict: [],
};

const mid = byCls.mid_error;
const hedge = byCls.residual_hedge;
const preVac = byCls.pre_vacuum;
report.verdict.push(`FADE/build_fade: ${rows.length}/${fills.length} fills (${((report.fadeShare || 0) * 100).toFixed(0)}%).`);
if (mid) {
  report.verdict.push(
    `mid_error n=${mid.n} edgeVsAsk=$${mid.edge} — candidato a bloquear (momoBlockFade).`,
  );
}
if (hedge) {
  report.verdict.push(
    `residual_hedge n=${hedge.n} edgeVsAsk=$${hedge.edge} — pode ser container legítimo; não bloquear cegamente.`,
  );
}
if (preVac) {
  report.verdict.push(`pre_vacuum n=${preVac.n} — overlap com vacuum rules.`);
}

const out = path.join(dir, 'fade-taxonomy.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('wrote', out);
