/**
 * Fill quality Phil shadow vs book (método Doggy).
 *
 * Lê logs/shadow do Phil (dry ou real) e junta cada fill ao tick mais próximo.
 * Reporta fill−ask / fill−bid / buckets — compara com Doggy (~−0,7¢ vs ask).
 *
 *   node labs/sandbox/shotandgo-fill-quality.mjs
 *   node labs/sandbox/shotandgo-fill-quality.mjs --dir=../polymarket-fm/logs/shadow
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function argVal(flag, fb) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : fb;
}

function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function pct(n, d) {
  return d ? (100 * n) / d : null;
}

function parseTs(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function nearestTick(ticks, tMs) {
  if (!ticks.length || tMs == null) return null;
  let best = ticks[0];
  let bestD = Math.abs(best.t - tMs);
  for (const tk of ticks) {
    const d = Math.abs(tk.t - tMs);
    if (d < bestD) {
      best = tk;
      bestD = d;
    }
  }
  return { tick: best, lagMs: best.t - tMs };
}

function classify(fillPx, ask, bid) {
  if (ask == null) return { bucket: 'NO_ASK', vsAsk: null, vsBid: null };
  const vsAsk = fillPx - ask;
  const vsBid = bid != null ? fillPx - bid : null;
  let bucket;
  if (fillPx >= ask - 0.001) bucket = fillPx > ask + 0.01 ? 'WALK_ASK' : 'AT_ASK';
  else if (bid != null && fillPx <= bid + 0.001) bucket = fillPx < bid - 0.01 ? 'BELOW_BID' : 'AT_BID';
  else if (bid != null && fillPx < (ask + bid) / 2) bucket = 'BETWEEN_MID_BID';
  else bucket = 'BETWEEN_MID_ASK';
  return { bucket, vsAsk, vsBid };
}

function loadShadows(dirs) {
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name.includes('replay') || name.includes('live-pair')) continue;
      files.push(path.join(dir, name));
    }
  }
  return files;
}

function analyzeFile(filePath) {
  const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const ticks = (j.ticks || [])
    .map((tk) => ({
      t: parseTs(tk.ts),
      askUp: tk.askUp,
      askDown: tk.askDown,
      bidUp: tk.bidUp,
      bidDown: tk.bidDown,
    }))
    .filter((tk) => tk.t != null)
    .sort((a, b) => a.t - b.t);

  const rows = [];
  for (const f of j.fills || []) {
    const tMs = parseTs(f.ts);
    const near = nearestTick(ticks, tMs);
    if (!near) continue;
    const lado = f.lado || f.side;
    const ask = lado === 'UP' ? near.tick.askUp : near.tick.askDown;
    const bid = lado === 'UP' ? near.tick.bidUp : near.tick.bidDown;
    const px = Number(f.price);
    if (!Number.isFinite(px)) continue;
    const kind = String(f.tipo || '').split('-')[0];
    const cl = classify(px, ask, bid);
    rows.push({
      slug: j.slug,
      tipo: f.tipo,
      kind,
      lado,
      liquidity: f.liquidity || (String(f.tipo || '').startsWith('DESC') ? 'maker' : 'taker'),
      dry: !!f.dry,
      price: px,
      ask,
      bid,
      lagMs: near.lagMs,
      ...cl,
      edgeUsd: cl.vsAsk != null ? (ask - px) * Number(f.shares || 0) : null, // + = cheaper than ask
      shares: Number(f.shares || 0),
    });
  }
  return { slug: j.slug, mode: j.mode, rows, nTicks: ticks.length };
}

function summarize(rows, label) {
  const vs = rows.map((r) => r.vsAsk).filter((x) => x != null);
  const edge = rows.map((r) => r.edgeUsd).filter((x) => x != null);
  const buckets = {};
  for (const r of rows) buckets[r.bucket] = (buckets[r.bucket] || 0) + 1;
  const lag = rows.map((r) => Math.abs(r.lagMs)).filter((x) => Number.isFinite(x));
  return {
    label,
    n: rows.length,
    medFillMinusAskC: med(vs) != null ? +(med(vs) * 100).toFixed(2) : null,
    meanFillMinusAskC: mean(vs) != null ? +(mean(vs) * 100).toFixed(2) : null,
    pctAtOrBelowAsk: pct(vs.filter((x) => x <= 0.001).length, vs.length),
    pctCheaperThanAsk1c: pct(vs.filter((x) => x <= -0.01).length, vs.length),
    pctWalkAsk: pct(vs.filter((x) => x > 0.01).length, vs.length),
    edgeVsAskUsd: edge.length ? +sum(edge).toFixed(2) : null,
    medAbsLagMs: med(lag),
    buckets,
  };
}

function sum(a) {
  return a.reduce((s, x) => s + x, 0);
}

function main() {
  const extra = argVal('--dir', null);
  const dirs = [
    path.resolve(ROOT, '../polymarket-fm/logs/shadow'),
    path.resolve(ROOT, 'labs/strategies/carry/shotandgo-v1/shadow'),
  ];
  if (extra) dirs.unshift(path.resolve(extra));

  const files = loadShadows(dirs);
  if (!files.length) {
    console.error('Nenhum shadow Phil encontrado em', dirs.join(' | '));
    process.exit(2);
  }

  const allRows = [];
  const perFile = [];
  for (const f of files) {
    const a = analyzeFile(f);
    perFile.push({ file: path.basename(f), slug: a.slug, fills: a.rows.length, ticks: a.nTicks });
    allRows.push(...a.rows);
  }

  const taker = allRows.filter((r) => r.liquidity === 'taker' || r.kind === 'SUB' || r.kind === 'EQUALIZA');
  const maker = allRows.filter((r) => r.liquidity === 'maker' || r.kind === 'DESC');
  const sub = allRows.filter((r) => r.kind === 'SUB');
  const desc = allRows.filter((r) => r.kind === 'DESC');

  const report = {
    kind: 'shotandgo-fill-quality',
    doggyBenchmark: { medFillMinusAskC: -0.7, note: 'Doggy tick-replay Etapa 1' },
    files: perFile,
    overall: summarize(allRows, 'all'),
    takerLike: summarize(taker, 'taker/SUB/EQ'),
    makerLike: summarize(maker, 'maker/DESC'),
    subOnly: summarize(sub, 'SUB'),
    descOnly: summarize(desc, 'DESC'),
    note: 'Shadows atuais são DRY (simulado). SUB dry usa preço de execução Phil; DESC dry = nível (optimistic) ou resting. Comparar com Doggy live só como referência de método.',
  };

  console.log('=== Shotandgo fill quality (Phil shadow × book) ===\n');
  console.log(`Arquivos: ${perFile.length} · fills: ${allRows.length}`);
  for (const s of [report.overall, report.subOnly, report.descOnly, report.takerLike, report.makerLike]) {
    console.log(`\n[${s.label}] n=${s.n}`);
    console.log(`  med fill−ask = ${s.medFillMinusAskC}¢  mean = ${s.meanFillMinusAskC}¢`);
    console.log(`  ≤ask ${s.pctAtOrBelowAsk?.toFixed?.(1)}% · ≤ask−1¢ ${s.pctCheaperThanAsk1c?.toFixed?.(1)}% · walk>${1}¢ ${s.pctWalkAsk?.toFixed?.(1)}%`);
    console.log(`  edge vs ask Σ$ = ${s.edgeVsAskUsd} · med|lag|=${s.medAbsLagMs}ms`);
    console.log(`  buckets ${JSON.stringify(s.buckets)}`);
  }
  console.log(`\nDoggy benchmark: med fill−ask ≈ ${report.doggyBenchmark.medFillMinusAskC}¢`);

  const outDir = path.resolve(ROOT, 'labs/strategies/carry/shotandgo-v1/shadow');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'FILL-QUALITY.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nsalvo: ${outPath}`);
}

main();
