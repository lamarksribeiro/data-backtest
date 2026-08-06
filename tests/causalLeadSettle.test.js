import assert from 'node:assert/strict';
import test from 'node:test';

import {
  binanceTimestampToAvailableSec,
  cappedShares,
  cryptoTakerFee,
  settlementPnl,
} from '../src/research/causalLeadSettle.js';

test('close da kline Binance em microssegundos só fica disponível no segundo seguinte', () => {
  assert.equal(binanceTimestampToAvailableSec(1777593600999999, 'close'), 1777593601);
  assert.equal(binanceTimestampToAvailableSec(1777593600000000, 'open-legacy'), 1777593600);
});

test('timestamp Binance em milissegundos também usa teto no modo causal', () => {
  assert.equal(binanceTimestampToAvailableSec(1777593600999, 'close'), 1777593601);
  assert.equal(binanceTimestampToAvailableSec(0, 'close'), null);
  assert.equal(binanceTimestampToAvailableSec(1777593600999, 'inválido'), null);
});

test('taxa taker crypto segue shares * 0.07 * p * (1-p)', () => {
  assert.equal(cryptoTakerFee(10, 0.35), 0.15925);
  assert.equal(cryptoTakerFee(10, 1), 0);
});

test('sizing limita a 10 shares e nunca amplia ask barato', () => {
  assert.equal(cappedShares(5, 0.35, 10), 10);
  assert.equal(cappedShares(5, 0.5, 10), 10);
  assert.equal(cappedShares(5, 0.6, 10), 5 / 0.6);
});

test('PnL de settlement contabiliza custo e taxa apenas na entrada', () => {
  const win = settlementPnl({ ask: 0.35, shares: 10, won: true });
  const loss = settlementPnl({ ask: 0.35, shares: 10, won: false });
  assert.equal(win.grossPnl, 6.5);
  assert.equal(win.netPnl, 6.34075);
  assert.equal(loss.grossPnl, -3.5);
  assert.equal(loss.netPnl, -3.65925);
});

