#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from './config.js';
import { openStateDatabase, closeStateDatabase } from './state/sqlite.js';
import { recoverStalePrepareJobs } from './state/prepareJobs.js';
import { recoverStaleAssetUpdateRuns } from './state/assetUpdateSchedules.js';
import { recoverStaleTelegramBackupRuns } from './state/telegramBackup.js';
import { createApiServer } from './api/server.js';
import { createAuthService } from './auth/authService.js';
import { seedPromotedStrategies } from './backtestStudio/gls/seedPromotedStrategies.js';
import { bindStrategyLibraryDatabase } from './backtestStudio/nativeLibrary/registry.js';
import { seedPortedStrategies } from '../scripts/seed-ported-strategies.js';

const config = loadConfig();
if (!config.TEST_MODE && !config.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required (set TEST_MODE=true only for automated tests)');
}

const db = openStateDatabase(config.stateDbPath);
bindStrategyLibraryDatabase(db);
const recoveredJobs = recoverStalePrepareJobs(db);
const recoveredAssetUpdateRuns = recoverStaleAssetUpdateRuns(db);
const recoveredTelegramBackupRuns = recoverStaleTelegramBackupRuns(db);
if (recoveredJobs > 0) {
  console.log(JSON.stringify({ ok: true, recoveredPrepareJobs: recoveredJobs }));
}
if (recoveredAssetUpdateRuns > 0) {
  console.log(JSON.stringify({ ok: true, recoveredAssetUpdateRuns }));
}
if (recoveredTelegramBackupRuns > 0) {
  console.log(JSON.stringify({ ok: true, recoveredTelegramBackupRuns }));
}
// Lab GLS strategies (edge-sniper-v3, qem, vsmr, etc.) sync from repo on every boot.
// Opt out only for isolated test/debug: SEED_PROMOTED_STRATEGIES=0
if (String(process.env.SEED_PROMOTED_STRATEGIES || '').trim() !== '0') {
  seedPromotedStrategies(db);
}
seedPortedStrategies(db);
const authService = createAuthService({ db, config });
if (!config.TEST_MODE) {
  const bootstrapped = await authService.bootstrapAdmin();
  if (bootstrapped) {
    console.log(JSON.stringify({ ok: true, message: 'Initial admin user created', username: bootstrapped }));
  }
}

const server = createApiServer({ config, db, authService, startScheduler: true });

server.listen(config.apiPort, () => {
  console.log(JSON.stringify({ ok: true, port: config.apiPort }));
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  closeStateDatabase(db);
}

process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
