/**
 * Midas high-ask — bolsão de favorito caro (ask≥0.82) que a TFC descarta.
 *
 * Uso: node --max-old-space-size=8192 labs/sandbox/midas-highask.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CUBE_DIR = path.join('labs', 'mining', 'cube');
const REPORT_PATH = path.join('labs', 'sandbox', 'midas-highask-report.md');
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
  { label: '[0.82,0.86)', lo: 0.82, hi: 0.86 },
  { label: '[0.86,0.90)', lo: 0.86, hi: 0.9 },
  { label: '[0.90,0.94)', lo: 0.9, hi: 0.94 },
  { label: '[0.94,0.97)', lo: 0.94, hi: 0.97 },
];

const Z_BINS = [
  { label: '[0,0.5)', lo: 0, hi: 0.5 },
  { label: '[0.5,1)', lo: 0.5, hi: 1 },
  { label: '[1,2)', lo: 1, hi: 2 },
  { label: '>=2', lo: 2, hi: Infinity },
];

const TAU_BINS = [
  { label: '[5,10)', lo: 5, hi: 10 },
  { label: '[10,20)', lo: 10, hi: 20 },
  { label: '[20,30)', lo: 20, hi: 30 },
];

const ODDS_BINS = [
  { label: '<0.98', lo: -Infinity, hi: 0.98 },
  { label: '[0.98,1.00)', lo: 0.98, hi: 1.0 },
  { label: '[1.00,1.02)', lo: 1.0, hi: 1.02 },
  { label: '[1.02,1.06)', lo: 1.02, hi: 1.06 },
  { label: '>=1.06', lo: 1.06, hi: Infinity },
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

function passesHighAskGates(row, { distMax = 40, spreadMax = 0.04 } = {}) {
  if (!(row.tau >= 5 && row.tau < 30)) return false;
  if (!(row.dist_abs != null && row.dist_abs < distMax)) return false;
  if (!(row.ask_fav >= 0.82 && row.ask_fav <= 0.97)) return false;
  if (!(row.spread_fav != null && row.spread_fav <= spreadMax)) return false;
  if (row.obi5 == null || row.obi5 < 0) return false;
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

function summaryRow(rows) {
  const st = stats(rows);
  return [String(st.n), fmtPct(st.wr), fmtUsd(st.sum), fmtUsd(st.exp), fmtUsd(maxDrawdown(rows))];
}

function collectEntries(gateFn) {
  const candidates = new Map();
  return streamCube((fields) => {
    const row = parseRow(fields);
    if (!row.condition_id || !row.dt || row.ts_ms == null) return;
    if (!passesQuality(row)) return;
    if (!gateFn(row)) return;
    maybeReplaceEarliest(candidates, row.condition_id, row);
  }).then((meta) => ({ entries: [...candidates.values()], meta }));
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

function tauBinTable(entries, split) {
  const rows = splitRows(entries, split);
  return TAU_BINS.map((b) => {
    const subset = rows.filter((r) => inBin(r.tau, b));
    const st = stats(subset);
    return [b.label, String(st.n), fmtPct(st.wr), fmtUsd(st.sum), fmtUsd(st.exp)];
  });
}

function oddsDistTable(entries, split) {
  const rows = splitRows(entries, split);
  const n = rows.length;
  return ODDS_BINS.map((b) => {
    const cnt = rows.filter((r) => r.odds_sum != null && inBin(r.odds_sum, b)).length;
    const pct = n ? (cnt / n) * 100 : 0;
    return [b.label, String(cnt), `${pct.toFixed(1)}%`];
  });
}

function crossTable(entries, split, minN = 10) {
  const rows = splitRows(entries, split);
  const out = [];
  for (const ab of ASK_BINS) {
    for (const zb of Z_BINS) {
      const subset = rows.filter((r) => r.ask_fav >= ab.lo && r.ask_fav < ab.hi
        && r.z != null && inBin(r.z, zb));
      if (subset.length < minN) continue;
      const st = stats(subset);
      out.push([ab.label, zb.label, String(st.n), fmtPct(st.wr), fmtUsd(st.exp)]);
    }
  }
  return out;
}

function variantTable(allVariants) {
  return SPLITS.map((split) => {
    const st = stats(splitRows(allVariants.base, split));
    const st20 = stats(splitRows(allVariants.dist20, split));
    const st03 = stats(splitRows(allVariants.spread03, split));
    return [
      split,
      String(st.n), fmtPct(st.wr), fmtUsd(st.exp),
      String(st20.n), fmtPct(st20.wr), fmtUsd(st20.exp),
      String(st03.n), fmtPct(st03.wr), fmtUsd(st03.exp),
    ];
  });
}

function findStableAskExtensions(entries) {
  const ceilings = [
    { label: 'ask≤0.86', hi: 0.86 },
    { label: 'ask≤0.90', hi: 0.9 },
    { label: 'ask≤0.94', hi: 0.94 },
    { label: 'ask≤0.97 (full)', hi: 0.97 },
  ];
  const stable = [];
  for (const c of ceilings) {
    const exps = {};
    let ok = true;
    let minN = Infinity;
    for (const split of ['train', 'june', 'july']) {
      const subset = splitRows(entries, split).filter((r) => r.ask_fav >= 0.82 && r.ask_fav < c.hi);
      const st = stats(subset);
      exps[split] = st.exp;
      minN = Math.min(minN, st.n);
      if (st.n < 20 || st.exp <= 0) ok = false;
    }
    if (ok) stable.push({ ...c, exps, minN });
  }

  const subRegions = [];
  for (const ab of ASK_BINS) {
    for (const zb of Z_BINS) {
      const exps = {};
      let ok = true;
      let minN = Infinity;
      for (const split of ['train', 'june', 'july']) {
        const subset = splitRows(entries, split).filter((r) => r.ask_fav >= ab.lo && r.ask_fav < ab.hi
          && r.z != null && inBin(r.z, zb));
        const st = stats(subset);
        exps[split] = st.exp;
        minN = Math.min(minN, st.n);
        if (st.n < 15 || st.exp <= 0) ok = false;
      }
      if (ok) subRegions.push({ ask: ab.label, z: zb.label, exps, minN });
    }
  }
  return { ceilings: stable, subRegions };
}

function observations(entries, meta, stable) {
  const lines = [];
  const total = stats(entries);
  lines.push(`- Universo high-ask (ask∈[0.82,0.97], dist<40, spread≤0.04, obi5≥0): **${total.n}** entradas, WR ${fmtPct(total.wr)}, exp ${fmtUsd(total.exp)}, max DD ${fmtUsd(maxDrawdown(entries))}.`);

  for (const split of ['train', 'june', 'july']) {
    const s = stats(splitRows(entries, split));
    lines.push(`  - ${split}: n=${s.n}, exp ${fmtUsd(s.exp)}.`);
  }

  for (const ab of ASK_BINS) {
    const exps = {};
    for (const split of ['train', 'june', 'july']) {
      const subset = splitRows(entries, split).filter((r) => r.ask_fav >= ab.lo && r.ask_fav < ab.hi);
      exps[split] = stats(subset).exp;
    }
    lines.push(`- Ask ${ab.label}: train ${fmtUsd(exps.train)}, june ${fmtUsd(exps.june)}, july ${fmtUsd(exps.july)}.`);
  }

  if (stable.ceilings.length) {
    lines.push('- **Extensões de teto estáveis** (exp>0, n≥20 nos 3 splits):');
    for (const c of stable.ceilings) {
      lines.push(`  - ${c.label}: train ${fmtUsd(c.exps.train)}, june ${fmtUsd(c.exps.june)}, july ${fmtUsd(c.exps.july)} (min n=${c.minN}).`);
    }
  } else {
    lines.push('- Nenhuma extensão simples de teto (0.86/0.90/0.94/0.97) é positiva em **todos** os splits com n≥20.');
  }

  if (stable.subRegions.length) {
    lines.push('- **Sub-regiões estáveis** (ask×z, exp>0, n≥15 nos 3 splits):');
    for (const r of stable.subRegions) {
      lines.push(`  - ${r.ask} × z${r.z}: train ${fmtUsd(r.exps.train)}, june ${fmtUsd(r.exps.june)}, july ${fmtUsd(r.exps.july)} (min n=${r.minN}).`);
    }
  }

  const ext86 = splitRows(entries, 'total').filter((r) => r.ask_fav >= 0.82 && r.ask_fav < 0.86);
  const st86 = stats(ext86);
  lines.push(`- Faixa incremental [0.82,0.86) vs TFC: n=${st86.n}, exp ${fmtUsd(st86.exp)} — comparar com TFC exp ~$0.91/trade no relatório anterior.`);

  lines.push(`- Fonte: ${meta.files} arquivos, ${meta.lines.toLocaleString('pt-BR')} linhas.`);

  return lines;
}

async function main() {
  const baseGate = (row) => passesHighAskGates(row);
  const dist20Gate = (row) => passesHighAskGates(row, { distMax: 20 });
  const spread03Gate = (row) => passesHighAskGates(row, { spreadMax: 0.03 });

  const [{ entries, meta }, dist20Result, spread03Result] = await Promise.all([
    collectEntries(baseGate),
    collectEntries(dist20Gate),
    collectEntries(spread03Gate),
  ]);

  const variants = {
    base: entries,
    dist20: dist20Result.entries,
    spread03: spread03Result.entries,
  };

  const stable = findStableAskExtensions(entries);

  const lines = [];
  lines.push('# Midas High-Ask Report');
  lines.push('');
  lines.push(`Gerado em: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Universo: primeira linha por evento com τ∈[5,30), dist_abs<40, ask_fav∈[0.82,0.97], spread_fav≤0.04, obi5≥0.');
  lines.push('');

  lines.push('## Distribuição de odds_sum (sem filtro)');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['odds_sum-bin', 'n', '%'], oddsDistTable(entries, split)));
    lines.push('');
  }

  lines.push('## 1. Resumo geral');
  lines.push('');
  const summaryRows = SPLITS.map((split) => [split, ...summaryRow(splitRows(entries, split))]);
  lines.push(mdTable(['split', 'n', 'WR', 'Σ pnl', 'exp', 'max DD ($10)'], summaryRows));
  lines.push('');

  lines.push('## 2. Por ask-bin');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['ask-bin', 'n', 'WR', 'Σ pnl', 'exp'], askBinTable(entries, split)));
    lines.push('');
  }

  lines.push('## 3. Por z-bin');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['z-bin', 'n', 'WR', 'Σ pnl', 'exp'], zBinTable(entries, split)));
    lines.push('');
  }

  lines.push('## 4. Por tau-bin');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['tau-bin', 'n', 'WR', 'Σ pnl', 'exp'], tauBinTable(entries, split)));
    lines.push('');
  }

  lines.push('## 5. Cruzamento ask-bin × z-bin (n≥10)');
  lines.push('');
  for (const split of SPLITS) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push(mdTable(['ask-bin', 'z-bin', 'n', 'WR', 'exp'], crossTable(entries, split)));
    lines.push('');
  }

  lines.push('## 6. Variantes');
  lines.push('');
  lines.push('Comparação: base (dist<40, spread≤0.04) vs dist<20 vs spread≤0.03.');
  lines.push('');
  lines.push(mdTable(
    ['split', 'n base', 'WR', 'exp', 'n dist<20', 'WR', 'exp', 'n spread≤0.03', 'WR', 'exp'],
    variantTable(variants),
  ));
  lines.push('');

  lines.push('## 7. Extensões de teto TFC (estabilidade)');
  lines.push('');
  if (stable.ceilings.length) {
    lines.push(mdTable(
      ['teto', 'min n', 'exp train', 'exp june', 'exp july'],
      stable.ceilings.map((c) => [c.label, String(c.minN), fmtUsd(c.exps.train), fmtUsd(c.exps.june), fmtUsd(c.exps.july)]),
    ));
  } else {
    lines.push('_Nenhuma extensão simples passou exp>0 com n≥20 nos três splits._');
  }
  lines.push('');
  if (stable.subRegions.length) {
    lines.push('Sub-regiões ask×z estáveis:');
    lines.push('');
    lines.push(mdTable(
      ['ask-bin', 'z-bin', 'min n', 'exp train', 'exp june', 'exp july'],
      stable.subRegions.map((r) => [r.ask, r.z, String(r.minN), fmtUsd(r.exps.train), fmtUsd(r.exps.june), fmtUsd(r.exps.july)]),
    ));
    lines.push('');
  }

  lines.push('## Observações');
  lines.push('');
  for (const line of observations(entries, meta, stable)) {
    lines.push(line);
  }
  lines.push('');

  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Relatório gravado em ${REPORT_PATH}`);
  console.log(`High-ask entries: ${entries.length}, estáveis: ${stable.ceilings.length} tetos, ${stable.subRegions.length} sub-regiões`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
