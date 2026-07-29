/**
 * Ciclo de vida real das ordens no live (24–25/07).
 *
 * Pergunta que decide o desenho do fix do GTC:
 *   A saída protetora falhou por FALTA DE LIQUIDEZ ou por SOFTWARE?
 *
 *   (a) havia bid no book no submit e mesmo assim não preencheu
 *       -> problema de tipo de ordem / retry / circuit breaker -> fix é código
 *   (b) não havia bid, ou a ordem nunca chegou a ser submetida
 *       -> nenhum tipo de ordem resolve -> só sair mais cedo resolve
 *
 * Uso: node scratch/live-vs-backtest/analyze-order-lifecycle.mjs
 */
import fs from 'node:fs';

const FILES = [
  'scratch/live-vs-backtest/prod-audit-2026-07-24.jsonl',
  'scratch/live-vs-backtest/prod-audit-2026-07-25.jsonl',
];

const recs = FILES.flatMap((f) => {
  try {
    return fs.readFileSync(f, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
});

const submits = recs.filter((r) => r.type === 'order_submit');
const terminals = recs.filter((r) => r.type === 'order_terminal');

const P = [];
P.push('# Ciclo de vida real das ordens — live 24–25/07\n');
P.push(`Registros: ${recs.length} · submits: ${submits.length} · terminals: ${terminals.length}\n`);

// ---------- 1. submits por tipo de intent ----------
P.push('## 1. O que foi efetivamente submetido\n');
const byKind = {};
for (const s of submits) {
  const k = `${s.kind}/${s.orderType}`;
  byKind[k] = (byKind[k] ?? 0) + 1;
}
P.push('| intent / tipo de ordem | submits |');
P.push('|---|--:|');
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) P.push(`| \`${k}\` | ${n} |`);

// ---------- 2. desfecho por tipo ----------
P.push('\n## 2. Desfecho\n');
const outcome = {};
for (const t of terminals) {
  const k = `${t.kind}/${t.orderType}`;
  outcome[k] ??= { n: 0, filled: 0, qty: 0, reasons: {} };
  const o = outcome[k];
  o.n += 1;
  if (t.filled) o.filled += 1;
  o.qty += Number(t.qty ?? 0);
  const r = (t.reason ?? t.eventType ?? '?').slice(0, 70);
  o.reasons[r] = (o.reasons[r] ?? 0) + 1;
}
P.push('| intent / tipo | terminais | preenchidos | fill % | shares |');
P.push('|---|--:|--:|--:|--:|');
for (const [k, o] of Object.entries(outcome).sort((a, b) => b[1].n - a[1].n)) {
  P.push(`| \`${k}\` | ${o.n} | ${o.filled} | ${(100 * o.filled / o.n).toFixed(1)} | ${o.qty} |`);
}

P.push('\n### Razões de término, por intent\n');
for (const [k, o] of Object.entries(outcome)) {
  P.push(`\n**${k}**\n`);
  for (const [r, n] of Object.entries(o.reasons).sort((a, b) => b[1] - a[1])) {
    P.push(`- ${n}× \`${r}\``);
  }
}

// ---------- 3. a pergunta central: havia liquidez? ----------
P.push('\n## 3. Havia liquidez no momento do submit?\n');
const exitish = terminals.filter((t) => t.kind !== 'ENTER');
if (exitish.length === 0) {
  P.push('**Nenhuma ordem de saída/reverse chegou a receber terminal.**');
  const exitSubs = submits.filter((s) => s.kind !== 'ENTER');
  P.push(`Submits de saída/reverse encontrados: ${exitSubs.length}.`);
  if (exitSubs.length === 0) {
    P.push('');
    P.push('> Conclusão direta: a proteção **nunca foi submetida**. Isso não é');
    P.push('> problema de tipo de ordem nem de liquidez — é caminho de código');
    P.push('> (circuit breaker / gate) impedindo a emissão.');
  }
} else {
  P.push('| intent | tipo | resultado | qty | bid no submit | spread | latência ms |');
  P.push('|---|---|---|--:|--:|--:|--:|');
  for (const t of exitish.slice(0, 40)) {
    const b = t.bookAtSubmit ?? {};
    P.push(`| ${t.kind} | ${t.orderType} | ${t.eventType} | ${t.qty ?? 0} | ${b.bid ?? '—'} | ${b.spread?.toFixed?.(3) ?? '—'} | ${t.latencyMs ?? '—'} |`);
  }
}

// ---------- 4. ENTER: o book estava lá e mesmo assim falhou? ----------
P.push('\n## 4. ENTER — falhas com liquidez visível no book\n');
const enters = terminals.filter((t) => t.kind === 'ENTER');
const enterFail = enters.filter((t) => !t.filled);
P.push(`ENTER terminais: ${enters.length} · falhas: ${enterFail.length} (${(100 * enterFail.length / Math.max(1, enters.length)).toFixed(1)}%)\n`);

// casa o submit para recuperar liquidez e maxPrice
const subByIntent = new Map();
for (const s of submits) subByIntent.set(`${s.intentId}|${s.attempt}`, s);

let withLiq = 0;
let askAboveMax = 0;
const lat = [];
P.push('| resultado | ask no submit | maxPrice | liq visível | qty | latência ms |');
P.push('|---|--:|--:|--:|--:|--:|');
for (const t of enterFail.slice(0, 25)) {
  const s = subByIntent.get(`${t.intentId}|${t.attempt}`);
  const b = t.bookAtSubmit ?? {};
  const liq = s?.liquidity?.liq;
  if (liq != null && liq > 0) withLiq += 1;
  if (b.ask != null && t.price != null && b.ask > t.price) askAboveMax += 1;
  if (t.latencyMs != null) lat.push(t.latencyMs);
  P.push(`| ${t.eventType} | ${b.ask ?? '—'} | ${t.price ?? '—'} | ${liq ?? '—'} | ${t.qty ?? 0} | ${t.latencyMs ?? '—'} |`);
}
P.push('');
P.push(`Falhas em que o book **mostrava liquidez** no submit: ${withLiq} de ${Math.min(25, enterFail.length)} amostradas.`);

const allLat = terminals.map((t) => t.latencyMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
if (allLat.length) {
  const q = (p) => allLat[Math.floor(p * (allLat.length - 1))];
  P.push('');
  P.push(`## 5. Latência submit → terminal (n=${allLat.length})\n`);
  P.push(`p50 **${q(0.5)} ms** · p90 **${q(0.9)} ms** · p99 **${q(0.99)} ms** · máx **${allLat[allLat.length - 1]} ms**`);
  P.push('');
  P.push('Com ticks de mercado a ~500 ms, uma latência p50 nessa ordem significa que');
  P.push('o book pode ter andado 1–2 atualizações entre a decisão e a chegada da ordem.');
}

const md = P.join('\n');
console.log(md);
fs.writeFileSync('scratch/live-vs-backtest/ORDER-LIFECYCLE-ANALYSIS.md', md);
