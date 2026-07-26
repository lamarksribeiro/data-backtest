/**
 * Etapa 11a — lead de spot BTC vs fills Doggy (lake 1Hz + Binance não disponível no lake).
 *
 * Proxy no lake: Δask do lado comprado (já Etapa 7) + Δask do lado oposto +
 * movimento do mid implícito (up_ask − down_ask) nos 5/15s antes do fill.
 *
 * Pergunta: Doggy compra DEPOIS do ask subir (chase) ou ANTES (lead / anticipação)?
 * Se med(dAsk15)>0 e hit rate alto → chase. Se dAsk≈0 mas win alto → lead externo (spot).
 *
 * Usage:
 *   node labs/sandbox/doggy-spot-lead.mjs [--days=2026-07-24,2026-07-25]
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
function q(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
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

  function tickAt(ep, tol = 2) {
    for (let d = 0; d <= tol; d += 1) {
      for (const s of d === 0 ? [0] : [-d, d]) {
        const t = ticks.get(ep + s);
        if (t) return t;
      }
    }
    return null;
  }

  const rows = [];
  for (const f of fills) {
    const ev = bySlug.get(f.slug);
    if (!ev?.redeemOutcome) continue;
    const t0 = tickAt(f.ts);
    const t5 = tickAt(f.ts - 5);
    const t15 = tickAt(f.ts - 15);
    const t30 = tickAt(f.ts - 30);
    if (!t0 || !t15) continue;
    const sideAsk = (t, side) => (side === 'Up' ? t.ua : t.da);
    const a0 = sideAsk(t0, f.outcome);
    const a5 = t5 ? sideAsk(t5, f.outcome) : null;
    const a15 = sideAsk(t15, f.outcome);
    const a30 = t30 ? sideAsk(t30, f.outcome) : null;
    const opp0 = sideAsk(t0, f.outcome === 'Up' ? 'Down' : 'Up');
    const opp15 = sideAsk(t15, f.outcome === 'Up' ? 'Down' : 'Up');
    // Implied lean: positive = Up more expensive (Up favored)
    const lean0 = t0.ua - t0.da;
    const lean15 = t15.ua - t15.da;
    const dLean15 = lean0 - lean15; // >0 = market leaned further to Up
    const dAsk15 = a0 - a15;
    const dAsk5 = a5 != null ? a0 - a5 : null;
    const dAsk30 = a30 != null ? a0 - a30 : null;
    const dOpp15 = opp0 - opp15;
    // Favorable lean move for the side bought
    const leanForSide = f.outcome === 'Up' ? dLean15 : -dLean15;
    const cls =
      dAsk15 >= 0.02 ? 'CHASE' :
      dAsk15 <= -0.02 ? 'FADE' :
      Math.abs(leanForSide) >= 0.03 ? 'LEAN' :
      'FLAT';
    const win = f.outcome === ev.redeemOutcome ? 1 : 0;
    const start = Number(String(f.slug).split('-').pop());
    rows.push({
      slug: f.slug,
      ts: f.ts,
      sec: f.ts - start,
      px: f.px,
      size: f.size,
      side: f.outcome,
      win,
      dAsk5,
      dAsk15,
      dAsk30,
      dOpp15,
      leanForSide,
      cls,
      phase: f.ts - start < 30 ? 'open' : f.ts - start < 180 ? 'mid' : 'late',
    });
  }
  console.log(`fills joined: ${rows.length}`);

  function bucket(sel, label) {
    if (!sel.length) return { label, n: 0 };
    const hit = mean(sel.map((r) => r.win));
    const px = med(sel.map((r) => r.px));
    return {
      label,
      n: sel.length,
      hit: +hit.toFixed(3),
      medPx: +px.toFixed(3),
      evShare: +(hit - mean(sel.map((r) => r.px))).toFixed(3),
      medDAsk15c: +(med(sel.map((r) => r.dAsk15)) * 100).toFixed(1),
      medLeanForc: +(med(sel.map((r) => r.leanForSide)) * 100).toFixed(1),
      p10DAsk15c: +(q(sel.map((r) => r.dAsk15), 0.1) * 100).toFixed(1),
      p90DAsk15c: +(q(sel.map((r) => r.dAsk15), 0.9) * 100).toFixed(1),
    };
  }

  const report = {
    asOf: new Date().toISOString(),
    days,
    nFills: rows.length,
    byClass: ['CHASE', 'LEAN', 'FLAT', 'FADE'].map((c) => bucket(rows.filter((r) => r.cls === c), c)),
    byPhase: ['open', 'mid', 'late'].map((p) => bucket(rows.filter((r) => r.phase === p), p)),
    midBand: bucket(rows.filter((r) => r.px >= 0.2 && r.px < 0.7), 'px20-70'),
    midChase: bucket(rows.filter((r) => r.px >= 0.2 && r.px < 0.7 && r.cls === 'CHASE'), 'px20-70 CHASE'),
    midFade: bucket(rows.filter((r) => r.px >= 0.2 && r.px < 0.7 && r.cls === 'FADE'), 'px20-70 FADE'),
    midLean: bucket(rows.filter((r) => r.px >= 0.2 && r.px < 0.7 && r.cls === 'LEAN'), 'px20-70 LEAN'),
    midFlat: bucket(rows.filter((r) => r.px >= 0.2 && r.px < 0.7 && r.cls === 'FLAT'), 'px20-70 FLAT'),
    // Timing: was ask already rising 30→15 before the last 15s?
    acceleration: (() => {
      const sel = rows.filter((r) => r.dAsk30 != null && r.dAsk15 != null && r.px >= 0.2 && r.px < 0.7);
      const accel = sel.filter((r) => r.dAsk15 - (r.dAsk30 - r.dAsk15) > 0.01); // recent rise faster
      return {
        n: sel.length,
        accelShare: sel.length ? +(accel.length / sel.length).toFixed(3) : null,
        accel: bucket(accel, 'accel'),
        other: bucket(sel.filter((r) => !accel.includes(r)), 'no-accel'),
      };
    })(),
  };

  // Verdict heuristics
  const chase = report.byClass.find((x) => x.label === 'CHASE');
  const fade = report.byClass.find((x) => x.label === 'FADE');
  const lean = report.byClass.find((x) => x.label === 'LEAN');
  report.verdict = [];
  if (chase?.n && fade?.n) {
    report.verdict.push(
      `CHASE hit=${chase.hit} ev=${chase.evShare} (n=${chase.n}) vs FADE hit=${fade.hit} ev=${fade.evShare} (n=${fade.n})`,
    );
    if (chase.evShare > fade.evShare + 0.02) {
      report.verdict.push('Dominante: chase do ask já em movimento (momentum-taker), não lead puro no book.');
    } else if (fade.evShare > chase.evShare + 0.02) {
      report.verdict.push('FADE supera CHASE — edge de reversion / vacuum, não momentum.');
    }
  }
  if (lean?.n) {
    report.verdict.push(
      `LEAN (ask flat, lean implícito a favor): n=${lean.n} hit=${lean.hit} ev=${lean.evShare} — candidato a lead spot externo.`,
    );
  }

  const outPath = path.join(OUT, 'doggy-spot-lead.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('wrote', outPath);
  await c.closeSync?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
