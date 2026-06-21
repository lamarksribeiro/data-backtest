export function getStrategyLibraryKind(db, slug, version = 1) {
  const row = db.prepare(`
    SELECT slv.validation_json
    FROM strategy_library_versions slv
    JOIN strategy_library_definitions sld ON sld.id = slv.library_id
    WHERE sld.slug = ? AND slv.version = ?
    ORDER BY slv.id DESC
    LIMIT 1
  `).get(slug, Number(version));
  if (!row?.validation_json) return null;
  try {
    const validation = JSON.parse(row.validation_json);
    return validation.kind || null;
  } catch {
    return null;
  }
}

export function getStrategyLibraryValidation(db, slug, version = 1) {
  const row = db.prepare(`
    SELECT slv.validation_json
    FROM strategy_library_versions slv
    JOIN strategy_library_definitions sld ON sld.id = slv.library_id
    WHERE sld.slug = ? AND slv.version = ?
    ORDER BY slv.id DESC
    LIMIT 1
  `).get(slug, Number(version));
  if (!row?.validation_json) return null;
  try {
    return JSON.parse(row.validation_json);
  } catch {
    return null;
  }
}

export function findRunnerDependency(db, dependencies = []) {
  for (const dep of dependencies) {
    const kind = getStrategyLibraryKind(db, dep.slug, dep.version);
    if (kind === 'runner' || kind === 'portfolio') {
      return { ...dep, kind };
    }
  }
  return null;
}