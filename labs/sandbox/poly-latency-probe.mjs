/**
 * Polymarket latency probe — zero cost (public endpoints only).
 *
 * Measures RTT of:
 *   - Gamma markets
 *   - CLOB /time
 *   - CLOB book (current BTC 5m UP token when resolvable)
 *   - CLOB WS handshake (optional)
 *
 * Usage:
 *   node labs/sandbox/poly-latency-probe.mjs
 *   node labs/sandbox/poly-latency-probe.mjs --samples 20 --label local-vpn
 *   node labs/sandbox/poly-latency-probe.mjs --no-ws
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function argVal(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const samples = Math.max(3, Number(argVal('samples', '15')) || 15);
const label = String(argVal('label', 'probe'));
const noWs = args.includes('--no-ws');
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tmp/poly-latency');
fs.mkdirSync(outDir, { recursive: true });

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stats(msList) {
  if (!msList.length) return null;
  const sorted = [...msList].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  return {
    n,
    min: sorted[0],
    p50: pct(50),
    p90: pct(90),
    p95: pct(95),
    max: sorted[n - 1],
    mean: Math.round((sum / n) * 10) / 10,
  };
}

async function timedFetch(url, options = {}) {
  const t0 = performance.now();
  let status = 0;
  let bytes = 0;
  let err = null;
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
    status = res.status;
    const buf = await res.arrayBuffer();
    bytes = buf.byteLength;
  } catch (e) {
    err = String(e?.message || e);
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  return { ms, status, bytes, err, url };
}

function currentBtcSlug(nowSec = Math.floor(Date.now() / 1000)) {
  const start = nowSec - (nowSec % 300);
  return `btc-updown-5m-${start}`;
}

async function resolveBookUrl() {
  const slug = currentBtcSlug();
  const r = await timedFetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (r.err || r.status >= 400) {
    return { slug, bookUrl: null, resolveMs: r.ms, resolveErr: r.err || `http ${r.status}` };
  }
  try {
    // re-fetch body for parse (timedFetch discarded body — redo lightweight)
    const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const event = Array.isArray(data) ? data[0] : data;
    const market = event?.markets?.[0] || event?.markets;
    const m = Array.isArray(market) ? market[0] : market;
    let tokenIds = m?.clobTokenIds || m?.clob_token_ids;
    if (typeof tokenIds === 'string') {
      try {
        tokenIds = JSON.parse(tokenIds);
      } catch {
        tokenIds = null;
      }
    }
    const tokenId = Array.isArray(tokenIds) ? tokenIds[0] : null;
    if (!tokenId) {
      return { slug, bookUrl: null, resolveMs: r.ms, resolveErr: 'no token id' };
    }
    return {
      slug,
      bookUrl: `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`,
      tokenId: String(tokenId),
      resolveMs: r.ms,
    };
  } catch (e) {
    return { slug, bookUrl: null, resolveMs: r.ms, resolveErr: String(e?.message || e) };
  }
}

async function timedWsHandshake(tokenId) {
  if (noWs || typeof WebSocket === 'undefined') {
    return { ms: null, err: noWs ? 'skipped' : 'WebSocket unavailable in this runtime' };
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(payload);
    };
    let ws;
    try {
      ws = new WebSocket(CLOB_WS);
    } catch (e) {
      finish({ ms: null, err: String(e?.message || e) });
      return;
    }
    const timer = setTimeout(() => finish({ ms: null, err: 'timeout 10s' }), 10000);
    ws.addEventListener('open', () => {
      try {
        ws.send(
          JSON.stringify({
            assets_ids: tokenId ? [tokenId] : [],
            type: 'market',
          }),
        );
      } catch {
        /* ignore */
      }
      const ms = Math.round((performance.now() - t0) * 10) / 10;
      clearTimeout(timer);
      // wait briefly for first message if any
      const msgTimer = setTimeout(() => finish({ ms, firstMsgMs: null, err: null }), 1500);
      ws.addEventListener('message', () => {
        clearTimeout(msgTimer);
        const firstMsgMs = Math.round((performance.now() - t0) * 10) / 10;
        finish({ ms, firstMsgMs, err: null });
      });
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish({ ms: null, err: 'ws error' });
    });
  });
}

function printStats(name, s) {
  if (!s) {
    console.log(`  ${name}: (no data)`);
    return;
  }
  console.log(
    `  ${name.padEnd(14)} n=${s.n}  min=${s.min}  p50=${s.p50}  p90=${s.p90}  p95=${s.p95}  max=${s.max}  mean=${s.mean}  (ms)`,
  );
}

async function main() {
  const startedAt = new Date().toISOString();
  const hostHint = process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown-host';
  console.log(`=== Polymarket latency probe ===`);
  console.log(`label=${label}  host=${hostHint}  samples=${samples}  at=${startedAt}`);
  console.log(`vpn_hint=check_local_only  node=${process.version}`);
  console.log('');

  // warmup DNS/TLS
  await timedFetch(`${CLOB}/time`);
  await sleep(200);

  const bookInfo = await resolveBookUrl();
  console.log(
    `market: slug=${bookInfo.slug} token=${bookInfo.tokenId || '-'} resolveMs=${bookInfo.resolveMs}` +
      (bookInfo.resolveErr ? ` err=${bookInfo.resolveErr}` : ''),
  );
  console.log('');

  const series = {
    gamma_markets: [],
    clob_time: [],
    clob_book: [],
    ws_open: [],
    ws_first_msg: [],
  };
  const raw = [];

  for (let i = 0; i < samples; i++) {
    const row = { i: i + 1, t: new Date().toISOString() };

    const g = await timedFetch(`${GAMMA}/markets?limit=1`);
    row.gamma_markets = g;
    if (!g.err && g.status < 400) series.gamma_markets.push(g.ms);

    const t = await timedFetch(`${CLOB}/time`);
    row.clob_time = t;
    if (!t.err && t.status < 400) series.clob_time.push(t.ms);

    if (bookInfo.bookUrl) {
      const b = await timedFetch(bookInfo.bookUrl);
      row.clob_book = b;
      if (!b.err && b.status < 400) series.clob_book.push(b.ms);
    }

    // WS only every 3rd sample to avoid hammering
    if (!noWs && bookInfo.tokenId && i % 3 === 0) {
      const w = await timedWsHandshake(bookInfo.tokenId);
      row.ws = w;
      if (w.ms != null) series.ws_open.push(w.ms);
      if (w.firstMsgMs != null) series.ws_first_msg.push(w.firstMsgMs);
    }

    raw.push(row);
    const parts = [
      `#${String(i + 1).padStart(2, '0')}`,
      `gamma=${g.ms}ms/${g.status}`,
      `time=${t.ms}ms/${t.status}`,
    ];
    if (row.clob_book) parts.push(`book=${row.clob_book.ms}ms/${row.clob_book.status}`);
    if (row.ws?.ms != null) parts.push(`wsOpen=${row.ws.ms}ms`);
    if (row.ws?.firstMsgMs != null) parts.push(`wsMsg=${row.ws.firstMsgMs}ms`);
    if (row.ws?.err) parts.push(`wsErr=${row.ws.err}`);
    console.log(parts.join('  '));
    await sleep(250);
  }

  console.log('');
  console.log('--- summary (ms) ---');
  printStats('gamma', stats(series.gamma_markets));
  printStats('clob_time', stats(series.clob_time));
  printStats('clob_book', stats(series.clob_book));
  printStats('ws_open', stats(series.ws_open));
  printStats('ws_1st_msg', stats(series.ws_first_msg));

  const report = {
    label,
    host: hostHint,
    startedAt,
    finishedAt: new Date().toISOString(),
    samples,
    market: bookInfo,
    summary: {
      gamma_markets: stats(series.gamma_markets),
      clob_time: stats(series.clob_time),
      clob_book: stats(series.clob_book),
      ws_open: stats(series.ws_open),
      ws_first_msg: stats(series.ws_first_msg),
    },
    raw,
  };

  const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const stamp = startedAt.replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${stamp}-${safeLabel}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('');
  console.log(`saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
