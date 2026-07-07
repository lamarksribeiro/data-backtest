/**
 * Utilitários compartilhados — diagnóstico TFC V7.
 */
import fs from 'node:fs';
import path from 'node:path';

export const FROM = '2026-05-04';
export const TO = '2026-07-01';
export const JUNE_CUTOFF = '2026-06-01';
export const BUDGET = 10;
export const FEE_RATE = 0.07;
export const CACHE_DIR = path.join('labs', 'sandbox', 'cache');
export const CUBE_DIR = path.join('labs', 'mining', 'cube');

export function splitName(dt) {
  return dt >= JUNE_CUTOFF ? 'june' : 'train';
}

export function splitFromEventStart(eventStart) {
  const dt = String(eventStart || '').slice(0, 10);
  return splitName(dt);
}

export function* dateRange(from, to) {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

export function parseDateStart(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function parseDateEnd(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

export function tsMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

export function fmtUsd(x) {
  return `$${Number(x).toFixed(2)}`;
}

export function fmtUsd3(x) {
  return `$${Number(x).toFixed(3)}`;
}

export function stats(rows, pnlKey = 'finalPnl') {
  if (!rows.length) return { n: 0, winrate: 0, exp: 0, sum: 0, wins: 0, losses: 0 };
  const n = rows.length;
  const wins = rows.filter((r) => Number(r[pnlKey]) > 0).length;
  const losses = rows.filter((r) => Number(r[pnlKey]) < 0).length;
  const sum = rows.reduce((a, r) => a + Number(r[pnlKey] || 0), 0);
  return { n, winrate: wins / n, exp: sum / n, sum, wins, losses };
}

export function maxDrawdownFromDaily(dailyPnls) {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const pnl of dailyPnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

export function dailySeries(events) {
  const byDay = new Map();
  for (const e of events) {
    const dt = String(e.eventStart || e.dt || '').slice(0, 10);
    if (!dt) continue;
    byDay.set(dt, (byDay.get(dt) || 0) + Number(e.finalPnl || 0));
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, pnl]) => pnl);
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function signedDistance(side, underlying, ptb) {
  if (!Number.isFinite(underlying) || !Number.isFinite(ptb)) return null;
  return side === 'UP' ? underlying - ptb : ptb - underlying;
}

export function compactEvent(event) {
  const entry = (event.orders || []).find((o) => !o.type || o.type === 'entry');
  const dt = String(event.eventStart || '').slice(0, 10);
  return {
    eventId: event.eventId,
    eventStart: event.eventStart,
    eventEnd: event.eventEnd,
    dt,
    split: splitName(dt),
    finalPnl: Number(event.finalPnl || 0),
    winnerSide: event.winnerSide,
    positionType: event.positionType,
    priceToBeat: event.priceToBeat,
    entryTimeRemaining: event.entryTimeRemaining,
    entryDistanceToPtb: event.entryDistanceToPtb,
    expiryPnl: Number(event.expiryPnl || 0),
    hedgePnl: event.hedgePnl != null ? Number(event.hedgePnl) : null,
    primaryLotPnl: event.primaryLotPnl != null ? Number(event.primaryLotPnl) : null,
    entry: entry ? {
      ts: entry.ts,
      side: entry.side,
      price: Number(entry.avgPrice ?? entry.price),
      shares: Number(entry.shares || 0),
      cost: Number(entry.notional ?? entry.cost ?? 0),
      reason: entry.reason,
    } : null,
    orders: (event.orders || []).map((o) => ({
      type: o.type,
      reason: o.reason,
      side: o.side,
      price: o.price != null ? Number(o.price) : null,
      avgPrice: o.avgPrice != null ? Number(o.avgPrice) : null,
      shares: o.shares != null ? Number(o.shares) : null,
      notional: o.notional != null ? Number(o.notional) : null,
      ts: o.ts,
      liquidity: o.liquidity,
    })),
    marks: (event.marks || []).map((m) => ({
      kind: m.kind ?? m.type,
      reason: m.reason ?? m.data?.reason,
      data: m.data ?? m,
    })),
    reason: event.reason,
    hedgeFill: event.hedgeFill ? {
      side: event.hedgeFill.side,
      price: Number(event.hedgeFill.avgPrice ?? event.hedgeFill.price),
      shares: Number(event.hedgeFill.shares || 0),
      reason: event.hedgeFill.reason,
      liquidity: event.hedgeFill.liquidity,
    } : null,
  };
}

export function traceCrossMeta({ event, samples, entryOrder }) {
  const side = entryOrder.side ?? event.positionType;
  const ptb = Number(event.priceToBeat);
  const entryMs = tsMs(entryOrder.ts);
  const eventEndMs = tsMs(event.eventEnd ?? event.closedAt);
  if (!side || !Number.isFinite(ptb) || !entryMs || !samples?.length) {
    return { firstCrossTau: null, missedFlipAfterFloor: false, crossAfterFloorCost: null };
  }

  let firstCrossTau = null;
  let firstCrossMs = null;
  for (const sample of samples) {
    const tickMs = sample._tsMs ?? tsMs(sample.ts);
    if (tickMs < entryMs - 500) continue;
    const px = Number(sample.underlying_price ?? sample.underlyingPrice);
    const dist = signedDistance(side, px, ptb);
    if (dist == null) continue;
    const secsLeft = eventEndMs != null ? Math.max(0, (eventEndMs - tickMs) / 1000) : null;
    if (dist <= 0 && firstCrossTau == null) {
      firstCrossTau = secsLeft;
      firstCrossMs = tickMs;
      break;
    }
  }

  const reasons = (event.orders || []).map((o) => String(o.reason || ''));
  const hadLateAction = reasons.some((r) => r.includes('late_flip'));
  const missedFlipAfterFloor = firstCrossTau != null && firstCrossTau < 4 && !hadLateAction;

  return {
    firstCrossTau,
    firstCrossMs,
    missedFlipAfterFloor,
    crossAfterFloorCost: missedFlipAfterFloor ? Number(event.finalPnl || 0) : 0,
  };
}

export function classifyOutcome(event) {
  const orders = event.orders || [];
  const hasReverse = orders.some((o) => String(o.reason || '').includes('late_flip_reverse'));
  const hasExit = orders.some((o) => o.type === 'exit' && String(o.reason || '').includes('late_flip_exit'));
  const entry = orders.find((o) => !o.type || o.type === 'entry');
  if (!entry) return 'no_entry';

  if (hasReverse) return 'late_flip_reverse';
  if (hasExit) return 'late_flip_exit';

  const won = event.winnerSide && entry.side === event.winnerSide;
  return won ? 'hold_win' : 'hold_loss';
}

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Varre asks do book depth 25 para orçamento fixo. */
export function sweepFillFromRow(row, side, budget = BUDGET) {
  let remaining = budget;
  let shares = 0;
  let levels = 0;
  let spentOnLevels = 0;
  const prefix = side === 'UP' ? 'up_ask' : 'down_ask';
  for (let i = 1; i <= 25; i += 1) {
    const px = Number(row[`${prefix}_px_${i}`]);
    const sz = Number(row[`${prefix}_sz_${i}`]);
    if (!(px > 0) || !(sz > 0) || px >= 1) continue;
    const eff = px + FEE_RATE * px * (1 - px);
    const levelCost = sz * eff;
    if (remaining >= levelCost) {
      shares += sz;
      remaining -= levelCost;
      levels += 1;
      spentOnLevels += levelCost;
    } else {
      const partial = remaining / eff;
      shares += partial;
      spentOnLevels += remaining;
      remaining = 0;
      levels += 1;
      break;
    }
  }
  const spent = budget - remaining;
  if (spent <= 0 || shares <= 0) return null;
  return { shares, spent, avgPx: spent / shares, levels };
}

/** Profundidade em USD no melhor ask (nível 1). */
export function topAskDepthUsd(row, side) {
  const prefix = side === 'UP' ? 'up_ask' : 'down_ask';
  const px = Number(row[`${prefix}_px_1`]);
  const sz = Number(row[`${prefix}_sz_1`]);
  if (!(px > 0) || !(sz > 0)) return 0;
  return px * sz;
}

export function v5EntryGates(row) {
  const tau = Number(row.tau ?? row.secsLeft);
  const distAbs = Number(row.dist_abs ?? Math.abs(Number(row.underlying_price) - Number(row.price_to_beat)));
  const fav = row.fav ?? (Number(row.underlying_price) >= Number(row.price_to_beat) ? 'UP' : 'DOWN');
  const askFav = Number(row.ask_fav ?? (fav === 'UP' ? row.up_best_ask : row.down_best_ask));
  const bidFav = Number(row.bid_fav ?? (fav === 'UP' ? row.up_best_bid : row.down_best_bid));
  const spreadFav = Number(row.spread_fav ?? (askFav - bidFav));
  const upAsk = Number(row.ask_up ?? row.up_best_ask);
  const downAsk = Number(row.ask_down ?? row.down_best_ask);
  const oddsSum = Number(row.odds_sum ?? (upAsk + downAsk));
  const dSpot5 = Number(row.d_spot_5);
  const obi5 = row.obi5 != null ? Number(row.obi5) : null;

  if (!(tau >= 5 && tau < 30)) return false;
  if (!(distAbs < 20)) return false;
  if (!(askFav >= 0.55 && askFav <= 0.82)) return false;
  if (!(spreadFav <= 0.03)) return false;
  if (!(oddsSum >= 0.98 && oddsSum <= 1.06)) return false;
  if (Number.isFinite(dSpot5)) {
    const adv = fav === 'UP' ? -dSpot5 : dSpot5;
    if (adv > 8) return false;
  }
  if (obi5 != null && obi5 < 0) return false;
  return true;
}

export function binAskFav(v) {
  if (!Number.isFinite(v)) return 'NA';
  if (v < 0.6) return '0.55-0.60';
  if (v < 0.65) return '0.60-0.65';
  if (v < 0.7) return '0.65-0.70';
  if (v < 0.75) return '0.70-0.75';
  if (v < 0.82) return '0.75-0.82';
  return '>0.82';
}

export function binDistAbs(v) {
  if (!Number.isFinite(v)) return 'NA';
  if (v < 3) return '0-3';
  if (v < 6) return '3-6';
  if (v < 9) return '6-9';
  if (v < 12) return '9-12';
  if (v < 15) return '12-15';
  return '15-20';
}

export function binDistVol(v) {
  if (!Number.isFinite(v) || v <= 0) return 'NA';
  if (v < 0.5) return '<0.5';
  if (v < 1.0) return '0.5-1.0';
  if (v < 1.5) return '1.0-1.5';
  if (v < 2.5) return '1.5-2.5';
  if (v < 4.0) return '2.5-4.0';
  return '>=4.0';
}

export function binObi5(v) {
  if (!Number.isFinite(v)) return 'NA';
  if (v < -0.3) return '<-0.3';
  if (v < 0) return '-0.3..0';
  if (v <= 0.3) return '0..0.3';
  return '>0.3';
}

export function binFlips(v) {
  if (!Number.isFinite(v)) return 'NA';
  if (v >= 4) return '4+';
  return String(Math.floor(v));
}

export function binHourUtc(tsMsValue) {
  const h = new Date(tsMsValue).getUTCHours();
  const block = Math.floor(h / 4) * 4;
  return `${String(block).padStart(2, '0')}-${String(block + 4).padStart(2, '0')} UTC`;
}
