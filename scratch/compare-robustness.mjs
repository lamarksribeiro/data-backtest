import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('Usage: node scratch/compare-robustness.mjs <reportDir>...');
  process.exit(1);
}

function load(dir) {
  const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  const list = results.variants || results.results || results;
  return { dir, meta, variants: Array.isArray(list) ? list : [] };
}

function summarizeVariant(v) {
  const s = v.summary || {};
  const daily = v.daily || [];
  const losingDays = daily.filter((d) => (d.totalPnl || 0) < 0);
  const worstDay = daily.reduce((w, d) => ((d.totalPnl || 0) < (w?.totalPnl ?? Infinity) ? d : w), null);
  const bestDay = daily.reduce((w, d) => ((d.totalPnl || 0) > (w?.totalPnl ?? -Infinity) ? d : w), null);
  const jun2 = daily.find((d) => d.dt === '2026-06-02');
  const jun1to6 = daily.filter((d) => d.dt >= '2026-06-01' && d.dt <= '2026-06-06');
  const jun1to6Pnl = jun1to6.reduce((a, d) => a + (d.totalPnl || 0), 0);

  // Circuit breaker simulation: stop trading after day PnL hits -40
  let cbPnl = 0;
  let cbStoppedDays = 0;
  let cum = 0;
  for (const d of daily) {
    const dayPnl = d.totalPnl || 0;
    // approximate: if previous cumulative day already stopped... better: stop within day when DD from day start exceeds 40
    // We only have day totals, so: if day would be < -40, cap at -40 (optimistic CB)
    const capped = Math.max(dayPnl, -40);
    if (dayPnl < -40) cbStoppedDays++;
    cbPnl += capped;
    cum += dayPnl;
  }

  return {
    id: v.id,
    pnl: s.totalPnl ?? 0,
    entries: s.entries ?? 0,
    winRate: s.winRate ?? 0,
    pf: s.profitFactor ?? 0,
    dd: s.maxDrawdown ?? 0,
    fees: s.feesPaid ?? 0,
    profitableDays: daily.filter((d) => (d.totalPnl || 0) > 0).length,
    losingDays: losingDays.length,
    days: daily.length,
    worstDay: worstDay ? { dt: worstDay.dt, pnl: worstDay.totalPnl } : null,
    bestDay: bestDay ? { dt: bestDay.dt, pnl: bestDay.totalPnl } : null,
    jun2Pnl: jun2?.totalPnl ?? null,
    jun1to6Pnl: jun1to6.length ? jun1to6Pnl : null,
    cbPnlCap40: cbPnl,
    cbStoppedDays,
    daily,
  };
}

const reports = dirs.map(load);
const out = {};

for (const r of reports) {
  const name = path.basename(r.dir);
  const rows = r.variants.map(summarizeVariant).sort((a, b) => b.pnl - a.pnl);
  const champ = rows.find((x) => x.id === 'champion' || x.id === 'v7-champion') || rows[0];
  console.log(`\n======== ${name} ========`);
  console.log(
    'id'.padEnd(22),
    'pnl'.padStart(9),
    'Δchamp'.padStart(9),
    'entries'.padStart(7),
    'WR%'.padStart(6),
    'PF'.padStart(5),
    'DD'.padStart(7),
    '+days'.padStart(6),
    'worst'.padStart(18),
    'jun2'.padStart(8),
  );
  for (const row of rows) {
    const delta = row.pnl - champ.pnl;
    const worst = row.worstDay ? `${row.worstDay.dt.slice(5)}:${row.worstDay.pnl.toFixed(0)}` : '—';
    const jun2 = row.jun2Pnl == null ? '—' : row.jun2Pnl.toFixed(0);
    console.log(
      String(row.id).padEnd(22),
      row.pnl.toFixed(1).padStart(9),
      (delta >= 0 ? '+' : '') + delta.toFixed(1).padStart(8),
      String(row.entries).padStart(7),
      row.winRate.toFixed(1).padStart(6),
      row.pf.toFixed(2).padStart(5),
      row.dd.toFixed(1).padStart(7),
      `${row.profitableDays}/${row.days}`.padStart(6),
      worst.padStart(18),
      jun2.padStart(8),
    );
  }

  // Concentration: how much of delta vs champion comes from jun1-6
  console.log('\nDelta vs champion — concentration on Jun1-6 (when available):');
  for (const row of rows) {
    if (row.id === champ.id) continue;
    const dTotal = row.pnl - champ.pnl;
    let dJun = null;
    if (row.jun1to6Pnl != null && champ.jun1to6Pnl != null) {
      dJun = row.jun1to6Pnl - champ.jun1to6Pnl;
    }
    const share = dJun != null && Math.abs(dTotal) > 1e-6 ? (100 * dJun) / dTotal : null;
    console.log(
      `  ${row.id}: Δtotal=${dTotal.toFixed(1)} Δjun1-6=${dJun == null ? 'n/a' : dJun.toFixed(1)} share=${share == null ? 'n/a' : share.toFixed(0) + '%'}`,
    );
  }

  // Circuit breaker note on champion
  console.log(
    `\nCircuit breaker post-hoc (cap day at -$40): champion pnl ${champ.pnl.toFixed(1)} → ${champ.cbPnlCap40.toFixed(1)} (days capped=${champ.cbStoppedDays})`,
  );

  out[name] = { champion: champ.id, rows, from: r.meta?.experiment?.from || r.meta?.from, to: r.meta?.experiment?.to || r.meta?.to };
}

fs.writeFileSync('scratch/robustness-compare.json', JSON.stringify(out, null, 2));
console.log('\nWrote scratch/robustness-compare.json');
