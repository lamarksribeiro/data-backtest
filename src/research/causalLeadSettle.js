/**
 * Primitivas puras do candidato research-only Binance Lead -> Settlement.
 * Nenhuma função envia ordens ou acessa credenciais.
 */

export function binanceTimestampToAvailableSec(rawTimestamp, mode = 'close') {
  const timestamp = Number(rawTimestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (!['close', 'open-legacy'].includes(mode)) return null;

  if (mode === 'open-legacy') {
    const milliseconds = timestamp > 1e14 ? Math.floor(timestamp / 1000) : timestamp;
    return Math.floor(milliseconds / 1000);
  }

  // Binance Vision recente usa microssegundos; dumps antigos podem usar ms.
  // ceil impede que o close xx:xx:00.999999 seja visível antes de xx:xx:01.
  return timestamp > 1e14
    ? Math.ceil(timestamp / 1e6)
    : Math.ceil(timestamp / 1000);
}

export function cryptoTakerFee(shares, price, feeRate = 0.07) {
  const c = Number(shares);
  const p = Number(price);
  const rate = Number(feeRate);
  if (!(c > 0 && p > 0 && p < 1 && rate >= 0)) return 0;
  return c * rate * p * (1 - p);
}

export function cappedShares(budget, ask, sharesCap = 10) {
  const notional = Number(budget);
  const price = Number(ask);
  const cap = Number(sharesCap);
  if (!(notional > 0 && price > 0 && price < 1 && cap > 0)) return 0;
  return Math.min(notional / price, cap);
}

export function settlementPnl({
  ask,
  shares,
  won,
  feeRate = 0.07,
}) {
  const price = Number(ask);
  const count = Number(shares);
  if (!(price > 0 && price < 1 && count > 0)) return null;
  const cost = price * count;
  const fee = cryptoTakerFee(count, price, feeRate);
  const payout = won ? count : 0;
  return {
    cost,
    fee,
    payout,
    grossPnl: payout - cost,
    netPnl: payout - cost - fee,
  };
}

