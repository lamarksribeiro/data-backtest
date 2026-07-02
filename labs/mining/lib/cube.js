/** Carrega o cubo CSV em arrays tipados para mineração rápida. */
import fs from 'node:fs';
import path from 'node:path';

const CUBE_DIR = path.join('labs', 'mining', 'cube');

export const NUM_COLS = [
  'ts_ms', 'tau', 'dist', 'dist_abs', 'ask_fav', 'bid_fav', 'spread_fav',
  'ask_up', 'ask_down', 'odds_sum',
  'd_spot_5', 'd_spot_10', 'd_spot_15', 'd_spot_20', 'd_spot_30', 'd_spot_60',
  'sigma_ps_90', 'flips_60', 'secs_since_flip', 'pin45',
  'd_askfav_10', 'd_askfav_15', 'd_askfav_30', 'sigma_askfav_15',
  'depth5_ask_fav', 'depth5_bid_fav', 'obi5', 'ladder_fav',
  'fill_px_fav', 'fill_sh_fav', 'fill_px_non', 'fill_sh_non',
  'p_phys', 'edge_phys', 'coverage', 'mkt_agree',
  'pnl_fav', 'pnl_non',
];

export function loadCube({ minCoverage = 0.9, requireMktAgree = true } = {}) {
  const files = fs.readdirSync(CUBE_DIR)
    .filter((f) => f.startsWith('dt=') && f.endsWith('.csv'))
    .sort();

  // primeira passada: contar linhas
  let total = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(CUBE_DIR, f), 'utf8');
    total += text.split('\n').length; // superestima (header/vazias), ok
  }

  const cols = {};
  for (const c of NUM_COLS) cols[c] = new Float64Array(total);
  const eventId = new Int32Array(total);
  const dayId = new Int16Array(total);
  const favUp = new Uint8Array(total);
  const favWon = new Uint8Array(total);

  const eventKey = new Map();
  const days = [];
  let n = 0;

  for (const f of files) {
    const text = fs.readFileSync(path.join(CUBE_DIR, f), 'utf8');
    const lines = text.split('\n');
    if (lines.length < 2) continue;
    const hdr = lines[0].split(',');
    const idx = Object.fromEntries(hdr.map((h, i) => [h, i]));
    const dt = f.slice(3, 13);
    const di = days.length;
    days.push(dt);
    for (let li = 1; li < lines.length; li += 1) {
      const parts = lines[li].split(',');
      if (parts.length < hdr.length) continue;
      const coverage = Number(parts[idx.coverage]);
      if (Number.isFinite(coverage) && coverage < minCoverage) continue;
      if (parts[idx.degraded] === '1') continue;
      if (requireMktAgree && idx.mkt_agree != null && parts[idx.mkt_agree] === '0') continue;
      const cid = parts[idx.condition_id];
      let ev = eventKey.get(cid);
      if (ev === undefined) { ev = eventKey.size; eventKey.set(cid, ev); }
      eventId[n] = ev;
      dayId[n] = di;
      favUp[n] = parts[idx.fav] === 'UP' ? 1 : 0;
      favWon[n] = parts[idx.fav_won] === '1' ? 1 : 0;
      for (const c of NUM_COLS) {
        const raw = parts[idx[c]];
        cols[c][n] = raw === '' || raw === undefined ? NaN : Number(raw);
      }
      n += 1;
    }
  }

  return {
    n,
    days,
    numEvents: eventKey.size,
    eventId: eventId.subarray(0, n),
    dayId: dayId.subarray(0, n),
    favUp: favUp.subarray(0, n),
    favWon: favWon.subarray(0, n),
    cols: Object.fromEntries(NUM_COLS.map((c) => [c, cols[c].subarray(0, n)])),
  };
}

/**
 * Avalia uma regra: primeira linha qualificada por evento vira 1 trade.
 * pred(i) -> boolean; side 'fav' | 'non'.
 * Retorna { trades: [{day, pnl, won, i}], byDay }.
 */
export function evalRule(cube, pred, { side = 'fav' } = {}) {
  const { n, eventId, dayId, favWon, cols } = cube;
  const pnlCol = side === 'non' ? cols.pnl_non : cols.pnl_fav;
  const stamp = evalRule._stamp = (evalRule._stamp || 0) + 1;
  if (!evalRule._seen || evalRule._seen.length < cube.numEvents) {
    evalRule._seen = new Int32Array(cube.numEvents);
  }
  const seen = evalRule._seen;
  const trades = [];
  for (let i = 0; i < n; i += 1) {
    const ev = eventId[i];
    if (seen[ev] === stamp) continue;
    if (!pred(i)) continue;
    seen[ev] = stamp;
    const won = side === 'non' ? 1 - favWon[i] : favWon[i];
    trades.push({ day: dayId[i], pnl: pnlCol[i], won, i });
  }
  return trades;
}

export function summarize(trades, days, splitDay) {
  const mk = () => ({ n: 0, wins: 0, pnl: 0, pnls: [] });
  const train = mk();
  const hold = mk();
  const all = mk();
  for (const t of trades) {
    const bucket = days[t.day] < splitDay ? train : hold;
    for (const b of [bucket, all]) {
      b.n += 1; b.wins += t.won; b.pnl += t.pnl; b.pnls.push(t.pnl);
    }
  }
  const fin = (b, nDays) => ({
    n: b.n,
    wr: b.n ? b.wins / b.n : 0,
    pnl: Math.round(b.pnl * 100) / 100,
    exp: b.n ? Math.round((b.pnl / b.n) * 10000) / 10000 : 0,
    perDay: nDays ? Math.round((b.n / nDays) * 100) / 100 : null,
    median: median(b.pnls),
  });
  const trainDays = days.filter((d) => d < splitDay).length;
  const holdDays = days.filter((d) => d >= splitDay).length;
  return { train: fin(train, trainDays), holdout: fin(hold, holdDays), full: fin(all, days.length) };
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10000) / 10000;
}

export function maxDrawdown(trades) {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    dd = Math.max(dd, peak - equity);
  }
  return Math.round(dd * 100) / 100;
}
