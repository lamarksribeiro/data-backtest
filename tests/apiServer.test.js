import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createApiServer } from '../src/api/server.js';
import { createPrepareJobRunner } from '../src/prepare/runner.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createTestAuthService, testServerConfig } from './testAuth.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeBacktestTicksParquet } from '../src/sync/duckdbParquet.js';
import { createStrategy, createStrategyVersion } from '../src/backtestStudio/state/strategies.js';

test('data-backtest API exposes health, availability and prepare plan', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-api-'));
  let server = null;
  try {
    const config = testServerConfig({
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
    });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
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

      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const health = await getJson(`${baseUrl}/healthz`);
      assert.equal(health.status, 'ok');
      assert.equal(health.manifest.by_status.valid, 1);

      const page = await fetch(`${baseUrl}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.match(await page.text(), /Data Runner/);

      const script = await fetch(`${baseUrl}/app.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);

      const availability = await getJson(`${baseUrl}/api/availability?dataset=backtest_ticks&from=2026-05-31&to=2026-06-02&underlying=BTC&interval=5m&book_depth=10`);
      assert.equal(availability.availability.ok, false);
      assert.deepEqual(availability.availability.missing, ['2026-06-01']);

      const prepare = await getJson(`${baseUrl}/api/prepare?dataset=backtest_ticks&from=2026-05-31&to=2026-06-02&underlying=BTC&interval=5m&book_depth=10`);
      assert.equal(prepare.result.status, 'prepare_required');
      assert.equal(prepare.result.preparation[0].command, 'sync:backfill-backtest-ticks');

      const contextOptions = await getJson(`${baseUrl}/api/context-options`);
      assert.deepEqual(contextOptions.options.lake.underlyings, ['BTC']);
      assert.deepEqual(contextOptions.options.lake.intervals, ['5m']);
      assert.deepEqual(contextOptions.options.lake.book_depths, ['10']);
      assert.deepEqual(contextOptions.options.underlyings, ['BTC']);
      assert.deepEqual(contextOptions.options.intervals, ['5m']);
      assert.deepEqual(contextOptions.options.book_depths, ['10']);
      assert.equal(contextOptions.options.source.underlyings.length, 0);
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
    const config = testServerConfig({
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
    });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      server = createApiServer({ config, db, authService });
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

test('data-backtest API creates and completes prepare jobs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-api-job-'));
  let server = null;
  try {
    const config = testServerConfig({
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
    });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      const prepareRunner = createPrepareJobRunner({
        config,
        db,
        executeActions: async ({ actions, dryRun }) => actions.map((action) => ({ command: action.command, dryRun })),
      });
      server = createApiServer({ config, db, prepareRunner, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const created = await postJson(`${baseUrl}/api/prepare/run`, {
        request: {
          dataset: 'backtest_ticks',
          from: '2026-05-31',
          to: '2026-06-01',
          underlying: 'BTC',
          interval: '5m',
          book_depth: 10,
        },
        dry_run: true,
      }, 202);
      assert.equal(created.job.status, 'queued');

      await prepareRunner.waitForIdle();
      const completed = await getJson(`${baseUrl}/api/prepare/jobs/${created.job.id}`);
      assert.equal(completed.job.status, 'completed');
      assert.equal(completed.job.result.actions[0].command, 'sync:backfill-backtest-ticks');
      assert.equal(completed.job.result.actions[0].dryRun, true);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('data-backtest API requires confirmation for real rebuild jobs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-api-rebuild-'));
  let server = null;
  try {
    const config = testServerConfig({
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
    });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 10,
        dt: '2026-05-31',
        activePath: '/lake/backtest_ticks/stale.parquet',
        status: 'stale',
      });
      const prepareRunner = createPrepareJobRunner({
        config,
        db,
        executeActions: async ({ actions, dryRun }) => actions.map((action) => ({
          command: action.command,
          dryRun,
          args: action.args,
        })),
      });
      server = createApiServer({ config, db, prepareRunner, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const prepare = await getJson(`${baseUrl}/api/prepare?dataset=backtest_ticks&from=2026-05-31&to=2026-06-01&underlying=BTC&interval=5m&book_depth=10&rebuild=true`);
      assert.equal(prepare.result.status, 'prepare_required');
      assert.ok(prepare.result.preparation[0].args.includes('--rebuild'));

      const rejected = await postJson(`${baseUrl}/api/prepare/run`, {
        request: {
          dataset: 'backtest_ticks',
          from: '2026-05-31',
          to: '2026-06-01',
          underlying: 'BTC',
          interval: '5m',
          book_depth: 10,
          rebuild: true,
        },
        dry_run: false,
      }, 400);
      assert.equal(rejected.error.code, 'CONFIRMATION_REQUIRED');

      const created = await postJson(`${baseUrl}/api/prepare/run`, {
        request: {
          dataset: 'backtest_ticks',
          from: '2026-05-31',
          to: '2026-06-01',
          underlying: 'BTC',
          interval: '5m',
          book_depth: 10,
          rebuild: true,
        },
        dry_run: false,
        confirm_rebuild: 'REBUILD_PARTITIONS',
      }, 202);

      await prepareRunner.waitForIdle();
      const completed = await getJson(`${baseUrl}/api/prepare/jobs/${created.job.id}`);
      assert.equal(completed.job.status, 'completed');
      assert.equal(completed.job.result.actions[0].dryRun, false);
      assert.ok(completed.job.result.actions[0].args.includes('--rebuild'));
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('data-backtest API runs versioned strategy only when data is ready', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-api-run-'));
  let server = null;
  try {
    const config = testServerConfig({
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
      backtestBookDepth: 2,
    });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const strategy = createStrategy(db, { slug: 'api-gls', name: 'API GLS' });
      const version = createStrategyVersion(db, strategy.id, {
        source_code: `strategy "API GLS" {
          param minDistanceAbs = 5
          onEventStart(event) { state.entered = false }
          onTick(tick, event) {
            let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
            let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
            let ask = book.ask(side, tick)
            if (!state.entered && dist >= params.minDistanceAbs) {
              enter(side, { price: ask, budget: 10, reason: "entry" })
              state.entered = true
            }
          }
          onEventEnd(event) { closeOpenPosition({ reason: "event_end" }) }
        }`,
      });

      const blocked = await postJson(`${baseUrl}/api/backtest/run`, {
        strategy_id: strategy.id,
        strategy_version_id: version.id,
        from: '2026-05-31',
        to: '2026-06-01',
        underlying: 'BTC',
        interval: '5m',
        book_depth: 2,
      }, 409);
      assert.equal(blocked.error.code, 'DATA_NOT_READY');
      assert.deepEqual(blocked.availability.missing, ['2026-05-31']);

      const parquetPath = path.join(dir, 'lake', 'backtest_ticks', 'part-test.parquet');
      await writeBacktestTicksParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'backtest_ticks.parquet'),
        finalPath: parquetPath,
        bookDepth: 2,
        rows: Array.from({ length: 12 }, (_, index) => makeBacktestTickRow(`2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`, 73400 + index)),
      });
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        dt: '2026-05-31',
        activePath: toPortablePath(parquetPath),
        rows: 12,
        status: 'valid',
      });

      const completed = await postJson(`${baseUrl}/api/backtest/run`, {
        strategy_id: strategy.id,
        strategy_version_id: version.id,
        from: '2026-05-31',
        to: '2026-06-01',
        underlying: 'BTC',
        interval: '5m',
        book_depth: 2,
        batch_size: 5,
      });
      assert.equal(completed.result.strategy, 'API GLS');
      assert.equal(completed.result.ticks, 12);
      assert.equal(completed.result.batches, 3);
      assert.equal(completed.run.id, 1);
      assert.equal(completed.run.result.ticks, 12);
      assert.equal(completed.run.strategy_id, strategy.id);

      const runs = await getJson(`${baseUrl}/api/backtest/runs`);
      assert.equal(runs.runs.length, 1);
      assert.equal(runs.runs[0].id, 1);
      assert.equal(runs.runs[0].ticks, 12);

      const byStrategy = await getJson(`${baseUrl}/api/backtest/runs?strategy_id=${strategy.id}&strategy_version_id=${version.id}`);
      assert.equal(byStrategy.runs.length, 1);
      assert.equal(byStrategy.runs[0].strategy_version_id, version.id);

      const byStatus = await getJson(`${baseUrl}/api/backtest/runs?status=completed&underlying=BTC&interval=5m`);
      assert.equal(byStatus.runs.length, 1);

      const noMatches = await getJson(`${baseUrl}/api/backtest/runs?underlying=ETH`);
      assert.equal(noMatches.runs.length, 0);
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

async function postJson(url, body, expectedStatus = 200) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, expectedStatus);
  return res.json();
}

function makeBacktestTickRow(ts, underlyingPrice) {
  return {
    marketId: 'market-1',
    underlying: 'BTC',
    interval: '5m',
    conditionId: 'condition-1',
    eventStart: '2026-05-31T00:00:00.000Z',
    eventEnd: '2026-05-31T00:05:00.000Z',
    ts,
    underlyingPrice,
    priceToBeat: underlyingPrice,
    upPrice: 0.51,
    downPrice: 0.49,
    upBestBid: 0.5,
    upBestAsk: 0.52,
    downBestBid: 0.48,
    downBestAsk: 0.5,
    coverage: 1,
    degraded: false,
    up_ask_px_1: 0.52,
    up_ask_sz_1: 50,
    up_ask_px_2: 0.53,
    up_ask_sz_2: 50,
    up_bid_px_1: 0.5,
    up_bid_sz_1: 50,
    up_bid_px_2: 0.49,
    up_bid_sz_2: 50,
    down_ask_px_1: 0.51,
    down_ask_sz_1: 50,
    down_ask_px_2: 0.52,
    down_ask_sz_2: 50,
    down_bid_px_1: 0.48,
    down_bid_sz_1: 50,
    down_bid_px_2: 0.47,
    down_bid_sz_2: 50,
  };
}
