#!/usr/bin/env node
/**
 * Reconstruct the historical Pair/Clip denominator from local artifacts only.
 *
 * This tool never calls Polymarket, never reads credentials, and never places
 * orders. It preserves conflicting assertions instead of choosing a winner.
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/recover-historical-denominator.mjs
 *   node ... --root=D:/path/data-backtest --robot-root=D:/path/data-robot
 *             --out=.tmp/pair-path-v0-denominator-recovery
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const CATEGORIES = [
  'event_seen',
  'idle',
  'skip',
  'order',
  'no_order',
  'no_fill',
  'fill',
  'complete_set',
  'resolution',
];

function posix(value) {
  return value.replaceAll('\\', '/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stableSort(nested)]),
  );
}

export function stableJson(value) {
  return `${JSON.stringify(stableSort(value), null, 2)}\n`;
}

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseLocaleNumber(raw) {
  if (raw == null) return null;
  const cleaned = String(raw)
    .replaceAll('*', '')
    .replaceAll('$', '')
    .replaceAll('US', '')
    .replaceAll(' ', '')
    .replace(',', '.');
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function lineNumber(lines, predicate) {
  const index = lines.findIndex((line) =>
    typeof predicate === 'string' ? line.includes(predicate) : predicate.test(line),
  );
  return index >= 0 ? index + 1 : null;
}

function floorFiveMinuteEpoch(utcMinute) {
  const milliseconds = Date.parse(`${utcMinute.replace(' ', 'T')}:00Z`);
  if (!Number.isFinite(milliseconds)) return null;
  return Math.floor(milliseconds / 300_000) * 300;
}

export function resolveEpochSuffix(suffix, anchors, radiusSeconds = 12 * 3600) {
  const matches = new Map();
  for (const anchor of anchors) {
    const low = Math.floor((anchor - radiusSeconds) / 300) * 300;
    const high = Math.ceil((anchor + radiusSeconds) / 300) * 300;
    for (let epoch = low; epoch <= high; epoch += 300) {
      if (!String(epoch).endsWith(String(suffix))) continue;
      const distance = Math.abs(epoch - anchor);
      const previous = matches.get(epoch);
      if (previous == null || distance < previous) matches.set(epoch, distance);
    }
  }
  if (!matches.size) return null;
  const ranked = [...matches.entries()].sort(
    ([epochA, distanceA], [epochB, distanceB]) =>
      distanceA - distanceB || epochA - epochB,
  );
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

function slugFromEpoch(epoch) {
  return Number.isFinite(epoch) ? `btc-updown-5m-${epoch}` : null;
}

function eventStartFromEpoch(epoch) {
  return Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null;
}

function sourceRecord(root, absolutePath, sourceClass) {
  if (!fs.existsSync(absolutePath)) return null;
  const text = fs.readFileSync(absolutePath, 'utf8');
  const relative = posix(path.relative(root, absolutePath));
  return {
    absolutePath,
    path: relative.startsWith('../') ? relative : relative,
    sourceClass,
    text,
    lines: text.split(/\r?\n/),
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
  };
}

function sourceManifestEntry(source) {
  return {
    path: source.path,
    source_class: source.sourceClass,
    sha256: source.sha256,
    bytes: source.bytes,
  };
}

function makeAssertion({
  source,
  line,
  eventKey,
  eventSlug = null,
  eventEpoch = null,
  sourceClass = source.sourceClass,
  categories,
  scopeRoles = [],
  overlapStatus = 'exact',
  details = {},
}) {
  const normalizedCategories = [...new Set(categories)].sort();
  for (const category of normalizedCategories) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown denominator category: ${category}`);
    }
  }
  const identity = stableJson({
    source: source.path,
    line,
    eventKey,
    sourceClass,
    categories: normalizedCategories,
    details,
  });
  return {
    assertion_id: `a_${sha256(identity).slice(0, 16)}`,
    source: source.path,
    source_line: line,
    source_class: sourceClass,
    event_key: eventKey,
    event_slug: eventSlug,
    event_epoch: eventEpoch,
    event_start: eventStartFromEpoch(eventEpoch),
    categories: normalizedCategories,
    scope_roles: [...new Set(scopeRoles)].sort(),
    overlap_status: overlapStatus,
    details,
  };
}

function parseLegs(raw) {
  const legs = [];
  for (const match of raw.matchAll(/\b(DN|DOWN|UP)@([\d,]+)×([\d,]+)/g)) {
    legs.push({
      side: match[1] === 'UP' ? 'UP' : 'DOWN',
      price: parseLocaleNumber(match[2]),
      shares: parseLocaleNumber(match[3]),
    });
  }
  return legs;
}

export function parseBriefing(source) {
  const assertions = [];
  const official = [];
  for (let index = 0; index < source.lines.length; index += 1) {
    const line = source.lines[index];
    const match = line.match(
      /^\|\s*(2026-\d{2}-\d{2} \d{2}:\d{2})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([\d,]+)\s*\|\s*\*{0,2}([\d,]+)\*{0,2}\s*\|\s*([+-][\d,]+)\s*\|\s*([+-][\d,]+)\s*\|/,
    );
    if (!match) continue;
    const [, whenUtc, style, legsRaw, investedRaw, avgSumRaw, grossRaw, netRaw] = match;
    const eventEpoch = floorFiveMinuteEpoch(whenUtc);
    const eventSlug = slugFromEpoch(eventEpoch);
    const legs = parseLegs(legsRaw);
    const upShares = legs
      .filter((leg) => leg.side === 'UP')
      .reduce((sum, leg) => sum + leg.shares, 0);
    const downShares = legs
      .filter((leg) => leg.side === 'DOWN')
      .reduce((sum, leg) => sum + leg.shares, 0);
    const assertion = makeAssertion({
      source,
      line: index + 1,
      eventKey: eventSlug,
      eventSlug,
      eventEpoch,
      sourceClass: 'clob_account_summary',
      categories: ['event_seen', 'order', 'fill', 'complete_set'],
      scopeRoles: ['official_four'],
      details: {
        when_utc: `${whenUtc}:00Z`,
        style: style.trim(),
        legs,
        fill_leg_count: legs.length,
        up_shares: upShares,
        down_shares: downShares,
        residual: Math.abs(upShares - downShares),
        invested: parseLocaleNumber(investedRaw),
        avg_sum: parseLocaleNumber(avgSumRaw),
        gross: parseLocaleNumber(grossRaw),
        modeled_net: parseLocaleNumber(netRaw),
        raw_export_preserved: false,
      },
    });
    assertions.push(assertion);
    official.push({
      event_slug: eventSlug,
      event_epoch: eventEpoch,
      assertion_id: assertion.assertion_id,
    });
  }

  const anchors = official
    .map((row) => row.event_epoch)
    .filter((epoch) => eventStartFromEpoch(epoch)?.startsWith('2026-07-28'));
  const missSpecs = [
    {
      suffix: '8600',
      needle: '…8600 clip',
      categories: ['event_seen', 'order', 'no_fill'],
      details: {
        outcome: 'gtc_posted_matched_zero_then_cancelled',
        exposure_usd: 0,
      },
    },
    {
      suffix: '8900',
      needle: '…8900 / …9200',
      categories: ['event_seen', 'idle', 'skip', 'no_order', 'no_fill'],
      details: { outcome: 'idle', reason: 'OPEN_MISS_CAP_or_no_band' },
    },
    {
      suffix: '9200',
      needle: '…8900 / …9200',
      categories: ['event_seen', 'idle', 'skip', 'no_order', 'no_fill'],
      details: { outcome: 'idle', reason: 'OPEN_MISS_CAP_or_no_band' },
    },
    {
      suffix: '9800',
      needle: '…9800 (série “protegida”)',
      categories: ['event_seen', 'skip', 'no_order', 'no_fill'],
      details: {
        outcome: 'guard_blocked_open',
        reason: 'OPEN_PAIR_NOT_CHEAP',
        polling_block_count: 261,
        polling_blocks_are_not_unique_opportunities: true,
      },
    },
  ];
  for (const spec of missSpecs) {
    const line = lineNumber(source.lines, spec.needle);
    if (!line) continue;
    const eventEpoch = resolveEpochSuffix(spec.suffix, anchors);
    const eventSlug = slugFromEpoch(eventEpoch);
    assertions.push(
      makeAssertion({
        source,
        line,
        eventKey: eventSlug ?? `documented-suffix:${spec.suffix}`,
        eventSlug,
        eventEpoch,
        sourceClass: 'documented_live_miss',
        categories: spec.categories,
        scopeRoles: ['denominator_candidate'],
        overlapStatus: eventSlug ? 'exact' : 'unresolved_suffix',
        details: spec.details,
      }),
    );
  }

  const clipLine = lineNumber(source.lines, '### 6.2 Clip live detalhado');
  const clipEpoch = 1785289500;
  const clipSlug = slugFromEpoch(clipEpoch);
  if (clipLine && official.some((row) => row.event_slug === clipSlug)) {
    assertions.push(
      makeAssertion({
        source,
        line: clipLine,
        eventKey: clipSlug,
        eventSlug: clipSlug,
        eventEpoch: clipEpoch,
        sourceClass: 'clob_clip_detail',
        categories: ['event_seen', 'order', 'fill', 'complete_set'],
        scopeRoles: ['official_four', 'clip_detail'],
        details: {
          order_id_count: 3,
          order_ids_truncated_in_source: true,
          matched_legs: 3,
          residual: 0,
        },
      }),
    );
  }
  return { assertions, official };
}

function hashedOrderIds(report) {
  const ids = [
    ...(report.fills ?? []).map((fill) => fill?.orderId),
    ...(report.orders ?? []).flatMap((order) => [
      order?.raw?.orderID,
      order?.raw?.orderId,
      order?.raw?.id,
    ]),
  ].filter(Boolean);
  return [...new Set(ids)].sort().map((id) => sha256(String(id)));
}

export function parseRawReport(source, report) {
  const eventSlug = report?.event?.slug ?? null;
  const eventEpoch = Number(eventSlug?.match(/(\d+)$/)?.[1]);
  if (!eventSlug || !Number.isFinite(eventEpoch)) {
    throw new Error(`Raw report lacks a valid event slug: ${source.path}`);
  }
  const fills = (report.fills ?? []).filter(Boolean);
  const orders = (report.orders ?? []).filter(Boolean);
  const upShares = Number(report?.inv?.UP?.shares ?? 0);
  const downShares = Number(report?.inv?.DOWN?.shares ?? 0);
  const categories = ['event_seen'];
  if (orders.length || fills.length) categories.push('order');
  if (!orders.length && !fills.length) categories.push('idle', 'no_order');
  if (fills.length) categories.push('fill');
  else categories.push('no_fill');
  if (
    fills.length &&
    upShares > 0 &&
    downShares > 0 &&
    Math.abs(upShares - downShares) < 1e-9
  ) {
    categories.push('complete_set');
  }
  const legs = fills.map((fill) => ({
    side: fill.side,
    price: Number(fill.px),
    shares: Number(fill.sh),
    kind: fill.kind,
    dry: fill.dry,
    matched_at: fill.ts,
  }));
  return makeAssertion({
    source,
    line: lineNumber(source.lines, '"generatedAt"') ?? 1,
    eventKey: eventSlug,
    eventSlug,
    eventEpoch,
    sourceClass: 'raw_local_live_report',
    categories,
    scopeRoles: ['raw_local_report'],
    details: {
      generated_at: report.generatedAt ?? null,
      live: report.live === true,
      mode: report.mode ?? null,
      order_count: orders.length,
      fill_leg_count: fills.length,
      order_id_sha256: hashedOrderIds(report),
      legs,
      up_shares: upShares,
      down_shares: downShares,
      invested: report.invested ?? null,
      modeled_fees: report.fees ?? null,
      avg_sum: report.avgSum ?? null,
      residual: report.residual ?? null,
      winner_proxy: report.winner ?? null,
      pnl_proxy: report.pnl ?? null,
      open_attempts: report.openAttempts ?? null,
      hedge_attempts: report.hedgeAttempts ?? null,
      stale_blocks: report.staleBlocks ?? null,
      block_counts: report.blockCounts ?? {},
    },
  });
}

function parseMachineSummary(source, officialAnchors) {
  const assertions = [];
  const firstLine = lineNumber(source.lines, 'evento `…22600`');
  if (firstLine) {
    const epoch = resolveEpochSuffix('22600', officialAnchors, 24 * 3600);
    const slug = slugFromEpoch(epoch);
    assertions.push(
      makeAssertion({
        source,
        line: firstLine,
        eventKey: slug ?? 'session:micro-live-1:event-1',
        eventSlug: slug,
        eventEpoch: epoch,
        sourceClass: 'documented_session_summary',
        categories: ['event_seen', 'idle', 'no_order', 'no_fill'],
        scopeRoles: ['denominator_candidate', 'micro_live_1'],
        overlapStatus: slug ? 'exact' : 'unmapped_session_observation',
        details: { outcome: 'idle_one_way_book', order_count: 0, fill_count: 0 },
      }),
    );
  }

  const specs = [
    {
      key: 'session:micro-live-2:event-1',
      needle: '| 1/3 | idle',
      categories: ['event_seen', 'idle', 'no_order', 'no_fill'],
      details: { outcome: 'idle_one_way_book' },
    },
    {
      key: 'session:micro-live-2:event-2',
      needle: '| 2/3 | skip `tau_low`',
      categories: ['event_seen', 'skip', 'no_order', 'no_fill'],
      details: { outcome: 'skip', reason: 'tau_low' },
    },
    {
      key: 'session:micro-live-2:event-3',
      needle: '| 3/3 | FOK',
      categories: ['event_seen', 'order', 'no_fill'],
      details: {
        outcome: 'fok_killed',
        requested_side: 'UP',
        requested_price: 0.55,
        requested_shares: 5,
        later_open_miss_cap_count: 2,
      },
    },
    {
      key: 'session:micro-live-3:successful-unmapped',
      needle: 'live #3: 1 trade real avgSum 0.96',
      categories: ['event_seen', 'order', 'fill', 'complete_set'],
      details: { outcome: 'real_complete_set', avg_sum: 0.96 },
    },
    {
      key: 'session:micro-live-4:event-unmapped',
      needle: 'Micro live #4 size10: 0 fills',
      categories: ['event_seen', 'idle', 'no_fill'],
      details: { outcome: 'zero_fills', reasons: ['MISS_CAP', 'WS_stale'] },
    },
  ];
  for (const spec of specs) {
    const line = lineNumber(source.lines, spec.needle);
    if (!line) continue;
    assertions.push(
      makeAssertion({
        source,
        line,
        eventKey: spec.key,
        sourceClass: 'documented_session_summary',
        categories: spec.categories,
        scopeRoles: [
          'denominator_candidate',
          spec.key.split(':')[1].replaceAll('-', '_'),
        ],
        overlapStatus: 'unmapped_session_observation',
        details: spec.details,
      }),
    );
  }
  return assertions;
}

function parseSessionHandoff(source, officialAnchors) {
  const assertions = [];
  const specs = [
    {
      key: 'session:micro-live-1:event-1',
      suffix: '22600',
      needle: '| Resultado | **idle · 0 ordens · $0** |',
      categories: ['event_seen', 'idle', 'no_order', 'no_fill'],
      details: { outcome: 'idle_one_way_book', duplicate_session_description: true },
    },
    {
      key: 'session:micro-live-2:event-1',
      needle: '| Evento 1 | idle · 0 fills · one-way |',
      categories: ['event_seen', 'idle', 'no_fill'],
      details: { outcome: 'idle_one_way_book', duplicate_session_description: true },
    },
    {
      key: 'session:micro-live-2:event-2',
      needle: '| Evento 2 | skip `tau_low`',
      categories: ['event_seen', 'skip', 'no_order', 'no_fill'],
      details: {
        outcome: 'skip',
        reason: 'tau_low',
        duplicate_session_description: true,
      },
    },
    {
      key: 'session:micro-live-2:event-3',
      needle: '| Evento 3 | **1 FOK real**',
      categories: ['event_seen', 'order', 'no_fill'],
      details: { outcome: 'fok_killed', duplicate_session_description: true },
    },
  ];
  for (const spec of specs) {
    const line = lineNumber(source.lines, spec.needle);
    if (!line) continue;
    const eventEpoch = spec.suffix
      ? resolveEpochSuffix(spec.suffix, officialAnchors, 24 * 3600)
      : null;
    const eventSlug = slugFromEpoch(eventEpoch);
    assertions.push(
      makeAssertion({
        source,
        line,
        eventKey: eventSlug ?? spec.key,
        eventSlug,
        eventEpoch,
        sourceClass: 'documented_session_handoff',
        categories: spec.categories,
        scopeRoles: [
          'denominator_candidate',
          spec.key.split(':')[1].replaceAll('-', '_'),
        ],
        overlapStatus: eventSlug ? 'exact' : 'unmapped_session_observation',
        details: spec.details,
      }),
    );
  }
  return assertions;
}

function parseCanonicalOutcomes(source, relevantSlugs) {
  const latest = new Map();
  for (let index = 0; index < source.lines.length; index += 1) {
    const line = source.lines[index];
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!relevantSlugs.has(row.slug) || !row.winner) continue;
    const previous = latest.get(row.slug);
    if (!previous || String(row.observed_at) > String(previous.row.observed_at)) {
      latest.set(row.slug, { row, line: index + 1 });
    }
  }
  return [...latest.values()].map(({ row, line }) =>
    makeAssertion({
      source,
      line,
      eventKey: row.slug,
      eventSlug: row.slug,
      eventEpoch: Number(row.event_epoch),
      sourceClass: 'research_resolved_market_outcome',
      categories: ['resolution'],
      scopeRoles: ['resolution_context'],
      details: {
        winner: row.winner,
        outcome_source: row.source,
        observed_at: row.observed_at,
        automatically_resolved: row.automatically_resolved ?? null,
        account_redeem_observed: false,
      },
    }),
  );
}

function classifyEvent(assertions) {
  const categories = new Set(assertions.flatMap((assertion) => assertion.categories));
  const conflicts = [];
  const warnings = [];
  const fillPositive = categories.has('fill') || categories.has('complete_set');
  const fillNegative =
    categories.has('idle') || categories.has('no_fill') || categories.has('no_order');
  if (fillPositive && fillNegative) {
    conflicts.push({
      type: 'fill_vs_no_fill',
      positive_assertions: assertions
        .filter((row) => row.categories.includes('fill') || row.categories.includes('complete_set'))
        .map((row) => row.assertion_id)
        .sort(),
      negative_assertions: assertions
        .filter(
          (row) =>
            row.categories.includes('idle') ||
            row.categories.includes('no_fill') ||
            row.categories.includes('no_order'),
        )
        .map((row) => row.assertion_id)
        .sort(),
    });
  }
  if (categories.has('order') && categories.has('no_order')) {
    conflicts.push({
      type: 'order_vs_no_order',
      positive_assertions: assertions
        .filter((row) => row.categories.includes('order'))
        .map((row) => row.assertion_id)
        .sort(),
      negative_assertions: assertions
        .filter((row) => row.categories.includes('no_order'))
        .map((row) => row.assertion_id)
        .sort(),
    });
  }
  if (categories.has('skip') && categories.has('complete_set')) {
    conflicts.push({
      type: 'skip_vs_complete_set',
      positive_assertions: assertions
        .filter((row) => row.categories.includes('complete_set'))
        .map((row) => row.assertion_id)
        .sort(),
      negative_assertions: assertions
        .filter((row) => row.categories.includes('skip'))
        .map((row) => row.assertion_id)
        .sort(),
    });
  }
  const proxyWinners = new Set(
    assertions
      .filter((row) => row.source_class === 'raw_local_live_report')
      .map((row) => row.details.winner_proxy)
      .filter(Boolean),
  );
  const resolvedWinners = new Set(
    assertions
      .filter((row) => row.source_class === 'research_resolved_market_outcome')
      .map((row) => row.details.winner)
      .filter(Boolean),
  );
  for (const proxy of proxyWinners) {
    for (const resolved of resolvedWinners) {
      if (proxy === resolved) continue;
      warnings.push({
        type: 'winner_proxy_vs_research_resolution',
        winner_proxy: proxy,
        resolved_winner: resolved,
        complete_set_pnl_invariant_when_residual_zero: true,
      });
    }
  }

  let activity = 'event_seen';
  if (conflicts.length) activity = 'conflict';
  else if (categories.has('complete_set')) activity = 'complete_set';
  else if (categories.has('fill')) activity = 'fill';
  else if (categories.has('order') && categories.has('no_fill')) activity = 'order_no_fill';
  else if (categories.has('skip')) activity = 'skip';
  else if (categories.has('idle')) activity = 'idle';

  return {
    activity,
    conflict: conflicts.length > 0,
    conflicts,
    warnings,
  };
}

export function groupAssertions(assertions) {
  const grouped = new Map();
  for (const assertion of assertions) {
    if (!grouped.has(assertion.event_key)) grouped.set(assertion.event_key, []);
    grouped.get(assertion.event_key).push(assertion);
  }
  return [...grouped.entries()]
    .map(([eventKey, evidence]) => {
      const sortedEvidence = evidence.sort((a, b) =>
        `${a.source}:${a.source_line}:${a.assertion_id}`.localeCompare(
          `${b.source}:${b.source_line}:${b.assertion_id}`,
        ),
      );
      const exact = sortedEvidence.find((row) => row.event_slug);
      const categoryEvidence = {};
      for (const category of CATEGORIES) {
        const ids = sortedEvidence
          .filter((row) => row.categories.includes(category))
          .map((row) => row.assertion_id)
          .sort();
        if (ids.length) categoryEvidence[category] = ids;
      }
      return {
        event_key: eventKey,
        event_slug: exact?.event_slug ?? null,
        event_epoch: exact?.event_epoch ?? null,
        event_start: exact?.event_start ?? null,
        countable_as_exact_unique_event: Boolean(exact?.event_slug),
        overlap_status: exact?.event_slug ? 'exact_slug' : 'unknown_possible_overlap',
        scope_roles: [...new Set(sortedEvidence.flatMap((row) => row.scope_roles))].sort(),
        category_evidence: categoryEvidence,
        classification: classifyEvent(sortedEvidence),
        evidence: sortedEvidence,
      };
    })
    .sort((a, b) => {
      const aEpoch = a.event_epoch ?? Number.MAX_SAFE_INTEGER;
      const bEpoch = b.event_epoch ?? Number.MAX_SAFE_INTEGER;
      return aEpoch - bEpoch || a.event_key.localeCompare(b.event_key);
    });
}

function inspectSourceHazards({
  harnessSource,
  summarizerSource,
  analyzeSource,
  rawReportSlugs,
  officialSlugs,
}) {
  const findings = [];
  if (harnessSource) {
    const overwriteLine = lineNumber(
      harnessSource.lines,
      /writeFileSync\(path\.join\(outDir,\s*`\$\{slug\}\.json`/,
    );
    if (overwriteLine) {
      findings.push({
        finding: 'per_slug_overwrite_hazard',
        severity: 'high',
        source: harnessSource.path,
        source_line: overwriteLine,
        detail: 'A later process for the same slug can replace an earlier event report.',
      });
    }
    const earlySkipLine = lineNumber(harnessSource.lines, "reason: 'tau_low'");
    if (earlySkipLine) {
      findings.push({
        finding: 'tau_low_returns_before_event_report_write',
        severity: 'high',
        source: harnessSource.path,
        source_line: earlySkipLine,
        detail: 'A tau_low observation can appear in a session summary but has no per-slug file.',
      });
    }
    const proxyLine = lineNumber(harnessSource.lines, '// winner proxy');
    if (proxyLine) {
      findings.push({
        finding: 'winner_and_pnl_are_proxy_not_account_settlement',
        severity: 'high',
        source: harnessSource.path,
        source_line: proxyLine,
        detail: 'Final asks determine the report winner; no redeem or credited payout is observed.',
      });
    }
  }
  if (summarizerSource) {
    const dropsLine = lineNumber(summarizerSource.lines, 'if (!fills.length) continue;');
    if (dropsLine) {
      findings.push({
        finding: 'fill_summarizer_drops_zero_fill_events',
        severity: 'high',
        source: summarizerSource.path,
        source_line: dropsLine,
        detail: 'Totals made by this helper cannot be used as a policy denominator.',
      });
    }
  }
  if (analyzeSource) {
    const referenced = [
      ...analyzeSource.text.matchAll(/btc-updown-5m-(\d+)\.json/g),
    ].map((match) => `btc-updown-5m-${match[1]}`);
    for (const eventSlug of [...new Set(referenced)].sort()) {
      if (rawReportSlugs.has(eventSlug)) continue;
      findings.push({
        finding: 'historically_referenced_report_missing_locally',
        severity: 'high',
        source: analyzeSource.path,
        source_line: lineNumber(analyzeSource.lines, eventSlug),
        event_slug: eventSlug,
        detail: 'The container report was referenced by a historical analysis script but is absent now.',
      });
    }
  }
  for (const eventSlug of [...officialSlugs].sort()) {
    if (rawReportSlugs.has(eventSlug)) continue;
    findings.push({
      finding: 'official_complete_set_without_raw_local_report',
      severity: 'medium',
      event_slug: eventSlug,
      detail: 'The account-level CLOB summary remains, but the per-event raw report is absent.',
    });
  }
  for (const eventSlug of [...rawReportSlugs].sort()) {
    if (officialSlugs.has(eventSlug)) continue;
    findings.push({
      finding: 'raw_complete_set_or_idle_report_not_mapped_to_official_four',
      severity: 'medium',
      event_slug: eventSlug,
      detail: 'Keep as separate evidence; do not count it as one of the four without a raw account export.',
    });
  }
  findings.push({
    finding: 'raw_clob_account_export_not_preserved',
    severity: 'high',
    detail: 'The briefing cites getTrades/getTradesPaginated, but no raw response is in the configured inputs.',
  });
  findings.push({
    finding: 'no_split_merge_redeem_or_balance_delta_record',
    severity: 'high',
    detail: 'Complete-set payout is structural/modelled; actual account settlement is not locally evidenced.',
  });
  return findings;
}

function makeAggregates(events, officialSlugs) {
  const exact = events.filter((event) => event.countable_as_exact_unique_event);
  const unmapped = events.filter((event) => !event.countable_as_exact_unique_event);
  const exactNoConflict = exact.filter((event) => !event.classification.conflict);
  const categoryCount = (rows, category) =>
    rows.filter((event) => event.category_evidence[category]?.length).length;
  const official = exact.filter((event) => officialSlugs.has(event.event_slug));
  return {
    denominator_status: 'not_exactly_recoverable_from_local_artifacts',
    exact_unique_event_groups: exact.length,
    unmapped_session_observation_groups: unmapped.length,
    exact_event_groups_with_conflict: exact.filter((event) => event.classification.conflict).length,
    official_four_expected: 4,
    official_four_present_in_clob_summary: categoryCount(official, 'complete_set'),
    official_four_with_conflicting_local_assertion: official.filter(
      (event) => event.classification.conflict,
    ).length,
    conflict_free_exact_groups: {
      complete_set: categoryCount(exactNoConflict, 'complete_set'),
      order_no_fill: exactNoConflict.filter(
        (event) =>
          event.category_evidence.order?.length && event.category_evidence.no_fill?.length,
      ).length,
      idle: categoryCount(exactNoConflict, 'idle'),
      skip: categoryCount(exactNoConflict, 'skip'),
    },
    unmapped_groups_not_added_to_exact_counts: {
      complete_set: categoryCount(unmapped, 'complete_set'),
      order_no_fill: unmapped.filter(
        (event) =>
          event.category_evidence.order?.length && event.category_evidence.no_fill?.length,
      ).length,
      idle: categoryCount(unmapped, 'idle'),
      skip: categoryCount(unmapped, 'skip'),
    },
  };
}

export function buildRecovery({
  root = process.cwd(),
  robotRoot = path.resolve(root, '..', 'data-robot'),
} = {}) {
  const sources = [];
  const missingInputs = [];
  const addSource = (absolutePath, sourceClass, required = false) => {
    const source = sourceRecord(root, absolutePath, sourceClass);
    if (source) sources.push(source);
    else if (required) {
      missingInputs.push({
        path: posix(path.relative(root, absolutePath)),
        source_class: sourceClass,
      });
    }
    return source;
  };

  addSource(fileURLToPath(import.meta.url), 'recovery_implementation', true);
  const briefing = addSource(
    path.join(root, 'labs', 'sandbox', 'pair-path-v0', 'BRIEFING-CLIP-PATH-2026-07-28.md'),
    'clob_briefing',
    true,
  );
  const audit = addSource(
    path.join(root, 'labs', 'sandbox', 'pair-path-v0', 'AUDIT-PAIR-PATH-2026-07-29.md'),
    'independent_audit',
    true,
  );
  const machine = addSource(
    path.join(root, 'labs', 'sandbox', 'pair-path-v0', 'MACHINE-V0.md'),
    'machine_session_summary',
    true,
  );
  const handoff = addSource(
    path.join(root, 'docs', 'labs', 'pair-path-v0-sessao-019fa6ab.md'),
    'session_handoff',
    true,
  );
  const analyze = addSource(
    path.join(root, 'labs', 'sandbox', 'pair-path-v0', 'analyze-last-trade.sh'),
    'historical_analysis_helper',
  );
  const summarizer = addSource(
    path.join(root, 'labs', 'sandbox', 'pair-path-v0', 'summarize-live-fills.mjs'),
    'historical_fill_summarizer',
  );
  const canonical = addSource(
    path.join(root, 'scratch', 'canonical-outcomes-v1.jsonl'),
    'resolved_outcome_research_journal',
  );
  const harness = addSource(
    path.join(robotRoot, 'scripts', 'pair-path', 'micro-live.js'),
    'historical_harness_source',
  );

  const assertions = [];
  let official = [];
  if (briefing) {
    const parsed = parseBriefing(briefing);
    assertions.push(...parsed.assertions);
    official = parsed.official;
  }
  const officialAnchors = official.map((row) => row.event_epoch);
  if (machine) assertions.push(...parseMachineSummary(machine, officialAnchors));
  if (handoff) assertions.push(...parseSessionHandoff(handoff, officialAnchors));

  const rawReportSlugs = new Set();
  const rawDir = path.join(root, '.tmp', 'pair-path-v0-live-fills');
  if (fs.existsSync(rawDir)) {
    const files = fs
      .readdirSync(rawDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const name of files) {
      const source = addSource(path.join(rawDir, name), 'raw_local_live_report');
      if (!source) continue;
      const report = JSON.parse(source.text);
      const assertion = parseRawReport(source, report);
      rawReportSlugs.add(assertion.event_slug);
      assertions.push(assertion);
    }
  } else {
    missingInputs.push({
      path: '.tmp/pair-path-v0-live-fills',
      source_class: 'raw_local_live_report_directory',
    });
  }

  const relevantSlugs = new Set(assertions.map((row) => row.event_slug).filter(Boolean));
  if (canonical) assertions.push(...parseCanonicalOutcomes(canonical, relevantSlugs));

  const officialSlugs = new Set(official.map((row) => row.event_slug));
  const events = groupAssertions(assertions);
  const findings = inspectSourceHazards({
    harnessSource: harness,
    summarizerSource: summarizer,
    analyzeSource: analyze,
    rawReportSlugs,
    officialSlugs,
  });
  for (const event of events) {
    if (event.classification.conflicts.length) {
      findings.push({
        finding: 'contradictory_event_assertions',
        severity: 'high',
        event_slug: event.event_slug,
        event_key: event.event_key,
        conflict_types: event.classification.conflicts.map((conflict) => conflict.type),
        detail: 'Assertions are retained separately; this event is excluded from conflict-free counts.',
      });
    }
    for (const warning of event.classification.warnings) {
      findings.push({
        finding: warning.type,
        severity: 'medium',
        event_slug: event.event_slug,
        event_key: event.event_key,
        winner_proxy: warning.winner_proxy,
        resolved_winner: warning.resolved_winner,
        detail:
          'The harness winner proxy disagrees with the Gamma-resolved research label; an equalized complete-set remains payout-invariant.',
      });
    }
  }
  for (const missing of missingInputs) {
    findings.push({
      finding: 'configured_input_missing',
      severity: 'medium',
      ...missing,
    });
  }

  const inputManifest = sources
    .map(sourceManifestEntry)
    .sort((a, b) => a.path.localeCompare(b.path));
  const datasetId = `pair_clip_denominator_${sha256(stableJson(inputManifest)).slice(0, 16)}`;
  const result = {
    schema_version: SCHEMA_VERSION,
    dataset_id: datasetId,
    scope: {
      operation: 'local_read_only_recovery',
      network_calls: false,
      credentials_read: false,
      orders_placed: false,
      official_complete_set_target: 4,
    },
    counting_policy: {
      exact_event_identity: 'event_slug',
      unmapped_session_identity:
        'stable session/event label; excluded from exact unique-event counts because overlap is unknown',
      duplicate_sources:
        'multiple assertions for one event_key remain evidence rows but count as one event group',
      contradictions:
        'mutually exclusive assertions are retained and excluded from conflict-free counts',
      polling_blocks:
        'block counters are diagnostics, never independent market opportunities',
      raw_unmapped_reports:
        'not assigned to the official four without an account-level raw export',
    },
    input_manifest: inputManifest,
    aggregates: makeAggregates(events, officialSlugs),
    official_four: official,
    events,
    findings: findings.sort((a, b) =>
      `${a.severity}:${a.finding}:${a.event_slug ?? ''}:${a.source ?? ''}`.localeCompare(
        `${b.severity}:${b.finding}:${b.event_slug ?? ''}:${b.source ?? ''}`,
      ),
    ),
    excluded_claims: [
      'No exact historical eligible-opportunity denominator is claimed.',
      'No unmapped session observation is added to an exact slug count.',
      'No modeled fee or winner proxy is described as actual account settlement.',
      'No raw local report is assigned to an official CLOB row solely by similar size or price.',
    ],
  };
  return result;
}

function fmt(value) {
  if (value == null) return '';
  return String(value).replaceAll('|', '\\|');
}

export function renderMarkdown(result) {
  const lines = [
    '# Pair/Clip historical denominator recovery',
    '',
    `Dataset: \`${result.dataset_id}\``,
    '',
    '## Conclusion',
    '',
    `Exact denominator status: **${result.aggregates.denominator_status}**.`,
    '',
    'The four account-level complete sets are preserved as evidence. Conflicting',
    'and unmapped observations remain explicit and are not forced into a single',
    'chronology.',
    '',
    '## Safe counts',
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Exact slug groups | ${result.aggregates.exact_unique_event_groups} |`,
    `| Unmapped session groups, excluded from exact total | ${result.aggregates.unmapped_session_observation_groups} |`,
    `| Exact groups with conflicts | ${result.aggregates.exact_event_groups_with_conflict} |`,
    `| Official complete sets in CLOB summary | ${result.aggregates.official_four_present_in_clob_summary} |`,
    `| Official events with conflicting local assertion | ${result.aggregates.official_four_with_conflicting_local_assertion} |`,
    `| Conflict-free exact complete-set groups | ${result.aggregates.conflict_free_exact_groups.complete_set} |`,
    `| Conflict-free exact order/no-fill groups | ${result.aggregates.conflict_free_exact_groups.order_no_fill} |`,
    '',
    'These counts are evidence-group counts, not an expectancy estimate.',
    '',
    '## Exact event ledger',
    '',
    '| Event | UTC start | Activity | Scope | Evidence | Conflict |',
    '|---|---|---|---|---:|---|',
  ];
  for (const event of result.events.filter((row) => row.event_slug)) {
    lines.push(
      `| ${fmt(event.event_slug)} | ${fmt(event.event_start)} | ${fmt(event.classification.activity)} | ${fmt(event.scope_roles.join(', '))} | ${event.evidence.length} | ${event.classification.conflict ? 'yes' : 'no'} |`,
    );
  }
  lines.push(
    '',
    '## Unmapped session observations',
    '',
    '| Stable group | Activity | Evidence | Overlap handling |',
    '|---|---|---:|---|',
  );
  for (const event of result.events.filter((row) => !row.event_slug)) {
    lines.push(
      `| ${fmt(event.event_key)} | ${fmt(event.classification.activity)} | ${event.evidence.length} | excluded from exact counts |`,
    );
  }
  lines.push(
    '',
    '## Contradictions',
    '',
  );
  const conflicts = result.events.filter((event) => event.classification.conflict);
  if (!conflicts.length) lines.push('No event-level contradiction was detected.');
  for (const event of conflicts) {
    lines.push(
      `- \`${event.event_slug ?? event.event_key}\`: ${event.classification.conflicts
        .map((conflict) => conflict.type)
        .join(', ')}.`,
    );
  }
  lines.push(
    '',
    '## Recovery hazards and missing evidence',
    '',
  );
  for (const finding of result.findings) {
    lines.push(
      `- **${finding.severity} · ${finding.finding}**${finding.event_slug ? ` · \`${finding.event_slug}\`` : ''}: ${finding.detail ?? 'Configured input is missing.'}`,
    );
  }
  lines.push(
    '',
    '## Counting rules',
    '',
    '- Exact events are keyed only by full event slug.',
    '- Session observations without a slug remain separate, with unknown overlap.',
    '- Duplicate sources reinforce evidence but do not add event counts.',
    '- Success/no-fill or order/no-order disagreements remain conflicts.',
    '- Poll-loop block counts are never counted as market opportunities.',
    '- Modeled fees, final-ask winner proxies, and structural payout are not account settlement.',
    '',
    '## Input manifest',
    '',
    '| Source | Class | SHA-256 | Bytes |',
    '|---|---|---|---:|',
  );
  for (const source of result.input_manifest) {
    lines.push(
      `| ${fmt(source.path)} | ${fmt(source.source_class)} | \`${source.sha256}\` | ${source.bytes} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const root = path.resolve(parseArg('root', process.cwd()));
  const robotRoot = path.resolve(parseArg('robot-root', path.join(root, '..', 'data-robot')));
  const out = path.resolve(
    root,
    parseArg('out', path.join('.tmp', 'pair-path-v0-denominator-recovery')),
  );
  const result = buildRecovery({ root, robotRoot });
  const json = stableJson(result);
  const markdown = renderMarkdown(result);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'denominator-recovery.json'), json);
  fs.writeFileSync(path.join(out, 'denominator-recovery.md'), markdown);
  process.stdout.write(
    `${JSON.stringify({
      dataset_id: result.dataset_id,
      out: posix(path.relative(root, out)),
      exact_events: result.aggregates.exact_unique_event_groups,
      unmapped_groups: result.aggregates.unmapped_session_observation_groups,
      conflicts: result.aggregates.exact_event_groups_with_conflict,
    })}\n`,
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
