/**
 * Analisa run do doggy-live-observer (Etapa 13 shadow).
 *
 * Usage:
 *   node labs/sandbox/doggy-live-analyze.mjs [--run=<runId>|--latest]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.tmp/pair-ladder-re/live-observer');
const args = process.argv.slice(2);
const runArg = args.find((a) => a.startsWith('--run='))?.slice(6);
const latest = args.includes('--latest') || !runArg;

function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function q(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function pickRun() {
  if (!latest && runArg) return path.join(ROOT, runArg);
  const dirs = fs.readdirSync(ROOT)
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'fills.jsonl')))
    .filter((d) => !fs.existsSync(path.join(ROOT, d, 'CONTAMINATED.md')))
    .sort();
  if (!dirs.length) throw new Error('no clean live-observer runs');
  return path.join(ROOT, dirs[dirs.length - 1]);
}

/** Offline shadow path (canonical) — recompute if phase missing */
function reclassifyPhases(fills) {
  const bySlug = new Map();
  for (const f of fills) {
    if (!bySlug.has(f.slug)) bySlug.set(f.slug, []);
    bySlug.get(f.slug).push(f);
  }
  const out = [];
  for (const [, list] of bySlug) {
    list.sort((a, b) => (a.ts - b.ts) || String(a.tx).localeCompare(String(b.tx)));
    let openedSide = null;
    let hedged = false;
    let n = 0;
    for (const f of list) {
      let phase = f.phase;
      if (!phase || phase === 'unknown') {
        if (n === 0) {
          openedSide = f.outcome;
          phase = 'open';
        } else if (!hedged && openedSide && f.outcome !== openedSide) {
          hedged = true;
          phase = 'hedge';
        } else if (f.price <= 0.20 && f.secInto != null && f.secInto >= 120) {
          phase = 'vacuum';
        } else if (f.dAsk15 != null && f.dAsk15 >= 0.02) {
          phase = 'build_momo';
        } else if (f.dAsk15 != null && f.dAsk15 <= -0.02) {
          phase = 'build_fade';
        } else {
          phase = 'build_flat';
        }
      }
      if (n === 0) openedSide = f.outcome;
      if (phase === 'hedge') hedged = true;
      n += 1;
      out.push({ ...f, phase });
    }
  }
  return out;
}

function verdict(report) {
  const lines = [];
  const ask = report.medFillMinusAskCents;
  const min500 = report.medFillMinusMinAsk500Cents;
  if (ask != null && min500 != null) {
    const delta = ask - min500;
    if (Math.abs(min500) <= 0.5 && ask < -0.5) {
      lines.push('fill−ask negativo é em parte artefato do clock de 1s (minAsk±500ms ≈ 0); edge de fill sub-s fraco/incerto.');
    } else if (min500 < -0.5) {
      lines.push('fill ainda abaixo do minAsk±500ms → fill quality real (melhor que best do journal).');
    } else if (ask >= -0.3 && min500 >= -0.3) {
      lines.push('fills ≈ ask mesmo no journal fino → edge não é fill−1¢ sistemático.');
    } else {
      lines.push(`ask med ${ask?.toFixed?.(2)}¢ vs min500 ${min500?.toFixed?.(2)}¢ (Δ ${delta?.toFixed?.(2)}¢).`);
    }
  }
  if ((report.momoShare ?? 0) >= 0.45 && (report.fadeShare ?? 0) <= 0.35) {
    lines.push('seleção MOMO dominante no live — alinha narrativa canônica.');
  }
  if ((report.vacuumShare ?? 0) >= 0.1) {
    lines.push(`vacuumShare=${((report.vacuumShare || 0) * 100).toFixed(0)}% — scoop late presente ao vivo.`);
  } else {
    lines.push('vacuumShare baixo nesta janela — amostra curta ou Doggy pouco vacuumou.');
  }
  if ((report.spotLeadShare ?? 0) < 0.25) {
    lines.push('spotLead baixo — confirma descarte de gate spot.');
  }
  // a/b/c decision
  const fillEdge = (report.medFillMinusMinAsk500Cents ?? 0) < -0.8;
  const selEdge = (report.momoShare ?? 0) >= 0.5;
  if (fillEdge && selEdge) lines.push('DECISÃO: edge = (c) fill quality + seleção de clip.');
  else if (fillEdge) lines.push('DECISÃO: edge = (a) fill quality sub-s.');
  else if (selEdge) lines.push('DECISÃO: edge = (b) seleção de clip MOMO (journal 1Hz/2Hz cego ao timing).');
  else lines.push('DECISÃO: amostra inconclusiva — repetir sessão ≥45min.');
  return lines;
}

const dir = pickRun();
const fillsRaw = fs.readFileSync(path.join(dir, 'fills.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const classified = reclassifyPhases(fillsRaw);
const matched = classified.filter((f) => f.bookMatched !== false && f.fillMinusAsk != null);
const usable = matched.length
  ? matched
  : classified.filter((f) => f.marketSlug && f.slug === f.marketSlug && f.fillMinusAsk != null);

const fillMinus = usable.map((f) => f.fillMinusAsk);
const fillMin500 = usable.map((f) => f.fillMinusMinAsk500).filter((x) => x != null);
const fillMin1000 = usable.map((f) => f.fillMinusMinAsk1000).filter((x) => x != null);
const dAsk = usable.map((f) => f.dAsk15).filter((x) => x != null);
const dSpot = usable.map((f) => f.dSpot5s).filter((x) => x != null && Number.isFinite(x));

const spotLead = usable.filter((f) => {
  if (f.dSpot5s == null) return false;
  return f.outcome === 'Up' ? f.dSpot5s > 1 : f.dSpot5s < -1;
});
const spotAgainst = usable.filter((f) => {
  if (f.dSpot5s == null) return false;
  return f.outcome === 'Up' ? f.dSpot5s < -1 : f.dSpot5s > 1;
});
const withDask = usable.filter((f) => f.dAsk15 != null);
const momo = withDask.filter((f) => f.dAsk15 >= 0.02);
const fade = withDask.filter((f) => f.dAsk15 <= -0.02);

const byPhase = {};
for (const f of usable) {
  const p = f.phase || 'unknown';
  byPhase[p] = (byPhase[p] || 0) + 1;
}
const bySlug = new Map();
for (const f of usable) {
  if (!bySlug.has(f.slug)) bySlug.set(f.slug, []);
  bySlug.get(f.slug).push(f);
}
const vacPerEvent = [...bySlug.values()].map((list) => list.filter((f) => f.phase === 'vacuum').length);

let tickN = 0;
const tickPath = path.join(dir, 'books-tick.jsonl');
if (fs.existsSync(tickPath)) {
  tickN = fs.readFileSync(tickPath, 'utf8').trim().split('\n').filter(Boolean).length;
}

const report = {
  dir,
  fillsN: fillsRaw.length,
  usableN: usable.length,
  bookTicksN: tickN,
  medFillMinusAskCents: med(fillMinus) != null ? +(med(fillMinus) * 100).toFixed(2) : null,
  medFillMinusMinAsk500Cents: med(fillMin500) != null ? +(med(fillMin500) * 100).toFixed(2) : null,
  medFillMinusMinAsk1000Cents: med(fillMin1000) != null ? +(med(fillMin1000) * 100).toFixed(2) : null,
  p10FillMinusAskCents: q(fillMinus, 0.1) != null ? +(q(fillMinus, 0.1) * 100).toFixed(2) : null,
  p10FillMinusMinAsk500Cents: q(fillMin500, 0.1) != null ? +(q(fillMin500, 0.1) * 100).toFixed(2) : null,
  belowAskShare: fillMinus.length ? +(fillMinus.filter((x) => x < -0.001).length / fillMinus.length).toFixed(3) : null,
  belowMinAsk500Share: fillMin500.length
    ? +(fillMin500.filter((x) => x < -0.001).length / fillMin500.length).toFixed(3) : null,
  medDAsk15Cents: med(dAsk) != null ? +(med(dAsk) * 100).toFixed(2) : null,
  momoShare: withDask.length ? +(momo.length / withDask.length).toFixed(3) : null,
  fadeShare: withDask.length ? +(fade.length / withDask.length).toFixed(3) : null,
  medDSpot5s: med(dSpot),
  spotLeadShare: usable.length ? +(spotLead.length / usable.length).toFixed(3) : null,
  spotAgainstShare: usable.length ? +(spotAgainst.length / usable.length).toFixed(3) : null,
  byPhase,
  vacuumShare: usable.length ? +((byPhase.vacuum || 0) / usable.length).toFixed(3) : null,
  medVacuumPerEvent: med(vacPerEvent),
  eventsN: bySlug.size,
  byOutcome: ['Up', 'Down'].map((o) => {
    const sel = usable.filter((f) => f.outcome === o);
    return {
      outcome: o,
      n: sel.length,
      medFillAskC: med(sel.map((f) => f.fillMinusAsk)) != null
        ? +(med(sel.map((f) => f.fillMinusAsk)) * 100).toFixed(2) : null,
      medFillMin500C: med(sel.map((f) => f.fillMinusMinAsk500).filter((x) => x != null)) != null
        ? +(med(sel.map((f) => f.fillMinusMinAsk500).filter((x) => x != null)) * 100).toFixed(2) : null,
      medDSpot5: med(sel.map((f) => f.dSpot5s).filter((x) => x != null)),
    };
  }),
};
report.verdict = verdict(report);

console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(dir, 'analyze.json'), JSON.stringify(report, null, 2));
console.log('wrote', path.join(dir, 'analyze.json'));
