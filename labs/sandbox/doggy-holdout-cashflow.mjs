/**
 * Etapa 5 companion: cashflow Doggy na janela do holdout (redeem − buy + rebate lag).
 * Usage: node labs/sandbox/doggy-holdout-cashflow.mjs [--from=2026-07-22] [--to=2026-07-25]
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.tmp/pair-ladder-re');
const args = new Set(process.argv.slice(2));
const from = ([...args].find((a) => a.startsWith('--from=')) || '--from=2026-07-22').slice(7);
const to = ([...args].find((a) => a.startsWith('--to=')) || '--to=2026-07-25').slice(5);

function utcDay(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}
function inRange(day) {
  return day >= from && day <= to;
}

const rows = JSON.parse(fs.readFileSync(path.join(OUT, 'doggy-activity-fresh.json'), 'utf8'));
const trades = rows.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
const redeems = rows.filter((r) => r.type === 'REDEEM' && /btc-updown-5m/i.test(r.slug || ''));
const rebates = rows.filter((r) => r.type === 'TAKER_REBATE');

const byDay = {};
const ensure = (d) => {
  if (!byDay[d]) byDay[d] = { buy: 0, redeem: 0, fee: 0, nBuys: 0, nRedeem: 0, rebate: 0 };
  return byDay[d];
};

for (const t of trades) {
  const d = utcDay(t.timestamp);
  if (!inRange(d)) continue;
  const row = ensure(d);
  row.buy += t.usdcSize || 0;
  row.fee += (t.usdcSize || 0) - t.price * t.size;
  row.nBuys += 1;
}
for (const r of redeems) {
  const d = utcDay(r.timestamp);
  if (!inRange(d)) continue;
  const row = ensure(d);
  row.redeem += r.usdcSize || 0;
  row.nRedeem += 1;
}
for (const r of rebates) {
  const d = utcDay(r.timestamp);
  if (!inRange(d)) continue;
  ensure(d).rebate += r.usdcSize || 0;
}

const days = Object.keys(byDay).sort();
let buy = 0; let redeem = 0; let fee = 0; let rebate = 0; let nBuys = 0;
for (const d of days) {
  buy += byDay[d].buy;
  redeem += byDay[d].redeem;
  fee += byDay[d].fee;
  rebate += byDay[d].rebate;
  nBuys += byDay[d].nBuys;
}

const pnlAfterFees = redeem - buy; // buy já inclui fee
const pnlWithObservedRebate = pnlAfterFees + rebate;
const rebateIf44OnFees = fee * 0.44;
const pnlWith44 = pnlAfterFees + rebateIf44OnFees;

const out = {
  asOf: new Date().toISOString(),
  from,
  to,
  days,
  nBuys,
  buy,
  redeem,
  fee,
  rebateObserved: rebate,
  pnlAfterFees,
  pnlWithObservedRebate,
  rebateIfDiamond44: rebateIf44OnFees,
  pnlWithDiamond44OnSampleFees: pnlWith44,
  byDay,
};

fs.writeFileSync(path.join(OUT, 'doggy-holdout-cashflow.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
