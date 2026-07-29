/**
 * Pair-Path V0 shadow live — zero orders, public book only.
 *
 *   node labs/sandbox/pair-path-v0/shadow-live.mjs --events 3 --full-event
 *   node labs/sandbox/pair-path-v0/shadow-live.mjs --preset presets/candidate-shadow.json
 *
 * On Giovanna:
 *   docker run --rm -e BALIZA_OUT=/out -v ... node:20-alpine node shadow-live.mjs --events 3 --full-event
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);

function hasFlag(f) {
  return args.includes(f);
}
function argVal(name, fb) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fb;
}

const FULL_EVENT = hasFlag('--full-event') || Number(argVal('events', '1')) > 1;
const EVENTS = Math.max(1, Number(argVal('events', '1')) || 1);
const POLL_MS = Math.max(100, Number(argVal('poll-ms', '250')) || 250);
const MIN_TAU = Math.max(0, Number(argVal('min-tau', '40')) || 40);
const SECONDS = Math.max(30, Number(argVal('seconds', '320')) || 320);
const LABEL = String(argVal('label', 'shadow-v0'));
const OUT_ROOT = process.env.BALIZA_OUT || path.join(ROOT, '.tmp/pair-path-v0-shadow');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
}

function loadParams() {
  const presetRel = argVal('preset', path.join(__dirname, 'presets/candidate-shadow.json'));
  const presetPath = path.isAbsolute(presetRel) ? presetRel : path.resolve(process.cwd(), presetRel);
  const alt = path.join(__dirname, 'presets/candidate-shadow.json');
  const p = fs.existsSync(presetPath) ? presetPath : alt;
  if (!fs.existsSync(p)) return { ...DEFAULT_PARAMS };
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { ...DEFAULT_PARAMS, ...(j.params || j) };
}

async function fetchJson(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'pair-path-v0-shadow/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (!res.ok) return { ok: false, ms, data: null };
    return { ok: true, ms, data: await res.json() };
  } catch {
    return { ok: false, ms: Math.round((performance.now() - t0) * 10) / 10, data: null };
  }
}

function currentSlug(nowSec = Math.floor(Date.now() / 1000)) {
  const start = nowSec - (nowSec % 300);
  return `btc-updown-5m-${start}`;
}
function eventStart(slug) {
  const m = String(slug).match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}
function parseTokens(raw) {
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
  const asks = book?.asks || [];
  let best = null;
  for (const level of asks) {
    const p = Number(level.price ?? level[0]);
    if (!Number.isFinite(p)) continue;
    if (best == null || p < best) best = p;
  }
  return best;
}

async function resolveMarket(slug) {
  const r = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (!r.ok) throw new Error('gamma fail');
  const event = Array.isArray(r.data) ? r.data[0] : r.data;
  const m = (event?.markets || [])[0];
  const tokens = parseTokens(m?.clobTokenIds || m?.clob_token_ids);
  if (tokens.length < 2) throw new Error('tokens');
  return {
    slug,
    eventStart: eventStart(slug),
    tokens: { UP: tokens[0], DOWN: tokens[1] },
  };
}

async function book(tokenId) {
  const r = await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!r.ok) return { ask: null, ms: r.ms };
  return { ask: bestAsk(r.data), ms: r.ms };
}

async function main() {
  const params = loadParams();
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown';
  const stamp = nowIso().replace(/[:.]/g, '-');
  const seriesDir = path.join(OUT_ROOT, `${stamp}-${LABEL}`);
  fs.mkdirSync(path.join(seriesDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(seriesDir, 'params.json'), JSON.stringify(params, null, 2));

  console.log('=== pair-path-v0 shadow live ===');
  console.log(`host=${host} events=${EVENTS} poll=${POLL_MS} out=${seriesDir}`);
  console.log(`params=${JSON.stringify(params)}`);

  const done = new Set();
  const summaries = [];

  for (let i = 0; i < EVENTS; i++) {
    let market = null;
    for (let a = 0; a < 90; a++) {
      const slug = currentSlug();
      const start = eventStart(slug);
      const tau = start != null ? start + 300 - Math.floor(Date.now() / 1000) : 0;
      if (done.has(slug)) {
        await sleep(2000);
        continue;
      }
      if (FULL_EVENT && tau < MIN_TAU) {
        console.log(`wait tau=${tau} ${slug}`);
        await sleep(2000);
        continue;
      }
      try {
        market = await resolveMarket(slug);
        market.tauAtStart = tau;
        break;
      } catch (e) {
        console.log('resolve', e.message);
        await sleep(2000);
      }
    }
    if (!market) break;

    console.log(`\n--- ${i + 1}/${EVENTS} ${market.slug} tau≈${market.tauAtStart} ---`);
    const eng = createEventEngine(params, { slug: market.slug });
    const evDir = path.join(seriesDir, 'events', market.slug);
    fs.mkdirSync(evDir, { recursive: true });
    const ticksPath = path.join(evDir, 'ticks.jsonl');
    const deadline = Date.now() + SECONDS * 1000;
    let last = null;
    let ticks = 0;

    while (Date.now() < deadline) {
      const start = market.eventStart;
      const tau = start != null ? start + 300 - Math.floor(Date.now() / 1000) : null;
      if (FULL_EVENT && tau != null && tau <= 0) break;

      const [up, dn] = await Promise.all([
        book(market.tokens.UP),
        book(market.tokens.DOWN),
      ]);
      const tick = {
        ts: nowIso(),
        tau,
        pollMs: Math.max(up.ms || 0, dn.ms || 0),
        upAsk: up.ask,
        downAsk: dn.ask,
      };
      fs.appendFileSync(ticksPath, `${JSON.stringify(tick)}\n`);
      eng.onTick(tick);
      last = tick;
      ticks += 1;
      if (ticks % 40 === 0) {
        const st = eng.state;
        console.log(
          `… t=${ticks} tau=${tau} up=${up.ask} dn=${dn.ask} mode=${st.mode} fills=${st.fills.length}`,
        );
      }
      await sleep(POLL_MS);
    }

    const result = eng.finish(last);
    const summary = { slug: market.slug, ticks, ...result };
    summaries.push(summary);
    fs.writeFileSync(path.join(evDir, 'summary.json'), JSON.stringify(summary, null, 2));
    done.add(market.slug);
    console.log(
      `done mode=${result.mode} fills=${result.nFills} avgSum=${result.avgSum} pnl≈${result.pnl} worst=${result.worstPnl}`,
    );
    fs.writeFileSync(
      path.join(seriesDir, 'STATUS.json'),
      JSON.stringify(
        {
          running: i + 1 < EVENTS,
          completed: done.size,
          target: EVENTS,
          lastSlug: market.slug,
          updatedAt: nowIso(),
        },
        null,
        2,
      ),
    );
    if (i + 1 < EVENTS) await sleep(3000);
  }

  const report = {
    generatedAt: nowIso(),
    host,
    params,
    summaries,
    totalPnl: summaries.reduce((a, s) => a + (s.pnl || 0), 0),
    nTraded: summaries.filter((s) => s.nFills > 0).length,
  };
  fs.writeFileSync(path.join(seriesDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== shadow series done ===');
  console.log(`traded ${report.nTraded}/${summaries.length} totalPnl≈${report.totalPnl}`);
  console.log(seriesDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
