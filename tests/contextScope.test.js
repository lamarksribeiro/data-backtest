import test from 'node:test';
import assert from 'node:assert/strict';

import { applyContextOptions, loadContext, saveContext } from '../public/js/utils/context.js';

test('scoped context does not overwrite the default backtest context', () => {
  installLocalStorageMock();

  saveContext({ underlying: 'BTC', interval: '5m', book_depth: '25' });
  saveContext({ underlying: 'ETH', interval: '1m', book_depth: '10' }, 'data');

  assert.equal(loadContext().underlying, 'BTC');
  assert.equal(loadContext().interval, '5m');
  assert.equal(loadContext('data').underlying, 'ETH');
  assert.equal(loadContext('data').interval, '1m');
});

test('applyContextOptions persists corrections only in the requested scope', () => {
  installLocalStorageMock();

  saveContext({ underlying: 'BTC', interval: '5m', book_depth: '25' });
  saveContext({ underlying: 'DOGE', interval: '5m', book_depth: '25' }, 'data');

  const dataContext = applyContextOptions(loadContext('data'), {
    underlyings: ['ETH'],
    intervals: ['5m'],
    book_depths: ['25'],
  }, 'data');

  assert.equal(dataContext.underlying, 'ETH');
  assert.equal(loadContext('data').underlying, 'ETH');
  assert.equal(loadContext().underlying, 'BTC');
});

function installLocalStorageMock() {
  const store = new Map();
  global.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}
