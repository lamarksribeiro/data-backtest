#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from './config.js';
import { openStateDatabase, closeStateDatabase } from './state/sqlite.js';
import { createApiServer } from './api/server.js';
import { createPrepareJobRunner } from './prepare/runner.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);
const prepareRunner = createPrepareJobRunner({ config, db });
const server = createApiServer({ config, db, prepareRunner });

server.listen(config.apiPort, () => {
  console.log(JSON.stringify({ ok: true, port: config.apiPort }));
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  closeStateDatabase(db);
}

process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
