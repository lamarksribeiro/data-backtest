/**
 * Exit-Depth A/B — responde a pergunta que o `clip-levels-ab.mjs` não responde:
 * **em que profundidade o hedge deve sair?**
 *
 * O `clip-levels-ab` compara 0.42 / 0.40 / 0.38 / 0.36 — uma faixa de 6¢ — e
 * conclui `prefer_clip-2-tight`. Este runner mostra que a curva é monótona bem
 * abaixo disso e que a faixa testada estava no lado raso da mesa.
 *
 * Três coisas que este runner faz e o outro não:
 *
 *  1. **Preço honesto do residual.** `pnl` do engine depende do vencedor proxy.
 *     Aqui a métrica primária é `worst` (= PnL se o lado nu perder), que não
 *     depende de vencedor nenhum. Variante que só ganha com residual aberto
 *     aparece como o que é: aposta direcional.
 *  2. **Sensibilidade a fee.** `0.07·p·(1−p)·sh` é a fórmula oficial atual
 *     para crypto. A coluna `pnl(stress)` usa deliberadamente o custo maior
 *     `0.07·min(p,1−p)·sh` como stress conservador, não como fee alternativa.
 *  3. **Nível vs escape.** Separa quem encheu no nível pedido de quem foi
 *     resgatado pelo escape tardio. Sem isso, "10/10 equalizou" mascara
 *     profundidade que nunca chegou.
 *
 *   node labs/sandbox/pair-path-v0/exit-depth-ab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const PRESET = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'presets/size-fee-v0-cap2.json'), 'utf8'),
);

/**
 * Mesma base do clip-levels-ab, com duas diferenças deliberadas:
 * - `avgSumMax` 1.00 (e não 0.95) para NÃO clampar a curva de profundidade.
 *   Com soma de book ≡ 1.01, `avgSumMax` 0.95 trava todo hedge acima de
 *   `0.95 − openPx` (≈ 0.38–0.40), então ela — e não `hedgeAskMax` — é quem
 *   define o nível raso. Ver §"trava vinculante" no fim da saída.
 * - `escapeAvgSumMax` 1.00: escape pode piorar o avgSum até 1.00, nunca acima.
 */
const BASE = {
  ...PRESET.params,
  openShares: 25,
  maxEventNotional: 50,
  avgSumMax: 1.0,
  eqAvgSumMax: 0.98,
  hedgeAskMax: 0.42,
  openCapCents: 2,
  maxHedgeAttempts: 12,
  escapeAvgSumMax: 1.0,
  tauHedgeEscape: 25,
  hedgeEscapeAskMax: 0.42,
};

const SERIES = [
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
  '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
  '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
].map((p) => path.join(ROOT, p));

/** Nível único, do raso (o que o lab testou) ao fundo (o que ele não testou). */
const DEPTHS = [0.42, 0.4, 0.38, 0.36, 0.32, 0.28, 0.24, 0.2];

/** Escadas: as duas do lab atual + as fundas. */
const LADDERS = [
  { name: 'clip-2-tight 40/36', levels: [{ askMax: 0.4, frac: 0.5 }, { askMax: 0.36, frac: 0.5 }] },
  { name: 'clip-3 42/38/34', levels: [{ askMax: 0.42, frac: 0.4 }, { askMax: 0.38, frac: 0.3 }, { askMax: 0.34, frac: 0.3 }] },
  { name: 'clip-2 deep 36/28', levels: [{ askMax: 0.36, frac: 0.5 }, { askMax: 0.28, frac: 0.5 }] },
  { name: 'clip-3 deep 36/28/20', levels: [{ askMax: 0.36, frac: 0.34 }, { askMax: 0.28, frac: 0.33 }, { askMax: 0.2, frac: 0.33 }] },
];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function listDirs() {
  const m = new Map();
  for (const s of SERIES) {
    const ed = path.join(s, 'events');
    if (!fs.existsSync(ed)) continue;
    for (const n of fs.readdirSync(ed)) {
      if (fs.existsSync(path.join(ed, n, 'ticks.jsonl'))) m.set(n, path.join(ed, n));
    }
  }
  return [...m.values()].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

const feeStress = (px, sh, rate) => rate * Math.min(px, 1 - px) * sh;

function runVariant(name, params, cache) {
  const rows = [];
  for (const { slug, ticks } of cache) {
    const eng = createEventEngine({ ...DEFAULT_PARAMS, ...BASE, ...params }, { slug });
    let last = null;
    for (const t of ticks) { eng.onTick(t); last = t; }
    const r = eng.finish(last);
    if (!r.nFills) continue;
    // Stress não-oficial: custo deliberadamente maior que a fórmula vigente.
    const feesStress = r.fills.reduce(
      (a, f) => a + (f.liquidity === 'maker' ? 0 : feeStress(f.px, f.sh, BASE.feeRate)), 0);
    const deltaFee = feesStress - r.fees;
    rows.push({
      ...r,
      slug,
      feesStress,
      pnlStress: (r.pnl ?? 0) - deltaFee,
      worstStress: r.worstPnl - deltaFee,
    });
  }
  const eq = rows.filter((r) => (r.residual?.shares || 0) < 1e-6);
  const withResid = rows.filter((r) => (r.residual?.shares || 0) >= 1);
  const avgs = eq.map((r) => r.avgSum).filter((x) => x != null).sort((a, b) => a - b);
  const escapeFills = rows.reduce((a, r) => a + r.fills.filter((f) => f.kind === 'hedge_escape').length, 0);
  const makerSh = rows.reduce((a, r) => a + r.fills.filter((f) => f.liquidity === 'maker').reduce((s, f) => s + f.sh, 0), 0);
  const refusedAvgSum = rows.reduce((a, r) => a + (r.blockCounts?.HEDGE_REFUSE_AVGSUM || 0), 0);
  return {
    name,
    n: rows.length,
    eq: eq.length,
    resid: withResid.length,
    pnl: rows.reduce((a, r) => a + (r.pnl ?? 0), 0),
    pnlStress: rows.reduce((a, r) => a + r.pnlStress, 0),
    worst: rows.reduce((a, r) => a + r.worstPnl, 0),
    worstStress: rows.reduce((a, r) => a + r.worstStress, 0),
    avgSumMed: avgs.length ? avgs[Math.floor(avgs.length / 2)] : null,
    escapeFills,
    makerSh,
    refusedAvgSum,
    rows,
  };
}

function line(r) {
  return (
    `${r.name.padEnd(22)} ${String(r.n).padStart(3)}  ${String(r.eq).padStart(3)} ${String(r.resid).padStart(4)}` +
    `  ${r.pnl.toFixed(2).padStart(7)} ${r.pnlStress.toFixed(2).padStart(10)}` +
    `  ${r.worst.toFixed(2).padStart(7)} ${r.worstStress.toFixed(2).padStart(12)}` +
    `   ${r.avgSumMed != null ? r.avgSumMed.toFixed(3) : '  -  '}` +
    `  ${String(r.escapeFills).padStart(4)} ${String(r.makerSh).padStart(6)}`
  );
}

const HEAD =
  'variante                 n   eq resid      pnl pnl(stress)    worst worst(stress) avgSumMed   esc  makerSh';

function main() {
  const dirs = listDirs();
  if (!dirs.length) {
    console.error('Nenhum journal encontrado em .tmp/poly-baliza e .tmp/pair-path-v0-shadow');
    process.exit(1);
  }
  const cache = dirs.map((d) => ({ slug: path.basename(d), ticks: readJsonl(path.join(d, 'ticks.jsonl')) }));

  // --- identidade da soma do book: por que avgSum < 1 é direcional ---
  const sums = [];
  let oneSided = 0;
  for (const { ticks } of cache) for (const t of ticks) {
    if (t.upAsk == null || t.downAsk == null) { oneSided++; continue; }
    sums.push(Number(t.upAsk) + Number(t.downAsk));
  }
  sums.sort((a, b) => a - b);
  const med = sums[Math.floor(sums.length / 2)];
  const below1 = sums.filter((s) => s < 0.9999).length;

  console.log('=== Exit-Depth A/B · Clip-Path ===\n');
  console.log(`journals: ${dirs.length} eventos · base sh${BASE.openShares} cap+${BASE.openCapCents} avgSumMax${BASE.avgSumMax} notional≤${BASE.maxEventNotional}`);
  console.log(
    `book: soma(ask_UP+ask_DOWN) mediana=${med.toFixed(2)} · abaixo de 1.00 em ${(below1 / sums.length * 100).toFixed(2)}% dos ticks` +
    ` · ${(oneSided / (sums.length + oneSided) * 100).toFixed(1)}% dos ticks com um lado nulo (resolução)`);
  console.log(
    `  ⇒ não existe complete-set < $1 simultâneo. Com soma ≡ ${med.toFixed(2)},` +
    ` avgSum = ${med.toFixed(2)} − (deriva do open leg entre as duas pernas).`);
  console.log('  ⇒ o edge é DIRECIONAL: só existe se a perna aberta subir. O hedge realiza o lucro, não o cria.\n');

  console.log('--- nível único (100% do hedge num preço só) ---');
  console.log(HEAD);
  const depthRes = [];
  for (const lv of DEPTHS) {
    const r = runVariant(
      `nível ≤${lv.toFixed(2)} (+${Math.round((med - lv - 0.56) * 100)}¢)`,
      { hedgeLevels: [{ askMax: lv, frac: 1 }] },
      cache,
    );
    depthRes.push({ lv, r });
    console.log(line(r));
  }

  console.log('\n--- escadas ---');
  console.log(HEAD);
  const ladderRes = [];
  for (const l of LADDERS) {
    const r = runVariant(l.name, { hedgeLevels: l.levels }, cache);
    ladderRes.push(r);
    console.log(line(r));
  }

  // preset vigente, com os próprios freios (avgSumMax, escape 2 estágios)
  const CAND = JSON.parse(fs.readFileSync(path.join(__dirname, 'presets/clip-path-v1.json'), 'utf8'));
  const candRes = runVariant(`preset: ${CAND.abRecommendation || CAND.id}`, CAND.params, cache);
  ladderRes.push(candRes);
  console.log(line(candRes));
  const capHedge = (CAND.params.avgSumMax ?? BASE.avgSumMax) - 0.57;
  console.log(
    `  ↑ avgSumMax ${CAND.params.avgSumMax} ⇒ com open a 0.57 o hedge é recusado acima de ${capHedge.toFixed(2)};` +
    ` os níveis declarados acima disso (${(CAND.params.hedgeLevels || []).filter((l) => l.askMax > capHedge + 1e-9).map((l) => l.askMax).join(', ') || 'nenhum'}) são inalcançáveis nesse open.`);

  // --- trava vinculante ---
  console.log('\n--- trava vinculante: avgSumMax vs hedgeAskMax ---');
  for (const cap of [0.95, 0.98, 1.0]) {
    const r = runVariant(`avgSumMax ${cap}`, { avgSumMax: cap, escapeAvgSumMax: cap, hedgeLevels: [{ askMax: 0.42, frac: 1 }] }, cache);
    console.log(
      `  hedgeAskMax 0.42 + avgSumMax ${cap}: hedge efetivo ≤ ${(cap - 0.56).toFixed(2)}` +
      ` · avgSumMed=${r.avgSumMed != null ? r.avgSumMed.toFixed(3) : '-'} pnl=${r.pnl.toFixed(2)}` +
      ` · recusas por avgSum=${r.refusedAvgSum}`);
  }
  console.log('  ⇒ com open em 0.55–0.57, avgSumMax é quem define o teto do hedge. `hedgeAskMax` 0.42 nunca vincula.');

  // --- veredito ---
  const all = [...depthRes.map((d) => d.r), ...ladderRes];
  const clean = all.filter((r) => r.resid === 0);
  clean.sort((a, b) => b.worstStress - a.worstStress);
  const tight = ladderRes.find((r) => r.name.startsWith('preset:'));
  console.log('\n--- veredito (ordenado por worst no stress de custo, só variantes sem residual) ---');
  for (const r of clean.slice(0, 5)) {
    console.log(`  ${r.name.padEnd(22)} worst(stress)=${r.worstStress.toFixed(2).padStart(7)}  avgSumMed=${r.avgSumMed?.toFixed(3)}  eq=${r.eq}/${r.n}`);
  }
  if (tight) {
    const best = clean[0];
    console.log(
      `\n  preset atual (${tight.name}): worst(stress)=${tight.worstStress.toFixed(2)}` +
      ` · melhor sem residual (${best.name}): worst(stress)=${best.worstStress.toFixed(2)}` +
      ` → ${(best.worstStress - tight.worstStress).toFixed(2)} na mesa`);
  }

  console.log(
    '\n  AVISO: 14 eventos de UMA janela de ~90min (28/07 04:03–05:30 UTC). Todo nível\n' +
    '  enche 10/10 nesta amostra — inclusive 0.20. Isso não prova que fundo é melhor;\n' +
    '  prova que ESTES journals não têm poder para escolher o nível. O que a amostra\n' +
    '  descarta é o contrário: não há evidência para preferir 0.40/0.36 a 0.36/0.28.\n' +
    '  Decidir profundidade exige journals de regime calmo (deriva < 10¢).');

  const outDir = path.join(ROOT, '.tmp/clip-path-v1-ab');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'exit-depth.json');
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    lab: 'exit-depth',
    base: BASE,
    bookSum: { median: med, pctBelow1: below1 / sums.length, pctOneSided: oneSided / (sums.length + oneSided) },
    depths: depthRes.map(({ lv, r }) => ({ level: lv, ...r, rows: undefined })),
    ladders: ladderRes.map((r) => ({ ...r, rows: undefined })),
  }, null, 2));
  console.log('\nsaved', outFile);
}

main();
