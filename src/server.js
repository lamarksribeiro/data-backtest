#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from './config.js';
import { openStateDatabase, closeStateDatabase } from './state/sqlite.js';
import { createApiServer } from './api/server.js';
import { createPrepareJobRunner } from './prepare/runner.js';
import { createAuthService } from './auth/authService.js';

const config = loadConfig();
if (!config.TEST_MODE && !config.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required (set TEST_MODE=true only for automated tests)');
}

const db = openStateDatabase(config.stateDbPath);
const authService = createAuthService({ db, config });
if (!config.TEST_MODE) {
  const bootstrapped = await authService.bootstrapAdmin();
  if (bootstrapped) {
    console.log(JSON.stringify({ ok: true, message: 'Initial admin user created', username: bootstrapped }));
  }
}

const prepareRunner = createPrepareJobRunner({ config, db });
const server = createApiServer({ config, db, prepareRunner, authService });

server.listen(config.apiPort, () => {
  console.log(JSON.stringify({ ok: true, port: config.apiPort }));
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  closeStateDatabase(db);
}

process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
