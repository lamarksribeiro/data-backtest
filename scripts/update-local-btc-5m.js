#!/usr/bin/env node
/**
 * One-shot: atualiza o lake local BTC 5m a partir do Brutus.
 *
 * Uso típico (agente / humano):
 *   npm run lake:update-btc-5m
 *
 * Não precisa de dry-run, query:availability nem --remote-container manual.
 */
import 'dotenv/config';

import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadConfig } from '../src/config.js';
import { runLakePull } from '../src/ops/lakePull.js';
import {
  computeUpdateRange,
  readLocalCoverage,
  summarizeUpdateResult,
  utcToday,
} from '../src/ops/updateLocalLake.js';
import { closeStateDatabase, openStateDatabase } from '../src/state/sqlite.js';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const opts = {
    help: false,
    dryRun: false,
    skipCheck: false,
    refreshContainer: false,
    lookbackDays: 0,
    emptyLookbackDays: 14,
    from: null,
    to: null,
    underlying: 'BTC',
    interval: '5m',
    bookDepth: null,
    dataset: 'backtest_ticks',
    remoteHost: process.env.LAKE_PULL_REMOTE_HOST || 'Brutus',
    remoteLakeRoot: process.env.LAKE_PULL_REMOTE_LAKE || '/data/goldenlens/lakehouse',
    remoteStatePath: process.env.LAKE_PULL_REMOTE_STATE || '/data/goldenlens/backtest-state/data-backtest.db',
    remoteContainer: process.env.LAKE_PULL_REMOTE_CONTAINER || null,
    remoteStateInContainer: process.env.LAKE_PULL_REMOTE_STATE_CONTAINER || '/state/data-backtest.db',
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

  if (opts.bookDepth != null && opts.bookDepth !== true) {
    opts.bookDepth = Number.parseInt(String(opts.bookDepth), 10);
  }
  if (opts.lookbackDays != null && opts.lookbackDays !== true) {
    opts.lookbackDays = Number.parseInt(String(opts.lookbackDays), 10);
  }
  if (opts.emptyLookbackDays != null && opts.emptyLookbackDays !== true) {
    opts.emptyLookbackDays = Number.parseInt(String(opts.emptyLookbackDays), 10);
  }

  return opts;
}

function toCamelCase(flag) {
  return flag.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function printHelp() {
  console.log(`lake:update-btc-5m — atualiza BTC 5m local a partir do Brutus

Uso:
  npm run lake:update-btc-5m
  npm run lake:update-btc-5m -- --dry-run
  npm run lake:update-btc-5m -- --lookback-days 3
  npm run lake:update-btc-5m -- --from 2026-07-01 --to 2026-07-10

Comportamento:
  1. Lê max(dt) local no manifest (BTC / 5m / book_depth do .env)
  2. Puxa do Brutus: from = max_local (lookback 0) até hoje UTC
  3. Pula Parquets que já existem localmente; só baixa o que falta
  4. Se o container em cache morreu (redeploy), rediscobre sozinho
  5. UPSERT no manifest local + ops:check (a menos de --skip-check)

Flags úteis:
  --dry-run              Só lista o que seria copiado/pulado
  --lookback-days N      Inclui N dias antes do tip (padrão 0; use 1+ para forçar refresh)
  --empty-lookback-days  Se lake vazio, quantos dias puxar (padrão 14)
  --from / --to          Sobrescreve a janela automática
  --refresh-container    Apaga cache do container e rediscobre
  --remote-container ID  Força o container do data-backtest no Brutus
  --skip-check           Não roda ops:check no final
`);
}

async function runCommand(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (stderr?.trim()) process.stderr.write(stderr);
    return stdout;
  } catch (err) {
    const details = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
    throw new Error(details || err.message || `Command failed: ${command} ${args.join(' ')}`);
  }
}

function isDeadContainerError(err) {
  const msg = String(err?.message || err || '');
  return /No such container/i.test(msg) || /container .* not found/i.test(msg);
}

async function pullWithContainerRecovery(params, containerCachePath) {
  try {
    return await runLakePull(params);
  } catch (err) {
    if (!isDeadContainerError(err) || params.filters?.remoteContainer) throw err;
    console.log('[lake:update] cache de container morto — rediscobrindo...');
    await unlink(containerCachePath).catch(() => {});
    return runLakePull({
      ...params,
      filters: { ...params.filters, remoteContainer: null },
    });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const bookDepth = opts.bookDepth ?? config.backtestBookDepth;
  const containerCachePath = path.join(path.dirname(config.stateDbPath), '.lake-pull-remote-container.json');

  if (opts.refreshContainer) {
    await unlink(containerCachePath).catch(() => {});
    console.log('[lake:update] cache de container removido');
  }

  const db = openStateDatabase(config.stateDbPath);
  try {
    const coverageBefore = readLocalCoverage(db, {
      underlying: opts.underlying,
      interval: opts.interval,
      bookDepth,
      dataset: opts.dataset,
    });

    const range = computeUpdateRange({
      localMaxDt: coverageBefore.maxDt,
      today: utcToday(),
      lookbackDays: opts.lookbackDays,
      emptyLookbackDays: opts.emptyLookbackDays,
      fromOverride: opts.from,
      toOverride: opts.to,
    });

    console.log(`[lake:update] local ${opts.underlying} ${opts.interval} depth=${bookDepth}: ${coverageBefore.minDt || '—'} → ${coverageBefore.maxDt || 'vazio'} (${coverageBefore.partitions} partições)`);
    console.log(`[lake:update] puxando ${range.from} → ${range.to}${opts.dryRun ? ' (dry-run)' : ''}`);

    const pullResult = await pullWithContainerRecovery({
      config,
      db,
      remoteHost: opts.remoteHost,
      remoteLakeRoot: opts.remoteLakeRoot,
      remoteStatePath: opts.remoteStatePath,
      dryRun: Boolean(opts.dryRun),
      skipCheck: Boolean(opts.skipCheck),
      filters: {
        from: range.from,
        to: range.to,
        underlying: opts.underlying,
        interval: opts.interval,
        bookDepth,
        datasets: [opts.dataset],
        remoteContainer: opts.remoteContainer,
        remoteStateInContainer: opts.remoteStateInContainer,
      },
      runCommand,
      log: console.log,
    }, containerCachePath);

    const coverageAfter = opts.dryRun
      ? coverageBefore
      : readLocalCoverage(db, {
        underlying: opts.underlying,
        interval: opts.interval,
        bookDepth,
        dataset: opts.dataset,
      });

    const summary = summarizeUpdateResult({
      coverageBefore,
      coverageAfter,
      range,
      pullResult,
    });

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(`[lake:update] ${err.message}`);
  process.exitCode = 1;
});
