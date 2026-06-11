import { mkdirSync, appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { downsamplePoints } from '../utils/downsample.js';

const MAX_CHART_POINTS = 500;
const MAX_SIDECAR_FILE_CACHE = 6;

/** @type {Map<string, { mtimeMs: number, lines: string[] }>} */
const sidecarFileCache = new Map();

export function chartSidecarPath(stateDbPath, runId) {
  const stateDir = path.dirname(stateDbPath);
  return path.join(stateDir, 'event-series', `run-${runId}.jsonl`);
}

export function ensureChartSidecarDir(stateDbPath) {
  const dir = path.join(path.dirname(stateDbPath), 'event-series');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildEventChartSeries(samples, side = 'UP') {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const underlying = [];
  const priceToBeat = [];
  const upPrice = [];
  const downPrice = [];
  const bid = [];
  const ask = [];
  for (const tick of samples || []) {
    const ts = tick.ts;
    underlying.push({ ts, value: num(tick.underlying_price ?? tick.underlyingPrice) });
    priceToBeat.push({ ts, value: num(tick.price_to_beat ?? tick.priceToBeat) });
    upPrice.push({ ts, value: num(tick.up_price ?? tick.upPrice) });
    downPrice.push({ ts, value: num(tick.down_price ?? tick.downPrice) });
    bid.push({ ts, value: num(tick[`${prefix}_best_bid`]) });
    ask.push({ ts, value: num(tick[`${prefix}_best_ask`]) });
  }
  const keepTs = [];
  return downsampleSeries({ underlying, priceToBeat, upPrice, downPrice, bid, ask }, keepTs);
}

function downsampleSeries(series, keepTs) {
  const base = series.underlying || [];
  if (base.length <= MAX_CHART_POINTS) {
    return { series, meta: { total_points: base.length, displayed_points: base.length, downsampled: false } };
  }
  const picked = downsamplePoints(base, { maxPoints: MAX_CHART_POINTS, keepTs });
  const pickedTs = new Set(picked.map((p) => p.ts));
  const pick = (arr) => (arr || []).filter((p) => pickedTs.has(p.ts));
  return {
    series: {
      underlying: pick(series.underlying),
      priceToBeat: pick(series.priceToBeat),
      upPrice: pick(series.upPrice),
      downPrice: pick(series.downPrice),
      bid: pick(series.bid),
      ask: pick(series.ask),
    },
    meta: { total_points: base.length, displayed_points: picked.length, downsampled: true },
  };
}

export function appendChartSidecarLine(filePath, conditionId, payload) {
  const line = JSON.stringify({ condition_id: conditionId, ...payload });
  appendFileSync(filePath, `${line}\n`, 'utf8');
  sidecarFileCache.delete(filePath);
}

function loadSidecarLines(filePath) {
  if (!existsSync(filePath)) return null;
  const mtimeMs = statSync(filePath).mtimeMs;
  const cached = sidecarFileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.lines;

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim());
  sidecarFileCache.set(filePath, { mtimeMs, lines });
  if (sidecarFileCache.size > MAX_SIDECAR_FILE_CACHE) {
    const oldest = sidecarFileCache.keys().next().value;
    sidecarFileCache.delete(oldest);
  }
  return lines;
}

export function readChartSidecarForEvent(filePath, conditionId) {
  const lines = loadSidecarLines(filePath);
  if (!lines) return null;
  const target = String(conditionId);
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (String(row.condition_id) === target) return row;
    } catch {
      // skip bad lines
    }
  }
  return null;
}

export function clearChartSidecarCache() {
  sidecarFileCache.clear();
}

function num(value) {
  return value == null ? null : Number(value);
}
