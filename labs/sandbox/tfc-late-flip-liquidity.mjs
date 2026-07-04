/**
 * Liquidez no late flip reverse — cubo BTC 5m.
 * Simula: entrou no fav (V5 entry), cruzou contra nos últimos N segundos.
 * Mede fill do lado oposto (reverse) e bid do fav (exit) no tick do cruzamento.
 */
import fs from 'node:fs';
import path from 'node:path';

const CUBE_DIR = path.join('labs', 'mining', 'cube');
const FROM = '2026-04-27';
const TO = '2026-06-27';
const BUDGET = 10;
const MIN_SHARES = 1; // ~$10 / 0.95

function parseCsvLine(line) {
  const parts = line.split(',');
  const o = {};
  const cols = ['dt','condition_id','ts_ms','tau','spot','ptb','dist','dist_abs','fav',
    'ask_fav','bid_fav','spread_fav','ask_up','ask_down','odds_sum',
    'd_spot_5','d_spot_10','d_spot_15','d_spot_20','d_spot_30','d_spot_60',
    'sigma_ps_90','flips_60','secs_since_flip','pin45',
    'd_askfav_10','d_askfav_15','d_askfav_30','sigma_askfav_15',
    'depth5_ask_fav','depth5_bid_fav','obi5','ladder_fav',
    'fill_px_fav','fill_sh_fav','fill_px_non','fill_sh_non',
    'p_phys','edge_phys','coverage','degraded','mkt_agree',
    'winner','fav_won','pnl_fav','pnl_non'];
  cols.forEach((c, i) => { o[c] = parts[i] ?? ''; });
  for (const k of ['tau','dist','dist_abs','ask_fav','bid_fav','spread_fav','ask_up','ask_down',
    'fill_px_non','fill_sh_non','fill_px_fav','fill_sh_fav','d_spot_5']) {
    o[k] = o[k] === '' ? null : Number(o[k]);
  }
  return o;
}

function v5Entry(row) {
  if (row.tau < 5 || row.tau >= 30) return false;
  if (row.dist_abs >= 20) return false;
  if (row.ask_fav < 0.55 || row.ask_fav > 0.82) return false;
  if (row.spread_fav > 0.03) return false;
  if (row.odds_sum < 0.98 || row.odds_sum > 1.06) return false;
  if (row.d_spot_5 != null) {
    const adv = row.fav === 'UP' ? -row.d_spot_5 : row.d_spot_5;
    if (adv > 8) return false;
  }
  if (row.obi5 != null && row.obi5 < 0) return false;
  return true;
}

function signedDist(row, side) {
  const raw = row.spot - row.ptb;
  return side === 'DOWN' ? row.ptb - row.spot : raw;
}

function tauBucket(tau) {
  if (tau <= 2) return '0-2s';
  if (tau <= 5) return '2-5s';
  if (tau <= 8) return '5-8s';
  if (tau <= 15) return '8-15s';
  return '15-30s';
}

const stats = {
  eventsEntered: 0,
  eventsWithLateCross: 0,
  crosses: [], // { tau, bucket, fillShNon, fillPxNon, bidFav, askNon, canReverse, canExit }
};

function addCross(row, entrySide, tauLimit) {
  const sd = signedDist(row, entrySide);
  if (sd > 0) return false; // ainda não cruzou

  // Após cruzar, o novo favorito é o lado oposto à nossa posição.
  // No cubo, fill_fav = sweep de compra no fav ATUAL (= lado que vencerá).
  const newFav = entrySide === 'UP' ? 'DOWN' : 'UP';
  const fillSh = row.fill_sh_fav;
  const fillPx = row.fill_px_fav;
  const askNew = newFav === 'UP' ? row.ask_up : row.ask_down;
  const askOld = entrySide === 'UP' ? row.ask_up : row.ask_down;

  // Saída: vendemos o lado antigo (perdedor). Cubo não exporta bid do loser;
  // usamos ask do lado antigo como proxy de book vivo (bid < ask).
  const canExit = askOld != null && askOld >= 0.02;
  const canReverseEntry = fillSh != null && fillSh >= MIN_SHARES && fillPx != null && fillPx <= 0.95;
  stats.crosses.push({
    tau: row.tau,
    bucket: tauBucket(row.tau),
    fillShNew: fillSh,
    fillPxNew: fillPx,
    askNew,
    askOld,
    canReverseEntry,
    canExit,
    both: canReverseEntry && canExit,
    tauLimit,
  });
  return true;
}

function processEvent(lines) {
  const rows = lines.map(parseCsvLine).filter((r) => r.tau != null);
  rows.sort((a, b) => a.ts_ms - b.ts_ms);

  let entrySide = null;
  let entryTau = null;
  for (const row of rows) {
    if (!entrySide && v5Entry(row)) {
      entrySide = row.fav;
      entryTau = row.tau;
      stats.eventsEntered += 1;
      break;
    }
  }
  if (!entrySide) return;

  let crossed = false;
  for (const limit of [2, 4, 5, 8, 10]) {
    for (const row of rows) {
      if (row.tau > limit || row.tau < 0) continue;
      if (addCross(row, entrySide, limit)) {
        if (!crossed) {
          crossed = true;
          stats.eventsWithLateCross += 1;
        }
        break; // primeiro cruzamento dentro da janela
      }
    }
  }
}

function agg(crosses, filter) {
  const subset = crosses.filter(filter);
  const n = subset.length;
  if (!n) return { n: 0 };
  const pct = (x) => (100 * subset.filter(x).length / n).toFixed(1);
  const avg = (fn) => subset.reduce((s, r) => s + fn(r), 0) / n;
  return {
    n,
    pctCanExit: pct((r) => r.canExit),
    pctCanReverseEntry: pct((r) => r.canReverseEntry),
    pctBoth: pct((r) => r.both),
    avgFillShNew: avg((r) => r.fillShNew ?? 0).toFixed(1),
    avgFillPxNew: avg((r) => r.fillPxNew ?? 0).toFixed(3),
    avgAskOld: avg((r) => r.askOld ?? 0).toFixed(3),
    avgAskNew: avg((r) => r.askNew ?? 0).toFixed(3),
  };
}

// dias
const days = [];
for (let ms = Date.parse(`${FROM}T00:00:00Z`); ms <= Date.parse(`${TO}T00:00:00Z`); ms += 86400000) {
  days.push(new Date(ms).toISOString().slice(0, 10));
}

const byEvent = new Map();
for (const dt of days) {
  const fp = path.join(CUBE_DIR, `dt=${dt}.csv`);
  if (!fs.existsSync(fp)) continue;
  const text = fs.readFileSync(fp, 'utf8');
  const lines = text.trim().split('\n').slice(1);
  for (const line of lines) {
    const row = parseCsvLine(line);
    const cid = row.condition_id;
    if (!byEvent.has(cid)) byEvent.set(cid, []);
    byEvent.get(cid).push(line);
  }
}

for (const [, lines] of byEvent) processEvent(lines);

console.log('=== Liquidez no Late Flip Reverse (cubo, V5 entry, hold-to-cross) ===');
console.log(`Eventos com entrada V5: ${stats.eventsEntered}`);
console.log(`Eventos com cruzamento tardio (qualquer janela): ${stats.eventsWithLateCross}`);
console.log('');

for (const limit of [2, 4, 5, 8, 10]) {
  const a = agg(stats.crosses, (r) => r.tauLimit === limit);
  console.log(`--- Primeiro cruzamento com tau <= ${limit}s ---`);
  console.log(`  n=${a.n} | exit bid ok: ${a.pctCanExit}% | reverse fill ($10): ${a.pctCanReverseEntry}% | ambos: ${a.pctBoth}%`);
  console.log(`  médias: fill_sh_new=${a.avgFillShNew} fill_px_new=${a.avgFillPxNew} ask_old=${a.avgAskOld} ask_new=${a.avgAskNew}`);
}

console.log('');
console.log('--- Por bucket de tau no momento do cruzamento (limite 10s) ---');
for (const b of ['0-2s', '2-5s', '5-8s', '8-15s']) {
  const a = agg(stats.crosses, (r) => r.tauLimit === 10 && r.bucket === b);
  if (a.n) console.log(`  ${b}: n=${a.n} reverse_fill=${a.pctCanReverseEntry}% both=${a.pctBoth}% avg_ask_new=${a.avgAskNew} avg_fill_px=${a.avgFillPxNew}`);
}

// ask_non distribution when tau <= 2
const late2 = stats.crosses.filter((r) => r.tauLimit === 2);
const askBins = { '<0.55': 0, '0.55-0.70': 0, '0.70-0.85': 0, '0.85-0.95': 0, '>0.95': 0, 'no_fill': 0 };
for (const r of late2) {
  const px = r.fillPxNew;
  if (px == null || r.fillShNew < MIN_SHARES) { askBins.no_fill += 1; continue; }
  if (px < 0.55) askBins['<0.55'] += 1;
  else if (px < 0.70) askBins['0.55-0.70'] += 1;
  else if (px < 0.85) askBins['0.70-0.85'] += 1;
  else if (px <= 0.95) askBins['0.85-0.95'] += 1;
  else askBins['>0.95'] += 1;
}
console.log('');
console.log('--- Distribuição fill_px_new (comprar novo fav) quando cruzamento em tau<=2s ---');
for (const [k, v] of Object.entries(askBins)) console.log(`  ${k}: ${v} (${late2.length ? (100*v/late2.length).toFixed(1) : 0}%)`);
