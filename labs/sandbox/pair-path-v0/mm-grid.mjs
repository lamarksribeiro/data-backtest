/**
 * Exhaustive grid over the two-sided maker engine.
 *
 * Reports EVERY variant under BOTH fee hypotheses:
 *   makerFee=0     — the documented Polymarket rule ("makers are never charged")
 *   makerFee=0.07  — the pessimistic floor, because real fills recorded in this
 *                    repo matched the taker formula in 99.96% of cases
 *
 * A variant only counts as a finding if it survives the pessimistic floor OR if
 * the maker exemption is independently confirmed on a real fill.
 *
 *   node labs/sandbox/pair-path-v0/mm-grid.mjs --from=2026-07-29 --to=2026-07-29
 *   node labs/sandbox/pair-path-v0/mm-grid.mjs --from=2026-04-23 --to=2026-06-30 --tag=train
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { runEvent, defaultPolicy, summarize, FEE_RATE } from './mm-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const FROM = arg('from', '2026-07-29');
const TO = arg('to', '2026-07-29');
const TAG = arg('tag', 'd29');
const TOP = Number(arg('top', '40'));
const OUT_DIR = path.join(ROOT, `.tmp/mm-grid-${TAG}`);
const WINNER_CSV = path.resolve(
  ROOT,
  arg('winnerCsv', 'scratch/canonical-outcomes-v1.csv'),
);

function loadCanonicalWinners(file) {
  if (!fs.existsSync(file)) return new Map();
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift()?.split(',') ?? [];
  const conditionIndex = header.indexOf('condition_id');
  const winnerIndex = header.indexOf('winner');
  if (conditionIndex < 0 || winnerIndex < 0) {
    throw new Error(`winner CSV needs condition_id,winner: ${file}`);
  }
  return new Map(
    lines
      .filter(Boolean)
      .map((line) => line.split(','))
      .filter((values) => ['UP', 'DOWN'].includes(values[winnerIndex]))
      .map((values) => [values[conditionIndex], values[winnerIndex]]),
  );
}

const CANONICAL_WINNERS = loadCanonicalWinners(WINNER_CSV);

function r4(x) {
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null;
}
function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
}
function clusterBootstrap(map, iterations = 1200) {
  const keys = [...map.keys()];
  if (keys.length < 3) return [null, null];
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const arr = map.get(keys[(Math.random() * keys.length) | 0]);
      for (let j = 0; j < arr.length; j += 1) {
        sum += arr[j];
        n += 1;
      }
    }
    if (n) means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [
    r4(means[Math.floor(means.length * 0.025)]),
    r4(means[Math.floor(means.length * 0.975)]),
  ];
}

function buildGrid() {
  const out = [];
  const seen = new Set();
  const add = (id, o) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(defaultPolicy({ id, ...o }));
  };

  const zones = [
    ['all', 0, 1],
    ['mid', 0.4, 0.62],
    ['hi', 0.62, 0.88],
    ['xhi', 0.88, 0.98],
    ['lo', 0.02, 0.4],
  ];
  // cut rules: drift trigger (cents) x max accepted loss (cents)
  const cuts = [
    ['nocut', null],
    ['d1L3', { driftTrigger: 0.01, maxLossPerShare: 0.03 }],
    ['d2L4', { driftTrigger: 0.02, maxLossPerShare: 0.04 }],
    ['d3L5', { driftTrigger: 0.03, maxLossPerShare: 0.05 }],
    ['d5L7', { driftTrigger: 0.05, maxLossPerShare: 0.07 }],
    ['d8L10', { driftTrigger: 0.08, maxLossPerShare: 0.1 }],
    ['d2L4t60', { driftTrigger: 0.02, maxLossPerShare: 0.04, tauMax: 60 }],
    ['d3L5t60', { driftTrigger: 0.03, maxLossPerShare: 0.05, tauMax: 60 }],
    ['d3L5t30', { driftTrigger: 0.03, maxLossPerShare: 0.05, tauMax: 30 }],
    ['t60L5', { driftTrigger: 99, maxLossPerShare: 0.05, tauMax: 60 }],
    ['t30L5', { driftTrigger: 99, maxLossPerShare: 0.05, tauMax: 30 }],
    ['t30L15', { driftTrigger: 99, maxLossPerShare: 0.15, tauMax: 30 }],
  ];

  for (const [zTag, zoneLo, zoneHi] of zones) {
    for (const [cTag, cut] of cuts) {
      for (const entryTau of [280, 200]) {
        add(`${zTag}-${cTag}-e${entryTau}`, {
          zoneLo,
          zoneHi,
          cut,
          entryTau,
        });
      }
    }
  }

  // best-guess core, swept on the remaining knobs
  const core = { zoneLo: 0, zoneHi: 1, entryTau: 280 };

  // DEEP two-sided quoting: rest both bids well below the touch so the pair is
  // acquired at a large discount. Only correctly simulable now that the fill
  // reference is min(px, touch) — previously these were phantom fills.
  for (const backoffTicks of [3, 5, 10, 20, 30, 50]) {
    for (const cutTag of ['nocut', 'd3L5', 't30L5', 'oneStrike']) {
      const cut =
        cutTag === 'nocut'
          ? null
          : cutTag === 'd3L5'
            ? { driftTrigger: 0.03, maxLossPerShare: 0.05 }
            : cutTag === 't30L5'
              ? { driftTrigger: 99, maxLossPerShare: 0.05, tauMax: 30 }
              : { driftTrigger: 0.03, maxLossPerShare: 0.05, stopAfterCut: true };
      add(`deep${backoffTicks}-${cutTag}`, {
        ...core,
        quoteMode: 'backoff',
        backoffTicks,
        cut,
        maxCuts: 2,
      });
    }
  }
  // STATIC PAIR LOCK — the core mechanism, swept against its dynamic control
  const cutSet = [
    ['nocut', null],
    ['d2L4', { driftTrigger: 0.02, maxLossPerShare: 0.04 }],
    ['d3L5', { driftTrigger: 0.03, maxLossPerShare: 0.05 }],
    ['d5L7', { driftTrigger: 0.05, maxLossPerShare: 0.07 }],
    ['t60L5', { driftTrigger: 99, maxLossPerShare: 0.05, tauMax: 60 }],
    ['t30L5', { driftTrigger: 99, maxLossPerShare: 0.05, tauMax: 30 }],
    ['t30L20', { driftTrigger: 99, maxLossPerShare: 0.2, tauMax: 30 }],
  ];
  for (const staticQuotes of [true, false]) {
    for (const [cTag, cut] of cutSet) {
      for (const maxSets of [1, 3, 10]) {
        add(`lock${staticQuotes ? 'S' : 'D'}-${cTag}-sets${maxSets}`, {
          ...core,
          staticQuotes,
          cut,
          maxSets,
          maxImbalance: 1,
          maxCuts: 3,
        });
      }
    }
  }
  // static lock at a discount to the touch (bigger cushion per pair)
  for (const backoffTicks of [0, 2, 5, 10]) {
    for (const [cTag, cut] of cutSet) {
      add(`lockS-b${backoffTicks}-${cTag}`, {
        ...core,
        staticQuotes: true,
        quoteMode: backoffTicks === 0 ? 'join' : 'backoff',
        backoffTicks,
        cut,
        maxSets: 3,
        maxCuts: 3,
      });
    }
  }
  // LOW-TAU x EXTREME-PRICE family.
  // Rationale: the pair always pays 1c, but every correction costs fee+drift.
  // fee = 0.07*p*(1-p) collapses 5x at the extremes (0.33c at 0.95 vs 1.75c at
  // 0.50), and drift collapses as tau -> 0 because the price is pinned. So the
  // cheapest place to be wrong is late and extreme. maxNakedPx caps the tail.
  for (const [zTag, zoneLo, zoneHi] of [
    ['any', 0, 1],
    ['x88', 0.88, 0.995],
    ['x92', 0.92, 0.995],
    ['h75', 0.75, 0.92],
  ]) {
    for (const [eTau, sTau] of [
      [120, 10],
      [90, 10],
      [60, 5],
      [45, 5],
      [30, 5],
    ]) {
      for (const maxNakedPx of [null, 0.2, 0.1, 0.05]) {
        for (const [cTag, cut] of [
          ['nocut', null],
          ['d2L4', { driftTrigger: 0.02, maxLossPerShare: 0.04 }],
          ['t15L5', { driftTrigger: 99, maxLossPerShare: 0.05, tauMax: 15 }],
        ]) {
          add(
            `late-${zTag}-t${eTau}_${sTau}-nk${maxNakedPx == null ? 'any' : String(maxNakedPx).slice(2)}-${cTag}`,
            {
              zoneLo,
              zoneHi,
              entryTau: eTau,
              stopQuoteTau: sTau,
              maxNakedPx,
              cut,
              maxSets: 3,
              maxCuts: 2,
              staticQuotes: true,
            },
          );
        }
      }
    }
  }
  // DEEP PAIR + EXECUTABLE CUT.
  // A pair resting b ticks below each touch pays 0.01 + 0.002b if both legs
  // fill (11c at b=50), which finally makes a 1.75c taker correction affordable.
  // Earlier runs never realised this because maxLossPerShare was 5c while the
  // actual naked loss was already 11c, so the cut was BLOCKED and the position
  // rode to a ~42c settlement loss. Here the ceiling is raised until the cut can
  // actually execute.
  for (const backoffTicks of [10, 20, 30, 50]) {
    for (const driftTrigger of [0.02, 0.04, 0.06]) {
      for (const maxLossPerShare of [0.05, 0.1, 0.15, 0.25]) {
        for (const tauMax of [null, 60]) {
          add(
            `dpair${backoffTicks}-d${String(driftTrigger).slice(2)}-L${String(maxLossPerShare).slice(2)}${tauMax ? `-t${tauMax}` : ''}`,
            {
              ...core,
              quoteMode: 'backoff',
              backoffTicks,
              staticQuotes: true,
              maxSets: 3,
              maxCuts: 2,
              cut: {
                driftTrigger,
                maxLossPerShare,
                ...(tauMax ? { tauMax } : {}),
              },
            },
          );
        }
      }
    }
  }
  // WIDE-BOOK GATE.
  // The pair spread is 2c in 95% of ticks, but it widens: on day 29 the bid sum
  // was <=0.98 in ~2.6% of ticks and reached 0.95. A passive pair pays
  // (1 - bidSum), so quoting ONLY when the book is wide raises the prize from 1c
  // to 3-5c, which is the only way a 1.75c correction becomes affordable without
  // relying on oscillation. Rare, but the payoff scales exactly with the gate.
  for (const openPairSumMax of [0.99, 0.98, 0.97, 0.96, 0.95]) {
    for (const [cTag, cut] of [
      ['nocut', null],
      ['d2L10', { driftTrigger: 0.02, maxLossPerShare: 0.1 }],
      ['d4L15', { driftTrigger: 0.04, maxLossPerShare: 0.15 }],
      ['t60L15', { driftTrigger: 99, maxLossPerShare: 0.15, tauMax: 60 }],
    ]) {
      for (const maxSets of [1, 5]) {
        add(
          `wide${String(openPairSumMax).slice(2)}-${cTag}-s${maxSets}`,
          {
            ...core,
            openPairSumMax,
            staticQuotes: true,
            cut,
            maxSets,
            maxCuts: 2,
          },
        );
      }
    }
  }
  // churn cap on the flagship cut rule
  for (const maxCuts of [1, 2, 3, 5]) {
    add(`maxCuts${maxCuts}`, {
      ...core,
      cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
      maxCuts,
    });
  }
  for (const slackTicks of [0, 1, 2, 5]) {
    add(`slack${slackTicks}`, {
      ...core,
      slackTicks,
      cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
    });
  }
  for (const quoteMode of ['join', 'improve', 'backoff']) {
    for (const n of [1, 2, 3]) {
      add(`${quoteMode}${n}`, {
        ...core,
        quoteMode,
        improveTicks: n,
        backoffTicks: n,
        cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
      });
    }
  }
  for (const maxPairSum of [0.999, 0.995, 0.99, 0.985, 0.98]) {
    for (const chase of [false, true]) {
      add(`pairSum${String(maxPairSum).slice(2)}-chase${chase ? 1 : 0}`, {
        ...core,
        maxPairSum,
        chase,
        cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
      });
    }
  }
  for (const openPairSumMax of [null, 0.99, 0.985, 0.98]) {
    add(`openSum${openPairSumMax == null ? 'any' : String(openPairSumMax).slice(2)}`, {
      ...core,
      openPairSumMax,
      cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
    });
  }
  for (const skew of [true, false]) {
    for (const maxImbalance of [1, 2, 3]) {
      add(`skew${skew ? 1 : 0}-imb${maxImbalance}`, {
        ...core,
        skew,
        maxImbalance,
        cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
      });
    }
  }
  for (const maxSets of [1, 2, 3, 5]) {
    add(`sets${maxSets}`, {
      ...core,
      maxSets,
      cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
    });
  }
  for (const stopQuoteTau of [15, 30, 60, 90]) {
    add(`stopQ${stopQuoteTau}`, {
      ...core,
      stopQuoteTau,
      cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
    });
  }
  for (const entryTau of [290, 280, 240, 200, 150, 100, 60]) {
    add(`entry${entryTau}`, {
      ...core,
      entryTau,
      cut: { driftTrigger: 0.03, maxLossPerShare: 0.05 },
    });
  }
  // stopAfterCut: one strike and the event is over
  for (const d of [0.02, 0.03, 0.05]) {
    add(`oneStrike-d${String(d).slice(2)}`, {
      ...core,
      cut: {
        driftTrigger: d,
        maxLossPerShare: d + 0.02,
        stopAfterCut: true,
      },
    });
  }
  return out;
}

async function main() {
  const days = listDays();
  if (!days.length) throw new Error(`no lake days in ${FROM}..${TO}`);
  const ONLY = arg('only', null);
  let base = buildGrid();
  if (ONLY) {
    const re = new RegExp(ONLY);
    base = base.filter((v) => re.test(v.id));
    if (!base.length) throw new Error(`--only=${ONLY} matched no variants`);
  }
  // duplicate the whole grid under both fee hypotheses
  const variants = [];
  for (const feeRate of [0, FEE_RATE]) {
    for (const v of base) {
      variants.push({
        ...v,
        makerFeeRate: feeRate,
        id: `${v.id}|mf${feeRate === 0 ? '0' : '7'}`,
      });
    }
  }
  console.log(
    `=== mm grid === days=${days.length} ${FROM}..${TO} variants=${variants.length}`,
  );

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  const results = new Map(variants.map((v) => [v.id, []]));
  const byDay = new Map(variants.map((v) => [v.id, new Map()]));
  let nEvents = 0;
  let canonicalEvents = 0;
  let proxyFallbackEvents = 0;

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    const dayDir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dayDir)
      .filter((n) => n.endsWith('.parquet'))
      .map((n) => path.join(dayDir, n));
    if (!files.length) continue;
    const parquet = `[${files.map((f) => quotedString(f)).join(',')}]`;
    const rows = (
      await c.runAndReadAll(`
      SELECT condition_id,
        epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS ev,
        extract(epoch FROM (
          try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
        ))::DOUBLE AS tau,
        up_best_bid, up_best_ask, down_best_bid, down_best_ask,
        underlying_price, price_to_beat
      FROM read_parquet(${parquet})
      WHERE coverage >= 0.99 AND coalesce(degraded, false) = false
        AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
        AND up_best_bid IS NOT NULL AND down_best_bid IS NOT NULL
        AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
      QUALIFY row_number() OVER (
        PARTITION BY condition_id, event_start, ts ORDER BY coverage DESC) = 1
      ORDER BY condition_id, ev, tau DESC
    `)
    ).getRowObjectsJS();

    let key = null;
    let conditionId = null;
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      if (buf[0].tau < 240 || buf[buf.length - 1].tau > 15) return;
      const last = buf[buf.length - 1];
      const canonicalWinner = CANONICAL_WINNERS.get(conditionId);
      const winner = canonicalWinner ??
        (last.spot > last.ptb ? 'UP' : last.spot < last.ptb ? 'DOWN' : null);
      if (!winner) return;
      if (canonicalWinner) canonicalEvents += 1;
      else proxyFallbackEvents += 1;
      nEvents += 1;
      for (const v of variants) {
        const res = runEvent(buf, v, winner);
        results.get(v.id).push(res);
        const m = byDay.get(v.id);
        if (!m.has(day)) m.set(day, []);
        m.get(day).push(res.pnl);
      }
    };
    for (const row of rows) {
      const k = `${row.condition_id}:${row.ev}`;
      if (key != null && k !== key) {
        flush();
        buf = [];
      }
      key = k;
      conditionId = String(row.condition_id);
      buf.push({
        tau: Number(row.tau),
        upBid: Number(row.up_best_bid),
        upAsk: Number(row.up_best_ask),
        downBid: Number(row.down_best_bid),
        downAsk: Number(row.down_best_ask),
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
      });
    }
    flush();
    if (di === 0 || di === days.length - 1 || (di + 1) % 10 === 0) {
      console.log(`[${di + 1}/${days.length}] ${day} events=${nEvents}`);
    }
  }

  const reports = variants.map((v) => {
    const s = summarize(results.get(v.id));
    const [lo, hi] = clusterBootstrap(byDay.get(v.id));
    return {
      id: v.id,
      makerFeeRate: v.makerFeeRate,
      params: v,
      ...s,
      evLo95: lo,
      evHi95: hi,
      significantPositive: lo != null && lo > 0,
    };
  });
  reports.sort((a, b) => (b.pnlPerEvent ?? -9) - (a.pnlPerEvent ?? -9));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        window: { FROM, TO, days: days.length },
        nEvents,
        settlement: {
          winnerCsv: fs.existsSync(WINNER_CSV)
            ? path.relative(ROOT, WINNER_CSV).replaceAll('\\', '/')
            : null,
          canonicalEvents,
          proxyFallbackEvents,
        },
        reports,
      },
      null,
      2,
    ),
  );

  const show = (list, title) => {
    console.log(`\n=== ${title} ===`);
    console.log(
      'variant'.padEnd(30),
      'eng%'.padEnd(6),
      'sets'.padEnd(6),
      'res%'.padEnd(6),
      'cuts'.padEnd(6),
      'PnL/ev'.padEnd(9),
      'lo95'.padEnd(9),
      'hi95'.padEnd(9),
      'PF'.padEnd(7),
      'win%'.padEnd(6),
      'worst',
    );
    for (const r of list) {
      console.log(
        r.id.padEnd(30),
        String(r.engagedPct ?? '-').padEnd(6),
        String(r.setsTotal ?? '-').padEnd(6),
        String(r.residualPct ?? '-').padEnd(6),
        String(r.cuts ?? '-').padEnd(6),
        String(r.pnlPerEvent ?? '-').padEnd(9),
        String(r.evLo95 ?? '-').padEnd(9),
        String(r.evHi95 ?? '-').padEnd(9),
        String(r.profitFactor ?? '-').padEnd(7),
        String(r.winRatePct ?? '-').padEnd(6),
        String(r.worst ?? '-'),
        r.significantPositive ? ' ***' : '',
      );
    }
  };

  console.log(`\nevents=${nEvents}`);
  show(
    reports.filter((r) => r.makerFeeRate === 0).slice(0, TOP),
    `TOP ${TOP} — maker fee EXEMPT (documented rule)`,
  );
  show(
    reports.filter((r) => r.makerFeeRate > 0).slice(0, TOP),
    `TOP ${TOP} — maker fee CHARGED (pessimistic floor)`,
  );

  const pos0 = reports.filter((r) => r.makerFeeRate === 0 && r.pnlPerEvent > 0);
  const pos7 = reports.filter((r) => r.makerFeeRate > 0 && r.pnlPerEvent > 0);
  const sig0 = reports.filter((r) => r.makerFeeRate === 0 && r.significantPositive);
  const sig7 = reports.filter((r) => r.makerFeeRate > 0 && r.significantPositive);
  console.log(
    `\npositive: exempt=${pos0.length}/${base.length}` +
      ` charged=${pos7.length}/${base.length}`,
  );
  console.log(
    `significant positive (day-clustered): exempt=${sig0.length}` +
      ` charged=${sig7.length}`,
  );
  console.log('\nsaved', path.join(OUT_DIR, 'report.json'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
