#!/usr/bin/env node
/**
 * Consolida estratégias legadas em uma única definição com versões internas
 * e migra backtest_runs, presets e snapshots.
 *
 *   gamma-ladder-v1 + gamma-ladder-v2  →  gamma-ladder
 *   cofre-sete-v1   + cofre-sete-v2    →  cofre-sete
 */
import 'dotenv/config';

import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { invalidateStrategyStatsCache } from '../src/backtestStudio/state/strategyStats.js';
import { seedPromotedStrategies } from '../src/backtestStudio/gls/seedPromotedStrategies.js';
import { seedPortedStrategies } from './seed-ported-strategies.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { loadStrategyManifest } from '../labs/shared/discoverStrategies.js';

const CONSOLIDATIONS = [
  {
    targetSlug: 'gamma-ladder',
    targetName: 'Gamma Ladder',
    legacySlugs: ['gamma-ladder-v1', 'gamma-ladder-v2'],
    versionMapByLegacySlug: {
      'gamma-ladder-v1': { 1: 1, 2: 2, 3: 3 },
      'gamma-ladder-v2': { 1: 3 },
    },
    defaultVersion: 3,
  },
  {
    targetSlug: 'cofre-sete',
    targetName: 'Cofre Sete',
    legacySlugs: ['cofre-sete-v1', 'cofre-sete-v2'],
    versionMapByLegacySlug: {
      'cofre-sete-v1': { 1: 1, 2: 2 },
      'cofre-sete-v2': { 1: 3, 2: 4 },
    },
    defaultVersion: 4,
  },
];

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run'), reseed: !argv.includes('--no-reseed') };
}

function getStrategyBySlug(db, slug) {
  return db.prepare('SELECT * FROM strategy_definitions WHERE slug = ?').get(slug) ?? null;
}

function listVersions(db, strategyId) {
  return db.prepare(`
    SELECT id, version, notes
    FROM strategy_versions
    WHERE strategy_id = ?
    ORDER BY version ASC, id ASC
  `).all(strategyId);
}

function findVersionRow(db, strategyId, versionNum) {
  return db.prepare(`
    SELECT id, version, notes
    FROM strategy_versions
    WHERE strategy_id = ? AND version = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(strategyId, versionNum);
}

function patchSnapshotJson(raw, { slug, name, strategyId, strategyVersionId, versionNum }) {
  if (!raw) return raw;
  try {
    const meta = JSON.parse(raw);
    meta.strategy_id = strategyId;
    meta.strategy_version_id = strategyVersionId;
    if (versionNum != null) meta.version = versionNum;
    if (typeof meta.slug === 'string' && specLegacySlug(meta.slug)) {
      meta.slug = slug;
    }
    if (typeof meta.name === 'string' && /Cofre Sete V[12]|Gamma Ladder V[12]/.test(meta.name)) {
      meta.name = name;
    }
    if (typeof meta.strategyLabel === 'string' && /Cofre Sete V[12]|Gamma Ladder V[12]/.test(meta.strategyLabel)) {
      meta.strategyLabel = meta.strategyLabel
        .replace(/Cofre Sete V[12]/g, 'Cofre Sete')
        .replace(/Gamma Ladder V[12]/g, 'Gamma Ladder');
    }
    return JSON.stringify(meta);
  } catch {
    return raw;
  }
}

function specLegacySlug(slug) {
  return /^(gamma-ladder-v[12]|cofre-sete-v[12])$/.test(slug);
}

function patchStrategyLabel(raw, targetName) {
  const text = String(raw || '');
  if (!text) return text;
  return text
    .replace(/^GAMMA_LADDER_V1$/i, targetName)
    .replace(/^COFRE_SETE_V1$/i, targetName)
    .replace(/Gamma Ladder V[12]/g, 'Gamma Ladder')
    .replace(/Cofre Sete V[12]/g, 'Cofre Sete');
}

function resolveCanonicalStrategy(db, spec) {
  const target = getStrategyBySlug(db, spec.targetSlug);
  const legacyRows = spec.legacySlugs
    .map((slug) => getStrategyBySlug(db, slug))
    .filter(Boolean);

  if (target) return target;

  const primary = legacyRows[0] ?? null;
  return primary;
}

function buildVersionIdMap(db, spec, canonical, { dryRun }) {
  const versionIdMap = new Map();
  const versionMapByLegacySlug = spec.versionMapByLegacySlug;
  const movedVersionIds = new Set();

  for (const row of listVersions(db, canonical.id)) {
    versionIdMap.set(row.id, { id: row.id, version: row.version });
  }

  for (const legacySlug of spec.legacySlugs) {
    const legacy = getStrategyBySlug(db, legacySlug);
    if (!legacy) continue;

    const perSlugMap = versionMapByLegacySlug[legacySlug] || {};
    for (const row of listVersions(db, legacy.id)) {
      const targetVersionNum = perSlugMap[row.version];
      if (targetVersionNum == null) continue;

      let canonicalVersion = findVersionRow(db, canonical.id, targetVersionNum);
      if (!canonicalVersion) {
        if (!dryRun) {
          db.prepare(`
            UPDATE strategy_versions
            SET strategy_id = ?, version = ?
            WHERE id = ?
          `).run(canonical.id, targetVersionNum, row.id);
        }
        movedVersionIds.add(row.id);
        versionIdMap.set(row.id, { id: row.id, version: targetVersionNum });
        continue;
      }

      if (canonicalVersion.id === row.id) {
        versionIdMap.set(row.id, { id: row.id, version: targetVersionNum });
        continue;
      }

      versionIdMap.set(row.id, {
        id: canonicalVersion.id,
        version: targetVersionNum,
      });

      if (!dryRun && legacy.id !== canonical.id) {
        const runsOnDuplicate = db.prepare('SELECT COUNT(*) AS n FROM backtest_runs WHERE strategy_version_id = ?')
          .get(row.id)?.n ?? 0;
        if (runsOnDuplicate === 0 && !movedVersionIds.has(row.id)) {
          db.prepare('DELETE FROM strategy_presets WHERE strategy_version_id = ?').run(row.id);
          db.prepare('DELETE FROM strategy_versions WHERE id = ?').run(row.id);
        }
      }
    }
  }

  return versionIdMap;
}

function deleteStrategyTree(db, strategyId) {
  const versionIds = db.prepare('SELECT id FROM strategy_versions WHERE strategy_id = ?').all(strategyId).map((r) => r.id);
  for (const versionId of versionIds) {
    db.prepare('DELETE FROM strategy_presets WHERE strategy_version_id = ?').run(versionId);
  }
  db.prepare('DELETE FROM strategy_presets WHERE strategy_id = ?').run(strategyId);
  db.prepare('DELETE FROM strategy_versions WHERE strategy_id = ?').run(strategyId);
  db.prepare('DELETE FROM strategy_definitions WHERE id = ?').run(strategyId);
}

function consolidateOne(db, spec, { dryRun }) {
  const report = {
    targetSlug: spec.targetSlug,
    canonicalId: null,
    versionMaps: [],
    runsUpdated: 0,
    presetsUpdated: 0,
    strategiesRemoved: [],
  };

  const canonical = resolveCanonicalStrategy(db, spec);
  if (!canonical) {
    report.skipped = 'no strategy found';
    return report;
  }
  report.canonicalId = canonical.id;

  if (canonical.slug !== spec.targetSlug) {
    report.renamed = { from: canonical.slug, to: spec.targetSlug };
  }

  const versionIdMap = buildVersionIdMap(db, spec, canonical, { dryRun });
  for (const [fromId, to] of versionIdMap.entries()) {
    report.versionMaps.push({ fromVersionId: fromId, toVersionId: to.id, toVersion: to.version });
  }

  if (canonical.slug !== spec.targetSlug && !dryRun) {
    db.prepare(`
      UPDATE strategy_definitions
      SET slug = ?, name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(spec.targetSlug, spec.targetName, canonical.id);
  } else if (!dryRun) {
    db.prepare(`
      UPDATE strategy_definitions
      SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(spec.targetName, canonical.id);
  }

  const legacyIds = spec.legacySlugs
    .map((slug) => getStrategyBySlug(db, slug)?.id)
    .filter((id) => id && id !== canonical.id);

  const strategyIdsToScan = [...new Set([canonical.id, ...legacyIds])];
  const runs = db.prepare(`
    SELECT id, strategy, strategy_id, strategy_version_id, strategy_snapshot_json
    FROM backtest_runs
    WHERE strategy_id IN (${strategyIdsToScan.map(() => '?').join(', ')})
  `).all(...strategyIdsToScan);

  for (const run of runs) {
    const mapped = versionIdMap.get(run.strategy_version_id);
    let snapshotSlug = null;
    if (run.strategy_snapshot_json) {
      try {
        snapshotSlug = JSON.parse(run.strategy_snapshot_json)?.slug ?? null;
      } catch {
        snapshotSlug = null;
      }
    }
    const needsStrategyId = run.strategy_id !== canonical.id;
    const needsVersion = mapped && run.strategy_version_id !== mapped.id;
    const needsLabel = /gamma ladder v[12]|cofre sete v[12]|GAMMA_LADDER_V1|COFRE_SETE_V1/i.test(String(run.strategy || ''));
    const needsSnapshot = specLegacySlug(snapshotSlug);
    if (!needsStrategyId && !needsVersion && !needsLabel && !needsSnapshot) continue;
    if (!mapped) {
      throw new Error(`Run ${run.id} has unmapped strategy_version_id ${run.strategy_version_id}`);
    }

    report.runsUpdated += 1;
    if (dryRun) continue;

    db.prepare(`
      UPDATE backtest_runs
      SET strategy_id = ?,
          strategy_version_id = ?,
          strategy = ?,
          strategy_snapshot_json = ?
      WHERE id = ?
    `).run(
      canonical.id,
      mapped.id,
      patchStrategyLabel(run.strategy, spec.targetName),
      patchSnapshotJson(run.strategy_snapshot_json, {
        slug: spec.targetSlug,
        name: spec.targetName,
        strategyId: canonical.id,
        strategyVersionId: mapped.id,
        versionNum: mapped.version,
      }),
      run.id,
    );
  }

  for (const preset of db.prepare('SELECT id, strategy_id, strategy_version_id FROM strategy_presets').all()) {
    const mapped = versionIdMap.get(preset.strategy_version_id);
    if (!mapped) continue;
    if (preset.strategy_id === canonical.id && preset.strategy_version_id === mapped.id) continue;
    report.presetsUpdated += 1;
    if (!dryRun) {
      db.prepare(`
        UPDATE strategy_presets
        SET strategy_id = ?, strategy_version_id = ?
        WHERE id = ?
      `).run(canonical.id, mapped.id, preset.id);
    }
  }

  for (const legacyId of legacyIds) {
    const legacy = db.prepare('SELECT slug FROM strategy_definitions WHERE id = ?').get(legacyId);
    report.strategiesRemoved.push(legacy?.slug ?? legacyId);
    if (!dryRun) deleteStrategyTree(db, legacyId);
  }

  const defaultRow = findVersionRow(db, canonical.id, spec.defaultVersion);
  if (defaultRow && !dryRun) {
    db.prepare('UPDATE strategy_definitions SET default_version_id = ? WHERE id = ?')
      .run(defaultRow.id, canonical.id);
  }
  report.defaultVersion = spec.defaultVersion;

  return report;
}

export function migrateConsolidatedStrategies(db, options = {}) {
  const { dryRun = false, reseed = true } = options;
  const reports = [];

  if (!dryRun) db.exec('BEGIN');
  try {
    for (const spec of CONSOLIDATIONS) {
      reports.push(consolidateOne(db, spec, { dryRun }));
    }
    if (!dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!dryRun) db.exec('ROLLBACK');
    throw err;
  }

  if (reseed && !dryRun) {
    bindStrategyLibraryDatabase(db);
    const gammaManifest = loadStrategyManifest(path.resolve('labs/strategies/gamma/gamma-ladder'));
    seedPromotedStrategies(db, { manifests: [gammaManifest], jsOnly: true });
    seedPortedStrategies(db);
    invalidateStrategyStatsCache();
  }

  return { ok: true, dryRun, reports };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const result = migrateConsolidatedStrategies(db, flags);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

const isMain = process.argv[1]?.endsWith('migrate-consolidate-strategies.js');
if (isMain) main();
