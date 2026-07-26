/**
 * Etapa 14 — shadow-lab offline sobre journal CLOB tick (books-tick.jsonl).
 *
 * Perguntas:
 *  1) Quanto $ Doggy ganha vs fill ao ask (fill quality)?
 *  2) Quanto vs ask−1¢ (proxy lab slippageCents=-1)?
 *  3) Os clips Doggy passam o gate chase_momo no journal fino?
 *  4) Vale shadow-lab contínuo / mais sessões?
 *
 * Usage:
 *   node labs/sandbox/doggy-shadow-lab.mjs [--run=<runId>|--latest]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.tmp/pair-ladder-re/live-observer');
const OUT_RE = path.resolve('.tmp/pair-ladder-re');
const args = process.argv.slice(2);
const runArg = args.find((a) => a.startsWith('--run='))?.slice(6);
const latest = args.includes('--latest') || !runArg;

const MOMO_RISE = 0.02;
const MOMO_LOOKBACK_MS = 15_000;
const MOMO_MIN = 0.20;
const MOMO_MAX = 0.70;

function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function sum(a) {
  return a.reduce((s, x) => s + x, 0);
}

function pickRun() {
  if (!latest && runArg) return path.join(ROOT, runArg);
  const dirs = fs.readdirSync(ROOT)
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'fills.jsonl')))
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'books-tick.jsonl')))
    .filter((d) => !fs.existsSync(path.join(ROOT, d, 'CONTAMINATED.md')))
    .sort();
  if (!dirs.length) throw new Error('no clean run with books-tick.jsonl');
  return path.join(ROOT, dirs[dirs.length - 1]);
}

function sideAsk(tick, outcome) {
  return outcome === 'Up' ? tick.upBestAsk : tick.downBestAsk;
}

function nearestTick(ticks, tMs) {
  if (!ticks.length) return null;
  let best = ticks[0];
  let bestD = Math.abs(best.t - tMs);
  // binary-ish linear scan OK for ~8k
  for (const tk of ticks) {
    const d = Math.abs(tk.t - tMs);
    if (d < bestD) { best = tk; bestD = d; }
  }
  return { tick: best, lagMs: best.t - tMs };
}

function minAskWindow(ticks, outcome, tMs, halfMs) {
  let min = null;
  for (const tk of ticks) {
    if (Math.abs(tk.t - tMs) > halfMs) continue;
    const a = sideAsk(tk, outcome);
    if (a == null || !Number.isFinite(a)) continue;
    if (min == null || a < min) min = a;
  }
  return min;
}

function askAtOrBefore(ticks, outcome, tMs) {
  let best = null;
  for (const tk of ticks) {
    if (tk.t > tMs) break;
    const a = sideAsk(tk, outcome);
    if (a != null && Number.isFinite(a)) best = { t: tk.t, ask: a };
  }
  return best;
}

function dAskLookback(ticks, outcome, tMs, lookbackMs) {
  const now = askAtOrBefore(ticks, outcome, tMs);
  const prev = askAtOrBefore(ticks, outcome, tMs - lookbackMs);
  if (!now || !prev) return null;
  if (tMs - prev.t < lookbackMs * 0.4) return null;
  return now.ask - prev.ask;
}

function passesMomoGate(ask, dAsk) {
  if (ask == null || dAsk == null) return false;
  if (ask < MOMO_MIN - 1e-12 || ask > MOMO_MAX + 1e-12) return false;
  return dAsk >= MOMO_RISE - 1e-12;
}

function main() {
  const dir = pickRun();
  const fills = fs.readFileSync(path.join(dir, 'fills.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((f) => f.bookMatched);
  const allTicks = fs.readFileSync(path.join(dir, 'books-tick.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // Index ticks by slug for correct market books
  const ticksBySlug = new Map();
  for (const tk of allTicks) {
    const slug = tk.slug || '_';
    if (!ticksBySlug.has(slug)) ticksBySlug.set(slug, []);
    ticksBySlug.get(slug).push(tk);
  }
  for (const list of ticksBySlug.values()) list.sort((a, b) => a.t - b.t);

  const rows = [];
  for (const f of fills) {
    const ticks = ticksBySlug.get(f.slug) || [];
    const tMs = f.tsJoinMs ?? (f.ts * 1000 + 500);
    const near = nearestTick(ticks, tMs);
    const ask = near ? sideAsk(near.tick, f.outcome) : f.askAtCapture;
    const min500 = minAskWindow(ticks, f.outcome, tMs, 500) ?? f.minAsk500;
    const min1000 = minAskWindow(ticks, f.outcome, tMs, 1000) ?? f.minAsk1000;
    const dAsk = dAskLookback(ticks, f.outcome, tMs, MOMO_LOOKBACK_MS) ?? f.dAsk15;
    const px = f.price;
    const sz = f.size;
    const edgeVsAsk = ask != null ? (ask - px) * sz : null; // + = Doggy cheaper than ask
    const edgeVsAskM1 = ask != null ? ((ask - 0.01) - px) * sz : null;
    const edgeVsMin500 = min500 != null ? (min500 - px) * sz : null;
    const momoOk = passesMomoGate(ask, dAsk);
    const midBand = ask != null && ask >= MOMO_MIN && ask <= MOMO_MAX;
    rows.push({
      slug: f.slug,
      phase: f.phase,
      outcome: f.outcome,
      px,
      size: sz,
      ask,
      min500,
      min1000,
      dAsk,
      fillMinusAsk: ask != null ? px - ask : null,
      fillMinusMin500: min500 != null ? px - min500 : null,
      edgeVsAsk,
      edgeVsAskM1,
      edgeVsMin500,
      momoOk,
      midBand,
      lagMs: near?.lagMs ?? f.bookLagMs,
    });
  }

  const mid = rows.filter((r) => r.midBand);
  const buildish = rows.filter((r) => String(r.phase || '').startsWith('build') || r.phase === 'hedge');

  const report = {
    asOf: new Date().toISOString(),
    dir,
    fillsN: rows.length,
    ticksN: allTicks.length,
    // Fill quality $
    doggyCheaperThanAskUsd: +sum(rows.map((r) => r.edgeVsAsk).filter((x) => x != null)).toFixed(2),
    doggyCheaperThanAskM1Usd: +sum(rows.map((r) => r.edgeVsAskM1).filter((x) => x != null)).toFixed(2),
    doggyCheaperThanMin500Usd: +sum(rows.map((r) => r.edgeVsMin500).filter((x) => x != null)).toFixed(2),
    medFillMinusAskCents: med(rows.map((r) => r.fillMinusAsk).filter((x) => x != null)) != null
      ? +(med(rows.map((r) => r.fillMinusAsk).filter((x) => x != null)) * 100).toFixed(2) : null,
    medFillMinusMin500Cents: med(rows.map((r) => r.fillMinusMin500).filter((x) => x != null)) != null
      ? +(med(rows.map((r) => r.fillMinusMin500).filter((x) => x != null)) * 100).toFixed(2) : null,
    // Selection
    midBandN: mid.length,
    midMomoPassShare: mid.length ? +(mid.filter((r) => r.momoOk).length / mid.length).toFixed(3) : null,
    buildMomoPassShare: buildish.length
      ? +(buildish.filter((r) => r.momoOk).length / buildish.length).toFixed(3) : null,
    byPhase: (() => {
      const m = {};
      for (const r of rows) {
        const p = r.phase || 'unk';
        if (!m[p]) m[p] = { n: 0, momoOk: 0, edgeVsAsk: 0 };
        m[p].n += 1;
        if (r.momoOk) m[p].momoOk += 1;
        if (r.edgeVsAsk != null) m[p].edgeVsAsk += r.edgeVsAsk;
      }
      for (const k of Object.keys(m)) {
        m[k].edgeVsAsk = +m[k].edgeVsAsk.toFixed(2);
        m[k].momoShare = m[k].n ? +(m[k].momoOk / m[k].n).toFixed(3) : null;
      }
      return m;
    })(),
  };

  report.verdict = [];
  const qUsd = report.doggyCheaperThanAskUsd;
  const qM1 = report.doggyCheaperThanAskM1Usd;
  const qMin = report.doggyCheaperThanMin500Usd;
  report.verdict.push(
    `Fill quality na sessão: Doggy edge vs ask = $${qUsd} (>+0 = mais barato que ask); vs ask−1¢ = $${qM1}; vs minAsk±500ms = $${qMin}.`,
  );
  if (qMin > 5) {
    report.verdict.push('Fill quality material vs journal fino — lab com slippageCents=-1 ainda subestima Doggy.');
  } else if (qMin > 0) {
    report.verdict.push('Fill quality leve vs minAsk±500ms — parte do −1¢ é real.');
  } else {
    report.verdict.push('Sem vantagem clara vs minAsk±500ms agregado — edge de fill pode ser seleção de momentos, não preço médio.');
  }
  report.verdict.push(
    `Gate chase_momo no journal: mid-band pass ${((report.midMomoPassShare || 0) * 100).toFixed(0)}%; build/hedge pass ${((report.buildMomoPassShare || 0) * 100).toFixed(0)}%.`,
  );
  if ((report.midMomoPassShare ?? 0) >= 0.45) {
    report.verdict.push('Seleção MOMO reproduzível no tick journal — shadow-lab contínuo vale a pena.');
  } else {
    report.verdict.push('Muitos clips Doggy mid NÃO passam momo no journal — timing intra-segundo ou outro sinal.');
  }
  report.verdict.push(
    qMin > 0 && (report.midMomoPassShare ?? 0) >= 0.4
      ? 'DECISÃO: continuar shadow-lab offline + mais sessões live; não subir Hz Brutus.'
      : 'DECISÃO: mais sessões live antes de investir em shadow-lab contínuo.',
  );

  const outPath = path.join(dir, 'shadow-lab.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_RE, 'doggy-shadow-lab.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('wrote', outPath);
}

main();
