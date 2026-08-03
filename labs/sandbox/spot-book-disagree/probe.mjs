/**
 * Spot×book disagreement (SBD) probe — incidência + EV follow-book vs follow-spot.
 *
 * Tese: quando spotLeader !== bookFavorite perto do fim, o book antecipa o flip.
 * Controle: comprar spotLeader (lado barato das screenshots).
 *
 *   node labs/sandbox/spot-book-disagree/probe.mjs
 *   node labs/sandbox/spot-book-disagree/probe.mjs --from=2026-07-20 --to=2026-07-31 --trainEnd=2026-07-25
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
const OUT_DIR = path.join(ROOT, '.tmp/spot-book-disagree');
const FEE_RATE = 0.07;
const BUDGET = 10;
const SETTLE = 0.995;

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-31');
const TRAIN_END = arg('trainEnd', '2026-06-30');
const MIN_TAU = Number(arg('minTau', '10')) || 10;
const MAX_TAU = Number(arg('maxTau', '40')) || 40;
const MIN_BOOK_EDGE = Number(arg('minBookEdge', '0.05')) || 0.05;
const MAX_DIST = Number(arg('maxDist', '15')) || 15;
const MAX_SPREAD = Number(arg('maxSpread', '0.04')) || 0.04;
const MIN_ODDS = Number(arg('minOddsSum', '0.96')) || 0.96;
const MAX_ODDS = Number(arg('maxOddsSum', '1.06')) || 1.06;

function r4(x) {
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null;
}
function r2(x) {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}
function r3(x) {
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
}

function feeEst(price, shares) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return FEE_RATE * p * (1 - p) * shares;
}

function takerPnl(side, ask, winner) {
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return null;
  const shares = BUDGET / ask;
  const fee = feeEst(ask, shares);
  const payout = side === winner ? shares * SETTLE : 0;
  return payout - BUDGET - fee;
}

function bootstrapDays(byDay, iterations = 2000) {
  const keys = [...byDay.keys()];
  if (keys.length < 5) return [null, null];
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const arr = byDay.get(keys[(Math.random() * keys.length) | 0]);
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

function profitFactor(pnls) {
  let gp = 0;
  let gl = 0;
  for (const x of pnls) {
    if (x > 0) gp += x;
    else if (x < 0) gl += -x;
  }
  if (gl <= 0) return gp > 0 ? Infinity : null;
  return gp / gl;
}

function distBucket(dist) {
  if (dist <= 2) return '0-2';
  if (dist <= 5) return '2-5';
  if (dist <= 10) return '5-10';
  if (dist <= 15) return '10-15';
  return '>15';
}

function favAskBucket(ask) {
  if (ask < 0.55) return '<0.55';
  if (ask < 0.6) return '0.55-0.60';
  if (ask < 0.7) return '0.60-0.70';
  if (ask < 0.8) return '0.70-0.80';
  return '>=0.80';
}

/** Gates SBD — retorna snapshot ou null. */
export function evalSbd(tick, gates = {}) {
  const minTau = gates.minTau ?? MIN_TAU;
  const maxTau = gates.maxTau ?? MAX_TAU;
  const minBookEdge = gates.minBookEdge ?? MIN_BOOK_EDGE;
  const maxDist = gates.maxDist ?? MAX_DIST;
  const maxSpread = gates.maxSpread ?? MAX_SPREAD;
  const minOdds = gates.minOddsSum ?? MIN_ODDS;
  const maxOdds = gates.maxOddsSum ?? MAX_ODDS;

  const { tau, spot, ptb, upAsk, downAsk, upBid, downBid } = tick;
  if (!(tau >= minTau && tau <= maxTau)) return null;
  if (![spot, ptb, upAsk, downAsk].every(Number.isFinite)) return null;
  if (spot === ptb) return null;

  const spotLeader = spot >= ptb ? 'UP' : 'DOWN';
  const bookFavorite = upAsk >= downAsk ? 'UP' : 'DOWN';
  if (spotLeader === bookFavorite) return null;

  const dist = Math.abs(spot - ptb);
  if (dist > maxDist) return null;

  const bookFavAsk = bookFavorite === 'UP' ? upAsk : downAsk;
  const spotAsk = spotLeader === 'UP' ? upAsk : downAsk;
  const bookFavBid = bookFavorite === 'UP' ? upBid : downBid;
  const bookEdge = bookFavAsk - spotAsk;
  if (!(bookEdge >= minBookEdge)) return null;

  const oddsSum = upAsk + downAsk;
  if (oddsSum < minOdds || oddsSum > maxOdds) return null;
  if (!Number.isFinite(bookFavBid) || bookFavAsk - bookFavBid > maxSpread) return null;

  return {
    spotLeader,
    bookFavorite,
    dist,
    bookEdge,
    bookFavAsk,
    spotAsk,
    tau,
    oddsSum,
  };
}

function emptyLeg() {
  return {
    byDay: new Map(),
    n: 0,
    wins: 0,
    pnlSum: 0,
    pnls: [],
  };
}

function pushLeg(leg, day, pnl, won) {
  leg.n += 1;
  if (won) leg.wins += 1;
  leg.pnlSum += pnl;
  leg.pnls.push(pnl);
  if (!leg.byDay.has(day)) leg.byDay.set(day, []);
  leg.byDay.get(day).push(pnl);
}

function legStats(leg) {
  const pf = profitFactor(leg.pnls);
  const [lo, hi] = bootstrapDays(leg.byDay);
  return {
    n: leg.n,
    wins: leg.wins,
    winPct: leg.n ? r2((leg.wins / leg.n) * 100) : null,
    pnlTotal: r4(leg.pnlSum),
    pnlPerTrade: leg.n ? r4(leg.pnlSum / leg.n) : null,
    pf: pf == null ? null : pf === Infinity ? 999 : r3(pf),
    evLo95: lo,
    evHi95: hi,
  };
}

function bumpBucket(map, key, who, pnlBook, pnlSpot) {
  if (!map.has(key)) {
    map.set(key, {
      n: 0,
      bookWins: 0,
      spotWins: 0,
      pnlBook: 0,
      pnlSpot: 0,
    });
  }
  const b = map.get(key);
  b.n += 1;
  if (who === 'book') b.bookWins += 1;
  if (who === 'spot') b.spotWins += 1;
  b.pnlBook += pnlBook;
  b.pnlSpot += pnlSpot;
}

async function main() {
  const days = listDays();
  console.log(`=== SBD probe === days=${days.length} ${FROM}..${TO}`);
  console.log(`train <= ${TRAIN_END} | holdout > ${TRAIN_END}`);
  console.log(
    `gates tau=${MIN_TAU}-${MAX_TAU} maxDist=${MAX_DIST} minBookEdge=${MIN_BOOK_EDGE}` +
      ` odds=${MIN_ODDS}-${MAX_ODDS} spread<=${MAX_SPREAD} budget=$${BUDGET}`,
  );

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run('SET threads TO 6');

  const splits = {
    train: { events: 0, sbdEvents: 0, book: emptyLeg(), spot: emptyLeg() },
    holdout: { events: 0, sbdEvents: 0, book: emptyLeg(), spot: emptyLeg() },
    all: { events: 0, sbdEvents: 0, book: emptyLeg(), spot: emptyLeg() },
  };
  const byDist = new Map();
  const byFavAsk = new Map();
  const fixedTauHits = { 40: 0, 30: 0, 20: 0, 10: 0 };
  let fixedTauEvents = 0;

  // Variante invertida (screenshot): comprar spotLeader barato quando bookFav caro
  const refined = {
    train: emptyLeg(),
    holdout: emptyLeg(),
    all: emptyLeg(),
    maxSpotAsk: 0.4,
    minBookFavAsk: 0.6,
  };

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    const splitName = day <= TRAIN_END ? 'train' : 'holdout';
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
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      // Exige cobertura razoável do fim do evento
      if (buf[0].tau < 60 || buf[buf.length - 1].tau > 15) return;

      const last = buf[buf.length - 1];
      const winner =
        last.spot > last.ptb ? 'UP' : last.spot < last.ptb ? 'DOWN' : null;
      if (!winner) return;

      splits[splitName].events += 1;
      splits.all.events += 1;
      fixedTauEvents += 1;

      for (const target of [40, 30, 20, 10]) {
        let best = null;
        let bestD = Infinity;
        for (const t of buf) {
          const d = Math.abs(t.tau - target);
          if (d < bestD && d <= 2.5) {
            bestD = d;
            best = t;
          }
        }
        if (best && evalSbd(best)) fixedTauHits[target] += 1;
      }

      // Primeiro tick (maior tau na janela, ordem DESC) que passa gates
      let hit = null;
      for (const t of buf) {
        const s = evalSbd(t);
        if (s) {
          hit = { ...s, tick: t };
          break;
        }
      }
      if (!hit) return;

      splits[splitName].sbdEvents += 1;
      splits.all.sbdEvents += 1;

      const pnlBook = takerPnl(hit.bookFavorite, hit.bookFavAsk, winner);
      const pnlSpot = takerPnl(hit.spotLeader, hit.spotAsk, winner);
      if (pnlBook == null || pnlSpot == null) return;

      const bookWon = hit.bookFavorite === winner;
      const spotWon = hit.spotLeader === winner;

      pushLeg(splits[splitName].book, day, pnlBook, bookWon);
      pushLeg(splits[splitName].spot, day, pnlSpot, spotWon);
      pushLeg(splits.all.book, day, pnlBook, bookWon);
      pushLeg(splits.all.spot, day, pnlSpot, spotWon);

      if (
        hit.spotAsk <= refined.maxSpotAsk &&
        hit.bookFavAsk >= refined.minBookFavAsk
      ) {
        pushLeg(refined[splitName], day, pnlSpot, spotWon);
        pushLeg(refined.all, day, pnlSpot, spotWon);
      }

      const who = bookWon ? 'book' : spotWon ? 'spot' : null;
      bumpBucket(byDist, distBucket(hit.dist), who, pnlBook, pnlSpot);
      bumpBucket(byFavAsk, favAskBucket(hit.bookFavAsk), who, pnlBook, pnlSpot);
    };

    for (const row of rows) {
      const k = `${row.condition_id}:${row.ev}`;
      if (key != null && k !== key) {
        flush();
        buf = [];
      }
      key = k;
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

    if (di === 0 || di === days.length - 1 || (di + 1) % 15 === 0) {
      console.log(
        `[${di + 1}/${days.length}] ${day} events=${splits.all.events} sbd=${splits.all.sbdEvents}`,
      );
    }
  }

  function summarizeSplit(name, s) {
    return {
      events: s.events,
      sbdEvents: s.sbdEvents,
      incidencePct: s.events ? r2((s.sbdEvents / s.events) * 100) : null,
      followBook: legStats(s.book),
      followSpot: legStats(s.spot),
      bookWinGivenSbdPct: s.book.n
        ? r2((s.book.wins / s.book.n) * 100)
        : null,
      spotWinGivenSbdPct: s.spot.n
        ? r2((s.spot.wins / s.spot.n) * 100)
        : null,
    };
  }

  const train = summarizeSplit('train', splits.train);
  const holdout = summarizeSplit('holdout', splits.holdout);
  const all = summarizeSplit('all', splits.all);

  const bookPfHo = holdout.followBook.pf;
  const spotPfHo = holdout.followSpot.pf;
  const goBook =
    holdout.followBook.n >= 20 &&
    bookPfHo != null &&
    bookPfHo >= 1.15 &&
    (spotPfHo == null || bookPfHo > spotPfHo);

  const refinedTrain = legStats(refined.train);
  const refinedHoldout = legStats(refined.holdout);
  const refinedAll = legStats(refined.all);
  const goSpotCheap =
    refinedHoldout.n >= 20 &&
    refinedHoldout.pf != null &&
    refinedHoldout.pf >= 1.15;

  // GO primário = follow-book (plano). GO invertido = follow-spot barato (screenshot).
  const go = goBook || goSpotCheap;
  const goMode = goBook ? 'follow-book' : goSpotCheap ? 'follow-spot-cheap' : null;

  const buckets = {
    byDist: [...byDist.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => ({
        bucket: k,
        n: v.n,
        bookWinPct: r2((v.bookWins / v.n) * 100),
        pnlBook: r4(v.pnlBook),
        pnlSpot: r4(v.pnlSpot),
      })),
    byFavAsk: [...byFavAsk.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => ({
        bucket: k,
        n: v.n,
        bookWinPct: r2((v.bookWins / v.n) * 100),
        pnlBook: r4(v.pnlBook),
        pnlSpot: r4(v.pnlSpot),
      })),
    fixedTauIncidencePct: Object.fromEntries(
      Object.entries(fixedTauHits).map(([t, n]) => [
        t,
        fixedTauEvents ? r2((n / fixedTauEvents) * 100) : null,
      ]),
    ),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    window: { FROM, TO, TRAIN_END },
    gates: {
      minTau: MIN_TAU,
      maxTau: MAX_TAU,
      maxDist: MAX_DIST,
      minBookEdge: MIN_BOOK_EDGE,
      minOddsSum: MIN_ODDS,
      maxOddsSum: MAX_ODDS,
      maxSpread: MAX_SPREAD,
      budget: BUDGET,
      settle: SETTLE,
      feeRate: FEE_RATE,
    },
    train,
    holdout,
    all,
    buckets,
    refinedFollowSpot: {
      gates: {
        maxSpotAsk: refined.maxSpotAsk,
        minBookFavAsk: refined.minBookFavAsk,
      },
      train: refinedTrain,
      holdout: refinedHoldout,
      all: refinedAll,
    },
    goDecision: {
      go,
      mode: goMode,
      goBook,
      goSpotCheap,
      reason: goBook
        ? `follow-book holdout PF=${bookPfHo} >= 1.15 and beats follow-spot PF=${spotPfHo}`
        : goSpotCheap
          ? `INVERTED GO: follow-spot-cheap holdout PF=${refinedHoldout.pf} n=${refinedHoldout.n} (spotAsk<=${refined.maxSpotAsk}, bookFavAsk>=${refined.minBookFavAsk}); follow-book PF=${bookPfHo}`
          : `NO-GO: bookPfHo=${bookPfHo} spotPfHo=${spotPfHo} refinedSpotPfHo=${refinedHoldout.pf} n=${refinedHoldout.n}`,
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const line = (label, s) => {
    console.log(`\n--- ${label} ---`);
    console.log(
      `events=${s.events} sbd=${s.sbdEvents} incidence=${s.incidencePct}%` +
        ` P(bookWins|SBD)=${s.bookWinGivenSbdPct}% P(spotWins|SBD)=${s.spotWinGivenSbdPct}%`,
    );
    const b = s.followBook;
    const sp = s.followSpot;
    console.log(
      `follow-book  n=${b.n} WR=${b.winPct}% PnL=${b.pnlTotal} EV/trade=${b.pnlPerTrade} PF=${b.pf} CI95=[${b.evLo95},${b.evHi95}]`,
    );
    console.log(
      `follow-spot  n=${sp.n} WR=${sp.winPct}% PnL=${sp.pnlTotal} EV/trade=${sp.pnlPerTrade} PF=${sp.pf} CI95=[${sp.evLo95},${sp.evHi95}]`,
    );
  };

  line('TRAIN', train);
  line('HOLDOUT', holdout);
  line('ALL', all);

  console.log('\n=== buckets |dist| ===');
  for (const b of buckets.byDist) {
    console.log(
      `  ${b.bucket.padEnd(6)} n=${b.n} bookWin%=${b.bookWinPct} pnlBook=${b.pnlBook} pnlSpot=${b.pnlSpot}`,
    );
  }
  console.log('=== buckets bookFavAsk ===');
  for (const b of buckets.byFavAsk) {
    console.log(
      `  ${b.bucket.padEnd(10)} n=${b.n} bookWin%=${b.bookWinPct} pnlBook=${b.pnlBook} pnlSpot=${b.pnlSpot}`,
    );
  }
  console.log(
    `\nfixed-tau SBD incidence %: ${JSON.stringify(buckets.fixedTauIncidencePct)}`,
  );
  console.log('\n=== refined follow-spot (spotAsk<=0.40, bookFavAsk>=0.60) ===');
  console.log(
    `train  n=${refinedTrain.n} WR=${refinedTrain.winPct}% PnL=${refinedTrain.pnlTotal} PF=${refinedTrain.pf}`,
  );
  console.log(
    `holdout n=${refinedHoldout.n} WR=${refinedHoldout.winPct}% PnL=${refinedHoldout.pnlTotal} PF=${refinedHoldout.pf}`,
  );
  console.log(
    `all    n=${refinedAll.n} WR=${refinedAll.winPct}% PnL=${refinedAll.pnlTotal} PF=${refinedAll.pf}`,
  );
  console.log(`\n*** GO=${go} mode=${goMode} — ${report.goDecision.reason}`);
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
