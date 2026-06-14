import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createApiServer } from '../src/api/server.js';
import { createPrepareJobRunner } from '../src/prepare/runner.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  createAssetUpdateSchedule,
  finishAssetUpdateRunByJobId,
  getAssetUpdateSchedule,
} from '../src/state/assetUpdateSchedules.js';
import { lastClosedUtcDate, runAssetUpdateSchedule } from '../src/scheduler/assetUpdates.js';
import { createTestAuthService, testServerConfig } from './testAuth.js';

test('asset update scheduler prepares only through the last closed UTC day', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-schedule-'));
  try {
    const config = testServerConfig({
      lakeRoot: path.join(dir, 'lake'),
      stateDbPath: path.join(dir, 'state.db'),
    });
    const db = openStateDatabase(config.stateDbPath);
    try {
      const createdAt = new Date('2026-06-13T01:00:00.000Z');
      const schedule = createAssetUpdateSchedule(db, {
        name: 'BTC nightly',
        underlying: 'BTC',
        interval: '5m',
        book_depth: 25,
        start_date: '2026-06-10',
        frequency: 'daily',
        time_utc: '03:00',
      }, { config, now: createdAt });

      assert.equal(schedule.next_run_at, '2026-06-13T03:00:00.000Z');
      assert.equal(lastClosedUtcDate(new Date('2026-06-13T10:15:00.000Z')), '2026-06-12');

      const prepareRunner = createPrepareJobRunner({
        config,
        db,
        executeActions: async ({ actions, dryRun }) => actions.map((action) => ({
          command: action.command,
          args: action.args,
          dryRun,
        })),
        onEvent: (event) => {
          if (event.type === 'job:completed') {
            finishAssetUpdateRunByJobId(db, event.jobId, event.status);
          }
        },
      });

      const result = await runAssetUpdateSchedule({
        db,
        config,
        prepareRunner,
        schedule,
        now: new Date('2026-06-13T10:15:00.000Z'),
      });

      assert.equal(result.ok, true);
      assert.equal(result.target_to_date, '2026-06-12');
      assert.equal(result.job.request.from, '2026-06-10T00:00:00.000Z');
      assert.equal(result.job.request.to, '2026-06-13T00:00:00.000Z');

      await prepareRunner.waitForIdle();
      const completed = getAssetUpdateSchedule(db, schedule.id);
      assert.equal(completed.recent_runs[0].status, 'completed');
      assert.equal(completed.recent_runs[0].to_date, '2026-06-12');
      assert.ok(completed.last_success_at);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('asset update schedule API manages schedules', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-schedule-api-'));
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
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const created = await postJson(`${baseUrl}/api/settings/asset-update-schedules`, {
        name: 'ETH overnight',
        enabled: false,
        underlying: 'ETH',
        interval: '15m',
        book_depth: 10,
        start_date: '2026-06-01',
        frequency: 'daily',
        time_utc: '04:30',
      }, 201);

      assert.equal(created.schedule.name, 'ETH overnight');
      assert.equal(created.schedule.enabled, false);
      assert.equal(created.schedule.next_run_at, null);

      const enabled = await patchJson(`${baseUrl}/api/settings/asset-update-schedules/${created.schedule.id}`, { enabled: true });
      assert.equal(enabled.schedule.enabled, true);
      assert.ok(enabled.schedule.next_run_at);

      const list = await getJson(`${baseUrl}/api/settings/asset-update-schedules`);
      assert.equal(list.schedules.length, 1);
      assert.equal(list.schedules[0].underlying, 'ETH');

      const deleted = await deleteJson(`${baseUrl}/api/settings/asset-update-schedules/${created.schedule.id}`);
      assert.equal(deleted.ok, true);

      const afterDelete = await getJson(`${baseUrl}/api/settings/asset-update-schedules`);
      assert.equal(afterDelete.schedules.length, 0);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

async function getJson(url, status = 200) {
  const res = await fetch(url);
  assert.equal(res.status, status);
  return res.json();
}

async function postJson(url, body, status = 200) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, status);
  return res.json();
}

async function patchJson(url, body, status = 200) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, status);
  return res.json();
}

async function deleteJson(url, status = 200) {
  const res = await fetch(url, { method: 'DELETE' });
  assert.equal(res.status, status);
  return res.json();
}
