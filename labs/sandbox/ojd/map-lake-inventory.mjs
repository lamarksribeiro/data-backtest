/**
 * Lake inventory map for theory/anomaly discovery.
 *
 * Usage: node labs/sandbox/ojd/map-lake-inventory.mjs
 * Writes: labs/sandbox/ojd/reports/lake-inventory.json
 *         docs/research/lake-data-map.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const LAKE = path.resolve(process.env.LAKE_ROOT || 'lake');
const OUT_JSON = path.join('labs', 'sandbox', 'ojd', 'reports', 'lake-inventory.json');
const OUT_MD = path.join('docs', 'research', 'lake-data-map.md');

function walkParquet(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkParquet(full, acc);
    else if (e.name.endsWith('.parquet')) acc.push(full);
  }
  return acc;
}

function dayDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .sort();
}

function gaps(days) {
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const prev = Date.parse(`${days[i - 1]}T00:00:00Z`);
    const cur = Date.parse(`${days[i]}T00:00:00Z`);
    const d = (cur - prev) / 864e5;
    if (d > 1) {
      const missing = [];
      for (let t = prev + 864e5; t < cur; t += 864e5) {
        missing.push(new Date(t).toISOString().slice(0, 10));
      }
      out.push({ after: days[i - 1], before: days[i], missing });
    }
  }
  return out;
}

function sizeBytes(files) {
  let s = 0;
  for (const f of files) {
    try {
      s += fs.statSync(f).size;
    } catch {
      /* ignore */
    }
  }
  return s;
}

function mb(n) {
  return Math.round((n / 1e6) * 10) / 10;
}

async function sampleStats(conn, file, columnsHint = null) {
  const qf = quotedString(path.resolve(file));
  const desc = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${qf})`);
  const cols = desc.getRowObjectsJS().map((r) => ({ name: r.column_name, type: r.column_type }));
  const colNames = new Set(cols.map((c) => c.name));

  const has = (c) => colNames.has(c);
  const selectBits = [
    'COUNT(*)::BIGINT AS ticks',
    has('condition_id') ? 'COUNT(DISTINCT condition_id)::BIGINT AS events' : 'NULL::BIGINT AS events',
    has('ts') ? 'MIN(ts)::VARCHAR AS min_ts' : 'NULL AS min_ts',
    has('ts') ? 'MAX(ts)::VARCHAR AS max_ts' : 'NULL AS max_ts',
    has('coverage') ? 'AVG(coverage) AS avg_coverage' : 'NULL AS avg_coverage',
    has('degraded') ? 'SUM(CASE WHEN degraded THEN 1 ELSE 0 END)::BIGINT AS degraded_ticks' : 'NULL::BIGINT AS degraded_ticks',
    has('up_best_ask') ? 'AVG(up_best_ask) AS avg_up_ask' : 'NULL AS avg_up_ask',
    has('underlying_price') && has('price_to_beat')
      ? 'AVG(ABS(underlying_price - price_to_beat)) AS avg_abs_dist'
      : 'NULL AS avg_abs_dist',
    has('up_ask_px_1') ? 'SUM(CASE WHEN up_ask_px_1 IS NULL THEN 1 ELSE 0 END)::BIGINT AS null_book_l1' : 'NULL::BIGINT AS null_book_l1',
    has('up_ask_px_25') ? 'SUM(CASE WHEN up_ask_px_25 IS NULL THEN 1 ELSE 0 END)::BIGINT AS null_book_l25' : 'NULL::BIGINT AS null_book_l25',
  ];

  const stats = await conn.runAndReadAll(`SELECT ${selectBits.join(', ')} FROM read_parquet(${qf})`);
  const raw = stats.getRowObjectsJS()[0];
  const normalized = {};
  for (const [k, v] of Object.entries(raw || {})) {
    normalized[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return { columns: cols, stats: normalized };
}

function inventoryBacktestTicks() {
  const root = path.join(LAKE, 'backtest_ticks');
  const assets = [];
  if (!fs.existsSync(root)) return assets;
  for (const aDir of fs.readdirSync(root).filter((x) => x.startsWith('underlying='))) {
    const asset = aDir.slice('underlying='.length);
    const intervalRoot = path.join(root, aDir, 'interval=5m');
    if (!fs.existsSync(intervalRoot)) continue;
    for (const dDir of fs.readdirSync(intervalRoot).filter((x) => x.startsWith('book_depth='))) {
      const full = path.join(intervalRoot, dDir);
      if (!fs.statSync(full).isDirectory()) continue;
      const days = dayDirs(full);
      const files = walkParquet(full);
      const span =
        days.length > 1
          ? (Date.parse(`${days[days.length - 1]}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / 864e5 + 1
          : days.length;
      assets.push({
        dataset: 'backtest_ticks',
        asset,
        interval: '5m',
        book_depth: Number(dDir.slice('book_depth='.length)),
        days: days.length,
        from: days[0] || null,
        to: days[days.length - 1] || null,
        calendar_span_days: span,
        coverage_pct: span ? Math.round((days.length / span) * 1000) / 10 : 0,
        parquet_files: files.length,
        size_mb: mb(sizeBytes(files)),
        gaps: gaps(days),
        sample_day: days.includes('2026-06-15') ? '2026-06-15' : days[Math.floor(days.length / 2)] || null,
      });
    }
  }
  return assets;
}

function inventoryLite() {
  const root = path.join(LAKE, 'backtest_ticks_lite');
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const aDir of fs.readdirSync(root).filter((x) => x.startsWith('underlying='))) {
    const asset = aDir.slice('underlying='.length);
    const full = path.join(root, aDir, 'interval=5m');
    const days = dayDirs(full);
    const files = walkParquet(full);
    out.push({
      dataset: 'backtest_ticks_lite',
      asset,
      interval: '5m',
      days: days.length,
      from: days[0] || null,
      to: days[days.length - 1] || null,
      parquet_files: files.length,
      size_mb: mb(sizeBytes(files)),
      gaps: gaps(days),
      sample_day: days.includes('2026-06-15') ? '2026-06-15' : days[Math.floor(days.length / 2)] || null,
    });
  }
  return out;
}

function inventoryEmptyRoots() {
  const names = ['books', 'features', 'manifests', 'ohlc', 'scalars'];
  return names.map((name) => {
    const files = walkParquet(path.join(LAKE, name));
    return { dataset: name, parquet_files: files.length, size_mb: mb(sizeBytes(files)), status: files.length ? 'present' : 'EMPTY_LOCAL' };
  });
}

function inventoryCube() {
  const cube = path.join('labs', 'mining', 'cube');
  if (!fs.existsSync(cube)) return null;
  const files = fs.readdirSync(cube).filter((f) => f.endsWith('.csv')).sort();
  if (!files.length) return null;
  const header = fs.readFileSync(path.join(cube, files[0]), 'utf8').split(/\r?\n/)[0].split(',');
  let bytes = 0;
  let rows = 0;
  for (const f of files) {
    const p = path.join(cube, f);
    bytes += fs.statSync(p).size;
    const txt = fs.readFileSync(p, 'utf8');
    rows += Math.max(0, txt.split(/\r?\n/).length - 2);
  }
  return {
    path: cube,
    files: files.length,
    from: files[0].replace('dt=', '').replace('.csv', ''),
    to: files[files.length - 1].replace('dt=', '').replace('.csv', ''),
    approx_rows: rows,
    size_mb: mb(bytes),
    columns: header,
  };
}

function hypothesisSurfaces(inv) {
  const surfaces = [];

  surfaces.push({
    id: 'S1_barrier_digital_path',
    title: 'Caminho barreira (spot vs PTB) + odds + settlement',
    needs: ['underlying_price', 'price_to_beat', 'up_best_ask', 'down_best_ask', 'event_end', 'condition_id'],
    present_in: ['backtest_ticks', 'backtest_ticks_lite', 'mining_cube'],
    theories: ['OJD/vol-jumps', 'Terminal convexity', 'Brownian bridge / digital', 'Pivot C odds-path consistency'],
    note: 'Superfície principal já usada. BTC depth25 é a mais rica em range.',
  });

  surfaces.push({
    id: 'S2_l2_book_microstructure',
    title: 'Livro L2 depth 25 (UP/DOWN asks+bids px/sz)',
    needs: ['up_ask_px_1..25', 'up_bid_*', 'down_*'],
    present_in: ['backtest_ticks (depth=25)'],
    absent_in: ['backtest_ticks_lite', 'mining_cube (só depth5 agregados)'],
    theories: ['OBI / toxicidade', 'ladder / pair-path', 'maker feasibility', 'liquidity reconstitution'],
    note: '~14GB multi-asset. Melhor para microestrutura; I/O pesado.',
  });

  surfaces.push({
    id: 'S3_cross_asset',
    title: 'Mesma janela multi-asset (ETH/SOL/BNB/XRP/DOGE/HYPE)',
    needs: ['mesmo schema em N underlyings'],
    present_in: ['backtest_ticks depth25 ~2026-05-24→07-25'],
    theories: ['lead-lag cross-asset', 'regime comum de vol', 'transfer de edge BTC→alt', 'portfolio correlation de losses'],
    note: 'Sobreposição multi-asset ~63 dias. Anomalias que só existem em alts são caça fértil e pouco explorada vs BTC.',
  });

  surfaces.push({
    id: 'S4_cube_features_fast',
    title: 'Cubo de features pré-computado (CSV) para mining rápido',
    needs: ['sigma, flips, obi5, p_phys, winner, pnl proxies'],
    present_in: ['labs/mining/cube'],
    theories: ['screening de hipóteses barato', 'calibragem p_phys vs mkt', 'flips/pinning'],
    note: '~1.1M linhas, 46 cols, Apr23–Jul13. Ideal para mapear anomalias ANTES de voltar ao parquet.',
  });

  surfaces.push({
    id: 'S5_empty_planned_datasets',
    title: 'Datasets planejados mas vazios localmente',
    needs: ['ohlc', 'scalars', 'books', 'features', 'manifests'],
    present_in: [],
    theories: ['OHLC multi-timeframe', 'features offline', 'books isolados'],
    note: 'EMPTY no lake local — se existirem no Brutus, lake:pull amplia o mapa.',
  });

  surfaces.push({
    id: 'S6_external_binance_1s',
    title: 'Lead Binance 1s (scripts, não lake padrão)',
    needs: ['scripts/download-binance-1s.js + labs hyperion'],
    present_in: ['scripts only — verificar se dados baixados fora do lake'],
    theories: ['spot lead / latency arb', 'Hyperion lead lab'],
    note: 'Complementar ao lake Polymarket; não misturar sem join temporal explícito.',
  });

  // data-driven priority from inventory
  const btc = inv.backtest_ticks.find((x) => x.asset === 'BTC' && x.book_depth === 25);
  const multi = inv.backtest_ticks.filter((x) => x.asset !== 'BTC' && x.book_depth === 25);
  surfaces.push({
    id: 'PRIORITY_NEXT',
    title: 'Prioridade sugerida para novas hipóteses',
    items: [
      '1) Screening em mining/cube (rápido) por residual do book condicionado a flips, sigma, tau, dist',
      '2) Cross-asset: mesma hipótese OJD/Pivot C em ETH/SOL no range sobreposto — se só BTC morre, pode ser artifact',
      '3) Pivot C (odds-path) em backtest_ticks BTC depth25 (maio–julho, não só 22 dias)',
      '4) Não gastar ciclos em ohlc/scalars locais (vazios) até pull',
      btc ? `5) BTC depth25: ${btc.from}→${btc.to} (${btc.days}d, ${btc.size_mb}MB) — eixo principal` : null,
      multi.length ? `6) Alts depth25: ${multi.map((m) => m.asset).join(', ')} ~${multi[0]?.from}→${multi[0]?.to}` : null,
    ].filter(Boolean),
  });

  return surfaces;
}

function toMarkdown(report) {
  const L = [];
  L.push('# Mapa de dados do Lake — descoberta de teorias');
  L.push('');
  L.push(`Gerado em: **${report.generated_at}**`);
  L.push(`LAKE_ROOT: \`${report.lake_root}\``);
  L.push('');
  L.push('## Por que este mapa existe');
  L.push('');
  L.push('Antes de fixar a próxima teoria matemática, o lake define o **espaço amostral real**:');
  L.push('quais ativos, profundidade de book, gaps, e quais superfícies de anomalia são testáveis.');
  L.push('O programa OJD/Pivot C **continua válido** como linha de vol/jumps/caminho;');
  L.push('este mapa **expande** onde caçar hipóteses sem descartar o trabalho já feito.');
  L.push('');
  L.push('## Inventário resumido');
  L.push('');
  L.push('| Dataset | Asset | Depth | Dias | From | To | Cov% | Size MB | Gaps |');
  L.push('|---|---|---:|---:|---|---|---:|---:|---:|');
  for (const r of report.backtest_ticks) {
    L.push(
      `| ${r.dataset} | ${r.asset} | ${r.book_depth} | ${r.days} | ${r.from} | ${r.to} | ${r.coverage_pct} | ${r.size_mb} | ${r.gaps.length} |`,
    );
  }
  for (const r of report.backtest_ticks_lite) {
    L.push(`| ${r.dataset} | ${r.asset} | — | ${r.days} | ${r.from} | ${r.to} | — | ${r.size_mb} | ${r.gaps.length} |`);
  }
  for (const r of report.empty_roots) {
    L.push(`| ${r.dataset} | — | — | — | — | — | — | ${r.size_mb} | ${r.status} |`);
  }
  L.push('');
  if (report.cube) {
    L.push('## Mining cube (features rápidas)');
    L.push('');
    L.push(`- Path: \`${report.cube.path}\``);
    L.push(`- Range: **${report.cube.from} → ${report.cube.to}** (${report.cube.files} arquivos)`);
    L.push(`- ~**${report.cube.approx_rows.toLocaleString()}** linhas, **${report.cube.size_mb} MB**`);
    L.push(`- Colunas (${report.cube.columns.length}): \`${report.cube.columns.join('`, `')}\``);
    L.push('');
  }
  L.push('## Schemas amostrados');
  L.push('');
  for (const s of report.samples || []) {
    L.push(`### ${s.label}`);
    L.push('');
    L.push(`- Arquivo: \`${s.file}\``);
    L.push(`- Colunas: **${s.columns.length}**`);
    if (s.stats) {
      L.push(
        `- Stats: ticks=${s.stats.ticks} events=${s.stats.events} avg_cov=${s.stats.avg_coverage} degraded=${s.stats.degraded_ticks} null_L1=${s.stats.null_book_l1}`,
      );
    }
    L.push('');
    L.push('<details><summary>Lista de colunas</summary>');
    L.push('');
    L.push(s.columns.map((c) => `\`${c.name}\` (${c.type})`).join(' · '));
    L.push('');
    L.push('</details>');
    L.push('');
  }
  L.push('## Superfícies de hipótese (o que os dados permitem)');
  L.push('');
  for (const s of report.hypothesis_surfaces) {
    if (s.id === 'PRIORITY_NEXT') {
      L.push(`### ${s.title}`);
      L.push('');
      for (const item of s.items) L.push(`- ${item}`);
      L.push('');
      continue;
    }
    L.push(`### ${s.id} — ${s.title}`);
    L.push('');
    L.push(`- Presente em: ${(s.present_in || []).join(', ') || '—'}`);
    if (s.absent_in?.length) L.push(`- Ausente em: ${s.absent_in.join(', ')}`);
    L.push(`- Teorias habilitadas: ${(s.theories || []).join('; ')}`);
    if (s.note) L.push(`- Nota: ${s.note}`);
    L.push('');
  }
  L.push('## Relação com OJD / programa atual');
  L.push('');
  L.push('| Trabalho | Status | Ação após o mapa |');
  L.push('|---|---|---|');
  L.push('| OJD jump-share η | KILL (Fase I) | Não reabrir sem medição nova |');
  L.push('| Pós-jump residual vs book | KILL | Idem |');
  L.push('| Pivot C odds-path | Pendente | **Continua prioritário** em BTC depth25 range completo |');
  L.push('| Screening cube residual | Novo | **Fazer cedo** — barato, gera hipóteses data-driven |');
  L.push('| Cross-asset replicate | Novo | Testar se anomalias BTC generalizam |');
  L.push('| ohlc/scalars/books locais | Vazios | Pull Brutus se necessário; não bloquear |');
  L.push('');
  L.push('## Gaps relevantes');
  L.push('');
  for (const r of report.backtest_ticks) {
    if (!r.gaps?.length) continue;
    L.push(`### ${r.asset} depth=${r.book_depth}`);
    L.push('');
    for (const g of r.gaps) {
      L.push(`- Após ${g.after} antes de ${g.before}: missing ${g.missing.join(', ')}`);
    }
    L.push('');
  }
  L.push('## Como regenerar');
  L.push('');
  L.push('```bash');
  L.push('node labs/sandbox/ojd/map-lake-inventory.mjs');
  L.push('```');
  L.push('');
  return L.join('\n');
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });

  const backtest_ticks = inventoryBacktestTicks();
  const backtest_ticks_lite = inventoryLite();
  const empty_roots = inventoryEmptyRoots();
  const cube = inventoryCube();

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  const samples = [];
  async function addSample(label, file) {
    if (!file || !fs.existsSync(file)) return;
    try {
      const { columns, stats } = await sampleStats(conn, file);
      samples.push({ label, file: path.relative(process.cwd(), file).replace(/\\/g, '/'), columns, stats });
    } catch (e) {
      samples.push({ label, file, error: String(e.message || e) });
    }
  }

  for (const row of [...backtest_ticks, ...backtest_ticks_lite]) {
    if (!row.sample_day) continue;
    if (row.dataset === 'backtest_ticks') {
      const dir = path.join(
        LAKE,
        'backtest_ticks',
        `underlying=${row.asset}`,
        'interval=5m',
        `book_depth=${row.book_depth}`,
        `dt=${row.sample_day}`,
      );
      if (!fs.existsSync(dir)) continue;
      const f = fs.readdirSync(dir).find((x) => x.endsWith('.parquet'));
      if (f) await addSample(`${row.dataset} ${row.asset} d${row.book_depth} ${row.sample_day}`, path.join(dir, f));
    } else {
      const dir = path.join(LAKE, 'backtest_ticks_lite', `underlying=${row.asset}`, 'interval=5m', `dt=${row.sample_day}`);
      if (!fs.existsSync(dir)) continue;
      const f = fs.readdirSync(dir).find((x) => x.endsWith('.parquet'));
      if (f) await addSample(`${row.dataset} ${row.asset} ${row.sample_day}`, path.join(dir, f));
    }
  }

  // Only keep a few samples in markdown (BTC full, BTC lite, one alt)
  const samplesForMd = samples.filter(
    (s) =>
      s.label.includes('BTC') && s.label.includes('d25') ||
      s.label.includes('lite BTC') ||
      s.label.includes('ETH d25'),
  );

  const inv = { backtest_ticks, backtest_ticks_lite, empty_roots, cube };
  const hypothesis_surfaces = hypothesisSurfaces(inv);

  const report = {
    generated_at: new Date().toISOString(),
    lake_root: LAKE,
    backtest_ticks,
    backtest_ticks_lite,
    empty_roots,
    cube,
    samples,
    hypothesis_surfaces,
    totals: {
      backtest_ticks_mb: mb(backtest_ticks.reduce((s, r) => s + r.size_mb * 1e6, 0)),
      lite_mb: mb(backtest_ticks_lite.reduce((s, r) => s + r.size_mb * 1e6, 0)),
      assets_depth25: backtest_ticks.filter((r) => r.book_depth === 25).map((r) => r.asset),
    },
  };

  // markdown uses filtered samples
  const mdReport = { ...report, samples: samplesForMd.length ? samplesForMd : samples.slice(0, 3) };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(OUT_MD, toMarkdown(mdReport));
  console.log('Wrote', OUT_JSON);
  console.log('Wrote', OUT_MD);
  console.log(
    'Assets depth25:',
    report.totals.assets_depth25.join(', '),
    '| BTC days',
    backtest_ticks.find((x) => x.asset === 'BTC' && x.book_depth === 25)?.days,
  );
  console.table(
    backtest_ticks.map((r) => ({
      asset: r.asset,
      depth: r.book_depth,
      days: r.days,
      from: r.from,
      to: r.to,
      cov: r.coverage_pct,
      mb: r.size_mb,
      gaps: r.gaps.length,
    })),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
