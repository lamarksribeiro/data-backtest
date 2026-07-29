/**
 * Market baliza live — zero ordens (só leitura pública Polymarket).
 *
 * Mede no book real BTC Up/Down 5m:
 *   - gap no cruzamento de níveis SUB/DESC
 *   - executabilidade taker_limit com cap +0/+1/+2¢
 *   - maker DESC resting (fill por atravessamento + timeout)
 *   - janela de equalização (residual hipotético barato)
 *   - latência de poll do book
 *   - path whip (avgSum projetado se comprasse no nível)
 *
 * Usage:
 *   node labs/sandbox/poly-market-baliza-live.mjs
 *   node labs/sandbox/poly-market-baliza-live.mjs --full-event
 *   node labs/sandbox/poly-market-baliza-live.mjs --events 10 --full-event --label series1
 *   node labs/sandbox/poly-market-baliza-live.mjs --seconds 180 --poll-ms 250
 *
 * Output:
 *   .tmp/poly-baliza/<series>/events/<slug>/  (summary.json, crosses.jsonl, ticks.jsonl)
 *   .tmp/poly-baliza/<series>/aggregate.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function hasFlag(f) {
  return args.includes(f);
}
function argVal(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
}

const FULL_EVENT = hasFlag('--full-event') || Number(argVal('events', '1')) > 1;
const EVENTS = Math.max(1, Number(argVal('events', '1')) || 1);
const SECONDS = Math.max(30, Number(argVal('seconds', FULL_EVENT ? '320' : '180')) || 180);
const POLL_MS = Math.max(100, Number(argVal('poll-ms', '250')) || 250);
const LABEL = String(argVal('label', 'baliza'));
const MAKER_TIMEOUT_SEC = Math.max(5, Number(argVal('maker-timeout', '45')) || 45);
const MIN_TAU_START = Math.max(0, Number(argVal('min-tau', '40')) || 40);
const BETWEEN_EVENTS_MS = Math.max(0, Number(argVal('between-ms', '3000')) || 3000);

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const SUB_LEVELS_C = [55, 60, 65, 70, 75, 80, 85, 90];
const DESC_LEVELS_C = [45, 40, 35, 30, 25, 20, 15, 10];
const CAPS_C = [0, 1, 2, 3];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_ROOT = process.env.BALIZA_OUT || path.join(ROOT, '.tmp/poly-baliza');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function clamp01(x) {
  return Math.min(0.99, Math.max(0.01, x));
}

function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    p50: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    max: s[s.length - 1],
    mean: Math.round((sum / s.length) * 100) / 100,
  };
}

async function fetchJson(url, timeoutMs = 12000) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'poly-market-baliza/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (!res.ok) return { ok: false, status: res.status, ms, data: null, err: `http ${res.status}` };
    const data = await res.json();
    return { ok: true, status: res.status, ms, data, err: null };
  } catch (e) {
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    return { ok: false, status: 0, ms, data: null, err: String(e?.message || e) };
  }
}

function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}

function currentSlug(nowSec = Math.floor(Date.now() / 1000)) {
  const start = nowSec - (nowSec % 300);
  return `btc-updown-5m-${start}`;
}

function parseTokenIds(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function bestAsk(book) {
  const asks = book?.asks || book?.sell || [];
  if (!asks.length) return null;
  let best = null;
  for (const level of asks) {
    const p = Number(level.price ?? level[0]);
    if (!Number.isFinite(p)) continue;
    if (best == null || p < best) best = p;
  }
  return best != null ? clamp01(best) : null;
}

function bestBid(book) {
  const bids = book?.bids || book?.buy || [];
  if (!bids.length) return null;
  let best = null;
  for (const level of bids) {
    const p = Number(level.price ?? level[0]);
    if (!Number.isFinite(p)) continue;
    if (best == null || p > best) best = p;
  }
  return best != null ? clamp01(best) : null;
}

async function resolveMarket(slug) {
  const r = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (!r.ok) throw new Error(`gamma events: ${r.err}`);
  const event = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!event) throw new Error(`event not found: ${slug}`);
  const markets = event.markets || [];
  const m = Array.isArray(markets) ? markets[0] : markets;
  if (!m) throw new Error(`no market on ${slug}`);
  const tokens = parseTokenIds(m.clobTokenIds || m.clob_token_ids);
  if (tokens.length < 2) throw new Error(`need 2 tokens, got ${tokens.length}`);
  // Polymarket BTC updown: usually [UP, DOWN]
  return {
    slug,
    eventStart: eventStartFromSlug(slug),
    conditionId: m.conditionId || m.condition_id || null,
    tokens: { UP: tokens[0], DOWN: tokens[1] },
    resolveMs: r.ms,
  };
}

async function fetchSideBook(tokenId) {
  const r = await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!r.ok) return { ask: null, bid: null, ms: r.ms, err: r.err };
  return {
    ask: bestAsk(r.data),
    bid: bestBid(r.data),
    ms: r.ms,
    err: null,
  };
}

function makeArmed() {
  const o = { UP: {}, DOWN: {} };
  for (const side of ['UP', 'DOWN']) {
    for (const c of SUB_LEVELS_C) o[side][`SUB:${c}`] = true;
    for (const c of DESC_LEVELS_C) o[side][`DESC:${c}`] = true;
  }
  return o;
}

function createSession(market) {
  return {
    market,
    startedAt: nowIso(),
    armed: makeArmed(),
    prevAsk: { UP: null, DOWN: null },
    crosses: [],
    resting: [], // {side, levelC, limit, placedTs, placedAsk, status, fillTs?, fillAsk?}
    ticks: 0,
    bookLatencies: [],
    eqSamples: [],
    path: {
      // hypothetical inventory if we filled every cross at ask (no cap miss)
      shares: { UP: 0, DOWN: 0 },
      cost: { UP: 0, DOWN: 0 },
      fills: 0,
    },
    pathCapped1: {
      shares: { UP: 0, DOWN: 0 },
      cost: { UP: 0, DOWN: 0 },
      fills: 0,
      misses: 0,
    },
  };
}

function avgOf(path, side) {
  return path.shares[side] > 0 ? path.cost[side] / path.shares[side] : null;
}

function avgSum(path) {
  const a = avgOf(path, 'UP');
  const b = avgOf(path, 'DOWN');
  if (a == null || b == null) return null;
  return a + b;
}

function buyHypo(path, side, px, sh = 5) {
  path.shares[side] += sh;
  path.cost[side] += sh * px;
  path.fills += 1;
}

function processCrosses(session, side, prevAsk, currAsk, ts, tau) {
  if (prevAsk == null || currAsk == null) return;

  // SUB: prev < L <= curr  (crossing up through level)
  for (const levelC of SUB_LEVELS_C) {
    const key = `SUB:${levelC}`;
    if (!session.armed[side][key]) continue;
    const L = levelC / 100;
    if (!(prevAsk < L - 1e-12 && currAsk + 1e-12 >= L)) continue;

    session.armed[side][key] = false;
    // re-arm pair DESC same idx-ish by price mirror not needed for baliza;
    // re-arm complementary DESC level for oscillation measurement
    const descC = 100 - levelC; // 55→45, 60→40...
    if (DESC_LEVELS_C.includes(descC)) session.armed[side][`DESC:${descC}`] = true;

    const gapC = Math.round((currAsk - L) * 1000) / 10; // cents, 1 decimal
    const exec = {};
    for (const cap of CAPS_C) {
      exec[`cap${cap}`] = gapC <= cap + 1e-9;
    }

    const cross = {
      ts,
      tau,
      side,
      tipo: 'SUB',
      levelC,
      prevAsk: Math.round(prevAsk * 1000) / 1000,
      ask: Math.round(currAsk * 1000) / 1000,
      gapC,
      exec,
    };
    session.crosses.push(cross);

    // hypo paths
    buyHypo(session.path, side, currAsk, 5);
    if (exec.cap1) buyHypo(session.pathCapped1, side, Math.min(currAsk, L + 0.01), 5);
    else session.pathCapped1.misses += 1;

    // post resting DESC maker at complementary level when SUB fires (baliza hedge)
    if (DESC_LEVELS_C.includes(descC)) {
      const limit = descC / 100;
      session.resting.push({
        side,
        levelC: descC,
        limit,
        placedTs: ts,
        placedAsk: currAsk,
        status: 'open',
        fillTs: null,
        fillAsk: null,
        ageAtFillSec: null,
      });
    }
  }

  // DESC: prev > L >= curr (crossing down)
  for (const levelC of DESC_LEVELS_C) {
    const key = `DESC:${levelC}`;
    if (!session.armed[side][key]) continue;
    const L = levelC / 100;
    if (!(prevAsk > L + 1e-12 && currAsk - 1e-12 <= L)) continue;

    session.armed[side][key] = false;
    const subC = 100 - levelC;
    if (SUB_LEVELS_C.includes(subC)) session.armed[side][`SUB:${subC}`] = true;

    const gapC = Math.round((L - currAsk) * 1000) / 10; // how far through
    const cross = {
      ts,
      tau,
      side,
      tipo: 'DESC',
      levelC,
      prevAsk: Math.round(prevAsk * 1000) / 1000,
      ask: Math.round(currAsk * 1000) / 1000,
      gapC,
      exec: { through: true },
    };
    session.crosses.push(cross);
    buyHypo(session.path, side, currAsk, 3);
    buyHypo(session.pathCapped1, side, currAsk, 3);
  }
}

function processResting(session, side, prevAsk, currAsk, ts) {
  for (const order of session.resting) {
    if (order.side !== side || order.status !== 'open') continue;
    const placedMs = Date.parse(order.placedTs);
    const ageSec = (Date.parse(ts) - placedMs) / 1000;
    if (ageSec > MAKER_TIMEOUT_SEC) {
      order.status = 'timeout';
      order.ageAtFillSec = Math.round(ageSec * 10) / 10;
      continue;
    }
    // fill if ask crosses down through limit (resting buy)
    const thr = order.limit - 0.01;
    if (prevAsk != null && currAsk != null && prevAsk > thr + 1e-12 && currAsk <= thr + 1e-12) {
      order.status = 'filled';
      order.fillTs = ts;
      order.fillAsk = currAsk;
      order.ageAtFillSec = Math.round(ageSec * 10) / 10;
    }
  }
}

function sampleEq(session, asks, ts, tau) {
  const shU = session.path.shares.UP;
  const shD = session.path.shares.DOWN;
  if (shU <= 0 && shD <= 0) return;
  const residualSide = shU === shD ? null : shU < shD ? 'UP' : 'DOWN';
  const residualSh = Math.abs(shU - shD);
  const cheapAsk = residualSide ? asks[residualSide] : Math.min(asks.UP ?? 1, asks.DOWN ?? 1);
  const sum = (asks.UP ?? 0) + (asks.DOWN ?? 0);
  session.eqSamples.push({
    ts,
    tau,
    residualSide,
    residualSh: Math.round(residualSh * 100) / 100,
    cheapAsk: cheapAsk != null ? Math.round(cheapAsk * 1000) / 1000 : null,
    eq5: residualSide != null && cheapAsk != null && cheapAsk <= 0.05,
    eq10: residualSide != null && cheapAsk != null && cheapAsk <= 0.1,
    eq15: residualSide != null && cheapAsk != null && cheapAsk <= 0.15,
    askSumC: Math.round(sum * 1000) / 10,
    avgSumPath: avgSum(session.path),
    avgSumCap1: avgSum(session.pathCapped1),
  });
}

function summarize(session, meta) {
  const sub = session.crosses.filter((c) => c.tipo === 'SUB');
  const desc = session.crosses.filter((c) => c.tipo === 'DESC');
  const gaps = sub.map((c) => c.gapC);
  const byLevel = {};
  for (const c of sub) {
    byLevel[c.levelC] = byLevel[c.levelC] || [];
    byLevel[c.levelC].push(c.gapC);
  }
  const execRates = {};
  for (const cap of CAPS_C) {
    const key = `cap${cap}`;
    const n = sub.length;
    const ok = sub.filter((c) => c.exec[key]).length;
    execRates[key] = n ? Math.round((1000 * ok) / n) / 10 : null;
  }

  const resting = session.resting;
  const filled = resting.filter((r) => r.status === 'filled');
  const timeout = resting.filter((r) => r.status === 'timeout');
  const open = resting.filter((r) => r.status === 'open');

  const eq = session.eqSamples;
  const eqRate = (flag) => {
    if (!eq.length) return null;
    return Math.round((1000 * eq.filter((e) => e[flag]).length) / eq.length) / 10;
  };

  const pathAvg = avgSum(session.path);
  const pathCap1Avg = avgSum(session.pathCapped1);

  return {
    meta,
    market: session.market,
    startedAt: session.startedAt,
    finishedAt: nowIso(),
    ticks: session.ticks,
    bookLatencyMs: stats(session.bookLatencies),
    crosses: {
      sub: sub.length,
      desc: desc.length,
      total: session.crosses.length,
    },
    gapSubCents: stats(gaps),
    gapByLevelC: Object.fromEntries(
      Object.entries(byLevel).map(([k, xs]) => [k, stats(xs)]),
    ),
    takerLimitExecPct: execRates,
    pctGapGt1: gaps.length ? Math.round((1000 * gaps.filter((g) => g > 1).length) / gaps.length) / 10 : null,
    pctGapGt2: gaps.length ? Math.round((1000 * gaps.filter((g) => g > 2).length) / gaps.length) / 10 : null,
    pctGapGt5: gaps.length ? Math.round((1000 * gaps.filter((g) => g > 5).length) / gaps.length) / 10 : null,
    makerDesc: {
      placed: resting.length,
      filled: filled.length,
      timeout: timeout.length,
      open: open.length,
      fillRatePct: resting.length ? Math.round((1000 * filled.length) / resting.length) / 10 : null,
      fillAgeSec: stats(filled.map((f) => f.ageAtFillSec).filter((x) => x != null)),
    },
    eqWindow: {
      samples: eq.length,
      pctEq5: eqRate('eq5'),
      pctEq10: eqRate('eq10'),
      pctEq15: eqRate('eq15'),
      anyEq5: eq.some((e) => e.eq5),
      anyEq10: eq.some((e) => e.eq10),
    },
    hypoPath: {
      shares: session.path.shares,
      cost: {
        UP: Math.round(session.path.cost.UP * 100) / 100,
        DOWN: Math.round(session.path.cost.DOWN * 100) / 100,
      },
      fills: session.path.fills,
      avgSum: pathAvg != null ? Math.round(pathAvg * 1000) / 1000 : null,
      residual: Math.round(Math.abs(session.path.shares.UP - session.path.shares.DOWN) * 100) / 100,
    },
    hypoPathCap1: {
      shares: session.pathCapped1.shares,
      cost: {
        UP: Math.round(session.pathCapped1.cost.UP * 100) / 100,
        DOWN: Math.round(session.pathCapped1.cost.DOWN * 100) / 100,
      },
      fills: session.pathCapped1.fills,
      misses: session.pathCapped1.misses,
      avgSum: pathCap1Avg != null ? Math.round(pathCap1Avg * 1000) / 1000 : null,
      residual: Math.round(Math.abs(session.pathCapped1.shares.UP - session.pathCapped1.shares.DOWN) * 100) / 100,
    },
    balizas: buildBalizasText({
      gaps,
      execRates,
      filled: filled.length,
      resting: resting.length,
      pathAvg,
      pathCap1Avg,
      eq,
      bookLat: stats(session.bookLatencies),
    }),
  };
}

function buildBalizasText(x) {
  const lines = [];
  const g = stats(x.gaps);
  if (g) {
    lines.push(
      `GAP_SUB: med=${g.p50}¢ p90=${g.p90}¢ mean=${g.mean}¢ (n=${g.n}) — taker no nível sem cap é caro se p50>0.`,
    );
  } else {
    lines.push('GAP_SUB: sem cruzamentos SUB neste trecho — prolongar amostragem.');
  }
  if (x.execRates.cap1 != null) {
    lines.push(
      `TAKER_LIMIT: exec cap0=${x.execRates.cap0}% cap1=${x.execRates.cap1}% cap2=${x.execRates.cap2}% cap3=${x.execRates.cap3}%.`,
    );
  }
  if (x.resting > 0) {
    const fr = Math.round((1000 * x.filled) / x.resting) / 10;
    lines.push(`MAKER_DESC: fill_rate=${fr}% (${x.filled}/${x.resting}) timeout/open no restante.`);
  } else {
    lines.push('MAKER_DESC: nenhum resting postado (sem SUB disparado).');
  }
  if (x.pathAvg != null) {
    lines.push(
      `PATH_HYPO avgSum=${x.pathAvg.toFixed(3)} | cap1 avgSum=${x.pathCap1Avg != null ? x.pathCap1Avg.toFixed(3) : 'n/a'} (>1 = par estruturalmente ruim).`,
    );
  }
  if (x.eq?.length) {
    const p5 = Math.round((1000 * x.eq.filter((e) => e.eq5).length) / x.eq.length) / 10;
    const p10 = Math.round((1000 * x.eq.filter((e) => e.eq10).length) / x.eq.length) / 10;
    lines.push(`EQ_WINDOW: samples com residual barato ≤5¢=${p5}% ≤10¢=${p10}%.`);
  }
  if (x.bookLat) {
    lines.push(`BOOK_RTT: p50=${x.bookLat.p50}ms p90=${x.bookLat.p90}ms (host dita viabilidade).`);
  }
  return lines;
}

function printSummary(summary) {
  console.log('');
  console.log('========== BALIZA SUMMARY ==========');
  console.log(`slug=${summary.market.slug}  ticks=${summary.ticks}`);
  console.log(`crosses SUB=${summary.crosses.sub} DESC=${summary.crosses.desc}`);
  if (summary.gapSubCents) {
    const g = summary.gapSubCents;
    console.log(`gap SUB ¢: n=${g.n} min=${g.min} p50=${g.p50} p90=${g.p90} max=${g.max} mean=${g.mean}`);
    console.log(`  %>1¢=${summary.pctGapGt1}  %>2¢=${summary.pctGapGt2}  %>5¢=${summary.pctGapGt5}`);
  }
  console.log('taker_limit exec%:', JSON.stringify(summary.takerLimitExecPct));
  console.log('maker DESC:', JSON.stringify(summary.makerDesc));
  console.log('eq window:', JSON.stringify(summary.eqWindow));
  console.log('hypo path:', JSON.stringify(summary.hypoPath));
  console.log('hypo cap1:', JSON.stringify(summary.hypoPathCap1));
  if (summary.bookLatencyMs) {
    console.log(
      `book RTT ms: p50=${summary.bookLatencyMs.p50} p90=${summary.bookLatencyMs.p90} mean=${summary.bookLatencyMs.mean}`,
    );
  }
  console.log('');
  console.log('--- balizas ---');
  for (const line of summary.balizas) console.log(`• ${line}`);
  console.log('====================================');
}

function loadSummaries(eventsDir) {
  if (!fs.existsSync(eventsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(eventsDir)) {
    const p = path.join(eventsDir, name, 'summary.json');
    if (!fs.existsSync(p)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch {
      /* skip */
    }
  }
  return out;
}

function aggregateSummaries(summaries, meta) {
  const allGaps = [];
  const bookLats = [];
  let sub = 0;
  let desc = 0;
  let makerPlaced = 0;
  let makerFilled = 0;
  let makerTimeout = 0;
  let cap0ok = 0;
  let cap0n = 0;
  let cap1ok = 0;
  let cap1n = 0;
  let cap2ok = 0;
  let cap2n = 0;
  const avgSums = [];
  const avgSumsCap1 = [];
  const eq5 = [];
  const eq10 = [];
  const events = [];

  for (const s of summaries) {
    const g = s.gapSubCents;
    if (g?.n) {
      // approximate: use mean*n is wrong; re-read not available — store per-event stats
    }
    sub += s.crosses?.sub || 0;
    desc += s.crosses?.desc || 0;
    makerPlaced += s.makerDesc?.placed || 0;
    makerFilled += s.makerDesc?.filled || 0;
    makerTimeout += s.makerDesc?.timeout || 0;
    if (s.bookLatencyMs?.p50 != null) bookLats.push(s.bookLatencyMs.p50);
    if (s.hypoPath?.avgSum != null) avgSums.push(s.hypoPath.avgSum);
    if (s.hypoPathCap1?.avgSum != null) avgSumsCap1.push(s.hypoPathCap1.avgSum);
    if (s.eqWindow?.pctEq5 != null) eq5.push(s.eqWindow.pctEq5);
    if (s.eqWindow?.pctEq10 != null) eq10.push(s.eqWindow.pctEq10);

    // rebuild cap rates from per-event exec% * n
    const nSub = s.crosses?.sub || 0;
    if (nSub > 0 && s.takerLimitExecPct) {
      cap0n += nSub;
      cap1n += nSub;
      cap2n += nSub;
      cap0ok += (s.takerLimitExecPct.cap0 / 100) * nSub;
      cap1ok += (s.takerLimitExecPct.cap1 / 100) * nSub;
      cap2ok += (s.takerLimitExecPct.cap2 / 100) * nSub;
    }
    if (s.gapSubCents) {
      // keep event-level gap p50/p90 for distribution of paths
      allGaps.push({
        slug: s.market?.slug,
        n: s.gapSubCents.n,
        p50: s.gapSubCents.p50,
        p90: s.gapSubCents.p90,
        mean: s.gapSubCents.mean,
        max: s.gapSubCents.max,
        pctGt1: s.pctGapGt1,
        pctGt2: s.pctGapGt2,
      });
    }
    events.push({
      slug: s.market?.slug,
      sub: s.crosses?.sub,
      desc: s.crosses?.desc,
      gapP50: s.gapSubCents?.p50 ?? null,
      gapP90: s.gapSubCents?.p90 ?? null,
      gapMean: s.gapSubCents?.mean ?? null,
      cap1: s.takerLimitExecPct?.cap1 ?? null,
      makerFillPct: s.makerDesc?.fillRatePct ?? null,
      avgSum: s.hypoPath?.avgSum ?? null,
      eq5: s.eqWindow?.pctEq5 ?? null,
      bookP50: s.bookLatencyMs?.p50 ?? null,
    });
  }

  const gapP50s = allGaps.map((g) => g.p50).filter((x) => x != null);
  const gapP90s = allGaps.map((g) => g.p90).filter((x) => x != null);
  const gapMeans = allGaps.map((g) => g.mean).filter((x) => x != null);

  const agg = {
    meta: { ...meta, eventsCompleted: summaries.length, generatedAt: nowIso() },
    totals: {
      events: summaries.length,
      subCrosses: sub,
      descCrosses: desc,
      makerPlaced,
      makerFilled,
      makerTimeout,
      makerFillRatePct: makerPlaced ? Math.round((1000 * makerFilled) / makerPlaced) / 10 : null,
    },
    gapSubCents_eventLevel: {
      // distribution of per-event gap stats
      p50_of_event_p50: stats(gapP50s),
      p50_of_event_p90: stats(gapP90s),
      p50_of_event_mean: stats(gapMeans),
    },
    takerLimitExecPct_pooled: {
      cap0: cap0n ? Math.round((1000 * cap0ok) / cap0n) / 10 : null,
      cap1: cap1n ? Math.round((1000 * cap1ok) / cap1n) / 10 : null,
      cap2: cap2n ? Math.round((1000 * cap2ok) / cap2n) / 10 : null,
      nSub: cap0n,
    },
    bookRttP50_ms: stats(bookLats),
    hypoAvgSum: stats(avgSums),
    hypoAvgSumCap1: stats(avgSumsCap1),
    eqWindowPctEq5: stats(eq5),
    eqWindowPctEq10: stats(eq10),
    events,
    balizas: [],
  };

  const lines = [];
  lines.push(`EVENTOS: ${agg.totals.events} | SUB crosses=${sub} DESC=${desc}`);
  if (agg.gapSubCents_eventLevel.p50_of_event_p50) {
    const x = agg.gapSubCents_eventLevel.p50_of_event_p50;
    lines.push(`GAP (mediana do p50 por evento): ${x.p50}¢ (range ${x.min}–${x.max}); p90-por-evento med=${agg.gapSubCents_eventLevel.p50_of_event_p90?.p50}¢`);
  }
  lines.push(
    `TAKER_LIMIT pooled: cap0=${agg.takerLimitExecPct_pooled.cap0}% cap1=${agg.takerLimitExecPct_pooled.cap1}% cap2=${agg.takerLimitExecPct_pooled.cap2}% (nSub=${agg.takerLimitExecPct_pooled.nSub})`,
  );
  lines.push(
    `MAKER_DESC same-side: fill=${agg.totals.makerFillRatePct}% (${makerFilled}/${makerPlaced}) timeout≈${makerTimeout}`,
  );
  if (agg.hypoAvgSum) {
    lines.push(`PATH avgSum med=${agg.hypoAvgSum.p50} (min ${agg.hypoAvgSum.min} max ${agg.hypoAvgSum.max})`);
  }
  if (agg.eqWindowPctEq5) {
    lines.push(`EQ≤5¢ med=${agg.eqWindowPctEq5.p50}% dos samples | EQ≤10¢ med=${agg.eqWindowPctEq10?.p50}%`);
  }
  if (agg.bookRttP50_ms) {
    lines.push(`BOOK RTT p50-por-evento: med=${agg.bookRttP50_ms.p50}ms`);
  }
  agg.balizas = lines;
  return agg;
}

function printAggregate(agg) {
  console.log('');
  console.log('########## SERIES AGGREGATE ##########');
  console.log(JSON.stringify(agg.totals, null, 2));
  console.log('taker pooled:', JSON.stringify(agg.takerLimitExecPct_pooled));
  console.log('gap event-level:', JSON.stringify(agg.gapSubCents_eventLevel));
  console.log('book p50:', JSON.stringify(agg.bookRttP50_ms));
  console.log('avgSum:', JSON.stringify(agg.hypoAvgSum));
  console.log('eq5%:', JSON.stringify(agg.eqWindowPctEq5));
  console.log('');
  for (const line of agg.balizas) console.log(`• ${line}`);
  console.log('events:');
  for (const e of agg.events) {
    console.log(
      `  ${e.slug} sub=${e.sub} gapP50=${e.gapP50} gapP90=${e.gapP90} cap1=${e.cap1}% maker=${e.makerFillPct}% avgSum=${e.avgSum} book=${e.bookP50}ms`,
    );
  }
  console.log('######################################');
}

async function resolveMarketReady(doneSlugs) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const slug = currentSlug();
    const start = eventStartFromSlug(slug);
    const tau = start != null ? start + 300 - Math.floor(Date.now() / 1000) : 0;
    if (doneSlugs.has(slug)) {
      console.log(`slug ${slug} already done — wait next (tau=${tau})`);
      await sleep(2000);
      continue;
    }
    if (FULL_EVENT && tau < MIN_TAU_START) {
      console.log(`wait tau=${tau}s < ${MIN_TAU_START}s slug=${slug}`);
      await sleep(2000);
      continue;
    }
    try {
      const market = await resolveMarket(slug);
      market.tauAtStart = start != null ? start + 300 - Math.floor(Date.now() / 1000) : null;
      return market;
    } catch (e) {
      console.log(`resolve fail: ${e.message}`);
      await sleep(2000);
    }
  }
  throw new Error('could not resolve market in time');
}

async function runOneEvent({ host, seriesDir, market }) {
  const outDir = path.join(seriesDir, 'events', market.slug);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('');
  console.log(`--- event ${market.slug} tau≈${market.tauAtStart}s ---`);
  console.log(
    `UP=${market.tokens.UP.slice(0, 12)}… DOWN=${market.tokens.DOWN.slice(0, 12)}… resolveMs=${market.resolveMs}`,
  );

  const session = createSession(market);
  const crossesPath = path.join(outDir, 'crosses.jsonl');
  const ticksPath = path.join(outDir, 'ticks.jsonl');
  const deadline = Date.now() + SECONDS * 1000;
  let lastCrossCount = 0;

  while (Date.now() < deadline) {
    const ts = nowIso();
    const startSec = market.eventStart;
    const tau = startSec != null ? startSec + 300 - Math.floor(Date.now() / 1000) : null;

    if (FULL_EVENT && tau != null && tau <= 0) {
      console.log('event ended (tau<=0)');
      break;
    }

    // market rolled to next slug unexpectedly
    if (FULL_EVENT && startSec != null) {
      const liveSlug = currentSlug();
      if (liveSlug !== market.slug && tau <= 0) {
        console.log('slug rolled');
        break;
      }
    }

    const tPoll0 = performance.now();
    const [up, down] = await Promise.all([
      fetchSideBook(market.tokens.UP),
      fetchSideBook(market.tokens.DOWN),
    ]);
    const pollMs = Math.round((performance.now() - tPoll0) * 10) / 10;
    session.bookLatencies.push(pollMs);
    session.ticks += 1;

    const asks = { UP: up.ask, DOWN: down.ask };
    const bids = { UP: up.bid, DOWN: down.bid };

    fs.appendFileSync(
      ticksPath,
      `${JSON.stringify({
        ts,
        tau,
        pollMs,
        upAsk: asks.UP,
        upBid: bids.UP,
        downAsk: asks.DOWN,
        downBid: bids.DOWN,
        upErr: up.err,
        downErr: down.err,
      })}\n`,
    );

    for (const side of ['UP', 'DOWN']) {
      const prev = session.prevAsk[side];
      const curr = asks[side];
      processCrosses(session, side, prev, curr, ts, tau);
      processResting(session, side, prev, curr, ts);
      session.prevAsk[side] = curr;
    }

    while (lastCrossCount < session.crosses.length) {
      const c = session.crosses[lastCrossCount++];
      fs.appendFileSync(crossesPath, `${JSON.stringify(c)}\n`);
      console.log(
        `CROSS ${c.tipo} ${c.side} L=${c.levelC}¢ ask=${c.ask} gap=${c.gapC}¢ tau=${c.tau}` +
          (c.tipo === 'SUB' ? ` cap1=${c.exec.cap1}` : ''),
      );
    }

    if (session.ticks % 4 === 0) sampleEq(session, asks, ts, tau);

    if (session.ticks % 40 === 0) {
      const g = stats(session.crosses.filter((c) => c.tipo === 'SUB').map((c) => c.gapC));
      console.log(
        `… tick=${session.ticks} tau=${tau} up=${asks.UP} dn=${asks.DOWN} sub=${session.crosses.filter((c) => c.tipo === 'SUB').length}` +
          (g ? ` gapP50=${g.p50}¢` : '') +
          ` poll=${pollMs}ms`,
      );
    }

    await sleep(POLL_MS);
  }

  const endTs = nowIso();
  for (const order of session.resting) {
    if (order.status === 'open') {
      order.status = 'open_eoe';
      order.ageAtFillSec = Math.round((Date.parse(endTs) - Date.parse(order.placedTs)) / 100) / 10;
    }
  }

  const summary = summarize(session, {
    host,
    label: LABEL,
    pollMs: POLL_MS,
    seconds: SECONDS,
    fullEvent: FULL_EVENT,
    makerTimeoutSec: MAKER_TIMEOUT_SEC,
  });

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'resting.json'), JSON.stringify(session.resting, null, 2));
  printSummary(summary);
  console.log(`saved event: ${outDir}`);
  return summary;
}

async function main() {
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown';
  const stamp = nowIso().replace(/[:.]/g, '-');
  const safeLabel = LABEL.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const seriesDir = path.join(OUT_ROOT, `${stamp}-${safeLabel}`);
  const eventsDir = path.join(seriesDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  console.log('=== poly-market-baliza-live ===');
  console.log(
    `host=${host} label=${LABEL} events=${EVENTS} pollMs=${POLL_MS} seconds=${SECONDS} fullEvent=${FULL_EVENT} minTau=${MIN_TAU_START}`,
  );
  console.log(`series=${seriesDir}`);

  const doneSlugs = new Set();
  // resume: mark existing
  for (const s of loadSummaries(eventsDir)) {
    if (s.market?.slug) doneSlugs.add(s.market.slug);
  }

  const completed = [];
  for (let i = 0; i < EVENTS; i++) {
    console.log(`\n######## series ${i + 1}/${EVENTS} (done=${doneSlugs.size}) ########`);
    try {
      const market = await resolveMarketReady(doneSlugs);
      const summary = await runOneEvent({ host, seriesDir, market });
      doneSlugs.add(market.slug);
      completed.push(summary);

      const agg = aggregateSummaries(loadSummaries(eventsDir), {
        host,
        label: LABEL,
        seriesDir,
        targetEvents: EVENTS,
      });
      fs.writeFileSync(path.join(seriesDir, 'aggregate.json'), JSON.stringify(agg, null, 2));
      fs.writeFileSync(path.join(seriesDir, 'STATUS.json'), JSON.stringify({
        running: i + 1 < EVENTS,
        completed: doneSlugs.size,
        target: EVENTS,
        lastSlug: market.slug,
        updatedAt: nowIso(),
      }, null, 2));
    } catch (e) {
      console.error(`event failed: ${e.message}`);
      fs.writeFileSync(path.join(seriesDir, 'STATUS.json'), JSON.stringify({
        running: false,
        error: String(e.message || e),
        completed: doneSlugs.size,
        target: EVENTS,
        updatedAt: nowIso(),
      }, null, 2));
      break;
    }

    if (i + 1 < EVENTS) {
      console.log(`between events sleep ${BETWEEN_EVENTS_MS}ms`);
      await sleep(BETWEEN_EVENTS_MS);
    }
  }

  const finalAgg = aggregateSummaries(loadSummaries(eventsDir), {
    host,
    label: LABEL,
    seriesDir,
    targetEvents: EVENTS,
  });
  fs.writeFileSync(path.join(seriesDir, 'aggregate.json'), JSON.stringify(finalAgg, null, 2));
  printAggregate(finalAgg);
  console.log(`series saved: ${seriesDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
