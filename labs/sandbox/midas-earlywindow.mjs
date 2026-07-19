/**
 * Midas early-window — bolsões por janela de tau (atual vs estendida).
 *
 * Uso: node --max-old-space-size=8192 labs/sandbox/midas-earlywindow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CUBE_DIR = path.join('labs', 'mining', 'cube');
const REPORT_PATH = path.join('labs', 'sandbox', 'midas-earlywindow-report.md');
const JUNE_START = '2026-06-01';
const JUNE_END = '2026-06-30';
const SPLITS = ['train', 'june', 'july', 'total'];

const COL = {
  dt: 0, condition_id: 1, ts_ms: 2, tau: 3, dist_abs: 7,
  ask_fav: 9, spread_fav: 11, odds_sum: 14,
  sigma_ps_90: 21, obi5: 31,
  coverage: 39, degraded: 40, mkt_agree: 41,
  fav_won: 43, pnl_fav: 44,
};

const ASK_BINS = [
  { label: '[0.55,0.70)', lo: 0.55, hi: 0.7 },
  { label: '[0.70,0.82)', lo: 0.7, hi: 0.82 },
  { label: '[0.82,0.94)', lo: 0.82, hi: 0.94 },
];

const Z_BINS = [
  { label: '[0,0.5)', lo: 0, hi: 0.5 },
  { label: '[0.5,1)', lo: 0.5, hi: 1 },
  { label: '[1,2)', lo: 1, hi: 2 },
  { label: '>=2', lo: 2, hi: Infinity },
];

const UNIVERSES = {
  A: {
    label: 'A — janela atual',
    desc: 'τ∈[5,30), ask∈[0.55,0.94], spread≤0.03, obi5≥0, odds_sum∈[0.98,1.06], dist<40',
    gate: (r) => baseGates(r) && r.tau >= 5 && r.tau < 30 && r.ask_fav >= 0.55 && r.ask_fav <= 0.94,
  },
  B: {
    label: 'B — janela estendida',
    desc: 'τ∈[30,60), demais filtros iguais a A',
    gate: (r) => baseGates(r) && r.tau >= 30 && r.tau < 60 && r.ask_fav >= 0.55 && r.ask_fav <= 0.94,
  },
  C: {
    label: 'C — janela estendida cara',
    desc: 'τ∈[30,60), ask∈[0.75,0.94], demais filtros iguais',
    gate: (r) => baseGates(r) && r.tau >= 30 && r.tau < 60 && r.ask_fav >= 0.75 && r.ask_fav <= 0.94,
  },
  D: {
    label: 'D — janela muito estendida cara',
    desc: 'τ∈[60,120), ask∈[0.80,0.94], demais filtros iguais',
    gate: (r) => baseGates(r) && r.tau >= 60 && r.tau < 120 && r.ask_fav >= 0.8 && r.ask_fav <= 0.94,
  },
};

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

function passesQuality(row) {
  if (row.coverage == null || row.coverage < 0.9) return false;
  if (row.degraded !== 0) return false;
  if (row.mkt_agree !== 1) return false;
  if (row.sigma_ps_90 == null || row.sigma_ps_90 <= 0) return false;
  return true;
}

function baseGates(row) {
  if (!(row.dist_abs != null && row.dist_abs < 40)) return false;
  if (!(row.spread_fav != null && row.spread_fav <= 0.03)) return false;
  if (row.obi5 == null || row.obi5 < 0) return false;
  if (!(row.odds_sum >= 0.98 && row.odds_sum <= 1.06)) return false;
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
    z,
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

async function loadAllUniverses() {
  const candidates = Object.fromEntries(Object.keys(UNIVERSES).map((k) => [k, new Map()]));
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

      const row = parseRow(line.split(','));
      if (!row.condition_id || !row.dt || row.ts_ms == null) continue;
      if (!passesQuality(row)) continue;

      for (const [key, u] of Object.entries(UNIVERSES)) {
        if (u.gate(row)) maybeReplaceEarliest(candidates[key], row.condition_id, row);
      }
    }
  }

  const entries = Object.fromEntries(
    Object.keys(UNIVERSES).map((k) => [k, [...candidates[k].values()]]),
  );
  return { entries, meta: { files: files.length, lines } };
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

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtUsd(x) {
  if (!Number.isFinite(x)) return '—';
  return `$${x.toFixed(2)}`;
}

function mdTable(headers, rows) {
  if (!rows.length) return '_sem dados_';
  const sep = headers.map(() => '---');
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `| ${headers.join(' | ')} |\n| ${sep.join(' | ')} |\n${body}`;
}

function summaryRow(entries, split) {
  const rows = splitRows(entries, split);
  const st = stats(rows);
  return [String(st.n), fmtPct(st.wr), fmtUsd(st.sum), fmtUsd(st.exp), fmtUsd(maxDrawdown(rows))];
}

function askBinTable(entries, split) {
  const rows = splitRows(entries, split);
  return ASK_BINS.map((b) => {
    const subset = rows.filter((r) => r.ask_fav >= b.lo && r.ask_fav < b.hi);
    const st = stats(subset);
    return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.sum), fmtUsd(st.exp)];
  });
}

function zBinTable(entries, split) {
  const rows = splitRows(entries, split);
  return Z_BINS.map((b) => {
    const subset = rows.filter((r) => r.z != null && inBin(r.z, b));
    const st = stats(subset);
    return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.sum), fmtUsd(st.exp)];
  });
}

function observations(allEntries, meta) {
  const lines = [];
  lines.push(`- Fonte: ${meta.files} arquivos, ${meta.lines.toLocaleString('pt-BR')} linhas. Universos independentes (evento pode aparecer em vários).`);

  for (const [key, u] of Object.entries(UNIVERSES)) {
    const st = stats(allEntries[key]);
    lines.push(`- **${key}** (${u.desc}): n=${st.n}, exp ${fmtUsd(st.exp)}, WR ${fmtPct(st.wr)}.`);
    for (const split of ['train', 'june', 'july']) {
      const s = stats(splitRows(allEntries[key], split));
      lines.push(`  - ${split}: n=${s.n}, exp ${fmtUsd(s.exp)}.`);
    }
  }

  const stable = [];
  for (const key of Object.keys(UNIVERSES)) {
    let ok = true;
    const exps = {};
    for (const split of ['train', 'june', 'july']) {
      const s = stats(splitRows(allEntries[key], split));
      exps[split] = s.exp;
      if (s.n < 20 || s.exp <= 0) ok = false;
    }
    if (ok) stable.push({ key, exps });
  }

  if (stable.length) {
    lines.push('- **Estáveis** (exp>0, n≥20 nos 3 splits): ' + stable.map((s) => `${s.key} (train ${fmtUsd(s.exps.train)}, june ${fmtUsd(s.exps.june)}, july ${fmtUsd(s.exps.july)})`).join('; ') + '.');
  } else {
    lines.push('- Nenhum universo B/C/D atingiu exp>0 com n≥20 em **todos** os splits; comparar com A como baseline.');
  }

  const aExp = stats(allEntries.A).exp;
  for (const key of ['B', 'C', 'D']) {
    const e = stats(allEntries[key]).exp;
    lines.push(`- ${key} vs A (total): exp ${fmtUsd(e)} vs ${fmtUsd(aExp)} (${e > aExp ? 'melhor' : 'pior'} que janela atual).`);
  }

  return lines;
}

async function main() {
  const { entries, meta } = await loadAllUniverses();

  const lines = [];
  lines.push('# Midas Early-Window Report');
  lines.push('');
  lines.push(`Gerado em: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Bolsões independentes por janela de τ; um evento pode qualificar em mais de um universo.');
  lines.push('');

  for (const [key, u] of Object.entries(UNIVERSES)) {
    const data = entries[key];
    lines.push(`## Universo ${u.label}`);
    lines.push('');
    lines.push(u.desc);
    lines.push('');

    lines.push('### 1. Resumo');
    lines.push('');
    const summaryRows = SPLITS.map((split) => [split, ...summaryRow(data, split)]);
    lines.push(mdTable(['split', 'n', 'WR', 'Σ pnl', 'exp', 'max DD ($10)'], summaryRows));
    lines.push('');

    lines.push('### 2. Por ask-bin');
    lines.push('');
    for (const split of SPLITS) {
      lines.push(`#### ${split}`);
      lines.push('');
      lines.push(mdTable(['ask-bin', 'n', 'WR', 'Σ pnl', 'exp'], askBinTable(data, split)));
      lines.push('');
    }

    lines.push('### 3. Por z-bin');
    lines.push('');
    for (const split of SPLITS) {
      lines.push(`#### ${split}`);
      lines.push('');
      lines.push(mdTable(['z-bin', 'n', 'WR', 'Σ pnl', 'exp'], zBinTable(data, split)));
      lines.push('');
    }
  }

  lines.push('## Comparação');
  lines.push('');
  lines.push('Expectância por split (A vs B vs C vs D):');
  lines.push('');
  const cmpRows = SPLITS.map((split) => {
    const row = [split];
    for (const key of ['A', 'B', 'C', 'D']) {
      const st = stats(splitRows(entries[key], split));
      row.push(fmtUsd(st.exp), String(st.n));
    }
    return row;
  });
  lines.push(mdTable(
    ['split', 'exp A', 'n A', 'exp B', 'n B', 'exp C', 'n C', 'exp D', 'n D'],
    cmpRows,
  ));
  lines.push('');

  const cmpSumRows = ['train', 'june', 'july'].map((split) => {
    const row = [split];
    for (const key of ['A', 'B', 'C', 'D']) {
      row.push(fmtUsd(stats(splitRows(entries[key], split)).exp));
    }
    return row;
  });
  lines.push('Resumo exp (sem n):');
  lines.push('');
  lines.push(mdTable(['split', 'exp A', 'exp B', 'exp C', 'exp D'], cmpSumRows));
  lines.push('');

  lines.push('## Observações');
  lines.push('');
  for (const line of observations(entries, meta)) {
    lines.push(line);
  }
  lines.push('');

  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Relatório gravado em ${REPORT_PATH}`);
  for (const key of Object.keys(UNIVERSES)) {
    console.log(`  ${key}: ${entries[key].length} entradas`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
