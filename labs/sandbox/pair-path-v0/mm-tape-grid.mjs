/**
 * Exhaustive grid inside the already-frozen late H75 maker hypothesis.
 *
 * Uses only cached public taker trades and strict trade-through proof. No
 * network access and no inferred fill from BBO movement.
 *
 * Discovery: 2026-07-29
 * Validation: 2026-07-22..2026-07-28
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);
const TAPE_CACHE = path.join(ROOT, '.tmp/mm-trade-tape-v1/cache');
const WINNER_CSV = path.join(ROOT, 'scratch/canonical-outcomes-v1.csv');
const OUT_DIR = path.join(ROOT, '.tmp/mm-tape-grid-v1');
const SIZE = 5;
const TICK = 0.001;
const STOP_TAU = 5;
const REBATE_RATE = 0.2;
const FEE_RATE = 0.07;

function loadWinners() {
  const lines = fs.readFileSync(WINNER_CSV, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  const conditionIndex = header.indexOf('condition_id');
  const winnerIndex = header.indexOf('winner');
  return new Map(
    lines.map((line) => line.split(',')).map((values) => [
      values[conditionIndex],
      values[winnerIndex],
    ]),
  );
}

function tape(conditionId) {
  const file = path.join(TAPE_CACHE, `${conditionId}.json`);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return payload.trades ?? [];
}

async function loadEvents(from, to, split) {
  const days = fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dt='))
    .map((entry) => entry.name.slice(3))
    .filter((day) => day >= from && day <= to)
    .sort();
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const events = [];
  for (const day of days) {
    const dir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.parquet'))
      .map((name) => path.join(dir, name));
    const parquet = `[${files.map((file) => quotedString(file)).join(',')}]`;
    const rows = (
      await connection.runAndReadAll(`
        SELECT
          condition_id,
          epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS event_epoch,
          epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
          extract(epoch FROM (
            try_cast(event_end AS TIMESTAMPTZ) -
            try_cast(ts AS TIMESTAMPTZ)
          ))::DOUBLE AS tau,
          up_best_bid,
          down_best_bid
        FROM read_parquet(${parquet})
        WHERE coverage >= 0.99
          AND coalesce(degraded, false) = false
          AND up_best_bid IS NOT NULL
          AND down_best_bid IS NOT NULL
        QUALIFY row_number() OVER (
          PARTITION BY condition_id, event_start, ts
          ORDER BY coverage DESC
        ) = 1
        ORDER BY condition_id, event_epoch, ts_epoch
      `)
    ).getRowObjectsJS();
    let conditionId = null;
    let eventEpoch = null;
    let ticks = [];
    const flush = () => {
      if (!ticks.length || ticks[0].tau < 240 || ticks.at(-1).tau > 15) return;
      events.push({
        split,
        day,
        conditionId,
        eventEpoch,
        ticks,
        trades: tape(conditionId),
      });
    };
    for (const row of rows) {
      const next = String(row.condition_id);
      if (conditionId != null && next !== conditionId) {
        flush();
        ticks = [];
      }
      conditionId = next;
      eventEpoch = Number(row.event_epoch);
      ticks.push({
        tsSecond: Number(row.ts_epoch),
        tau: Number(row.tau),
        upBid: Number(row.up_best_bid),
        downBid: Number(row.down_best_bid),
      });
    }
    flush();
  }
  return events;
}

function variants() {
  const rows = [];
  for (const entryTau of [15, 20, 30, 45, 60]) {
    for (const zoneLo of [0.75, 0.78, 0.8, 0.82]) {
      for (const zoneHi of [0.88, 0.9, 0.92]) {
        if (zoneLo >= zoneHi) continue;
        for (const maxNakedPx of [0.02, 0.03, 0.04, 0.05]) {
          for (const backoffTicks of [0, 1, 2, 3]) {
            rows.push({
              id: [
                `t${entryTau}`,
                `z${Math.round(zoneLo * 100)}-${Math.round(zoneHi * 100)}`,
                `dog${Math.round(maxNakedPx * 100)}`,
                `b${backoffTicks}`,
              ].join('-'),
              entryTau,
              zoneLo,
              zoneHi,
              maxNakedPx,
              backoffTicks,
            });
          }
        }
      }
    }
  }
  return rows;
}

function firstOrder(event, variant) {
  for (const tick of event.ticks) {
    if (tick.tau > variant.entryTau || tick.tau <= STOP_TAU) continue;
    const favBid = Math.max(tick.upBid, tick.downBid);
    if (favBid < variant.zoneLo || favBid > variant.zoneHi) continue;
    const side = tick.upBid <= tick.downBid ? 'UP' : 'DOWN';
    const bid = side === 'UP' ? tick.upBid : tick.downBid;
    if (bid > variant.maxNakedPx + 1e-12) continue;
    const price = Math.round(
      (bid - variant.backoffTicks * TICK) / TICK,
    ) * TICK;
    if (price <= 0 || price >= 1) continue;
    return {
      side,
      price,
      postedSecond: Math.floor(tick.tsSecond),
    };
  }
  return null;
}

function simulate(event, variant, winner) {
  const order = firstOrder(event, variant);
  if (!order) return { pnl: 0, rebateUpper: 0, filled: false, missingTape: false };
  if (!event.trades) {
    return { pnl: 0, rebateUpper: 0, filled: false, missingTape: true };
  }
  const lastSecond = event.eventEpoch + 300 - STOP_TAU;
  const proof = event.trades.find(
    (trade) =>
      trade.outcome === order.side &&
      trade.side === 'SELL' &&
      Number(trade.timestamp) > order.postedSecond &&
      Number(trade.timestamp) <= lastSecond &&
      Number(trade.price) < order.price - 1e-12,
  );
  if (!proof) return { pnl: 0, rebateUpper: 0, filled: false, missingTape: false };
  const pnl =
    order.side === winner
      ? SIZE * (1 - order.price)
      : -SIZE * order.price;
  const feeEquivalent = SIZE * FEE_RATE * order.price * (1 - order.price);
  return {
    pnl,
    rebateUpper: REBATE_RATE * feeEquivalent,
    filled: true,
    missingTape: false,
    won: order.side === winner,
    price: order.price,
    side: order.side,
  };
}

function summarize(rows) {
  const fills = rows.filter((row) => row.filled);
  const totalPnl = rows.reduce((sum, row) => sum + row.pnl, 0);
  const rebateUpper = rows.reduce((sum, row) => sum + row.rebateUpper, 0);
  const grossProfit = rows
    .filter((row) => row.pnl > 0)
    .reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = rows
    .filter((row) => row.pnl < 0)
    .reduce((sum, row) => sum + Math.abs(row.pnl), 0);
  const byDay = new Map();
  for (const row of rows) {
    if (!byDay.has(row.day)) byDay.set(row.day, 0);
    byDay.set(row.day, byDay.get(row.day) + row.pnl);
  }
  return {
    events: rows.length,
    fills: fills.length,
    wins: fills.filter((row) => row.won).length,
    winRatePct: fills.length
      ? Number((100 * fills.filter((row) => row.won).length / fills.length).toFixed(2))
      : null,
    totalPnl: Number(totalPnl.toFixed(4)),
    totalPnlWithRebateUpper: Number((totalPnl + rebateUpper).toFixed(4)),
    rebateUpper: Number(rebateUpper.toFixed(4)),
    profitFactor:
      grossLoss > 0
        ? Number((grossProfit / grossLoss).toFixed(4))
        : grossProfit > 0 ? 'Infinity' : 0,
    worst: fills.length
      ? Number(Math.min(...fills.map((row) => row.pnl)).toFixed(4))
      : 0,
    positiveDays: [...byDay.values()].filter((pnl) => pnl > 0).length,
    days: byDay.size,
    byDay: Object.fromEntries(
      [...byDay.entries()].map(([day, pnl]) => [day, Number(pnl.toFixed(4))]),
    ),
    missingTape: rows.filter((row) => row.missingTape).length,
  };
}

function bootstrapDays(rows, samples = 3000) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.day)) groups.set(row.day, []);
    groups.get(row.day).push(row.pnl);
  }
  const days = [...groups.keys()];
  if (days.length < 3) return null;
  const totals = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < days.length; index += 1) {
      const day = days[(Math.random() * days.length) | 0];
      total += groups.get(day).reduce((sum, pnl) => sum + pnl, 0);
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const q = (value) =>
    Number(totals[Math.floor((totals.length - 1) * value)].toFixed(4));
  return { p05: q(0.05), p50: q(0.5), p95: q(0.95) };
}

function markdown(report) {
  return `# Late H75 strict trade-through grid

Generated: ${report.generatedAt}

- Variants: ${report.variants}
- Discovery events: ${report.windows.discovery.events}
- Validation events: ${report.windows.validation.events}
- Positive in both windows: ${report.funnel.positiveBoth}
- Passed all gates: ${report.funnel.survivors}

## Top validation candidates

| id | D pnl | D fills | V pnl | V fills | V PF | V days+ | V p05 |
|---|---:|---:|---:|---:|---:|---:|---:|
${report.top.map((row) =>
    `| \`${row.id}\` | ${row.discovery.totalPnl} | ${row.discovery.fills} | ${row.validation.totalPnl} | ${row.validation.fills} | ${row.validation.profitFactor} | ${row.validation.positiveDays}/${row.validation.days} | ${row.validationBootstrap?.p05 ?? '-'} |`,
  ).join('\n')}

## Gates

- PnL > 0 and PF > 1 in both windows.
- At least 30 strict proven fills in validation.
- At least 5/7 positive validation days.
- Day-clustered bootstrap p05 > 0.
- Rebate is excluded from the pass gate and reported only as an upper bound.
`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const winners = loadWinners();
  const events = [
    ...(await loadEvents('2026-07-29', '2026-07-29', 'discovery')),
    ...(await loadEvents('2026-07-22', '2026-07-28', 'validation')),
  ];
  const grid = variants();
  const evaluations = [];
  for (const [index, variant] of grid.entries()) {
    const discoveryRows = [];
    const validationRows = [];
    for (const event of events) {
      const winner = winners.get(event.conditionId);
      if (!winner) continue;
      const row = {
        day: event.day,
        ...simulate(event, variant, winner),
      };
      if (event.split === 'discovery') discoveryRows.push(row);
      else validationRows.push(row);
    }
    const discovery = summarize(discoveryRows);
    const validation = summarize(validationRows);
    const validationBootstrap = bootstrapDays(validationRows);
    const passes =
      discovery.totalPnl > 0 &&
      (discovery.profitFactor === 'Infinity' || discovery.profitFactor > 1) &&
      validation.totalPnl > 0 &&
      (validation.profitFactor === 'Infinity' || validation.profitFactor > 1) &&
      validation.fills >= 30 &&
      validation.positiveDays >= 5 &&
      validationBootstrap?.p05 > 0;
    evaluations.push({
      ...variant,
      discovery,
      validation,
      validationBootstrap,
      passes,
    });
    if ((index + 1) % 100 === 0) {
      console.log(`[${index + 1}/${grid.length}]`);
    }
  }
  evaluations.sort(
    (a, b) =>
      Number(b.passes) - Number(a.passes) ||
      b.validation.totalPnl - a.validation.totalPnl ||
      b.discovery.totalPnl - a.discovery.totalPnl,
  );
  const positiveBoth = evaluations.filter(
    (row) => row.discovery.totalPnl > 0 && row.validation.totalPnl > 0,
  ).length;
  const survivors = evaluations.filter((row) => row.passes);
  const report = {
    generatedAt: new Date().toISOString(),
    model: {
      fill: 'strict public taker trade-through after posting second',
      size: SIZE,
      makerFee: 0,
      rebatePassGate: false,
      winnerSource: path.relative(ROOT, WINNER_CSV).replaceAll('\\', '/'),
    },
    windows: {
      discovery: {
        from: '2026-07-29',
        to: '2026-07-29',
        events: events.filter((event) => event.split === 'discovery').length,
      },
      validation: {
        from: '2026-07-22',
        to: '2026-07-28',
        events: events.filter((event) => event.split === 'validation').length,
      },
    },
    variants: grid.length,
    funnel: {
      positiveBoth,
      survivors: survivors.length,
    },
    survivors,
    top: evaluations.slice(0, 100),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'REPORT.md'),
    markdown(report),
    'utf8',
  );
  console.log(markdown(report));
}

await main();
