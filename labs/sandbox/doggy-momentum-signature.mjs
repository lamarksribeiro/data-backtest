/**
 * Etapa 7: assinatura de momentum nos fills do Doggy.
 *
 * Hipótese (da decomposição de PnL): o motor do lucro não é o locked edge —
 * é o fill marginal a 20–70¢ que ganha mais do que o preço implica.
 * Teste: o ask do lado comprado estava SUBINDO nos 15/30s antes do fill?
 * (compra a favor do movimento = momentum; contra = reversion/rebalance)
 *
 * Usage:
 *   node labs/sandbox/doggy-momentum-signature.mjs [--days=2026-07-24,2026-07-25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const OUT = path.resolve('.tmp/pair-ladder-re');
const daysArg = process.argv.slice(2).find((a) => a.startsWith('--days='));
const days = daysArg
  ? daysArg.slice('--days='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : ['2026-07-24', '2026-07-25'];

function collectParquet(daysList) {
  const files = [];
  for (const day of daysList) {
    const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.parquet')) files.push(path.join(dir, name));
    }
  }
  return files;
}

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function med(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}

async function main() {
  const ledger = JSON.parse(fs.readFileSync(path.join(OUT, 'doggy-events-ledger.json'), 'utf8'));
  const bySlug = new Map(ledger.map((e) => [e.slug, e]));

  const fillsCsv = fs.readFileSync(path.join(OUT, 'doggy-tick-replay-fills.csv'), 'utf8').trim().split('\n');
  const header = fillsCsv[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const fills = fillsCsv.slice(1).map((l) => {
    const c = l.split(',');
    return {
      ts: Number(c[idx.fill_ts]),
      px: Number(c[idx.fill_px]),
      size: Number(c[idx.size]),
      outcome: c[idx.outcome],
      slug: c[idx.slug],
    };
  });

  const parquet = collectParquet(days);
  if (!parquet.length) throw new Error(`no parquet for ${days.join(',')}`);
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${parquet.map((f) => quotedString(f)).join(',')}]`;
  const reader = await c.runAndReadAll(`
    SELECT epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
           up_best_ask::DOUBLE AS ua, down_best_ask::DOUBLE AS da
    FROM read_parquet(${pql})
    WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
  `);
  const ticks = new Map();
  for (const row of reader.getRowObjects()) {
    ticks.set(Number(row.ep), { ua: row.ua, da: row.da });
  }
  console.log(`ticks loaded: ${ticks.size}`);

  function askAt(ep, side, tol = 2) {
    for (let d = 0; d <= tol; d += 1) {
      for (const s of d === 0 ? [0] : [-d, d]) {
        const t = ticks.get(ep + s);
        if (t) return side === 'Up' ? t.ua : t.da;
      }
    }
    return null;
  }

  const rows = [];
  for (const f of fills) {
    const ev = bySlug.get(f.slug);
    if (!ev || !ev.redeemOutcome) continue;
    const a0 = askAt(f.ts, f.outcome);
    const a15 = askAt(f.ts - 15, f.outcome);
    const a30 = askAt(f.ts - 30, f.outcome);
    if (a0 == null || a15 == null) continue;
    const d15 = a0 - a15;
    const d30 = a30 != null ? a0 - a30 : null;
    const cls = d15 >= 0.02 ? 'MOMO' : d15 <= -0.02 ? 'REV' : 'FLAT';
    rows.push({
      slug: f.slug, ts: f.ts, px: f.px, size: f.size, side: f.outcome,
      win: f.outcome === ev.redeemOutcome ? 1 : 0,
      residualSide: ev.residualSide, d15, d30, cls,
      sec: f.ts - Number(f.slug.split('-').pop()),
    });
  }
  console.log(`fills joined: ${rows.length}`);

  function summarize(sel, label) {
    const n = sel.length;
    if (!n) return { label, n: 0 };
    const hit = mean(sel.map((r) => r.win));
    const px = med(sel.map((r) => r.px));
    return { label, n, hit: +hit.toFixed(3), medPx: px, evShare: +(hit - mean(sel.map((r) => r.px))).toFixed(3) };
  }

  const report = { asOf: new Date().toISOString(), days, nFills: rows.length, groups: [] };

  for (const [lo, hi] of [[0, 0.2], [0.2, 0.4], [0.4, 0.55], [0.55, 0.7], [0.7, 1.01]]) {
    for (const cls of ['MOMO', 'FLAT', 'REV']) {
      const sel = rows.filter((r) => r.px >= lo && r.px < hi && r.cls === cls);
      report.groups.push({ pxBand: `${lo}-${hi}`, cls, ...summarize(sel, cls) });
    }
  }

  // distribuição geral: quanto do fluxo é MOMO?
  const mid = rows.filter((r) => r.px >= 0.2 && r.px < 0.7);
  report.flowShare = {
    all: { MOMO: rows.filter((r) => r.cls === 'MOMO').length, FLAT: rows.filter((r) => r.cls === 'FLAT').length, REV: rows.filter((r) => r.cls === 'REV').length },
    mid20_70: { MOMO: mid.filter((r) => r.cls === 'MOMO').length, FLAT: mid.filter((r) => r.cls === 'FLAT').length, REV: mid.filter((r) => r.cls === 'REV').length },
  };

  // hit por classe no mid-price (o dinheiro está aqui)
  report.midSummary = ['MOMO', 'FLAT', 'REV'].map((cls) => summarize(mid.filter((r) => r.cls === cls), cls));

  // timing: MOMO fills concentrados em que fase do evento?
  report.momoTiming = {
    secP10: med(mid.filter((r) => r.cls === 'MOMO').map((r) => r.sec)),
    bySec: [[0, 60], [60, 180], [180, 240], [240, 301]].map(([lo, hi]) => {
      const sel = mid.filter((r) => r.cls === 'MOMO' && r.sec >= lo && r.sec < hi);
      return { sec: `${lo}-${hi}`, ...summarize(sel, '') };
    }),
  };

  // controle: EV do book em geral (todas as odds mid-price sobem→ganham?) — baseline do mercado
  // amostra ticks aleatórios: d15 do UP ask e resultado do evento
  const ctrl = [];
  for (const [ep, t] of ticks) {
    if (ctrl.length >= 20000) break;
    const evStart = ep - (ep % 300);
    const ev = bySlug.get(`btc-updown-5m-${evStart}`);
    if (!ev || !ev.redeemOutcome) continue;
    const prev = ticks.get(ep - 15);
    if (!prev) continue;
    const sec = ep - evStart;
    if (sec < 30 || sec > 290) continue;
    for (const side of ['Up', 'Down']) {
      const a0 = side === 'Up' ? t.ua : t.da;
      const a15 = side === 'Up' ? prev.ua : prev.da;
      if (a0 == null || a15 == null || a0 < 0.2 || a0 >= 0.7) continue;
      const d15 = a0 - a15;
      if (d15 >= 0.02) ctrl.push({ px: a0, win: ev.redeemOutcome === side ? 1 : 0 });
    }
  }
  report.marketBaselineMomo = summarize(ctrl.map((r) => ({ ...r, cls: 'CTRL' })), 'market MOMO ctrl');

  fs.writeFileSync(path.join(OUT, 'doggy-momentum-signature.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.flowShare, null, 1));
  console.table(report.midSummary);
  console.log('market baseline (qualquer tick MOMO 20-70¢):', report.marketBaselineMomo);
  console.log('timing MOMO:', JSON.stringify(report.momoTiming.bySec));
  console.log(`saved → ${path.join(OUT, 'doggy-momentum-signature.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
