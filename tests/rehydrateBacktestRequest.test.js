import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { seedPortedStrategies } from '../scripts/seed-ported-strategies.js';
import { getStrategyBySlug, getStrategyVersion } from '../src/backtestStudio/state/strategies.js';
import { stripRequestForSnapshot } from '../src/state/backtestRuns.js';
import { rehydrateBacktestRequest } from '../src/backtest/rehydrateRequest.js';
import { runBacktestJob } from '../src/backtest/runBacktestJob.js';
import { createQueuedBacktestRun, getBacktestRun } from '../src/state/backtestRuns.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeBacktestTicksParquet } from '../src/sync/duckdbParquet.js';

test('rehydrateBacktestRequest restores library runner from stripped async payload', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);

  const strategy = getStrategyBySlug(db, 'cofre-sete');
  const versionRow = db.prepare(`
    SELECT id FROM strategy_versions WHERE strategy_id = ? ORDER BY version ASC LIMIT 1
  `).get(strategy.id);

  const stripped = JSON.parse(JSON.stringify({
    ...stripRequestForSnapshot({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-01T00:01:00.000Z',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      batchSize: 1000,
      fastRun: true,
      strategy: 'gls:cofre-sete',
      glsAst: { type: 'Strategy' },
      db: {},
      runnerLibrary: { slug: 'stale-runner', version: 1, kind: 'runner' },
      columnAnalysis: { needsBookLevels: false, bookDepth: 0 },
      strategyMeta: {
        strategy_id: strategy.id,
        strategy_version_id: versionRow.id,
        slug: 'cofre-sete',
      },
    }),
    strategyMeta: {
      strategy_id: strategy.id,
      strategy_version_id: versionRow.id,
      slug: 'cofre-sete',
    },
  }));

  const hydrated = rehydrateBacktestRequest(db, stripped);
  assert.equal(hydrated.runnerLibrary?.slug, 'cofre-sete-runner');
  assert.equal(hydrated.columnAnalysis?.needsBookLevels, true);
  assert.equal(hydrated.columnAnalysis?.bookDepth, 25);
  assert.ok(hydrated.glsAst);
  assert.equal(typeof hydrated.db.prepare, 'function');
});

test('rehydrateBacktestRequest backfills dataset fields from queued run row', () => {
  const db = openStateDatabase(':memory:');
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);

  const strategy = getStrategyBySlug(db, 'cofre-sete');
  const versionRow = db.prepare(`
    SELECT id FROM strategy_versions WHERE strategy_id = ? ORDER BY version ASC LIMIT 1
  `).get(strategy.id);

  const queued = createQueuedBacktestRun(db, {
    request: {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-01T00:01:00.000Z',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      batchSize: 1000,
      fastRun: true,
      strategy: 'gls:cofre-sete',
      params: {},
      strategyMeta: {
        strategy_id: strategy.id,
        strategy_version_id: versionRow.id,
        slug: 'cofre-sete',
      },
    },
    strategyMeta: {
      strategy_id: strategy.id,
      strategy_version_id: versionRow.id,
      slug: 'cofre-sete',
    },
    totalTicks: 1,
  });

  const hydrated = rehydrateBacktestRequest(db, {
    strategyMeta: queued.strategy_snapshot,
    fastRun: true,
  }, { runId: queued.id });

  assert.equal(hydrated.from, '2026-06-01T00:00:00.000Z');
  assert.equal(hydrated.to, '2026-06-01T00:01:00.000Z');
  assert.equal(hydrated.underlying, 'BTC');
  assert.equal(hydrated.runnerLibrary?.slug, 'cofre-sete-runner');
});

test('runBacktestJob completes with serialized queue payload for ported strategy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-rehydrate-'));
  const dbPath = path.join(dir, 'state.db');
  const db = openStateDatabase(dbPath);
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);

  const parquetPath = path.join(dir, 'lake', 'ticks.parquet');
  await writeBacktestTicksParquet({
    tempPath: path.join(dir, 'lake', '.tmp', 'ticks.parquet'),
    finalPath: parquetPath,
    bookDepth: 25,
    rows: [{
      marketId: 'market-1',
      underlying: 'BTC',
      interval: '5m',
      conditionId: 'cond-1',
      eventStart: '2026-06-01T12:00:00.000Z',
      eventEnd: '2026-06-01T12:05:00.000Z',
      ts: '2026-06-01T12:00:10.000Z',
      underlyingPrice: 105000,
      priceToBeat: 104900,
      upPrice: 0.55,
      downPrice: 0.45,
      upBestBid: 0.54,
      upBestAsk: 0.56,
      downBestBid: 0.44,
      downBestAsk: 0.46,
      coverage: 1,
      degraded: false,
    }],
  });
  upsertManifestPartition(db, {
    dataset: 'backtest_ticks',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    dt: '2026-06-01',
    activePath: toPortablePath(parquetPath),
    rows: 1,
    status: 'valid',
  });

  const strategy = getStrategyBySlug(db, 'terminal-convexity-v1');
  const versionRow = db.prepare(`
    SELECT id FROM strategy_versions WHERE strategy_id = ? ORDER BY version ASC LIMIT 1
  `).get(strategy.id);

  const queued = createQueuedBacktestRun(db, {
    request: {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      batchSize: 500,
      fastRun: true,
      strategy: 'gls:terminal-convexity-v1',
      params: {},
      strategyMeta: {
        strategy_id: strategy.id,
        strategy_version_id: versionRow.id,
        slug: 'terminal-convexity-v1',
      },
    },
    strategyMeta: {
      strategy_id: strategy.id,
      strategy_version_id: versionRow.id,
      slug: 'terminal-convexity-v1',
    },
    totalTicks: 1,
  });

  const payloadRequest = JSON.parse(JSON.stringify({
    ...JSON.parse(queued.dataset_request_json || '{}'),
    strategyMeta: queued.strategy_snapshot,
    fastRun: true,
  }));
  assert.ok(payloadRequest.from, 'queued run should persist dataset request dates');
  assert.ok(payloadRequest.underlying, 'queued run should persist dataset request context');

  closeStateDatabase(db);

  const outcome = await runBacktestJob({
    stateDbPath: dbPath,
    runId: queued.id,
    request: payloadRequest,
    startedAt: Date.now(),
  });

  const reopened = openStateDatabase(dbPath);
  const run = getBacktestRun(reopened, queued.id, { includeResult: true });
  closeStateDatabase(reopened);
  await rm(dir, { recursive: true, force: true });

  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(run.status, 'completed');
  assert.ok(run.ticks >= 1);
});