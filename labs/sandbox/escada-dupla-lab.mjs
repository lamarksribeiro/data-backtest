#!/usr/bin/env node
/**
 * Laboratório sintético Escada Dupla — otimiza params em paths do simulador
 * ANTES de sweeps caros no lakehouse.
 *
 * Uso:
 *   node labs/sandbox/escada-dupla-lab.mjs
 *   node labs/sandbox/escada-dupla-lab.mjs --out labs/sandbox/escada-dupla-lab-report.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../legacy/strategy-runners/portable/escada-dupla-runner.js');

function loadEscada() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __escadaExports;`)();
}

const escada = loadEscada();

const SUB_PEAKS = [55, 60, 65, 70, 75, 80, 85, 90];

/** Cenários espelhando o HTML: direto, reversão, chicote */
function buildScenarios() {
  const rows = [
    { id: '95-direto', targets: [95], winner: 'UP', weight: 1 },
  ];
  for (const h of SUB_PEAKS) {
    rows.push({ id: `rev-${h}`, targets: [h, 0], winner: 'DOWN', weight: 1 });
    rows.push({ id: `whip-${h}`, targets: [h, 100 - h, 95], winner: 'UP', weight: 1.25 });
  }
  return rows;
}

function feeOnPathResult(sim) {
  // Monta um event fake para o fee engine
  const result = {
    params: { applyPolymarketFees: true, polymarketFeeCategory: 'crypto' },
    events: [{
      reason: 'expired',
      cost: sim.inv,
      quantity: sim.shares.UP + sim.shares.DOWN,
      finalPnl: sim.pnlGross,
      orders: sim.fills.map((f) => ({
        type: 'entry',
        shares: f.shares,
        price: f.preco / 100,
        liquidity: f.liquidity,
      })),
    }],
    summary: {},
  };
  applyPolymarketFeesToBacktestResult(result, { category: 'crypto' });
  const ev = result.events[0];
  return {
    pnlNet: ev.finalPnl,
    fees: ev.fees?.totalFee ?? 0,
    makerFree: ev.fees?.makerTradesFree ?? 0,
  };
}

function scoreVariant(baseParams, grid) {
  const params = { ...baseParams, ...grid, maxEventNotional: 500, maxSharesPerSide: 2000 };
  const scenarios = buildScenarios();
  let pnlNet = 0;
  let pnlGross = 0;
  let fees = 0;
  let worst = Infinity;
  let whipPnl = 0;
  let whipN = 0;
  const details = [];

  for (const sc of scenarios) {
    const path = escada.expandPathTargets(sc.targets);
    const sim = escada.simulateEscadaPath(params, path, sc.winner);
    const fee = feeOnPathResult(sim);
    const w = sc.weight || 1;
    pnlNet += fee.pnlNet * w;
    pnlGross += sim.pnlGross * w;
    fees += fee.fees * w;
    worst = Math.min(worst, fee.pnlNet);
    if (sc.id.startsWith('whip-')) {
      whipPnl += fee.pnlNet;
      whipN += 1;
    }
    details.push({
      id: sc.id,
      winner: sc.winner,
      shUp: sim.shares.UP,
      shDn: sim.shares.DOWN,
      inv: +sim.inv.toFixed(2),
      pnlGross: +sim.pnlGross.toFixed(2),
      pnlNet: +fee.pnlNet.toFixed(2),
      fees: +fee.fees.toFixed(4),
      leader: sim.leaderSide,
      fills: sim.fills.length,
      makerFills: sim.fills.filter((f) => f.liquidity === 'maker').length,
    });
  }

  return {
    grid,
    pnlNet: +pnlNet.toFixed(2),
    pnlGross: +pnlGross.toFixed(2),
    fees: +fees.toFixed(4),
    worst: +worst.toFixed(2),
    whipAvg: whipN ? +(whipPnl / whipN).toFixed(2) : null,
    details,
  };
}

function cartesian(space) {
  const keys = Object.keys(space);
  let rows = [{}];
  for (const key of keys) {
    const next = [];
    for (const row of rows) {
      for (const val of space[key]) next.push({ ...row, [key]: val });
    }
    rows = next;
  }
  return rows;
}

function main() {
  const outArg = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : path.resolve(__dirname, 'escada-dupla-lab-report.md');

  const base = {
    liquidityMode: 'auto',
    executionMode: 'optimistic_maker',
    equalizeEnabled: true,
    spreadCents: 1,
    slippageCents: 0,
  };

  const space = {
    sideMultiplier: [1, 2, 3],
    spreadCents: [0, 1, 2],
    slippageCents: [0, 1],
    equalizeEnabled: [true, false],
    liquidityMode: ['auto', 'taker'],
  };

  const variants = cartesian(space);
  const scored = variants.map((g) => scoreVariant(base, g));
  scored.sort((a, b) => b.pnlNet - a.pnlNet || b.worst - a.worst);

  const top = scored.slice(0, 15);
  const champion = top[0];

  const lines = [];
  lines.push('# Escada Dupla — lab sintético');
  lines.push('');
  lines.push(`Gerado: ${new Date().toISOString()}`);
  lines.push(`Variantes: ${scored.length}`);
  lines.push('');
  lines.push('## Campeão (soma ponderada PnL líquido nos cenários HTML)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(champion.grid, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`| métrica | valor |`);
  lines.push(`|---|---:|`);
  lines.push(`| pnlNet (Σ) | ${champion.pnlNet} |`);
  lines.push(`| pnlGross (Σ) | ${champion.pnlGross} |`);
  lines.push(`| fees (Σ) | ${champion.fees} |`);
  lines.push(`| pior cenário | ${champion.worst} |`);
  lines.push(`| whip avg | ${champion.whipAvg} |`);
  lines.push('');
  lines.push('## Top 15');
  lines.push('');
  lines.push('| # | mult | spread | slip | eq | liq | pnlNet | worst | whipAvg |');
  lines.push('|---:|---:|---:|---:|:---:|:---:|---:|---:|---:|');
  top.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.grid.sideMultiplier} | ${r.grid.spreadCents} | ${r.grid.slippageCents} | ${r.grid.equalizeEnabled} | ${r.grid.liquidityMode} | ${r.pnlNet} | ${r.worst} | ${r.whipAvg} |`,
    );
  });
  lines.push('');
  lines.push('## Detalhe do campeão (por cenário)');
  lines.push('');
  lines.push('| cenário | vence | shUP | shDN | inv | pnlGross | fees | pnlNet | leader | makerFills |');
  lines.push('|---|:---:|---:|---:|---:|---:|---:|---:|:---:|---:|');
  for (const d of champion.details) {
    lines.push(
      `| ${d.id} | ${d.winner} | ${d.shUp} | ${d.shDn} | ${d.inv} | ${d.pnlGross} | ${d.fees} | ${d.pnlNet} | ${d.leader} | ${d.makerFills} |`,
    );
  }
  lines.push('');
  lines.push('## Próximo passo');
  lines.push('');
  lines.push('1. Copiar grid campeão para `presets/` e `defaults.json` (se melhor que baseline).');
  lines.push('2. Rodar `npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/parity-smoke.json` no lake.');
  lines.push('3. Só então promover ao Studio.');
  lines.push('');

  fs.writeFileSync(outArg, `${lines.join('\n')}\n`, 'utf8');

  // Também grava preset sugerido
  const presetPath = path.resolve(
    __dirname,
    '../strategies/carry/escada-dupla-v1/presets/btc-lab-champion-synth.json',
  );
  fs.writeFileSync(
    presetPath,
    `${JSON.stringify({
      id: 'btc-lab-champion-synth',
      label: 'Campeão lab sintético (não é holdout lake)',
      params: { ...base, ...champion.grid, executionMode: 'optimistic_maker' },
      metrics: {
        pnlNetSynth: champion.pnlNet,
        worstSynth: champion.worst,
        whipAvgSynth: champion.whipAvg,
      },
    }, null, 2)}\n`,
    'utf8',
  );

  console.log(`Campeão pnlNet=${champion.pnlNet} worst=${champion.worst}`);
  console.log(JSON.stringify(champion.grid));
  console.log(`Report: ${outArg}`);
  console.log(`Preset: ${presetPath}`);
}

main();
