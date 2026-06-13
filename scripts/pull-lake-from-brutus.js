#!/usr/bin/env node
import 'dotenv/config';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadConfig } from '../src/config.js';
import { runLakePull } from '../src/ops/lakePull.js';
import { closeStateDatabase, openStateDatabase } from '../src/state/sqlite.js';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const opts = {
    help: false,
    full: false,
    fullState: false,
    lakeOnly: false,
    dryRun: false,
    skipCheck: false,
    from: null,
    to: null,
    underlying: null,
    interval: null,
    bookDepth: null,
    datasets: null,
    statuses: null,
    remoteHost: process.env.LAKE_PULL_REMOTE_HOST || 'Brutus',
    remoteLakeRoot: process.env.LAKE_PULL_REMOTE_LAKE || '/data/goldenlens/lakehouse',
    remoteStatePath: process.env.LAKE_PULL_REMOTE_STATE || '/data/goldenlens/backtest-state/data-backtest.db',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      opts[toCamelCase(key)] = true;
      continue;
    }
    opts[toCamelCase(key)] = next;
    i += 1;
  }

  if (opts.lakeOnly) {
    opts.fullState = false;
  } else if (opts.full) {
    opts.fullState = true;
  }

  if (typeof opts.datasets === 'string') {
    opts.datasets = opts.datasets.split(',').map((value) => value.trim()).filter(Boolean);
  }
  if (typeof opts.statuses === 'string') {
    opts.statuses = opts.statuses.split(',').map((value) => value.trim()).filter(Boolean);
  }
  if (opts.bookDepth != null && opts.bookDepth !== true) {
    opts.bookDepth = Number.parseInt(String(opts.bookDepth), 10);
  }

  return opts;
}

function toCamelCase(flag) {
  return flag.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function printHelp() {
  console.log(`data-backtest lake:pull — copia Parquets do Brutus para o lake local

Uso:
  npm run lake:pull -- --from 2026-06-01 --to 2026-06-07 --underlying BTC --interval 5m --book-depth 25
  npm run lake:pull -- --full
  npm run lake:pull -- --from 2026-06-01 --to 2026-06-01 --underlying BTC --interval 5m --dry-run

Modos:
  Seletivo (padrao)   Copia apenas os active_path do manifest remoto no intervalo e faz UPSERT local
  --full              Copia o lake inteiro e substitui o SQLite local (backup automatico do state)
  --lake-only         Com --full, copia so o lake (nao substitui o state local)

Filtros (modo seletivo):
  --from YYYY-MM-DD   Obrigatorio no modo seletivo
  --to YYYY-MM-DD     Obrigatorio no modo seletivo
  --underlying BTC
  --interval 5m
  --book-depth 25
  --dataset backtest_ticks[,scalars,...]   Padrao: backtest_ticks
  --status valid,accepted                  Padrao: valid,accepted

Remoto (env ou flags):
  --remote-host Brutus
  --remote-lake /data/goldenlens/lakehouse
  --remote-state /data/goldenlens/backtest-state/data-backtest.db

Outros:
  --dry-run           Lista o que seria copiado, sem transferir arquivos
  --skip-check        Nao roda ops:check ao final

Requisitos:
  ssh/scp configurados para o host remoto (alias Brutus)
  No modo seletivo, o script copia o SQLite remoto temporariamente para listar o manifest
`);
}

async function runCommand(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (stderr?.trim()) {
      process.stderr.write(stderr);
    }
    return stdout;
  } catch (err) {
    const details = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
    throw new Error(details || err.message || `Command failed: ${command} ${args.join(' ')}`);
  }
}

function validateDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new Error(`${label} must use YYYY-MM-DD format`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.full) {
    validateDate(opts.from, '--from');
    validateDate(opts.to, '--to');
    if (opts.from > opts.to) throw new Error('--from must be <= --to');
  }

  const config = loadConfig();
  let db = openStateDatabase(config.stateDbPath);

  try {
    const result = await runLakePull({
      config,
      db,
      remoteHost: opts.remoteHost,
      remoteLakeRoot: opts.remoteLakeRoot,
      remoteStatePath: opts.remoteStatePath,
      full: Boolean(opts.full),
      fullState: Boolean(opts.fullState),
      dryRun: Boolean(opts.dryRun),
      skipCheck: Boolean(opts.skipCheck),
      filters: {
        from: opts.from,
        to: opts.to,
        underlying: opts.underlying,
        interval: opts.interval,
        bookDepth: opts.bookDepth,
        datasets: opts.datasets,
        statuses: opts.statuses,
      },
      runCommand,
      log: console.log,
    });

    if (opts.full && opts.fullState && !opts.dryRun) {
      closeStateDatabase(db);
      db = openStateDatabase(config.stateDbPath);
      if (!opts.skipCheck) {
        const { runBackupCheck } = await import('../src/ops/backupCheck.js');
        result.check = await runBackupCheck(config, db);
        result.ok = result.check.ok;
      }
    }

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(`[lake:pull] ${err.message}`);
  process.exitCode = 1;
});
