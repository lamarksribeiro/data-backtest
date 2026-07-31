#!/usr/bin/env node
/**
 * Deterministic post-analysis for tsc-flatten-protection/report.json.
 *
 * No lake, network, credentials, or order access. This script only reads the
 * completed local research report and materializes the risk/economics frontier.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const INPUT = path.resolve(
  ROOT,
  arg('input', '.tmp/tsc-flatten-protection/report.json'),
);
const OUT_DIR = path.resolve(
  ROOT,
  arg('out', '.tmp/tsc-flatten-protection'),
);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mode(row) {
  return row.protection?.actionMode ?? 'unprotected';
}

function metrics(summary) {
  return {
    filled_events: summary.filledEvents,
    total_pnl: summary.totalPnl,
    profit_factor: summary.profitFactor,
    bootstrap_p05: summary.bootstrap.p05,
    bootstrap_p50: summary.bootstrap.p50,
    bootstrap_p95: summary.bootstrap.p95,
    worst_realized: summary.worstRealized,
    worst_case_min: summary.worstCaseMin,
    residual_events: summary.residualEvents,
    residual_pct: summary.residualPct,
    risk_breaches: summary.riskBreaches,
    protected_events: summary.protectedEvents,
    full_protections: summary.fullProtections,
    partial_protections: summary.partialProtections,
    flatten_events: summary.flattenEvents,
    pair_events: summary.pairEvents,
    protection_attempt_misses: summary.protectionAttemptMisses,
    unprotected_reasons: summary.unprotectedReasons,
  };
}

function compact(row) {
  return {
    id: row.id,
    entry: row.entry.id,
    protection: row.protection,
    discovery: metrics(row.discovery),
    temporal_validation_not_clean: metrics(row.validation),
    day_29: metrics(row.requestedDay),
  };
}

function discoveryEconomic(row) {
  return (
    row.discovery.totalPnl > 0 &&
    Number(row.discovery.profitFactor) > 1 &&
    row.discovery.bootstrap.p05 > 0
  );
}

function validationEconomic(row) {
  return (
    row.validation.totalPnl > 0 &&
    Number(row.validation.profitFactor) > 1 &&
    row.validation.bootstrap.p05 > 0
  );
}

function choose(rows, comparator) {
  return rows.length ? rows.slice().sort(comparator)[0] : null;
}

function buildAnalysis(report, inputSha256) {
  const rows = report.all;
  const modes = ['unprotected', 'flatten', 'pair', 'hybrid'];
  const byMode = {};
  for (const actionMode of modes) {
    const candidates = rows.filter((row) => mode(row) === actionMode);
    byMode[actionMode] = {
      best_discovery_economics: compact(
        choose(
          candidates,
          (left, right) =>
            right.discovery.totalPnl - left.discovery.totalPnl ||
            Number(right.discovery.profitFactor) -
              Number(left.discovery.profitFactor),
        ),
      ),
      least_discovery_risk_breaches: compact(
        choose(
          candidates,
          (left, right) =>
            left.discovery.riskBreaches - right.discovery.riskBreaches ||
            left.discovery.residualPct - right.discovery.residualPct ||
            right.discovery.totalPnl - left.discovery.totalPnl,
        ),
      ),
      best_discovery_worst_case: compact(
        choose(
          candidates,
          (left, right) =>
            right.discovery.worstCaseMin - left.discovery.worstCaseMin ||
            right.discovery.totalPnl - left.discovery.totalPnl,
        ),
      ),
    };
  }

  const frontierEntry = 'tsc-a80-lat1-slip1';
  const alwaysFloorFrontier = {};
  for (const actionMode of ['flatten', 'pair', 'hybrid']) {
    alwaysFloorFrontier[actionMode] = rows
      .filter(
        (row) =>
          row.entry.id === frontierEntry &&
          row.protection?.actionMode === actionMode &&
          row.protection.trigger.id === 'always' &&
          row.protection.latencyTicks === 1,
      )
      .sort(
        (left, right) =>
          right.protection.actionFloorPerShare -
          left.protection.actionFloorPerShare,
      )
      .map(compact);
  }

  const bothBootstrapPositive = rows
    .filter((row) => discoveryEconomic(row) && validationEconomic(row))
    .sort(
      (left, right) =>
        right.discovery.totalPnl - left.discovery.totalPnl,
    )
    .map(compact);
  const day29SafePositive = rows
    .filter(
      (row) =>
        row.requestedDay.totalPnl > 0 &&
        row.requestedDay.worstCaseMin >= -0.5,
    )
    .sort(
      (left, right) =>
        right.requestedDay.totalPnl - left.requestedDay.totalPnl,
    );

  const maxDiscoveryWorstCase = Math.max(
    ...rows.map((row) => row.discovery.worstCaseMin),
  );
  const minDiscoveryRiskBreaches = Math.min(
    ...rows.map((row) => row.discovery.riskBreaches),
  );
  const minDiscoveryResidualPct = Math.min(
    ...rows.map((row) => row.discovery.residualPct),
  );
  return {
    schema_version: 1,
    source_report: path.relative(ROOT, INPUT).replaceAll('\\', '/'),
    source_report_sha256: inputSha256,
    windows: report.windows,
    model: report.model,
    grid: report.grid,
    command_replay:
      'node labs/sandbox/pair-path-v0/tsc-flatten-protection.mjs --bootstrapSamples=2000',
    command_analysis:
      'node labs/sandbox/pair-path-v0/tsc-flatten-analysis.mjs',
    headline: {
      variants: report.variants,
      eligible_events: report.eligibleEvents,
      discovery_risk_gated: report.funnel.discoveryRiskGated,
      positive_pnl_pf_both_windows: report.funnel.positiveBoth,
      bootstrap_positive_both_windows: bothBootstrapPositive.length,
      survivors: report.funnel.survivors,
      variants_discovery_worst_case_gte_minus_050: rows.filter(
        (row) => row.discovery.worstCaseMin >= -0.5,
      ).length,
      variants_discovery_zero_risk_breaches: rows.filter(
        (row) => row.discovery.riskBreaches === 0,
      ).length,
      variants_discovery_residual_lte_5pct: rows.filter(
        (row) => row.discovery.residualPct <= 5,
      ).length,
      variants_discovery_economic: rows.filter(discoveryEconomic).length,
      variants_day29_safe_and_positive: day29SafePositive.length,
      max_discovery_worst_case: maxDiscoveryWorstCase,
      min_discovery_risk_breaches: minDiscoveryRiskBreaches,
      min_discovery_residual_pct: minDiscoveryResidualPct,
    },
    by_action_mode: byMode,
    always_floor_frontier: {
      entry: frontierEntry,
      latency_ticks: 1,
      rows: alwaysFloorFrontier,
    },
    bootstrap_positive_discovery_and_validation: bothBootstrapPositive,
    best_day29_safe_positive: day29SafePositive.slice(0, 10).map(compact),
    conclusions: [
      'Selective protection preserves positive TSC economics but leaves nearly all entry inventory residual.',
      'Always-on protection materially reduces residual events but turns discovery and temporal validation negative.',
      'No tested policy reaches the -0.50 per-event worst-case ceiling in discovery.',
      'Entry FAK partials below the five-share minimum, protection misses, event end, and missing qualifying depth preserve tail exposure.',
      'Hybrid overwhelmingly selects flatten; opposite buying does not create a material new frontier under the recorded binary books.',
      'Positive day-29 results do not repair the negative discovery/validation economics of the safest always-on policies.',
      'Result is research rejection for this automation, not a claim about all possible TSC selection policies.',
    ],
  };
}

function fmt(value) {
  return value == null ? '' : String(value);
}

function frontierRows(analysis) {
  const rows = [];
  for (const [action, variants] of Object.entries(
    analysis.always_floor_frontier.rows,
  )) {
    for (const row of variants) {
      rows.push(
        `| ${action} | ${row.protection.actionFloorPerShare} | ` +
          `${row.discovery.total_pnl} | ${row.discovery.profit_factor} | ` +
          `${row.discovery.bootstrap_p05} | ${row.discovery.worst_case_min} | ` +
          `${row.discovery.residual_pct}% | ${row.discovery.risk_breaches} | ` +
          `${row.temporal_validation_not_clean.total_pnl} | ` +
          `${row.temporal_validation_not_clean.bootstrap_p05} | ` +
          `${row.day_29.total_pnl} | ${row.day_29.worst_case_min} |`,
      );
    }
  }
  return rows.join('\n');
}

function renderMarkdown(analysis) {
  const safest = analysis.by_action_mode.hybrid.least_discovery_risk_breaches;
  const selective = analysis.by_action_mode.hybrid.best_discovery_economics;
  const bootstrapRows = analysis.bootstrap_positive_discovery_and_validation
    .map(
      (row) =>
        `| \`${row.id}\` | ${row.discovery.total_pnl} | ` +
        `${row.discovery.profit_factor} | ${row.discovery.bootstrap_p05} | ` +
        `${row.discovery.worst_case_min} | ${row.discovery.residual_pct}% | ` +
        `${row.temporal_validation_not_clean.total_pnl} | ` +
        `${row.temporal_validation_not_clean.profit_factor} | ` +
        `${row.temporal_validation_not_clean.bootstrap_p05} | ` +
        `${row.day_29.total_pnl} |`,
    )
    .join('\n');
  return `# TSC flatten / hybrid — risk frontier analysis

Source report SHA-256: \`${analysis.source_report_sha256}\`

## Verdict

**Rejected for promotion.** None of ${analysis.headline.variants} variants
reached the discovery worst-case ceiling of -$0.50. The best observed discovery
worst case was ${analysis.headline.max_discovery_worst_case}; the minimum number
of risk breaches was ${analysis.headline.min_discovery_risk_breaches}, and the
minimum residual rate was ${analysis.headline.min_discovery_residual_pct}%.

July 1–28 is temporal validation but **not a clean holdout**. Day 29 is isolated
and was not used for ranking.

## Headline counts

| Metric | Count |
|---|---:|
| Variants | ${analysis.headline.variants} |
| Eligible events | ${analysis.headline.eligible_events} |
| Discovery economic | ${analysis.headline.variants_discovery_economic} |
| Positive PnL/PF in discovery and validation | ${analysis.headline.positive_pnl_pf_both_windows} |
| Bootstrap-positive in both windows | ${analysis.headline.bootstrap_positive_both_windows} |
| Discovery worst-case >= -$0.50 | ${analysis.headline.variants_discovery_worst_case_gte_minus_050} |
| Discovery zero risk breaches | ${analysis.headline.variants_discovery_zero_risk_breaches} |
| Discovery residual <= 5% | ${analysis.headline.variants_discovery_residual_lte_5pct} |
| Full research survivors | ${analysis.headline.survivors} |

## Two failure regimes

Selective best hybrid:

- \`${selective.id}\`
- discovery PnL ${selective.discovery.total_pnl}, PF ${selective.discovery.profit_factor},
  bootstrap p05 ${selective.discovery.bootstrap_p05};
- worst-case ${selective.discovery.worst_case_min}, residual
  ${selective.discovery.residual_pct}%, risk breaches
  ${selective.discovery.risk_breaches};
- validation PnL ${selective.temporal_validation_not_clean.total_pnl};
- day29 PnL ${selective.day_29.total_pnl}.

Lowest-breach hybrid:

- \`${safest.id}\`
- discovery PnL ${safest.discovery.total_pnl}, PF ${safest.discovery.profit_factor},
  bootstrap p05 ${safest.discovery.bootstrap_p05};
- protected ${safest.discovery.protected_events}/${safest.discovery.filled_events},
  residual ${safest.discovery.residual_pct}%, risk breaches
  ${safest.discovery.risk_breaches};
- unprotected reasons: \`${JSON.stringify(safest.discovery.unprotected_reasons)}\`;
- validation PnL ${safest.temporal_validation_not_clean.total_pnl},
  bootstrap p05 ${safest.temporal_validation_not_clean.bootstrap_p05};
- day29 PnL ${safest.day_29.total_pnl}, worst-case
  ${safest.day_29.worst_case_min}.

## Always-on floor frontier

Entry: \`${analysis.always_floor_frontier.entry}\`, protection latency:
${analysis.always_floor_frontier.latency_ticks} tick.

| Action | Floor/share | Disc PnL | Disc PF | Disc boot p05 | Disc worst | Residual | Breaches | Val PnL | Val boot p05 | Day29 PnL | Day29 worst |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${frontierRows(analysis)}

## Economically positive in both temporal windows

These variants still fail risk. They are included to separate economics from
protection:

| Variant | Disc PnL | Disc PF | Disc boot p05 | Disc worst | Residual | Val PnL | Val PF | Val boot p05 | Day29 PnL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${bootstrapRows || '| none | | | | | | | | | |'}

## Scientific conclusions

${analysis.conclusions.map((line) => `- ${line}`).join('\n')}

## Reproduce

\`\`\`powershell
${analysis.command_replay}
${analysis.command_analysis}
node --test labs/sandbox/pair-path-v0/tsc-flatten-protection.test.mjs
\`\`\`
`;
}

function main() {
  const raw = fs.readFileSync(INPUT);
  const report = JSON.parse(raw);
  const analysis = buildAnalysis(report, sha256(raw));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'analysis.json'),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(OUT_DIR, 'ANALYSIS.md'), renderMarkdown(analysis));
  console.log(
    JSON.stringify({
      input: path.relative(ROOT, INPUT).replaceAll('\\', '/'),
      out: path.relative(ROOT, OUT_DIR).replaceAll('\\', '/'),
      headline: analysis.headline,
    }),
  );
}

main();
