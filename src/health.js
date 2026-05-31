import { manifestStats } from './state/manifest.js';
import { checkLakeStorage } from './lake/storage.js';

export async function getHealth(config, db) {
  const storage = await checkLakeStorage(config.lakeRoot);
  const manifest = manifestStats(db);
  return {
    status: 'ok',
    lake_root: storage.lake_root,
    state_db_path: config.stateDbPath,
    backtest_data_mode: config.backtestDataMode,
    manifest,
  };
}
