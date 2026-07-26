/**
 * Etapa 3: Taker Rebate como sistema (tier), não taxa constante.
 *
 * Docs: https://docs.polymarket.com/trading/taker-rebates
 * Diamond = 44% das fees taker; payout diário 00:00 UTC (rebate do dia D ≈ 44% das fees do dia D-1).
 *
 * Usage:
 *   node labs/sandbox/doggy-rebate-tier.mjs [--fetch]
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.tmp/pair-ladder-re');
const WALLET = '0x0484e64092ba4108c2786b61e6fc052d3bf41b1a';
const CRYPTO_WEIGHT = 2.3;
const TIERS = [
  { tier: 0, name: 'None', wv: 0, rebate: 0 },
  { tier: 1, name: 'Bronze', wv: 2_000, rebate: 0.03 },
  { tier: 2, name: 'Silver', wv: 20_000, rebate: 0.08 },
  { tier: 3, name: 'Gold', wv: 200_000, rebate: 0.18 },
  { tier: 4, name: 'Platinum', wv: 1_000_000, rebate: 0.32 },
  { tier: 5, name: 'Diamond', wv: 4_000_000, rebate: 0.44 },
  { tier: 6, name: 'Obsidian', wv: 10_000_000, rebate: 0.50 },
];

const args = new Set(process.argv.slice(2));
const fetchMore = args.has('--fetch');
fs.mkdirSync(OUT, { recursive: true });

function utcDay(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}
function prevUtcDay(day) {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function tierForWv(wv) {
  let hit = TIERS[0];
  for (const t of TIERS) {
    if (wv >= t.wv) hit = t;
  }
  return hit;
}

async function fetchActivity(limitPages = 40) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < limitPages; page += 1) {
    const offset = page * 100;
    const url = `https://data-api.polymarket.com/activity?user=${WALLET}&limit=100&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`activity ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    let novel = 0;
    for (const row of batch) {
      const key = `${row.type}|${row.transactionHash}|${row.timestamp}|${row.asset}|${row.size}|${row.price}|${row.usdcSize}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(row);
      novel += 1;
    }
    process.stdout.write(`fetch page ${page} +${novel} total ${all.length}\n`);
    if (batch.length < 100 || novel === 0) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  return all;
}

function loadActivity() {
  const p = path.join(OUT, 'doggy-activity-fresh.json');
  if (!fs.existsSync(p)) throw new Error('missing doggy-activity-fresh.json — run with --fetch');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function tradeFee(t) {
  // Activity BUY: usdcSize includes crypto taker fee → fee = usdc − price×size
  return (t.usdcSize || 0) - (t.price * t.size);
}

function tradeNotional(t) {
  // Docs: Trade Size = shares × entry price (pre-fee)
  return t.price * t.size;
}

function tradeWv(t, categoryWeight = CRYPTO_WEIGHT) {
  const size = tradeNotional(t);
  const upside = 1 - t.price;
  if (!(size > 0) || !(upside >= 0)) return 0;
  return size * upside * categoryWeight;
}

function analyze(rows) {
  const trades = rows.filter((r) => r.type === 'TRADE' && r.side === 'BUY');
  const btcTrades = trades.filter((r) => /btc-updown-5m/i.test(r.slug || ''));
  const rebates = rows.filter((r) => r.type === 'TAKER_REBATE');
  const redeems = rows.filter((r) => r.type === 'REDEEM' && /btc-updown-5m/i.test(r.slug || ''));

  const byDay = new Map();
  const ensure = (d) => {
    if (!byDay.has(d)) {
      byDay.set(d, {
        day: d,
        feeAll: 0,
        feeBtc: 0,
        notionalAll: 0,
        notionalBtc: 0,
        nAll: 0,
        nBtc: 0,
        wvBtc: 0,
        rebatePaid: 0,
        rebateN: 0,
        redeemUsdc: 0,
        buyUsdcBtc: 0,
      });
    }
    return byDay.get(d);
  };

  for (const t of trades) {
    const d = utcDay(t.timestamp);
    const row = ensure(d);
    const fee = tradeFee(t);
    const notional = tradeNotional(t);
    row.feeAll += fee;
    row.notionalAll += notional;
    row.nAll += 1;
    if (/btc-updown-5m/i.test(t.slug || '')) {
      row.feeBtc += fee;
      row.notionalBtc += notional;
      row.nBtc += 1;
      row.wvBtc += tradeWv(t);
      row.buyUsdcBtc += t.usdcSize || 0;
    }
  }
  for (const r of rebates) {
    const d = utcDay(r.timestamp);
    const row = ensure(d);
    row.rebatePaid += r.usdcSize || 0;
    row.rebateN += 1;
  }
  for (const r of redeems) {
    const d = utcDay(r.timestamp);
    const row = ensure(d);
    row.redeemUsdc += r.usdcSize || 0;
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const lagMatches = [];
  for (const day of days) {
    if (!(day.rebatePaid > 0)) continue;
    const priorKey = prevUtcDay(day.day);
    const prior = byDay.get(priorKey);
    const priorFee = prior?.feeBtc ?? null;
    const priorFeeAll = prior?.feeAll ?? null;
    // Prefer BTC-only if rebate≈44% of BTC fees; else all trades
    let basis = 'btc';
    let feeBasis = priorFee;
    let rate = priorFee > 0 ? day.rebatePaid / priorFee : null;
    if (rate == null || Math.abs(rate - 0.44) > 0.08) {
      if (priorFeeAll > 0) {
        const rateAll = day.rebatePaid / priorFeeAll;
        if (rate == null || Math.abs(rateAll - 0.44) < Math.abs((rate ?? 99) - 0.44)) {
          basis = 'all';
          feeBasis = priorFeeAll;
          rate = rateAll;
        }
      }
    }
    // Incomplete prior day in sample: impute fee from Diamond 44%
    const imputedPriorFee = day.rebatePaid / 0.44;
    // Prior day is "complete" only if lag-rate ≈ a known tier (else sample truncated).
    const nearTier = rate != null && TIERS.some((t) => t.rebate > 0 && Math.abs(rate - t.rebate) < 0.03);
    lagMatches.push({
      rebateDay: day.day,
      rebateUsd: day.rebatePaid,
      priorDay: priorKey,
      priorFeeInSample: feeBasis,
      priorFeeBasis: basis,
      priorComplete: prior != null && nearTier,
      effectiveRate: rate,
      vsDiamond44: rate != null ? rate - 0.44 : null,
      vsObsidian50: rate != null ? rate - 0.50 : null,
      imputedPriorFeeIfDiamond: imputedPriorFee,
      absErrVs44: rate != null ? Math.abs(rate - 0.44) : null,
      nearTier,
    });
  }

  // Naive same-day rate (WRONG — used in Iter G as ~76%)
  const naiveSameDay = days
    .filter((d) => d.rebatePaid > 0 && d.feeBtc > 0)
    .map((d) => ({
      day: d.day,
      rate: d.rebatePaid / d.feeBtc,
      rebate: d.rebatePaid,
      fee: d.feeBtc,
    }));

  const totalFeeBtc = btcTrades.reduce((s, t) => s + tradeFee(t), 0);
  const totalRebate = rebates.reduce((s, r) => s + (r.usdcSize || 0), 0);
  const totalWvBtc = btcTrades.reduce((s, t) => s + tradeWv(t), 0);
  const totalNotionalBtc = btcTrades.reduce((s, t) => s + tradeNotional(t), 0);

  // Best lag-matched rates (complete prior days only)
  const completeRates = lagMatches.filter((m) => m.priorComplete && m.effectiveRate != null);
  const bestRate = completeRates.length
    ? mean(completeRates.map((m) => m.effectiveRate))
    : mean(lagMatches.filter((m) => m.effectiveRate != null).map((m) => m.effectiveRate));

  // Extrapolate 30d wV from sample daily mean (rough)
  const sampleDays = days.filter((d) => d.nBtc > 0).length;
  const meanDailyWv = sampleDays ? totalWvBtc / sampleDays : 0;
  const projected30dWv = meanDailyWv * 30;
  const projectedTier = tierForWv(projected30dWv);

  // PnL stack with correct Diamond 44% vs wrong 76%
  const buyUsdc = btcTrades.reduce((s, t) => s + (t.usdcSize || 0), 0);
  const redeemUsdc = redeems.reduce((s, r) => s + (r.usdcSize || 0), 0);
  // buyUsdc already includes fees; redeem - buy = pnl after fees, before rebate
  const pnlAfterFees = redeemUsdc - buyUsdc;
  const feeEmbedded = totalFeeBtc;
  const pnlPreFee = pnlAfterFees + feeEmbedded;
  const rebateIf44 = feeEmbedded * 0.44;
  const rebateIf50 = feeEmbedded * 0.50;
  const rebateIf76 = feeEmbedded * 0.76;
  // Observed rebates in window (may cover fees outside incomplete days)
  const pnlWithObservedRebate = pnlAfterFees + totalRebate;
  const pnlWith44OnSampleFees = pnlAfterFees + rebateIf44;

  const rules = [];
  rules.push('Docs oficiais: Diamond rebate = 44% das fees taker; Obsidian = 50%; payout diário 00:00 UTC.');
  rules.push('wV = TradeSize × (1 − price) × categoryWeight; Crypto weight = 2.3.');
  if (completeRates.length) {
    rules.push(
      `Lag-match (rebate_D / fee_BTC_{D-1}) médio = ${(bestRate * 100).toFixed(2)}%`
      + ` em ${completeRates.length} dia(s) completo(s) → house = Diamond 44%.`,
    );
  }
  for (const m of lagMatches) {
    if (m.absErrVs44 != null && m.absErrVs44 < 0.01) {
      rules.push(
        `${m.rebateDay}: rebate $${m.rebateUsd.toFixed(2)} / fee ${m.priorDay} $${Number(m.priorFeeInSample).toFixed(2)}`
        + ` = ${(m.effectiveRate * 100).toFixed(2)}% (Δ vs 44¢ = ${(m.vsDiamond44 * 100).toFixed(2)} pp).`,
      );
    } else if (!m.priorComplete) {
      rules.push(
        `${m.rebateDay}: rebate $${m.rebateUsd.toFixed(2)} → fee imputada ${m.priorDay} ≈ $${m.imputedPriorFeeIfDiamond.toFixed(0)} @ Diamond 44% (amostra incompleta).`,
      );
    }
  }
  const naiveMean = mean(naiveSameDay.map((x) => x.rate));
  if (naiveMean != null) {
    rules.push(
      `Artefato Iter G: mesma-janela rebate/fee ≈ ${(naiveMean * 100).toFixed(0)}% (ex. “76%”) — ERRADO porque rebate_D cobre fees_{D-1}.`,
    );
  }
  rules.push(
    `Lab: usar takerRebateRate=0.44 (Diamond), não 0.76. Overlay Obsidian=0.50 só se badge Obsidian.`,
  );
  rules.push(
    `Projeção wV 30d (sample×30) ≈ $${projected30dWv.toFixed(0)} → tier ${projectedTier.name} (threshold $${projectedTier.wv.toLocaleString()}).`,
  );

  return {
    asOf: new Date().toISOString(),
    wallet: WALLET,
    docs: {
      url: 'https://docs.polymarket.com/trading/taker-rebates',
      diamondRebate: 0.44,
      obsidianRebate: 0.50,
      cryptoWeight: CRYPTO_WEIGHT,
      formula: 'wV = TradeSize × (1 − price) × categoryWeight × bonuses',
      payout: 'daily midnight UTC',
      tiers: TIERS,
    },
    sample: {
      nRows: rows.length,
      nTradesAll: trades.length,
      nTradesBtc: btcTrades.length,
      nRebates: rebates.length,
      nRedeemsBtc: redeems.length,
      daySpan: days.filter((d) => d.nBtc > 0).map((d) => d.day),
    },
    totals: {
      feeBtc: totalFeeBtc,
      notionalBtc: totalNotionalBtc,
      wvBtc: totalWvBtc,
      rebateObserved: totalRebate,
      naiveRebateOverFee: totalFeeBtc > 0 ? totalRebate / totalFeeBtc : null,
    },
    days,
    lagMatches,
    naiveSameDay,
    lagMatchedRateMean: bestRate,
    projected30d: {
      meanDailyWv,
      wv30d: projected30dWv,
      tier: projectedTier,
      diamondGap: Math.max(0, 4_000_000 - projected30dWv),
      obsidianGap: Math.max(0, 10_000_000 - projected30dWv),
    },
    pnlStack: {
      buyUsdc,
      redeemUsdc,
      feeEmbedded,
      pnlPreFee,
      pnlAfterFees,
      rebateObserved: totalRebate,
      pnlWithObservedRebate,
      rebateIfDiamond44: rebateIf44,
      rebateIfObsidian50: rebateIf50,
      rebateIfWrong76: rebateIf76,
      pnlWithDiamond44: pnlWith44OnSampleFees,
      pnlWithWrong76: pnlAfterFees + rebateIf76,
      overstatement76vs44: rebateIf76 - rebateIf44,
    },
    inferredRules: rules,
  };
}

async function main() {
  let rows = fetchMore ? await fetchActivity(40) : loadActivity();
  if (fetchMore) {
    fs.writeFileSync(path.join(OUT, 'doggy-activity-fresh.json'), JSON.stringify(rows));
  }

  const summary = analyze(rows);
  const canvas = {
    asOf: summary.asOf,
    diamond: 0.44,
    obsidian: 0.5,
    lagMatchedRateMean: summary.lagMatchedRateMean,
    lagMatches: summary.lagMatches.map((m) => ({
      rebateDay: m.rebateDay,
      rebateUsd: Math.round(m.rebateUsd * 100) / 100,
      priorDay: m.priorDay,
      priorFee: m.priorFeeInSample != null ? Math.round(m.priorFeeInSample * 100) / 100 : null,
      ratePct: m.effectiveRate != null ? Math.round(m.effectiveRate * 10000) / 100 : null,
      complete: m.priorComplete,
      imputedFee: Math.round(m.imputedPriorFeeIfDiamond),
    })),
    naiveSameDay: summary.naiveSameDay.map((x) => ({
      day: x.day,
      ratePct: Math.round(x.rate * 1000) / 10,
    })),
    pnl: {
      afterFees: Math.round(summary.pnlStack.pnlAfterFees * 100) / 100,
      with44: Math.round(summary.pnlStack.pnlWithDiamond44 * 100) / 100,
      with76: Math.round(summary.pnlStack.pnlWithWrong76 * 100) / 100,
      withObserved: Math.round(summary.pnlStack.pnlWithObservedRebate * 100) / 100,
      overstatement76: Math.round(summary.pnlStack.overstatement76vs44 * 100) / 100,
      feeEmbedded: Math.round(summary.pnlStack.feeEmbedded * 100) / 100,
    },
    projected: {
      wv30d: Math.round(summary.projected30d.wv30d),
      tier: summary.projected30d.tier.name,
      rebate: summary.projected30d.tier.rebate,
    },
    rules: summary.inferredRules,
    tiers: TIERS.map((t) => ({ name: t.name, wv: t.wv, rebatePct: t.rebate * 100 })),
  };

  // Round day numbers for JSON readability
  summary.days = summary.days.map((d) => ({
    ...d,
    feeAll: Math.round(d.feeAll * 100) / 100,
    feeBtc: Math.round(d.feeBtc * 100) / 100,
    notionalAll: Math.round(d.notionalAll * 100) / 100,
    notionalBtc: Math.round(d.notionalBtc * 100) / 100,
    wvBtc: Math.round(d.wvBtc * 100) / 100,
    rebatePaid: Math.round(d.rebatePaid * 100) / 100,
    redeemUsdc: Math.round(d.redeemUsdc * 100) / 100,
    buyUsdcBtc: Math.round(d.buyUsdcBtc * 100) / 100,
  }));

  fs.writeFileSync(path.join(OUT, 'doggy-rebate-tier.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'doggy-rebate-tier-canvas.json'), JSON.stringify(canvas, null, 2));

  console.log(JSON.stringify({
    lagMatches: summary.lagMatches,
    lagMatchedRateMean: summary.lagMatchedRateMean,
    naiveSameDay: summary.naiveSameDay,
    pnlStack: summary.pnlStack,
    projected30d: summary.projected30d,
    rules: summary.inferredRules,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
