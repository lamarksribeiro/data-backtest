/**
 * Cheap-scoop + momentum — filtros de sinal para pocket positivo.
 *
 * Uso: node --max-old-space-size=8192 labs/sandbox/midas-scoop-momentum.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CUBE_DIR = path.join('labs', 'mining', 'cube');
const REPORT_PATH = path.join('labs', 'sandbox', 'midas-scoop-momentum-report.md');
const JUNE_START = '2026-06-01';
const JUNE_END = '2026-06-30';
const SPLITS = ['train', 'june', 'july', 'total'];

const COL = {
  dt: 0, condition_id: 1, ts_ms: 2, tau: 3, dist_abs: 7, fav: 8,
  ask_fav: 9, spread_fav: 11, odds_sum: 14,
  d_spot_5: 15, d_spot_10: 16, d_spot_15: 17,
  sigma_ps_90: 21, obi5: 31,
  coverage: 39, degraded: 40, mkt_agree: 41,
  fav_won: 43, pnl_fav: 44,
};

const MOM_BINS = [
  { label: '(-∞,-5]', test: (m) => m <= -5 },
  { label: '(-5,0]', test: (m) => m > -5 && m <= 0 },
  { label: '(0,5]', test: (m) => m > 0 && m <= 5 },
  { label: '(5,15]', test: (m) => m > 5 && m <= 15 },
  { label: '>15', test: (m) => m > 15 },
];

const ASK_BINS = [
  { label: '0.10-0.30', lo: 0.1, hi: 0.3 },
  { label: '0.30-0.45', lo: 0.3, hi: 0.45 },
  { label: '0.45-0.55', lo: 0.45, hi: 0.55 },
];

const TAU_BINS = [
  { label: '[5,10)', lo: 5, hi: 10 },
  { label: '[10,20)', lo: 10, hi: 20 },
  { label: '[20,30)', lo: 20, hi: 30 },
];

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

function signedMom(dSpot, fav) {
  if (dSpot == null) return null;
  return fav === 'UP' ? dSpot : -dSpot;
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

function passesScoopGates(row) {
  if (!(row.tau >= 5 && row.tau < 30)) return false;
  if (!(row.ask_fav >= 0.1 && row.ask_fav < 0.55)) return false;
  if (!(row.spread_fav != null && row.spread_fav <= 0.05)) return false;
  if (row.z == null || row.z < 1.5) return false;
  return true;
}

function parseRow(fields) {
  const dt = fields[COL.dt];
  const fav = fields[COL.fav];
  const tau = parseNum(fields[COL.tau]);
  const distAbs = parseNum(fields[COL.dist_abs]);
  const sigma = parseNum(fields[COL.sigma_ps_90]);
  const z = distAbs != null && sigma != null && sigma > 0 && tau != null && tau > 0
    ? distAbs / (sigma * Math.sqrt(tau))
    : null;

  const d5 = parseNum(fields[COL.d_spot_5]);
  const d10 = parseNum(fields[COL.d_spot_10]);
  const d15 = parseNum(fields[COL.d_spot_15]);

  return {
    dt,
    split: splitOf(dt),
    condition_id: fields[COL.condition_id],
    ts_ms: parseNum(fields[COL.ts_ms]),
    tau,
    dist_abs: distAbs,
    fav,
    ask_fav: parseNum(fields[COL.ask_fav]),
    spread_fav: parseNum(fields[COL.spread_fav]),
    odds_sum: parseNum(fields[COL.odds_sum]),
    obi5: parseNum(fields[COL.obi5]),
    sigma_ps_90: sigma,
    z,
    mom5: signedMom(d5, fav),
    mom10: signedMom(d10, fav),
    mom15: signedMom(d15, fav),
    coverage: parseNum(fields[COL.coverage]),
    degraded: parseNum(fields[COL.degraded]) ?? 0,
    mkt_agree: fields[COL.mkt_agree] === '' ? null : parseNum(fields[COL.mkt_agree]),
    fav_won: parseNum(fields[COL.fav_won]),
    pnl_fav: parseNum(fields[COL.pnl_fav]),
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

function stats(rows) {
  if (!rows.length) return { n: 0, wr: 0, sum: 0, exp: 0 };
  const n = rows.length;
  const wins = rows.filter((r) => r.fav_won === 1).length;
  const sum = rows.reduce((s, r) => s + (r.pnl_fav ?? 0), 0);
  return { n, wr: wins / n, sum, exp: sum / n };
}

function splitRows(rows, split) {
  if (split === 'total') return rows;
  return rows.filter((r) => r.split === split);
}

function maxDrawdown(rows) {
  const sorted = [...rows].sort((a, b) => a.ts_ms - b.ts_ms);
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const r of sorted) {
    equity += r.pnl_fav ?? 0;
    if (equity > peak) peak = equity;
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function momBinLabel(mom) {
  if (mom == null) return null;
  for (const b of MOM_BINS) {
    if (b.test(mom)) return b.label;
  }
  return null;
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtUsd(x) {
  if (!Number.isFinite(x)) return '—';
  return `$${x.toFixed(2)}`;
}

function mdTable(headers, rows) {
  const sep = headers.map(() => '---');
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `| ${headers.join(' | ')} |\n| ${sep.join(' | ')} |\n${body}`;
}

function momBinTable(entries, split, momKey) {
  const rows = splitRows(entries, split);
  return MOM_BINS.map((b) => {
    const subset = rows.filter((r) => r[momKey] != null && b.test(r[momKey]));
    const st = stats(subset);
    return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.sum), fmtUsd(st.exp)];
  });
}

function crossTable(entries, split) {
  const rows = splitRows(entries, split);
  const confirmed = rows.filter((r) => r.mom5 != null && r.mom10 != null && r.mom5 > 0 && r.mom10 > 0);
  const rest = rows.filter((r) => !(r.mom5 != null && r.mom10 != null && r.mom5 > 0 && r.mom10 > 0));
  const out = [];
  for (const [label, subset] of [['mom5>0 ∧ mom10>0 (lag confirmado)', confirmed], ['resto', rest]]) {
    const st = stats(subset);
    out.push([label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp), fmtUsd(st.sum), fmtUsd(maxDrawdown(subset))]);
  }
  return out;
}

function confirmedDetail(entries, split) {
  const rows = splitRows(entries, split)
    .filter((r) => r.mom5 != null && r.mom10 != null && r.mom5 > 0 && r.mom10 > 0);

  const askRows = ASK_BINS.map((b) => {
    const subset = rows.filter((r) => r.ask_fav >= b.lo && r.ask_fav < b.hi);
    const st = stats(subset);
    return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp)];
  });

  const tauRows = TAU_BINS.map((b) => {
    const subset = rows.filter((r) => r.tau >= b.lo && r.tau < b.hi);
    const st = stats(subset);
    return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp)];
  });

  return { askRows, tauRows, overall: stats(rows) };
}

function thresholdTable(entries, split, filterFn, label) {
  const subset = splitRows(entries, split).filter(filterFn);
  const st = stats(subset);
  return [label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp)];
}

function findStableFilters(entries) {
  const candidates = [
    { label: 'mom5>0 ∧ mom10>0', fn: (r) => r.mom5 > 0 && r.mom10 > 0 },
    { label: 'mom10>0', fn: (r) => r.mom10 > 0 },
    { label: 'mom10>5', fn: (r) => r.mom10 > 5 },
    { label: 'mom10>10', fn: (r) => r.mom10 > 10 },
    { label: 'mom10>5 ∧ obi5≥0', fn: (r) => r.mom10 > 5 && r.obi5 != null && r.obi5 >= 0 },
    { label: 'mom10>5 ∧ mom15>0', fn: (r) => r.mom10 > 5 && r.mom15 > 0 },
    { label: 'mom5>0 ∧ mom10>5', fn: (r) => r.mom5 > 0 && r.mom10 > 5 },
    { label: 'mom5>5 ∧ mom10>5', fn: (r) => r.mom5 > 5 && r.mom10 > 5 },
    { label: 'mom10>5 ∧ ask∈[0.10,0.30)', fn: (r) => r.mom10 > 5 && r.ask_fav >= 0.1 && r.ask_fav < 0.3 },
    { label: 'mom10>5 ∧ tau∈[5,10)', fn: (r) => r.mom10 > 5 && r.tau >= 5 && r.tau < 10 },
  ];

  const stable = [];
  for (const c of candidates) {
    const exps = {};
    let allPositive = true;
    let minN = Infinity;
    for (const split of ['train', 'june', 'july']) {
      const subset = splitRows(entries, split).filter((r) => {
        if (r.mom5 == null || r.mom10 == null) return false;
        return c.fn(r);
      });
      const st = stats(subset);
      exps[split] = st.exp;
      minN = Math.min(minN, st.n);
      if (st.n < 15 || st.exp <= 0) allPositive = false;
    }
    if (allPositive && minN >= 15) {
      stable.push({ ...c, exps, minN });
    }
  }
  return stable;
}

function observations(entries, meta, stable) {
  const lines = [];
  const total = stats(entries);
  lines.push(`- Universo scoop (z≥1.5, sem TFC): **${total.n}** entradas, WR ${fmtPct(total.wr)}, exp ${fmtUsd(total.exp)}, Σ ${fmtUsd(total.sum)}.`);

  const confirmed = entries.filter((r) => r.mom5 > 0 && r.mom10 > 0);
  const stConf = stats(confirmed);
  lines.push(`- Filtro mom5>0 ∧ mom10>0: n=${stConf.n}, exp ${fmtUsd(stConf.exp)} (total); confirmação de lag spot→book.`);

  for (const split of ['train', 'june', 'july']) {
    const s = stats(splitRows(confirmed, split));
    lines.push(`  - ${split}: n=${s.n}, WR ${fmtPct(s.wr)}, exp ${fmtUsd(s.exp)}.`);
  }

  const mom10gt5 = entries.filter((r) => r.mom10 > 5);
  for (const split of ['train', 'june', 'july']) {
    const s = stats(splitRows(mom10gt5, split));
    lines.push(`- mom10>5 em ${split}: n=${s.n}, exp ${fmtUsd(s.exp)}.`);
  }

  const mom10gt5obi = entries.filter((r) => r.mom10 > 5 && r.obi5 != null && r.obi5 >= 0);
  for (const split of ['train', 'june', 'july']) {
    const s = stats(splitRows(mom10gt5obi, split));
    lines.push(`- mom10>5 ∧ obi5≥0 em ${split}: n=${s.n}, exp ${fmtUsd(s.exp)}.`);
  }

  if (stable.length) {
    lines.push('- **Filtros estáveis** (exp>0 e n≥15 em train/june/july):');
    for (const s of stable) {
      lines.push(`  - \`${s.label}\`: train ${fmtUsd(s.exps.train)}, june ${fmtUsd(s.exps.june)}, july ${fmtUsd(s.exps.july)} (min n=${s.minN}).`);
    }
  } else {
    lines.push('- Nenhum filtro testado atingiu exp>0 com n≥15 em **todos** os três splits; pockets positivos são locais (train vs june/july).');
  }

  const negMom = entries.filter((r) => r.mom5 != null && r.mom5 <= 0);
  const stNeg = stats(negMom);
  lines.push(`- Momentum contra favorito (mom5≤0): n=${stNeg.n}, exp ${fmtUsd(stNeg.exp)} — evitar.`);

  lines.push(`- Fonte: ${meta.files} arquivos, ${meta.lines.toLocaleString('pt-BR')} linhas.`);

  return lines;
}

async function main() {
  const tfcCandidates = new Map();
  const scoopCandidates = new Map();

  const meta = await streamCube((fields) => {
    const row = parseRow(fields);
    if (!row.condition_id || !row.dt || row.ts_ms == null) return;
    if (!passesQuality(row)) return;

    if (passesTfcGates(row)) {
      maybeReplaceEarliest(tfcCandidates, row.condition_id, row);
    }
    if (passesScoopGates(row)) {
      maybeReplaceEarliest(scoopCandidates, row.condition_id, row);
    }
  });

  const tfcIds = new Set([...tfcCandidates.keys()]);
  const entries = [...scoopCandidates.values()].filter((r) => !tfcIds.has(r.condition_id));

  const stable = findStableFilters(entries);

  const lines = [];
  lines.push('# Midas Scoop Momentum Report');
  lines.push('');
  lines.push(`Gerado em: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Universo: cheap-scoop (z≥1.5, ask∈[0.10,0.55), τ∈[5,30)) excluindo eventos com entrada TFC-like.');
  lines.push('');

  lines.push('## 1. Bins de mom5');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['mom5-bin', 'n', 'WR', 'Σ pnl', 'exp'], momBinTable(entries, split, 'mom5')));
    lines.push('');
  }

  lines.push('## 2. Bins de mom10');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['mom10-bin', 'n', 'WR', 'Σ pnl', 'exp'], momBinTable(entries, split, 'mom10')));
    lines.push('');
  }

  lines.push('## 3. Bins de mom15');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['mom15-bin', 'n', 'WR', 'Σ pnl', 'exp'], momBinTable(entries, split, 'mom15')));
    lines.push('');
  }

  lines.push('## 4. Cruzamento mom5>0 ∧ mom10>0 vs resto');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['grupo', 'n', 'WR', 'exp', 'Σ pnl', 'max DD ($10)'], crossTable(entries, split)));
    lines.push('');
  }

  lines.push('## 5. Detalhe: mom5>0 ∧ mom10>0');
  lines.push('');
  for (const split of SPLITS) {
    const d = confirmedDetail(entries, split);
    lines.push(`### ${split} (n=${d.overall.n}, WR=${fmtPct(d.overall.wr)}, exp=${fmtUsd(d.overall.exp)})`);
    lines.push('');
    lines.push('Por ask_fav:');
    lines.push('');
    lines.push(mdTable(['ask-bin', 'n', 'WR', 'exp'], d.askRows));
    lines.push('');
    lines.push('Por tau:');
    lines.push('');
    lines.push(mdTable(['tau-bin', 'n', 'WR', 'exp'], d.tauRows));
    lines.push('');
  }

  lines.push('## 6. Variantes de threshold mom10 (sozinho)');
  lines.push('');
  const thresholds = [
    { label: 'mom10 > 0', fn: (r) => r.mom10 != null && r.mom10 > 0 },
    { label: 'mom10 > 5', fn: (r) => r.mom10 != null && r.mom10 > 5 },
    { label: 'mom10 > 10', fn: (r) => r.mom10 != null && r.mom10 > 10 },
  ];
  for (const th of thresholds) {
    lines.push(`### ${th.label}`);
    lines.push('');
    const rows = SPLITS.map((split) => thresholdTable(entries, split, th.fn, split));
    lines.push(mdTable(['split', 'n', 'WR', 'exp'], rows));
    lines.push('');
  }

  lines.push('## 7. mom10>5 ∧ obi5≥0');
  lines.push('');
  const obiFilter = (r) => r.mom10 != null && r.mom10 > 5 && r.obi5 != null && r.obi5 >= 0;
  const obiRows = SPLITS.map((split) => thresholdTable(entries, split, obiFilter, split));
  lines.push(mdTable(['split', 'n', 'WR', 'exp'], obiRows));
  lines.push('');

  lines.push('## 8. Filtros candidatos estáveis (exp>0, n≥15 nos 3 splits)');
  lines.push('');
  if (stable.length) {
    const stableRows = stable.map((s) => [
      s.label,
      String(s.minN),
      fmtUsd(s.exps.train),
      fmtUsd(s.exps.june),
      fmtUsd(s.exps.july),
    ]);
    lines.push(mdTable(['filtro', 'min n', 'exp train', 'exp june', 'exp july'], stableRows));
  } else {
    lines.push('_Nenhum filtro da lista automática passou em todos os splits._');
  }
  lines.push('');

  lines.push('## Observações');
  lines.push('');
  for (const line of observations(entries, meta, stable)) {
    lines.push(line);
  }
  lines.push('');

  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Relatório gravado em ${REPORT_PATH}`);
  console.log(`Scoop entries: ${entries.length}, estáveis: ${stable.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
