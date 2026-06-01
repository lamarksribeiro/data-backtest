import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createApiServer } from '../src/api/server.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';

test('data-backtest API exposes health, availability and prepare plan', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-api-'));
  let server = null;
  try {
    const config = {
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
      backtestDataMode: 'strict',
      backtestBookDepth: 10,
    };
    const db = openStateDatabase(config.stateDbPath);
    try {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 10,
        dt: '2026-05-31',
        activePath: '/lake/backtest_ticks/part.parquet',
        status: 'valid',
      });

      server = createApiServer({ config, db });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const health = await getJson(`${baseUrl}/healthz`);
      assert.equal(health.status, 'ok');
      assert.equal(health.manifest.by_status.valid, 1);

      const page = await fetch(`${baseUrl}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.match(await page.text(), /Preparacao de dados/);

      const script = await fetch(`${baseUrl}/app.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);

      const availability = await getJson(`${baseUrl}/api/availability?dataset=backtest_ticks&from=2026-05-31&to=2026-06-02&underlying=BTC&interval=5m&book_depth=10`);
      assert.equal(availability.availability.ok, false);
      assert.deepEqual(availability.availability.missing, ['2026-06-01']);

      const prepare = await getJson(`${baseUrl}/api/prepare?dataset=backtest_ticks&from=2026-05-31&to=2026-06-02&underlying=BTC&interval=5m&book_depth=10`);
      assert.equal(prepare.result.status, 'prepare_required');
      assert.equal(prepare.result.preparation[0].command, 'sync:backfill-backtest-ticks');
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('data-backtest API returns 400 for invalid requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-api-invalid-'));
  let server = null;
  try {
    const config = {
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
      backtestDataMode: 'strict',
      backtestBookDepth: 10,
    };
    const db = openStateDatabase(config.stateDbPath);
    try {
      server = createApiServer({ config, db });
      await new Promise((resolve) => server.listen(0, resolve));
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/availability?dataset=backtest_ticks`);
      const body = await res.json();

      assert.equal(res.status, 400);
      assert.match(body.error.message, /from is required/);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

async function getJson(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}
