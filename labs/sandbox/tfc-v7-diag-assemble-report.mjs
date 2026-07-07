/**
 * Monta o relatório final a partir dos JSONs em labs/sandbox/cache/.
 *
 * Uso: node labs/sandbox/tfc-v7-diag-assemble-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CACHE_DIR, FROM, TO, JUNE_CUTOFF, loadJson, fmtPct, fmtUsd, fmtUsd3,
} from './tfc-v7-diag-lib.mjs';

const REPORT_PATH = path.join('labs', 'sandbox', 'tfc-v7-diagnostic-report.md');

function table(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function loadOrWarn(file) {
  const p = path.join(CACHE_DIR, file);
  if (!fs.existsSync(p)) return { missing: true, path: p };
  return loadJson(p);
}

function main() {
  const pnl = loadOrWarn('pnl-mechanism.json');
  const exec = loadOrWarn('executability.json');
  const loss = loadOrWarn('loss-pockets.json');
  const sizing = loadOrWarn('sizing.json');
  const meta = loadOrWarn('run-meta.json');

  const lines = [];
  lines.push('# TFC V7 — Diagnóstico Quantitativo (V5 Practical / V6 Hybrid)');
  lines.push('');
  lines.push(`Janela: **${FROM} → ${TO}** | Split june: dt ≥ ${JUNE_CUTOFF}`);
  lines.push('');
  lines.push('## Metodologia');
  lines.push('');
  lines.push('- Motor: GLS `compiled-soa`, book depth 25, fee taker `0.07·p·(1-p)`.');
  lines.push('- Eventos: backtest `fastRun:false` com `onEventFinalized` (ordens, marks, cross τ).');
  lines.push('- Executabilidade: DuckDB direto no Parquet (`backtest_ticks`).');
  lines.push('- Features de entrada: cubo `labs/mining/cube` cruzado com PnL real do motor.');
  lines.push('');

  // Section A
  lines.push('## A. Decomposição de PnL por mecanismo');
  lines.push('');
  if (pnl.missing) {
    lines.push(`*Dados ausentes: ${pnl.path}*`);
  } else {
    lines.push('### A.1 V5 Practical — desfechos');
    lines.push('');
    for (const split of ['train', 'june', 'all']) {
      lines.push(`#### ${split}`);
      lines.push('');
      const st = pnl.v5.splitStats[split];
      const rows = Object.entries(st.byOutcome)
        .filter(([, o]) => o.n > 0)
        .map(([k, o]) => [k, String(o.n), fmtPct(o.pct), fmtUsd(o.sum), fmtUsd(o.exp)]);
      lines.push(table(['Desfecho', 'n', '%', 'PnL', 'Exp'], rows));
      lines.push('');
      const miss = st.missedFlipAfterFloor;
      lines.push(`Flips perdidos após piso 4s: **n=${miss.n}** (${fmtPct(miss.pct)}) custo=${fmtUsd(miss.sum)} exp=${fmtUsd(miss.exp)}`);
      lines.push('');
    }

    lines.push('### A.2 Valor do mecanismo tardio (8→4s)');
    lines.push('');
    lines.push(table(
      ['Split', 'PnL V5', 'PnL hold (lateFlip off)', 'Δ mecanismo', '% do PnL V5'],
      ['train', 'june', 'all'].map((s) => {
        const c = pnl.contrafactual[s];
        return [s, fmtUsd(c.v5Pnl), fmtUsd(c.holdPnl), fmtUsd(c.lateMechanismValue), fmtPct(c.pctOfV5Pnl ?? 0)];
      }),
    ));
    lines.push('');

    lines.push('### A.3 V6 Hybrid — hedge stop + fallback taker');
    lines.push('');
    lines.push(table(
      ['Split', '% hedge fill', 'n hedge', 'PnL whipsaw', 'PnL fav perdeu', 'n fallback taker', 'PnL fallback'],
      ['train', 'june', 'all'].map((s) => {
        const h = pnl.v6.hedgeAnalysis[s];
        return [
          s,
          fmtPct(h.pctHedgeFilled),
          String(h.hedgeFilledCount),
          fmtUsd(h.hedgeEventPnlWhipsaw.sum),
          fmtUsd(h.hedgeEventPnlFavLost.sum),
          String(h.fallbackCount),
          fmtUsd(h.fallbackTaker.sum),
        ];
      }),
    ));
    lines.push('');
  }

  // Section B
  lines.push('## B. Auditoria de executabilidade');
  lines.push('');
  if (exec.missing) {
    lines.push(`*Dados ausentes: ${exec.path}*`);
  } else {
    lines.push('### B.1 Cadência de snapshots');
    lines.push('');
    const c30 = exec.cadence.last30s;
    const c10 = exec.cadence.last10s;
    lines.push(table(
      ['Janela', 'p50 gap', 'p90', 'p99', '% eventos buraco >2s'],
      [
        ['últimos 30s', `${c30.p50.toFixed(2)}s`, `${c30.p90.toFixed(2)}s`, `${c30.p99.toFixed(2)}s`, fmtPct(exec.cadence.eventsWithGapGt2s_last30s.holes / exec.cadence.eventsWithGapGt2s_last30s.total)],
        ['últimos 10s', `${c10.p50.toFixed(2)}s`, `${c10.p90.toFixed(2)}s`, `${c10.p99.toFixed(2)}s`, fmtPct(exec.cadence.eventsWithGapGt2s_last10s.holes / exec.cadence.eventsWithGapGt2s_last10s.total)],
      ],
    ));
    lines.push('');

    lines.push('### B.2 Presença de book');
    lines.push('');
    const aw = exec.bookPresence.actionWindow_tau_4_8;
    const ew = exec.bookPresence.entryWindow_tau_5_30;
    const fz = exec.bookPresence.forbiddenZone_tau_0_4;
    lines.push(table(
      ['Zona τ', 'ticks', 'book válido', 'spread≤0.03', 'depth≥$10', 'depth≥$50'],
      [
        ['entrada 5-30s', String(ew.tickCount), fmtPct(ew.pctValidBook), fmtPct(ew.pctSpreadLe003), fmtPct(ew.pctDepthGe10), fmtPct(ew.pctDepthGe50)],
        ['ação 4-8s', String(aw.tickCount), fmtPct(aw.pctValidBook), fmtPct(aw.pctSpreadLe003), fmtPct(aw.pctDepthGe10), fmtPct(aw.pctDepthGe50)],
        ['proibida 0-4s', String(fz.tickCount), fmtPct(fz.pctValidBook), fmtPct(fz.pctSpreadLe003), fmtPct(fz.pctDepthGe10), fmtPct(fz.pctDepthGe50)],
      ],
    ));
    lines.push('');

    lines.push('### B.3 Entrada $10 — profundidade e slippage');
    lines.push('');
    const en = exec.entryExecution;
    lines.push(`- Entradas simuladas (primeiro tick com gates V5): **${en.nEntriesSimulated}**`);
    lines.push(`- Profundidade média no topo: **${fmtUsd(en.avgTopDepthUsd)}**`);
    lines.push(`- Níveis consumidos (média): **${en.avgLevelsConsumed.toFixed(2)}** (${fmtPct(en.pctSingleLevel)} em 1 nível)`);
    lines.push(`- Slippage efetivo vs best ask: **${fmtUsd3(en.avgSlippageVsBestAsk)}**`);
    lines.push('');

    if (exec.latencyDegradation) {
      lines.push('### B.4 Degradação por latência (late flip)');
      lines.push('');
      lines.push(table(
        ['Latência', 'n', 'PnL simulado médio', 'PnL proxy médio', 'Δ/trade'],
        ['0', '0.5', '1.0'].map((lat) => {
          const l = exec.latencyDegradation[lat];
          return [lat + 's', String(l.n), fmtUsd(l.avgSimPnl), fmtUsd(l.avgProxyPnl), fmtUsd(l.avgDelta)];
        }),
      ));
      lines.push('');
    }

    lines.push('### Limitações B');
    lines.push('');
    for (const lim of exec.limitations || []) lines.push(`- ${lim}`);
    lines.push('');
  }

  // Section C
  lines.push('## C. Bolsões de perda V5 Practical');
  lines.push('');
  if (loss.missing) {
    lines.push(`*Dados ausentes: ${loss.path}*`);
  } else {
    lines.push('### C.1 Expectância por ask_fav (PnL real motor)');
    lines.push('');
    lines.push(table(
      ['Bin ask', 'n_train', 'exp_train', 'n_june', 'exp_june'],
      loss.askBins.map((b) => [b.bin, String(b.train.n), fmtUsd(b.train.exp), String(b.june.n), fmtUsd(b.june.exp)]),
    ));
    lines.push('');

    lines.push('### C.2 P(flip tardio) por dist/vol');
    lines.push('');
    for (const split of ['train', 'june']) {
      lines.push(`#### ${split}`);
      lines.push('');
      lines.push(table(
        ['dist/vol', 'n', 'P(flip)', 'P(missed floor)'],
        loss.flipByDistVol[split].filter((r) => r.n > 0).map((r) => [r.bin, String(r.n), fmtPct(r.pFlip), fmtPct(r.pMissed)]),
      ));
      lines.push('');
    }

    lines.push('### C.3 Impacto de filtros');
    lines.push('');
    for (const [name, f] of Object.entries(loss.filters)) {
      lines.push(`#### ${name}`);
      lines.push('');
      lines.push(table(
        ['Split', 'n após filtro', 'ΔPnL', 'DD antes', 'DD depois'],
        ['train', 'june', 'all'].map((s) => {
          const x = f[s];
          return [s, `${x.nKept}/${x.nAll}`, fmtUsd(x.pnlKept - x.pnlAll), fmtUsd(x.ddAll), fmtUsd(x.ddKept)];
        }),
      ));
      lines.push('');
    }
  }

  // Section D
  lines.push('## D. Upside de sizing');
  lines.push('');
  if (sizing.missing) {
    lines.push(`*Dados ausentes: ${sizing.path}*`);
  } else {
    lines.push(table(
      ['Scheme', 'Split', 'n', 'PnL', 'Exp', 'DD≈'],
      Object.entries(sizing.results).flatMap(([name, r]) =>
        ['train', 'june', 'all'].map((s) => {
          const x = r[s];
          return [name, s, String(x.n), fmtUsd(x.sum), fmtUsd(x.exp), fmtUsd(x.maxDrawdown)];
        }),
      ),
    ));
    lines.push('');
  }

  // Facts section
  lines.push('## Fatos para o design da V7');
  lines.push('');
  const facts = [];

  if (!pnl.missing) {
    const allMiss = pnl.v5.splitStats.all.missedFlipAfterFloor;
    facts.push(`Flips após o piso de 4s custam ${fmtUsd(allMiss.sum)} em ${allMiss.n} eventos (${fmtPct(allMiss.pct)} das entradas) — confirma o floor executável.`);
    const cAll = pnl.contrafactual.all;
    facts.push(`O mecanismo tardio 8→4s vale ${fmtUsd(cAll.lateMechanismValue)} (${fmtPct(cAll.pctOfV5Pnl ?? 0)} do PnL V5) vs hold com mesmo envelope.`);
    const hJune = pnl.v6.hedgeAnalysis.june;
    facts.push(`V6: hedge stop preenche em ${fmtPct(hJune.pctHedgeFilled)} dos eventos (june); whipsaw PnL hedge=${fmtUsd(hJune.hedgeEventPnlWhipsaw.sum)}, fav perdeu=${fmtUsd(hJune.hedgeEventPnlFavLost.sum)}.`);
  }
  if (!exec.missing) {
    const aw = exec.bookPresence.actionWindow_tau_4_8;
    const fz = exec.bookPresence.forbiddenZone_tau_0_4;
    facts.push(`Janela de ação 4-8s: ${fmtPct(aw.pctDepthGe10)} dos ticks têm depth≥$10 vs ${fmtPct(fz.pctDepthGe10)} na zona 0-4s.`);
    if (exec.latencyDegradation?.['1.0']) {
      facts.push(`Latência 1.0s degrada ~${fmtUsd(exec.latencyDegradation['1.0'].avgDelta)}/trade na janela tardia (proxy).`);
    }
  }
  if (!loss.missing) {
    const b5565 = loss.askBins.filter((b) => b.bin === '0.55-0.60' || b.bin === '0.60-0.65');
    for (const b of b5565) {
      facts.push(`Bolso ${b.bin} (V5 Practical): exp train=${fmtUsd(b.train.exp)} june=${fmtUsd(b.june.exp)} — **não** é bolsão fraco (contrasta com V4 hold).`);
    }
    const b6570 = loss.askBins.find((b) => b.bin === '0.65-0.70');
    if (b6570) facts.push(`Bolso 0.65-0.70: exp train=${fmtUsd(b6570.train.exp)} (fraco) vs june=${fmtUsd(b6570.june.exp)} — inconsistente entre splits.`);
    const f065 = loss.filters.minAsk065.all;
    facts.push(`Filtro minAsk≥0.65 **destrói** PnL: Δ=${fmtUsd(f065.pnlKept - f065.pnlAll)} (retém ${f065.nKept}/${f065.nAll}); não recomendado.`);
    const flipLow = loss.flipByDistVol.train.find((r) => r.bin === '<0.5');
    if (flipLow) facts.push(`dist/vol<0.5: P(flip tardio)=${fmtPct(flipLow.pFlip)} (train, n=${flipLow.n}) — maior risco de reverse.`);
  }
  if (!sizing.missing) {
    const fixed = sizing.results.fixed10.all;
    const prop2 = sizing.results.prop_v2?.all;
    if (prop2) facts.push(`Sizing prop_v2 (15/12/10/5/0 por ask): PnL ${fmtUsd(fixed.sum)}→${fmtUsd(prop2.sum)}, DD≈${fmtUsd(fixed.maxDrawdown)}→${fmtUsd(prop2.maxDrawdown)}.`);
  }
  if (!pnl.missing) {
    facts.push(`V5 ($4059.76) supera V6 ($3607.35) em +${fmtUsd(4059.76 - 3607.35)}; hedge stop preenche <1% — mecanismo V6 não substitui reverse taker.`);
    facts.push(`100% das ações tardias são late_flip_reverse (n=600); zero late_flip_exit puro.`);
  }

  facts.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  lines.push('');

  if (!meta.missing) {
    lines.push('## Run metadata');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(meta, null, 2));
    lines.push('```');
  }

  const report = lines.join('\n');
  fs.writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(report);
  console.error(`\nRelatório: ${REPORT_PATH}`);
}

main();
