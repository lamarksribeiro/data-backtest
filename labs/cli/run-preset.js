#!/usr/bin/env node
import 'dotenv/config';

import { runLabPreset } from '../shared/labRunner.js';
import { discoverLabStrategies } from '../shared/discoverStrategies.js';
import { listPresets } from '../shared/presets.js';

function resolveStrategyContext(flags) {
  const strategyId = flags.strategy || flags['strategy-id'] || 'edge-sniper-v3';
  const explicitFamily = flags['strategy-family'] || flags.family;
  if (explicitFamily) return { strategyId, strategyFamily: explicitFamily };
  const manifest = discoverLabStrategies().find((item) => item.id === strategyId);
  return {
    strategyId,
    strategyFamily: manifest?.family || 'edge',
  };
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const preset = flags.preset || flags.p;

  const { strategyId, strategyFamily } = resolveStrategyContext(flags);

  if (flags.list) {
    const presets = listPresets({ strategyId, strategyFamily });
    console.log(JSON.stringify(presets.map((item) => ({
      id: item.id,
      name: item.name,
      studioSlug: item.studioSlug,
      role: item.role,
      labSummary: item.labSummary,
    })), null, 2));
    return;
  }

  if (!preset) {
    throw new Error('Usage: npm run lab:run-preset -- --preset <id> [--strategy <id>] [--strategy-family <family>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--daily-metrics] [--dry-run] [--list]');
  }

  const result = await runLabPreset(preset, {
    strategyId,
    strategyFamily,
    dryRun: Boolean(flags['dry-run'] || flags.dryRun),
    from: flags.from,
    to: flags.to,
    underlying: flags.underlying || flags.u || flags.asset || flags.a,
    dailyMetrics: Boolean(flags['daily-metrics'] || flags.dailyMetrics),
    bookDepth: flags['book-depth'] || flags.bookDepth,
    variantWorkers: flags['variant-workers'] || flags.variantWorkers,
  });

  if (!result.ok) {
    console.error(JSON.stringify({ error: result.error, availability: result.availability }, null, 2));
    process.exitCode = result.error === 'DATA_NOT_READY' ? 2 : 1;
    return;
  }

  if (result.dryRun) {
    console.log(JSON.stringify({ dryRun: true, preset, metadata: result.metadata }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    preset,
    reportDir: result.reportDir,
    summary: result.topResults?.[0]?.summary,
    metadata: result.metadata,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
