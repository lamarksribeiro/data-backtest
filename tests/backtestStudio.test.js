import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createApiServer } from '../src/api/server.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createTestAuthService, testServerConfig } from './testAuth.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeBacktestTicksParquet } from '../src/sync/duckdbParquet.js';
import { createBacktestRun } from '../src/state/backtestRuns.js';
import { runBacktest } from '../src/backtest/engine.js';
import { listEventTraces } from '../src/backtestStudio/state/eventTraces.js';
import {
  createStrategy,
  createStrategyVersion,
  deleteStrategy,
  deleteStrategyVersion,
  listTrashedStrategies,
  permanentlyDeleteStrategy,
  restoreStrategy,
  trashStrategy,
  listStrategies,
  updateStrategy,
  validateStrategySource,
} from '../src/backtestStudio/state/strategies.js';
import { seedEdgeSniperV2Strategy } from '../src/backtestStudio/gls/seedStrategies.js';
import { getStrategyStats } from '../src/backtestStudio/state/strategyStats.js';

test('persistEventTraces normalizes native runner events', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-traces-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const result = {
        strategy: 'EDGE_SNIPER_V2',
        events: [{
          eventId: 'condition-1',
          eventStart: '2026-05-31T00:00:00.000Z',
          eventEnd: '2026-05-31T00:05:00.000Z',
          positionType: null,
          finalPnl: 0,
          reason: 'no_entry',
          closedAt: '2026-05-31T00:05:00.000Z',
          orders: [],
          exits: [],
        }],
        log: [{ ts: '2026-05-31T00:00:01.000Z', msg: 'Evento', type: 'info' }],
      };
      const run = createBacktestRun(db, {
        request: { batchSize: 5, params: {} },
        result: {
          strategy: 'EDGE_SNIPER_V2',
          source: 'lakehouse',
          underlying: 'BTC',
          interval: '5m',
          bookDepth: 2,
          from: '2026-05-31T00:00:00.000Z',
          to: '2026-05-31T00:05:00.000Z',
          ticks: 1,
          batches: 1,
          summary: { totalEvents: 1 },
          ...result,
        },
      });
      const events = listEventTraces(db, run.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].condition_id, 'condition-1');
      assert.equal(events[0].result, 'no_entry');
      assert.equal(events[0].entries_count, 0);
      assert.equal(events[0].ticks_count, 1);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('backtest studio API exposes run detail, events and chart-data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-studio-api-'));
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

      const result = await runBacktest(db, {
        strategy: 'edge-sniper-v2',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 2,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T00:00:12.000Z',
        batchSize: 5,
      });
      const run = createBacktestRun(db, {
        request: { batchSize: 5, params: {} },
        result,
      });

      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const detail = await getJson(`${baseUrl}/api/backtest/runs/${run.id}`);
      assert.equal(detail.run.id, run.id);
      assert.ok(Array.isArray(detail.run.equity));
      const full = await getJson(`${baseUrl}/api/backtest/runs/${run.id}?full=1`);
      assert.equal(full.run.result.strategy, 'EDGE_SNIPER_V2');

      const events = await getJson(`${baseUrl}/api/backtest/runs/${run.id}/events`);
      assert.equal(events.events.length, 1);
      assert.equal(events.events[0].condition_id, 'condition-1');
      assert.equal(events.events[0].result, 'no_entry');

      const eventDetail = await getJson(`${baseUrl}/api/backtest/runs/${run.id}/events/${events.events[0].id}`);
      assert.equal(eventDetail.event.condition_id, 'condition-1');
      assert.equal(eventDetail.event.result, 'no_entry');
      assert.ok(eventDetail.event.summary);
      assert.ok(Array.isArray(eventDetail.event.orders));
      assert.ok(Array.isArray(eventDetail.event.logs));

      const chart = await getJson(`${baseUrl}/api/backtest/runs/${run.id}/chart-data?condition_id=condition-1`);
      assert.equal(chart.series.underlying.length, 12);
      assert.equal(chart.series.priceToBeat.length, 12);
      assert.ok(Array.isArray(chart.series.bid));
      assert.ok(Array.isArray(chart.series.ask));
      assert.ok(chart.event);
      assert.ok(Array.isArray(chart.orders));
      assert.ok(Array.isArray(chart.marks));
      assert.ok(Array.isArray(chart.logs));

      const chartByEvent = await getJson(`${baseUrl}/api/backtest/runs/${run.id}/chart-data?event_id=${events.events[0].id}`);
      assert.equal(chartByEvent.event.id, events.events[0].id);
      assert.equal(chartByEvent.series.underlying.length, 12);

      const missing = await fetch(`${baseUrl}/api/backtest/runs/${run.id}/chart-data`);
      assert.equal(missing.status, 400);

      const notFound = await fetch(`${baseUrl}/api/backtest/runs/999/events`);
      assert.equal(notFound.status, 404);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('strategy CRUD API creates definitions and versions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-strategies-'));
  let server = null;
  try {
    const config = testServerConfig({
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
    });
    const db = openStateDatabase(config.stateDbPath);
    const authService = createTestAuthService(db);
    try {
      const strategy = createStrategy(db, {
        slug: 'simple-ptb',
        name: 'Simple PTB',
        description: 'Test strategy',
        tags: ['btc'],
      });
      assert.equal(strategy.slug, 'simple-ptb');
      assert.equal(strategy.latest_version, null);

      const version = createStrategyVersion(db, strategy.id, {
        language: 'gls-v1',
        source_code: 'strategy "Simple PTB" { param minDistanceAbs = 50 }',
      });
      assert.equal(version.version, 1);
      assert.equal(version.validation.ok, true);
      assert.throws(
        () => createStrategyVersion(db, strategy.id, { source_code: 'strategy "Simple PTB" { param minDistanceAbs = 50 }' }),
        /unchanged/,
      );

      const updated = updateStrategy(db, strategy.id, { status: 'validated' });
      assert.equal(updated.status, 'validated');
      assert.equal(listStrategies(db).length, 1);

      const defaultVersion = updateStrategy(db, strategy.id, { default_version_id: version.id });
      assert.equal(defaultVersion.default_version_id, version.id);
      assert.throws(
        () => updateStrategy(db, strategy.id, { default_version_id: 99999 }),
        /not found/,
      );

      const tempStrategy = createStrategy(db, { slug: 'delete-me', name: 'Delete Me' });
      createStrategyVersion(db, tempStrategy.id, { source_code: 'strategy "Delete Me" {}' });
      assert.equal(deleteStrategy(db, tempStrategy.id).slug, 'delete-me');
      assert.equal(listStrategies(db).length, 1);

      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const listed = await getJson(`${baseUrl}/api/strategies`);
      assert.equal(listed.strategies.length, 1);
      assert.equal(listed.strategies[0].latest_version, 1);

      const created = await postJson(`${baseUrl}/api/strategies`, {
        slug: 'another-one',
        name: 'Another One',
      });
      assert.equal(created.strategy.slug, 'another-one');

      const patched = await patchJson(`${baseUrl}/api/strategies/${strategy.id}`, {
        name: 'Simple PTB v2',
      });
      assert.equal(patched.strategy.name, 'Simple PTB v2');

      const versions = await getJson(`${baseUrl}/api/strategies/${strategy.id}/versions`);
      assert.equal(versions.versions.length, 1);

      const savedVersion = await postJson(`${baseUrl}/api/strategies/${strategy.id}/versions`, {
        source_code: 'strategy "Simple PTB" { param maxAsk = 0.58 }',
      });
      assert.equal(savedVersion.version.version, 2);

      const duplicateVersion = await fetch(`${baseUrl}/api/strategies/${strategy.id}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_code: 'strategy "Simple PTB" { param maxAsk = 0.58 }' }),
      });
      assert.equal(duplicateVersion.status, 400);

      const deletedVersion = deleteStrategyVersion(db, strategy.id, version.id);
      assert.equal(deletedVersion.version, 1);

      const lastVersionDelete = await fetch(`${baseUrl}/api/strategies/${strategy.id}/versions/${savedVersion.version.id}`, { method: 'DELETE' });
      assert.equal(lastVersionDelete.status, 400);

      const validation = await postJson(`${baseUrl}/api/strategies/validate`, {
        source_code: 'invalid',
      });
      assert.equal(validation.validation.ok, false);

      const apiDelete = await deleteJson(`${baseUrl}/api/strategies/${created.strategy.id}`);
      assert.equal(apiDelete.trashed, true);
      const listedAfterDelete = await getJson(`${baseUrl}/api/strategies`);
      assert.equal(listedAfterDelete.strategies.some((item) => item.id === created.strategy.id), false);
      const listedWithStats = await getJson(`${baseUrl}/api/strategies?stats=1`);
      assert.equal(listedWithStats.strategies.some((item) => item.id === created.strategy.id), false);
      const trashed = await getJson(`${baseUrl}/api/strategies/trash`);
      assert.equal(trashed.strategies.some((item) => item.id === created.strategy.id), true);

      const restored = await postJson(`${baseUrl}/api/strategies/${created.strategy.id}/restore`, {});
      assert.equal(restored.restored, true);
      const listedAfterRestore = await getJson(`${baseUrl}/api/strategies`);
      assert.equal(listedAfterRestore.strategies.some((item) => item.id === created.strategy.id), true);

      const apiTrashAgain = await deleteJson(`${baseUrl}/api/strategies/${created.strategy.id}`);
      assert.equal(apiTrashAgain.trashed, true);
      const permanent = await deleteJson(`${baseUrl}/api/strategies/${created.strategy.id}/permanent`);
      assert.equal(permanent.deleted, true);
      const trashedAfterPermanent = await getJson(`${baseUrl}/api/strategies/trash`);
      assert.equal(trashedAfterPermanent.strategies.some((item) => item.id === created.strategy.id), false);

      const minimal = validateStrategySource({ source_code: 'strategy "X" {}' });
      assert.equal(minimal.ok, true);
      assert.ok(Array.isArray(minimal.warnings));
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('GLS strategy runs on lakehouse via strategy_id/version', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-gls-run-'));
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
      const parquetPath = path.join(dir, 'lake', 'backtest_ticks', 'part-test.parquet');
      await writeBacktestTicksParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'backtest_ticks.parquet'),
        finalPath: parquetPath,
        bookDepth: 2,
        rows: Array.from({ length: 12 }, (_, index) => makeBacktestTickRow(`2026-05-31T00:00:${String(index).padStart(2, '0')}.000Z`, 73400 + index * 10)),
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

      const strategy = createStrategy(db, { slug: 'gls-distance', name: 'GLS Distance' });
      const version = createStrategyVersion(db, strategy.id, {
        source_code: `strategy "GLS Distance" {
          param minDistanceAbs = 5
          param budget = 10
          onEventStart(event) { state.entered = false }
          onTick(tick, event) {
            let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
            let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
            let ask = book.ask(side, tick)
            if (!state.entered && dist >= params.minDistanceAbs) {
              enter(side, { price: ask, budget: params.budget, reason: "entry" })
              state.entered = true
            }
          }
          onEventEnd(event) { closeOpenPosition({ reason: "event_end" }) }
        }`,
      });
      assert.equal(version.validation.ok, true);

      server = createApiServer({ config, db, authService });
      await new Promise((resolve) => server.listen(0, resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const runRes = await postJson(`${baseUrl}/api/backtest/run`, {
        strategy_id: strategy.id,
        strategy_version_id: version.id,
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-05-31T00:00:12.000Z',
        underlying: 'BTC',
        interval: '5m',
        book_depth: 2,
        batch_size: 5,
        async: false,
      });
      assert.ok(runRes.run.id);
      assert.equal(runRes.run.strategy_id, strategy.id);
      assert.equal(runRes.run.strategy_version_id, version.id);
      assert.ok(runRes.run.strategy_snapshot);

      const events = await getJson(`${baseUrl}/api/backtest/runs/${runRes.run.id}/events`);
      assert.equal(events.events.length, 1);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('repairs strategy_versions FK after status migration rebuild', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-fk-'));
  const dbPath = path.join(dir, 'state.db');
  try {
    const seed = openStateDatabase(dbPath);
    const strategy = createStrategy(seed, { slug: 'fk-test', name: 'FK Test' });
    createStrategyVersion(seed, strategy.id, { source_code: 'strategy "FK Test" {}' });
    closeStateDatabase(seed);

    const { DatabaseSync } = await import('node:sqlite');
    const broken = new DatabaseSync(dbPath);
    broken.exec('PRAGMA foreign_keys = OFF');
    broken.exec(`
      ALTER TABLE strategy_definitions RENAME TO strategy_definitions_old;
      CREATE TABLE strategy_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'failed', 'archived')),
        tags_json TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT 'now',
        updated_at TEXT NOT NULL DEFAULT 'now'
      );
      INSERT INTO strategy_definitions (
        id, slug, name, description, status, tags_json, pinned, created_at, updated_at
      )
      SELECT id, slug, name, description, status, tags_json, 0, created_at, updated_at
      FROM strategy_definitions_old;
      DROP TABLE strategy_definitions_old;
    `);
    broken.exec('PRAGMA foreign_keys = ON');
    broken.close();

    const db = openStateDatabase(dbPath);
    try {
      const fk = db.prepare('PRAGMA foreign_key_list(strategy_versions)').all()[0];
      assert.equal(fk.table, 'strategy_definitions');
      deleteStrategy(db, strategy.id);
      assert.equal(listStrategies(db).length, 0);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('trash restores strategy history and seed skips trashed slug', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-trash-'));
  const dbPath = path.join(dir, 'state.db');
  const db = openStateDatabase(dbPath);
  try {
    const strategy = seedEdgeSniperV2Strategy(db);
    assert.ok(strategy);
    db.prepare(`
      INSERT INTO backtest_runs (
        strategy, source, underlying, interval, from_ts, to_ts, batch_size,
        params_json, ticks, batches, summary_json, result_json,
        strategy_id, strategy_version_id, status
      ) VALUES (?, 'lakehouse', 'btc', '5m', '2026-01-01', '2026-01-02', 1000, '{}', 0, 0, ?, '{}', ?, ?, 'completed')
    `).run(`gls:${strategy.slug}`, JSON.stringify({ totalPnl: 12 }), strategy.id, strategy.latest_version_id);

    assert.equal(getStrategyStats(db, strategy.id).totals.runs, 1);
    trashStrategy(db, strategy.id);
    assert.equal(listStrategies(db).length, 0);
    assert.equal(listTrashedStrategies(db).length, 1);
    assert.equal(seedEdgeSniperV2Strategy(db), null);

    const restored = restoreStrategy(db, strategy.id);
    assert.ok(restored);
    assert.equal(restored.deleted_at, null);
    assert.equal(getStrategyStats(db, strategy.id).totals.runs, 1);
    assert.ok(seedEdgeSniperV2Strategy(db));

    trashStrategy(db, strategy.id);
    permanentlyDeleteStrategy(db, strategy.id);
    assert.equal(listTrashedStrategies(db).length, 0);
    const reseeded = seedEdgeSniperV2Strategy(db);
    assert.ok(reseeded);
    assert.notEqual(reseeded.id, strategy.id);
    assert.equal(getStrategyStats(db, reseeded.id).totals.runs, 0);
  } finally {
    closeStateDatabase(db);
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

async function patchJson(url, body, expectedStatus = 200) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, expectedStatus);
  return res.json();
}

async function deleteJson(url, expectedStatus = 200) {
  const res = await fetch(url, { method: 'DELETE' });
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
