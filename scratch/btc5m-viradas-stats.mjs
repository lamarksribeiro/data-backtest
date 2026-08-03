/**
 * Estatísticas de viradas (lead flips spot vs PTB) no lake BTC 5m.
 *
 * Virada = mudança do lado favorito físico: spot > PTB → UP, senão DOWN.
 *
 * Uso: node scratch/btc5m-viradas-stats.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'scratch', 'btc5m-viradas-stats.json');
const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs.readdirSync(baseDir).filter((d) => d.startsWith('dt=')).map((d) => d.slice(3)).sort();

function pct(n, d) {
  return d ? (100 * n) / d : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const mean = sum / s.length;
  const var_ = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length;
  return {
    n: s.length,
    mean,
    std: Math.sqrt(var_),
    min: s[0],
    p10: quantile(s, 0.1),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    p95: quantile(s, 0.95),
    p99: quantile(s, 0.99),
    max: s[s.length - 1],
  };
}

async function main() {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run('SET threads TO 8');
  await conn.run("SET memory_limit = '6GB'");

  /** @type {Array<Record<string, any>>} */
  const events = [];
  const seqCounts = new Map();
  const flipCountHist = new Map();
  const upDownHist = new Map();
  const downUpHist = new Map();
  const firstFlipBucket = new Map(); // 0-60, 60-120, ...
  const flipTimeBuckets = new Map(); // when flips happen within event
  const fine10 = new Map(); // 10s bins from event start
  const fine30 = new Map(); // 30s bins
  const fine10Ud = new Map();
  const fine10Du = new Map();
  let daysOk = 0;

  for (const day of days) {
    const dir = path.join(baseDir, `dt=${day}`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet'));
    if (!files.length) continue;
    const glob = path.join(dir, '*.parquet').replace(/\\/g, '/');
    const t0 = Date.now();

    const res = await conn.runAndReadAll(`
      WITH ticks AS (
        SELECT
          condition_id,
          event_start,
          event_end,
          ts,
          underlying_price AS spot,
          price_to_beat AS ptb,
          CASE WHEN underlying_price > price_to_beat THEN 'U' ELSE 'D' END AS fav,
          EXTRACT(EPOCH FROM (
            TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP)
          )) AS t_in,
          EXTRACT(EPOCH FROM (
            TRY_CAST(event_end AS TIMESTAMP) - TRY_CAST(ts AS TIMESTAMP)
          )) AS tau
        FROM read_parquet('${glob}')
        WHERE underlying_price IS NOT NULL
          AND price_to_beat IS NOT NULL
          AND price_to_beat > 1000
          AND (coverage IS NULL OR coverage >= 0.85)
      ),
      ordered AS (
        SELECT
          *,
          lag(fav) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_fav,
          lag(t_in) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_t_in
        FROM ticks
      ),
      flips AS (
        SELECT
          condition_id,
          event_start,
          ts,
          spot,
          ptb,
          t_in,
          tau,
          fav,
          prev_fav,
          prev_t_in,
          CASE WHEN prev_fav IS NOT NULL AND fav <> prev_fav THEN 1 ELSE 0 END AS is_flip,
          CASE WHEN prev_fav = 'U' AND fav = 'D' THEN 1 ELSE 0 END AS ud,
          CASE WHEN prev_fav = 'D' AND fav = 'U' THEN 1 ELSE 0 END AS du
        FROM ordered
      ),
      per_event AS (
        SELECT
          condition_id,
          any_value(event_start) AS event_start,
          count(*) AS n_ticks,
          min(t_in) AS first_t,
          max(t_in) AS last_t,
          arg_min(fav, ts) AS first_fav,
          arg_max(fav, ts) AS last_fav,
          CASE WHEN arg_max(spot, ts) > any_value(ptb) THEN 'U' ELSE 'D' END AS winner,
          any_value(ptb) AS ptb,
          sum(is_flip) AS flips,
          sum(ud) AS flips_ud,
          sum(du) AS flips_du,
          sum(is_flip) FILTER (WHERE t_in < 60) AS flips_0_60,
          sum(is_flip) FILTER (WHERE t_in >= 60 AND t_in < 120) AS flips_60_120,
          sum(is_flip) FILTER (WHERE t_in >= 120 AND t_in < 180) AS flips_120_180,
          sum(is_flip) FILTER (WHERE t_in >= 180 AND t_in < 240) AS flips_180_240,
          sum(is_flip) FILTER (WHERE t_in >= 240) AS flips_240_300,
          sum(is_flip) FILTER (WHERE tau <= 60) AS flips_last_60,
          sum(is_flip) FILTER (WHERE tau <= 30) AS flips_last_30,
          min(t_in) FILTER (WHERE is_flip = 1) AS first_flip_t,
          max(t_in) FILTER (WHERE is_flip = 1) AS last_flip_t,
          avg(t_in - prev_t_in) FILTER (WHERE is_flip = 1) AS avg_gap_before_flip
        FROM flips
        GROUP BY condition_id
      )
      SELECT *
      FROM per_event
      WHERE n_ticks >= 80
        AND last_t >= 250
    `);

    // Fine-grained flip times (10s and 30s buckets) for temporal density
    const timeRes = await conn.runAndReadAll(`
      WITH ticks AS (
        SELECT
          condition_id,
          ts,
          event_start,
          event_end,
          underlying_price AS spot,
          price_to_beat AS ptb,
          CASE WHEN underlying_price > price_to_beat THEN 'U' ELSE 'D' END AS fav,
          EXTRACT(EPOCH FROM (
            TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP)
          )) AS t_in,
          EXTRACT(EPOCH FROM (
            TRY_CAST(event_end AS TIMESTAMP) - TRY_CAST(ts AS TIMESTAMP)
          )) AS tau
        FROM read_parquet('${glob}')
        WHERE underlying_price IS NOT NULL
          AND price_to_beat IS NOT NULL
          AND price_to_beat > 1000
          AND (coverage IS NULL OR coverage >= 0.85)
      ),
      event_ok AS (
        SELECT condition_id
        FROM ticks
        GROUP BY condition_id
        HAVING count(*) >= 80 AND max(t_in) >= 250
      ),
      ordered AS (
        SELECT
          t.condition_id,
          t.t_in,
          t.tau,
          t.fav,
          lag(t.fav) OVER (PARTITION BY t.condition_id ORDER BY t.ts) AS prev_fav
        FROM ticks t
        INNER JOIN event_ok e USING (condition_id)
      ),
      flips_only AS (
        SELECT
          t_in,
          tau,
          CASE WHEN prev_fav = 'U' AND fav = 'D' THEN 'UD' ELSE 'DU' END AS dir
        FROM ordered
        WHERE prev_fav IS NOT NULL AND fav <> prev_fav
          AND t_in >= 0 AND t_in < 300
      )
      SELECT
        floor(t_in / 10)::INT AS bin10,
        floor(t_in / 30)::INT AS bin30,
        floor(GREATEST(0, LEAST(299, 300 - tau)) / 10)::INT AS bin10_from_start_via_tau,
        dir,
        count(*) AS n
      FROM flips_only
      GROUP BY 1, 2, 3, 4
    `);

    for (const r of timeRes.getRowObjectsJson()) {
      const nFlips = Number(r.n);
      const b10 = Number(r.bin10);
      const b30 = Number(r.bin30);
      const dir = String(r.dir);
      fine10.set(b10, (fine10.get(b10) || 0) + nFlips);
      fine30.set(b30, (fine30.get(b30) || 0) + nFlips);
      if (dir === 'UD') fine10Ud.set(b10, (fine10Ud.get(b10) || 0) + nFlips);
      else fine10Du.set(b10, (fine10Du.get(b10) || 0) + nFlips);
    }

    const seqRes2 = await conn.runAndReadAll(`
      WITH ticks AS (
        SELECT
          condition_id,
          ts,
          CASE WHEN underlying_price > price_to_beat THEN 'U' ELSE 'D' END AS fav,
          EXTRACT(EPOCH FROM (
            TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP)
          )) AS t_in
        FROM read_parquet('${glob}')
        WHERE underlying_price IS NOT NULL
          AND price_to_beat IS NOT NULL
          AND price_to_beat > 1000
          AND (coverage IS NULL OR coverage >= 0.85)
      ),
      ordered AS (
        SELECT
          condition_id,
          ts,
          fav,
          t_in,
          lag(fav) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_fav
        FROM ticks
      ),
      event_ok AS (
        SELECT condition_id
        FROM ticks
        GROUP BY condition_id
        HAVING count(*) >= 80 AND max(t_in) >= 250
      ),
      runs AS (
        SELECT
          o.condition_id,
          o.fav,
          o.ts,
          row_number() OVER (PARTITION BY o.condition_id ORDER BY o.ts) AS run_i
        FROM ordered o
        INNER JOIN event_ok e USING (condition_id)
        WHERE o.prev_fav IS NULL OR o.fav <> o.prev_fav
      )
      SELECT condition_id, string_agg(fav, '-' ORDER BY run_i) AS sequence
      FROM runs
      GROUP BY condition_id
    `);

    const seqById = new Map();
    for (const r of seqRes2.getRowObjectsJson()) {
      seqById.set(String(r.condition_id), String(r.sequence));
    }

    const dayRows = res.getRowObjectsJson();
    for (const r of dayRows) {
      const flips = Number(r.flips);
      const flipsUd = Number(r.flips_ud);
      const flipsDu = Number(r.flips_du);
      const firstFav = String(r.first_fav);
      const lastFav = String(r.last_fav);
      const winner = String(r.winner);
      const seq = seqById.get(String(r.condition_id)) || firstFav;

      const ev = {
        day,
        condition_id: String(r.condition_id),
        event_start: String(r.event_start),
        n_ticks: Number(r.n_ticks),
        flips,
        flips_ud: flipsUd,
        flips_du: flipsDu,
        first_fav: firstFav,
        last_fav: lastFav,
        winner,
        first_equals_winner: firstFav === winner,
        last_equals_winner: lastFav === winner,
        net_flip: firstFav !== winner,
        sequence: seq,
        sequence_len: seq.split('-').length,
        flips_0_60: Number(r.flips_0_60),
        flips_60_120: Number(r.flips_60_120),
        flips_120_180: Number(r.flips_120_180),
        flips_180_240: Number(r.flips_180_240),
        flips_240_300: Number(r.flips_240_300),
        flips_last_60: Number(r.flips_last_60),
        flips_last_30: Number(r.flips_last_30),
        first_flip_t: r.first_flip_t == null ? null : Number(r.first_flip_t),
        last_flip_t: r.last_flip_t == null ? null : Number(r.last_flip_t),
      };
      events.push(ev);

      flipCountHist.set(flips, (flipCountHist.get(flips) || 0) + 1);
      upDownHist.set(flipsUd, (upDownHist.get(flipsUd) || 0) + 1);
      downUpHist.set(flipsDu, (downUpHist.get(flipsDu) || 0) + 1);
      seqCounts.set(seq, (seqCounts.get(seq) || 0) + 1);

      if (ev.first_flip_t != null) {
        const b = Math.min(4, Math.floor(ev.first_flip_t / 60));
        const key = `${b * 60}-${b * 60 + 60}s`;
        firstFlipBucket.set(key, (firstFlipBucket.get(key) || 0) + 1);
      }

      for (const [key, val] of [
        ['0-60s', ev.flips_0_60],
        ['60-120s', ev.flips_60_120],
        ['120-180s', ev.flips_120_180],
        ['180-240s', ev.flips_180_240],
        ['240-300s', ev.flips_240_300],
      ]) {
        flipTimeBuckets.set(key, (flipTimeBuckets.get(key) || 0) + val);
      }
    }

    daysOk += 1;
    console.error(`[${day}] events=${dayRows.length} ${Date.now() - t0}ms`);
  }

  const n = events.length;
  const flipArr = events.map((e) => e.flips);
  const udArr = events.map((e) => e.flips_ud);
  const duArr = events.map((e) => e.flips_du);
  const firstFlipArr = events.filter((e) => e.first_flip_t != null).map((e) => e.first_flip_t);
  const lastFlipArr = events.filter((e) => e.last_flip_t != null).map((e) => e.last_flip_t);

  const thresholds = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
  const cdf = {};
  for (const t of thresholds) {
    const lt = events.filter((e) => e.flips < t).length;
    const le = events.filter((e) => e.flips <= t).length;
    const ge = events.filter((e) => e.flips >= t).length;
    cdf[`flips_lt_${t}`] = { count: lt, pct: pct(lt, n) };
    cdf[`flips_le_${t}`] = { count: le, pct: pct(le, n) };
    cdf[`flips_ge_${t}`] = { count: ge, pct: pct(ge, n) };
  }
  cdf.flips_eq_0 = {
    count: events.filter((e) => e.flips === 0).length,
    pct: pct(events.filter((e) => e.flips === 0).length, n),
  };

  const topSequences = [...seqCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([sequence, count]) => ({
      sequence,
      count,
      pct: pct(count, n),
      flips: sequence.split('-').length - 1,
    }));

  // Compact sequence families by flip count pattern length
  const bySeqLen = new Map();
  for (const e of events) {
    const L = e.sequence_len;
    bySeqLen.set(L, (bySeqLen.get(L) || 0) + 1);
  }

  const winnerByFirst = {
    start_U_win_U: events.filter((e) => e.first_fav === 'U' && e.winner === 'U').length,
    start_U_win_D: events.filter((e) => e.first_fav === 'U' && e.winner === 'D').length,
    start_D_win_D: events.filter((e) => e.first_fav === 'D' && e.winner === 'D').length,
    start_D_win_U: events.filter((e) => e.first_fav === 'D' && e.winner === 'U').length,
  };

  // Cap hist at 30+ for readability
  const compactHist = (m) => {
    const out = {};
    let tail = 0;
    for (const [k, v] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
      if (k <= 30) out[String(k)] = v;
      else tail += v;
    }
    if (tail) out['31+'] = tail;
    return out;
  };

  const zeroFlip = events.filter((e) => e.flips === 0);
  const oneFlip = events.filter((e) => e.flips === 1);
  const multiFlip = events.filter((e) => e.flips >= 2);

  const bins10 = [];
  let totalFlipsTime = 0;
  for (let i = 0; i < 30; i++) {
    const c = fine10.get(i) || 0;
    totalFlipsTime += c;
    bins10.push({
      from_s: i * 10,
      to_s: i * 10 + 10,
      label: `${i * 10}-${i * 10 + 10}s`,
      flips: c,
      ud: fine10Ud.get(i) || 0,
      du: fine10Du.get(i) || 0,
    });
  }
  for (const b of bins10) {
    b.pct_of_flips = pct(b.flips, totalFlipsTime);
    b.flips_per_event = n ? b.flips / n : 0;
    b.rate_per_min_per_event = n ? (b.flips / n) * 6 : 0; // 10s → ×6 = per minute
  }

  const bins30 = [];
  for (let i = 0; i < 10; i++) {
    const c = fine30.get(i) || 0;
    bins30.push({
      from_s: i * 30,
      to_s: i * 30 + 30,
      label: `${i * 30}-${i * 30 + 30}s`,
      flips: c,
      pct_of_flips: pct(c, totalFlipsTime),
      flips_per_event: n ? c / n : 0,
      rate_per_min_per_event: n ? (c / n) * 2 : 0,
    });
  }

  // Cumulative from start / remaining density
  let cum = 0;
  const cumulativeFromStart = bins10.map((b) => {
    cum += b.flips;
    return {
      until_s: b.to_s,
      flips: cum,
      pct: pct(cum, totalFlipsTime),
    };
  });
  let rem = totalFlipsTime;
  const remainingAfter = bins10.map((b) => {
    const after = rem - b.flips;
    const row = {
      after_s: b.to_s,
      flips_remaining: after,
      pct_remaining: pct(after, totalFlipsTime),
    };
    rem = after;
    return row;
  });

  // Peak / trough
  const peak10 = [...bins10].sort((a, b) => b.flips - a.flips)[0];
  const trough10 = [...bins10].sort((a, b) => a.flips - b.flips)[0];
  const peak30 = [...bins30].sort((a, b) => b.flips - a.flips)[0];
  const trough30 = [...bins30].sort((a, b) => a.flips - b.flips)[0];

  // Half-life style: from which second do we have <50% of flips remaining?
  const halfCut = remainingAfter.find((r) => r.pct_remaining < 50);
  const quarterCut = remainingAfter.find((r) => r.pct_remaining < 25);
  const firstHalfFlips = bins30.slice(0, 5).reduce((a, b) => a + b.flips, 0);
  const secondHalfFlips = bins30.slice(5).reduce((a, b) => a + b.flips, 0);

  // Rate ratio early vs late (first 60s vs last 60s)
  const first60 = bins30.slice(0, 2).reduce((a, b) => a + b.flips, 0);
  const last60 = bins30.slice(8).reduce((a, b) => a + b.flips, 0);
  const mid180 = bins30.slice(2, 8).reduce((a, b) => a + b.flips, 0);

  const report = {
    meta: {
      underlying: 'BTC',
      interval: '5m',
      book_depth: 25,
      definition: 'Virada = mudança do favorito físico (spot > PTB → U, senão D) entre ticks consecutivos',
      filters: 'ptb>1000, coverage>=0.85 (ou null), n_ticks>=80, last_t>=250s',
      from: days[0],
      to: days[days.length - 1],
      days_partition: days.length,
      days_processed: daysOk,
      events: n,
      generated_at: new Date().toISOString(),
    },
    summary: {
      flips: summarize(flipArr),
      flips_up_to_down: summarize(udArr),
      flips_down_to_up: summarize(duArr),
      first_flip_t_sec: summarize(firstFlipArr),
      last_flip_t_sec: summarize(lastFlipArr),
      mean_ud: udArr.reduce((a, b) => a + b, 0) / n,
      mean_du: duArr.reduce((a, b) => a + b, 0) / n,
      pct_ud_of_all_flips: pct(
        udArr.reduce((a, b) => a + b, 0),
        flipArr.reduce((a, b) => a + b, 0),
      ),
      pct_du_of_all_flips: pct(
        duArr.reduce((a, b) => a + b, 0),
        flipArr.reduce((a, b) => a + b, 0),
      ),
    },
    timing: {
      total_flips: totalFlipsTime,
      bins_10s: bins10,
      bins_30s: bins30,
      cumulative_from_start: cumulativeFromStart,
      remaining_after: remainingAfter,
      peak_10s: peak10,
      trough_10s: trough10,
      peak_30s: peak30,
      trough_30s: trough30,
      first_half_0_150s: { flips: firstHalfFlips, pct: pct(firstHalfFlips, totalFlipsTime) },
      second_half_150_300s: { flips: secondHalfFlips, pct: pct(secondHalfFlips, totalFlipsTime) },
      first_60s: { flips: first60, pct: pct(first60, totalFlipsTime), rate_vs_avg: first60 / (totalFlipsTime / 5) },
      last_60s: { flips: last60, pct: pct(last60, totalFlipsTime), rate_vs_avg: last60 / (totalFlipsTime / 5) },
      middle_60_240s: { flips: mid180, pct: pct(mid180, totalFlipsTime) },
      after_which_lt_50pct_remain: halfCut,
      after_which_lt_25pct_remain: quarterCut,
      ratio_first60_vs_last60: last60 ? first60 / last60 : null,
    },
    rates: {
      zero_flips: { count: zeroFlip.length, pct: pct(zeroFlip.length, n) },
      exactly_1: { count: oneFlip.length, pct: pct(oneFlip.length, n) },
      exactly_2: {
        count: events.filter((e) => e.flips === 2).length,
        pct: pct(events.filter((e) => e.flips === 2).length, n),
      },
      ge_2: { count: multiFlip.length, pct: pct(multiFlip.length, n) },
      first_equals_winner: {
        count: events.filter((e) => e.first_equals_winner).length,
        pct: pct(events.filter((e) => e.first_equals_winner).length, n),
      },
      net_flip_first_ne_winner: {
        count: events.filter((e) => e.net_flip).length,
        pct: pct(events.filter((e) => e.net_flip).length, n),
      },
      had_flip_last_60s: {
        count: events.filter((e) => e.flips_last_60 > 0).length,
        pct: pct(events.filter((e) => e.flips_last_60 > 0).length, n),
      },
      had_flip_last_30s: {
        count: events.filter((e) => e.flips_last_30 > 0).length,
        pct: pct(events.filter((e) => e.flips_last_30 > 0).length, n),
      },
      winner_up: {
        count: events.filter((e) => e.winner === 'U').length,
        pct: pct(events.filter((e) => e.winner === 'U').length, n),
      },
      winner_down: {
        count: events.filter((e) => e.winner === 'D').length,
        pct: pct(events.filter((e) => e.winner === 'D').length, n),
      },
    },
    cdf_thresholds: cdf,
    histogram_flips: compactHist(flipCountHist),
    histogram_up_to_down: compactHist(upDownHist),
    histogram_down_to_up: compactHist(downUpHist),
    flip_timing_buckets_total_flips: Object.fromEntries(
      [...flipTimeBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    first_flip_bucket_events: Object.fromEntries(
      [...firstFlipBucket.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    sequence_length_distribution: Object.fromEntries(
      [...bySeqLen.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), { count: v, pct: pct(v, n) }]),
    ),
    top_sequences: topSequences,
    start_vs_winner: {
      ...winnerByFirst,
      pct_start_U_hold: pct(winnerByFirst.start_U_win_U, winnerByFirst.start_U_win_U + winnerByFirst.start_U_win_D),
      pct_start_D_hold: pct(winnerByFirst.start_D_win_D, winnerByFirst.start_D_win_D + winnerByFirst.start_D_win_U),
      pct_start_U: pct(winnerByFirst.start_U_win_U + winnerByFirst.start_U_win_D, n),
      pct_start_D: pct(winnerByFirst.start_D_win_D + winnerByFirst.start_D_win_U, n),
    },
    conditional: {
      mean_flips_when_winner_U: (() => {
        const xs = events.filter((e) => e.winner === 'U').map((e) => e.flips);
        return summarize(xs);
      })(),
      mean_flips_when_winner_D: (() => {
        const xs = events.filter((e) => e.winner === 'D').map((e) => e.flips);
        return summarize(xs);
      })(),
      mean_flips_when_net_flip: summarize(events.filter((e) => e.net_flip).map((e) => e.flips)),
      mean_flips_when_no_net_flip: summarize(events.filter((e) => !e.net_flip).map((e) => e.flips)),
      mean_flips_last60_given_any: summarize(
        events.filter((e) => e.flips_last_60 > 0).map((e) => e.flips_last_60),
      ),
    },
    by_day_mean_flips: (() => {
      const byDay = new Map();
      for (const e of events) {
        if (!byDay.has(e.day)) byDay.set(e.day, []);
        byDay.get(e.day).push(e.flips);
      }
      return [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, xs]) => ({
          day,
          events: xs.length,
          mean_flips: xs.reduce((a, b) => a + b, 0) / xs.length,
          pct_zero: pct(xs.filter((x) => x === 0).length, xs.length),
          pct_lt_3: pct(xs.filter((x) => x < 3).length, xs.length),
        }));
    })(),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    meta: report.meta,
    summary: report.summary,
    rates: report.rates,
    timing_headline: {
      peak_10s: report.timing.peak_10s,
      trough_10s: report.timing.trough_10s,
      peak_30s: report.timing.peak_30s,
      trough_30s: report.timing.trough_30s,
      first_half: report.timing.first_half_0_150s,
      second_half: report.timing.second_half_150_300s,
      first_60s: report.timing.first_60s,
      last_60s: report.timing.last_60s,
      after_lt_50pct: report.timing.after_which_lt_50pct_remain,
      after_lt_25pct: report.timing.after_which_lt_25pct_remain,
      ratio_first60_vs_last60: report.timing.ratio_first60_vs_last60,
      bins_30s: report.timing.bins_30s,
    },
    cdf_key: {
      flips_eq_0: report.cdf_thresholds.flips_eq_0,
      flips_lt_2: report.cdf_thresholds.flips_lt_2,
      flips_lt_3: report.cdf_thresholds.flips_lt_3,
      flips_lt_5: report.cdf_thresholds.flips_lt_5,
      flips_ge_5: report.cdf_thresholds.flips_ge_5,
      flips_ge_10: report.cdf_thresholds.flips_ge_10,
    },
    top_10_sequences: report.top_sequences.slice(0, 10),
    start_vs_winner: report.start_vs_winner,
    out: OUT,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
