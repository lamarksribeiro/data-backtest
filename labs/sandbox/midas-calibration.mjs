/**
 * Calibração quantitativa Midas — entradas TFC-like e cheap-scoop no cubo de features.
 *
 * Uso: node --max-old-space-size=8192 labs/sandbox/midas-calibration.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CUBE_DIR = path.join('labs', 'mining', 'cube');
const REPORT_PATH = path.join('labs', 'sandbox', 'midas-calibration-report.md');
const B = 10;
const JUNE_START = '2026-06-01';
const JULY_START = '2026-07-01';
const JUNE_END = '2026-06-30';

const SPLITS = ['train', 'june', 'july', 'total'];

const COL = {
  dt: 0, condition_id: 1, ts_ms: 2, tau: 3, dist_abs: 7,
  ask_fav: 9, spread_fav: 11, odds_sum: 14, sigma_ps_90: 21, obi5: 31,
  edge_phys: 38, coverage: 39, degraded: 40, mkt_agree: 41,
  fav_won: 43, pnl_fav: 44,
};

const Z_BINS = [
  { label: '[0,0.5)', lo: 0, hi: 0.5 },
  { label: '[0.5,1)', lo: 0.5, hi: 1 },
  { label: '[1,1.5)', lo: 1, hi: 1.5 },
  { label: '[1.5,2.5)', lo: 1.5, hi: 2.5 },
  { label: '[2.5,4)', lo: 2.5, hi: 4 },
  { label: '>=4', lo: 4, hi: Infinity },
];

const ASK_CROSS_BINS = [
  { label: '0.55-0.62', lo: 0.55, hi: 0.62 },
  { label: '0.62-0.70', lo: 0.62, hi: 0.7 },
  { label: '0.70-0.82', lo: 0.7, hi: 0.82 },
];

const CHEAP_ASK_BINS = [
  { label: '0.10-0.30', lo: 0.1, hi: 0.3 },
  { label: '0.30-0.45', lo: 0.3, hi: 0.45 },
  { label: '0.45-0.55', lo: 0.45, hi: 0.55 },
];

const TAU_BINS = [
  { label: '[5,10)', lo: 5, hi: 10 },
  { label: '[10,20)', lo: 10, hi: 20 },
  { label: '[20,30)', lo: 20, hi: 30 },
];

const CHEAP_VARIANTS = [
  { key: 'z1.0_tau30', zMin: 1.0, tauLo: 5, tauHi: 30 },
  { key: 'z1.5_tau30', zMin: 1.5, tauLo: 5, tauHi: 30 },
  { key: 'z2.0_tau30', zMin: 2.0, tauLo: 5, tauHi: 30 },
  { key: 'z1.0_tau15', zMin: 1.0, tauLo: 5, tauHi: 15 },
  { key: 'z1.5_tau15', zMin: 1.5, tauLo: 5, tauHi: 15 },
  { key: 'z2.0_tau15', zMin: 2.0, tauLo: 5, tauHi: 15 },
];

const SCHEMES = {
  fixed: { label: 'fixed', weight: () => 10, skip: () => false },
  zlinear: { label: 'zlinear', weight: (r) => clamp(5 * r.z, 4, 20), skip: () => false },
  zstep: { label: 'zstep', weight: (r) => zstepWeight(r.z), skip: () => false },
  'zstep-obi': {
    label: 'zstep-obi',
    weight: (r) => {
      let w = zstepWeight(r.z);
      if (r.obi5 > 0.3) w = Math.min(20, w * 1.2);
      return w;
    },
    skip: () => false,
  },
  edgekelly: {
    label: 'edgekelly',
    weight: (r) => clamp(150 * Math.max(r.edge_phys, 0), 0, 20),
    skip: (r) => r.edge_phys == null || r.edge_phys < 0.01,
  },
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function zstepWeight(z) {
  if (z < 0.5) return 4;
  if (z < 1) return 7;
  if (z < 2.5) return 10;
  if (z < 4) return 14;
  return 18;
}

function parseNum(s) {
  if (s == null || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function splitOf(dt) {
  if (dt < JUNE_START) return 'train';
  if (dt <= JUNE_END) return 'june';
  return 'july';
}

function inBin(v, bin) {
  return v >= bin.lo && v < bin.hi;
}

function zBinLabel(z) {
  for (const b of Z_BINS) {
    if (inBin(z, b)) return b.label;
  }
  return null;
}

function askCrossLabel(ask) {
  for (const b of ASK_CROSS_BINS) {
    if (ask >= b.lo && ask < b.hi) return b.label;
  }
  return null;
}

function cheapAskLabel(ask) {
  for (const b of CHEAP_ASK_BINS) {
    if (ask >= b.lo && ask < b.hi) return b.label;
  }
  return null;
}

function tauBinLabel(tau) {
  for (const b of TAU_BINS) {
    if (inBin(tau, b)) return b.label;
  }
  return null;
}

function passesQuality(row) {
  if (row.coverage == null || row.coverage < 0.9) return false;
  if (row.degraded !== 0) return false;
  if (row.mkt_agree !== 1) return false;
  if (row.sigma_ps_90 == null || row.sigma_ps_90 <= 0) return false;
  return true;
}

function passesTfcGates(row) {
  if (!(row.tau >= 5 && row.tau < 30)) return false;
  if (!(row.dist_abs != null && row.dist_abs < 20)) return false;
  if (!(row.ask_fav >= 0.55 && row.ask_fav <= 0.82)) return false;
  if (!(row.spread_fav != null && row.spread_fav <= 0.03)) return false;
  if (!(row.odds_sum >= 0.98 && row.odds_sum <= 1.06)) return false;
  if (row.obi5 == null || row.obi5 < 0) return false;
  return true;
}

function passesCheapGates(row, zMin, tauLo, tauHi) {
  if (!(row.tau >= tauLo && row.tau < tauHi)) return false;
  if (!(row.ask_fav < 0.55 && row.ask_fav >= 0.1)) return false;
  if (!(row.spread_fav != null && row.spread_fav <= 0.05)) return false;
  if (row.z == null || row.z < zMin) return false;
  return true;
}

function parseRow(fields) {
  const dt = fields[COL.dt];
  const tau = parseNum(fields[COL.tau]);
  const distAbs = parseNum(fields[COL.dist_abs]);
  const sigma = parseNum(fields[COL.sigma_ps_90]);
  const z = distAbs != null && sigma != null && sigma > 0 && tau != null && tau > 0
    ? distAbs / (sigma * Math.sqrt(tau))
    : null;

  return {
    dt,
    split: splitOf(dt),
    condition_id: fields[COL.condition_id],
    ts_ms: parseNum(fields[COL.ts_ms]),
    tau,
    dist_abs: distAbs,
    ask_fav: parseNum(fields[COL.ask_fav]),
    spread_fav: parseNum(fields[COL.spread_fav]),
    odds_sum: parseNum(fields[COL.odds_sum]),
    obi5: parseNum(fields[COL.obi5]),
    sigma_ps_90: sigma,
    edge_phys: parseNum(fields[COL.edge_phys]),
    coverage: parseNum(fields[COL.coverage]),
    degraded: parseNum(fields[COL.degraded]) ?? 0,
    mkt_agree: fields[COL.mkt_agree] === '' ? null : parseNum(fields[COL.mkt_agree]),
    fav_won: parseNum(fields[COL.fav_won]),
    pnl_fav: parseNum(fields[COL.pnl_fav]),
    z,
  };
}

function maybeReplaceEarliest(map, cid, row) {
  const prev = map.get(cid);
  if (!prev || row.ts_ms < prev.ts_ms) {
    map.set(cid, row);
    return true;
  }
  return false;
}

function listCubeFiles() {
  if (!fs.existsSync(CUBE_DIR)) return [];
  return fs.readdirSync(CUBE_DIR)
    .filter((f) => /^dt=\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .map((f) => path.join(CUBE_DIR, f))
    .sort();
}

async function streamCube(onRow) {
  const files = listCubeFiles();
  let lines = 0;
  for (const filePath of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo === 1) continue;
      if (!line.trim()) continue;
      lines += 1;
      onRow(line.split(','));
    }
  }
  return { files: files.length, lines };
}

function emptyAgg() {
  return { n: 0, wins: 0, sum: 0 };
}

function addAgg(agg, row) {
  agg.n += 1;
  if (row.fav_won === 1) agg.wins += 1;
  agg.sum += row.pnl_fav ?? 0;
}

function aggStats(agg) {
  if (!agg.n) return { n: 0, wr: 0, sum: 0, exp: 0 };
  return {
    n: agg.n,
    wr: agg.wins / agg.n,
    sum: agg.sum,
    exp: agg.sum / agg.n,
  };
}

function maxDrawdown(trades, pnlFn) {
  const sorted = [...trades].sort((a, b) => a.ts_ms - b.ts_ms);
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += pnlFn(t);
    if (equity > peak) peak = equity;
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function profitFactor(trades, pnlFn) {
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of trades) {
    const p = pnlFn(t);
    if (p > 0) grossWin += p;
    else if (p < 0) grossLoss += Math.abs(p);
  }
  if (grossLoss === 0) return grossWin > 0 ? Infinity : 0;
  return grossWin / grossLoss;
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtUsd(x) {
  if (!Number.isFinite(x)) return '—';
  return `$${x.toFixed(2)}`;
}

function fmtN(x) {
  return Number.isFinite(x) ? x.toFixed(2) : '—';
}

function mdTable(headers, rows) {
  const sep = headers.map(() => '---');
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `| ${headers.join(' | ')} |\n| ${sep.join(' | ')} |\n${body}`;
}

function splitRows(rows, split) {
  if (split === 'total') return rows;
  return rows.filter((r) => r.split === split);
}

function buildTfcTables(tfcEntries) {
  const out = {};
  for (const split of SPLITS) {
    const rows = splitRows(tfcEntries, split);
    const zTable = Z_BINS.map((b) => {
      const subset = rows.filter((r) => inBin(r.z, b));
      const st = aggStats(subset.reduce((a, r) => { addAgg(a, r); return a; }, emptyAgg()));
      return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.sum), fmtUsd(st.exp)];
    });
    const crossRows = [];
    for (const zb of Z_BINS) {
      for (const ab of ASK_CROSS_BINS) {
        const subset = rows.filter((r) => inBin(r.z, zb) && r.ask_fav >= ab.lo && r.ask_fav < ab.hi);
        const st = aggStats(subset.reduce((a, r) => { addAgg(a, r); return a; }, emptyAgg()));
        crossRows.push([zb.label, ab.label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp)]);
      }
    }
    out[split] = { zTable, crossRows, rows };
  }
  return out;
}

function simulateSizing(tfcEntries) {
  const out = {};
  for (const [schemeKey, scheme] of Object.entries(SCHEMES)) {
    out[schemeKey] = {};
    for (const split of SPLITS) {
      const baseRows = splitRows(tfcEntries, split);
      const trades = [];
      for (const r of baseRows) {
        if (scheme.skip(r)) continue;
        const w = scheme.weight(r);
        if (!(w > 0)) continue;
        const scaledPnl = (r.pnl_fav ?? 0) * (w / B);
        trades.push({ ...r, w, scaledPnl });
      }
      const n = trades.length;
      const avgBudget = n ? trades.reduce((s, t) => s + t.w, 0) / n : 0;
      const totalPnl = trades.reduce((s, t) => s + t.scaledPnl, 0);
      const normFactor = avgBudget > 0 ? B / avgBudget : 1;
      const normPnlFn = (t) => t.scaledPnl * normFactor;
      const totalNorm = totalPnl * normFactor;
      const grossWin = trades.filter((t) => t.scaledPnl > 0).reduce((s, t) => s + t.scaledPnl, 0);
      const grossLoss = trades.filter((t) => t.scaledPnl < 0).reduce((s, t) => s + Math.abs(t.scaledPnl), 0);
      out[schemeKey][split] = {
        n,
        avgBudget,
        totalPnl,
        totalNorm,
        expNorm: n ? totalNorm / n : 0,
        maxDd: maxDrawdown(trades, normPnlFn),
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      };
    }
  }
  return out;
}

function buildCheapTables(cheapByVariant) {
  const out = {};
  for (const variant of CHEAP_VARIANTS) {
    out[variant.key] = {};
    const entries = cheapByVariant.get(variant.key) ?? [];
    for (const split of SPLITS) {
      const rows = splitRows(entries, split);
      const overall = aggStats(rows.reduce((a, r) => { addAgg(a, r); return a; }, emptyAgg()));
      const askRows = CHEAP_ASK_BINS.map((b) => {
        const subset = rows.filter((r) => r.ask_fav >= b.lo && r.ask_fav < b.hi);
        const st = aggStats(subset.reduce((a, r) => { addAgg(a, r); return a; }, emptyAgg()));
        return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp)];
      });
      const tauRows = TAU_BINS.map((b) => {
        const subset = rows.filter((r) => inBin(r.tau, b));
        const st = aggStats(subset.reduce((a, r) => { addAgg(a, r); return a; }, emptyAgg()));
        return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp)];
      });
      const dd = maxDrawdown(rows, (r) => r.pnl_fav ?? 0);
      out[variant.key][split] = { overall, askRows, tauRows, dd, rows };
    }
  }
  return out;
}

function buildSanity(uniqueEventsBySplit, tfcEntries) {
  const tfcBySplit = { train: 0, june: 0, july: 0, total: 0 };
  for (const r of tfcEntries) {
    tfcBySplit[r.split] += 1;
    tfcBySplit.total += 1;
  }
  const out = {};
  for (const split of SPLITS) {
    const events = split === 'total'
      ? uniqueEventsBySplit.train + uniqueEventsBySplit.june + uniqueEventsBySplit.july
      : uniqueEventsBySplit[split];
    const tfc = tfcBySplit[split];
    out[split] = {
      events,
      tfc,
      pct: events ? tfc / events : 0,
    };
  }
  return out;
}

function observations({ sanity, tfcTables, sizing, cheapTables, meta }) {
  const lines = [];
  lines.push(`- Cubo: **${meta.files}** arquivos, **${meta.lines.toLocaleString('pt-BR')}** linhas processadas.`);
  lines.push(`- Eventos únicos (total): **${sanity.total.events.toLocaleString('pt-BR')}**; entradas TFC-like: **${sanity.total.tfc}** (${fmtPct(sanity.total.pct)}).`);

  const trainTfc = tfcTables.train.rows;
  const juneTfc = tfcTables.june.rows;
  const trainExp = trainTfc.length ? trainTfc.reduce((s, r) => s + (r.pnl_fav ?? 0), 0) / trainTfc.length : 0;
  const juneExp = juneTfc.length ? juneTfc.reduce((s, r) => s + (r.pnl_fav ?? 0), 0) / juneTfc.length : 0;
  lines.push(`- Expectância TFC-like $10 fixo: train **${fmtUsd(trainExp)}**/trade vs june **${fmtUsd(juneExp)}**/trade.`);

  const fixedTotal = sizing.fixed.total;
  const zstepTotal = sizing.zstep.total;
  const edgeTotal = sizing.edgekelly.total;
  if (fixedTotal.n) {
    lines.push(`- Sizing total (normalizado $10 médio): fixed PnL **${fmtUsd(fixedTotal.totalNorm)}** (PF ${fmtN(fixedTotal.profitFactor)}, DD ${fmtUsd(fixedTotal.maxDd)}) vs zstep **${fmtUsd(zstepTotal.totalNorm)}** (PF ${fmtN(zstepTotal.profitFactor)}, DD ${fmtUsd(zstepTotal.maxDd)}).`);
    if (edgeTotal.n < fixedTotal.n) {
      lines.push(`- edgekelly descarta ${fixedTotal.n - edgeTotal.n} entradas com edge_phys < 0.01; PnL norm **${fmtUsd(edgeTotal.totalNorm)}**, n=${edgeTotal.n}.`);
    }
  }

  const cheapBase = cheapTables['z1.0_tau30']?.total?.overall;
  if (cheapBase?.n) {
    lines.push(`- Cheap-scoop (z≥1, τ∈[5,30)): **${cheapBase.n}** entradas, WR ${fmtPct(cheapBase.wr)}, exp ${fmtUsd(cheapBase.exp)} — perfil distinto do TFC (favorito barato com z alto).`);
  } else {
    lines.push('- Cheap-scoop: poucas ou nenhuma entrada nas variantes testadas.');
  }

  const highZ = tfcTables.total.zTable.find((r) => r[0] === '>=4');
  if (highZ && Number(highZ[1]) > 0) {
    lines.push(`- Bin z≥4 no TFC: n=${highZ[1]}, WR ${highZ[2]}, exp ${highZ[4]} — extremos de distância/vol merecem atenção no sizing.`);
  }

  return lines;
}

async function main() {
  const tfcCandidates = new Map();
  const cheapCandidates = new Map();
  for (const v of CHEAP_VARIANTS) cheapCandidates.set(v.key, new Map());
  const uniqueEventsBySplit = { train: new Set(), june: new Set(), july: new Set() };

  const meta = await streamCube((fields) => {
    const row = parseRow(fields);
    if (!row.condition_id || !row.dt || row.ts_ms == null) return;

    uniqueEventsBySplit[row.split].add(row.condition_id);

    if (!passesQuality(row)) return;

    if (passesTfcGates(row)) {
      maybeReplaceEarliest(tfcCandidates, row.condition_id, row);
    }

    for (const variant of CHEAP_VARIANTS) {
      if (passesCheapGates(row, variant.zMin, variant.tauLo, variant.tauHi)) {
        maybeReplaceEarliest(cheapCandidates.get(variant.key), row.condition_id, row);
      }
    }
  });

  const tfcEntries = [...tfcCandidates.values()];
  const tfcIds = new Set(tfcEntries.map((r) => r.condition_id));

  const cheapByVariant = new Map();
  for (const variant of CHEAP_VARIANTS) {
    const entries = [...cheapCandidates.get(variant.key).values()]
      .filter((r) => !tfcIds.has(r.condition_id));
    cheapByVariant.set(variant.key, entries);
  }

  const tfcTables = buildTfcTables(tfcEntries);
  const sizing = simulateSizing(tfcEntries);
  const cheapTables = buildCheapTables(cheapByVariant);
  const sanity = buildSanity({
    train: uniqueEventsBySplit.train.size,
    june: uniqueEventsBySplit.june.size,
    july: uniqueEventsBySplit.july.size,
  }, tfcEntries);

  const lines = [];
  lines.push('# Midas Calibration Report');
  lines.push('');
  lines.push(`Gerado em: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## 1. Entradas TFC-like por bin de z');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['z-bin', 'n', 'WR', 'Σ pnl', 'exp'], tfcTables[split].zTable));
    lines.push('');
  }

  lines.push('## 2. Cruzamento z-bin × ask-bin (TFC-like)');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['z-bin', 'ask-bin', 'n', 'WR', 'exp'], tfcTables[split].crossRows));
    lines.push('');
  }

  lines.push('## 3. Simulação de sizing (TFC-like)');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    const rows = Object.entries(SCHEMES).map(([key]) => {
      const s = sizing[key][split];
      return [
        key,
        String(s.n),
        fmtUsd(s.avgBudget),
        fmtUsd(s.totalPnl),
        fmtUsd(s.totalNorm),
        fmtUsd(s.expNorm),
        fmtUsd(s.maxDd),
        fmtN(s.profitFactor),
      ];
    });
    lines.push(mdTable(['esquema', 'n', 'orç. médio', 'PnL total', 'PnL norm', 'exp norm', 'max DD norm', 'PF'], rows));
    lines.push('');
  }

  lines.push('## 4. Entradas cheap-scoop');
  lines.push('');
  for (const variant of CHEAP_VARIANTS) {
    lines.push(`### Variante ${variant.key} (z≥${variant.zMin}, τ∈[${variant.tauLo},${variant.tauHi}))`);
    lines.push('');
    for (const split of SPLITS) {
      const block = cheapTables[variant.key][split];
      lines.push(`#### ${split}`);
      lines.push('');
      lines.push(`Resumo: n=${block.overall.n}, WR=${fmtPct(block.overall.wr)}, Σ=${fmtUsd(block.overall.sum)}, exp=${fmtUsd(block.overall.exp)}, max DD ($10 fixo)=${fmtUsd(block.dd)}`);
      lines.push('');
      lines.push('Por ask_fav:');
      lines.push('');
      lines.push(mdTable(['ask-bin', 'n', 'WR', 'exp'], block.askRows));
      lines.push('');
      lines.push('Por tau:');
      lines.push('');
      lines.push(mdTable(['tau-bin', 'n', 'WR', 'exp'], block.tauRows));
      lines.push('');
    }
  }

  lines.push('## 5. Sanidade');
  lines.push('');
  const sanityRows = SPLITS.map((split) => [
    split,
    String(sanity[split].events),
    String(sanity[split].tfc),
    fmtPct(sanity[split].pct),
  ]);
  lines.push(mdTable(['split', 'eventos únicos', 'entradas TFC', '% TFC'], sanityRows));
  lines.push('');

  lines.push('## Observações');
  lines.push('');
  for (const line of observations({ sanity, tfcTables, sizing, cheapTables, meta })) {
    lines.push(line);
  }
  lines.push('');

  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Relatório gravado em ${REPORT_PATH}`);
  console.log(`Arquivos: ${meta.files}, linhas: ${meta.lines}, TFC: ${tfcEntries.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
