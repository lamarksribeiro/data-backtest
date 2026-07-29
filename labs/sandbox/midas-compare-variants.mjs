/**
 * Compara variantes de um run do lab com foco na queixa operacional real:
 * "ganha pouco nos acertos e um erro leva quase tudo".
 *
 * A métrica central é `razão G/P` = ganho médio por acerto / perda média por erro.
 * PF e PnL sozinhos escondem esse perfil.
 *
 * Uso: node labs/sandbox/midas-compare-variants.mjs <dir-do-report> [...mais dirs]
 */
import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('uso: node labs/sandbox/midas-compare-variants.mjs <dir-do-report> [...]');
  process.exit(1);
}

function loadVariants(dir) {
  const p = path.join(dir, 'results.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (raw.variants ?? []).map((v) => {
    const s = v.summary ?? {};
    const wins = Number(s.wins ?? 0);
    const losses = Number(s.losses ?? 0);
    const gp = Number(s.grossProfit ?? 0);
    const gl = Math.abs(Number(s.grossLoss ?? 0));
    const avgWin = wins > 0 ? gp / wins : 0;
    const avgLoss = losses > 0 ? gl / losses : 0;
    const daily = Array.isArray(s.daily) ? s.daily : (Array.isArray(v.daily) ? v.daily : []);
    const worstDay = daily.length ? Math.min(...daily.map((d) => Number(d.totalPnl ?? 0))) : null;
    const posDays = daily.filter((d) => Number(d.totalPnl ?? 0) > 0).length;
    return {
      id: v.id,
      pnl: Number(s.totalPnl ?? 0),
      entries: Number(s.totalEntries ?? s.entries ?? 0),
      wins, losses,
      winRate: Number(s.winRate ?? 0),
      pf: Number(s.profitFactor ?? 0),
      dd: Number(s.maxDrawdown ?? 0),
      fees: Number(s.feesPaid ?? s.totalFees ?? 0),
      avgWin, avgLoss,
      ratio: avgLoss > 0 ? avgWin / avgLoss : null,
      worstDay, posDays, nDays: daily.length,
    };
  });
}

for (const dir of dirs) {
  const vs = loadVariants(dir);
  console.log(`\n## ${path.basename(dir)}\n`);
  console.log('| Variante | PnL | Entradas | WR% | PF | ganho méd | perda méd | **razão G/P** | MaxDD | Pior dia | Dias+ |');
  console.log('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  vs.sort((a, b) => b.pnl - a.pnl);
  for (const v of vs) {
    console.log(`| \`${v.id}\` | ${v.pnl.toFixed(1)} | ${v.entries} | ${v.winRate.toFixed(1)} | ${v.pf.toFixed(3)} | ${v.avgWin.toFixed(3)} | ${v.avgLoss.toFixed(3)} | **${v.ratio == null ? '—' : v.ratio.toFixed(3)}** | ${v.dd.toFixed(1)} | ${v.worstDay == null ? '—' : v.worstDay.toFixed(2)} | ${v.posDays}/${v.nDays} |`);
  }
}
