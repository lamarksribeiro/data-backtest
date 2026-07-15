import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const h = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const dbPath = path.resolve('state/data-backtest.db');
console.log('using', dbPath, 'exists', fs.existsSync(dbPath));
const db = new DatabaseSync(dbPath, { readOnly: true });

const strats = db.prepare(`SELECT id, slug, default_version_id FROM strategy_definitions WHERE slug LIKE '%hopper%'`).all();
console.log('strategies', strats);
for (const s of strats) {
  const vers = db.prepare(`
    SELECT id, version, notes, length(source_code) AS srcLen, checksum, validation_json
    FROM strategy_versions WHERE strategy_id = ? ORDER BY version
  `).all(s.id);
  for (const v of vers) {
    const val = JSON.parse(v.validation_json || '{}');
    console.log(s.slug, `v${v.version}`, {
      notes: v.notes,
      srcLen: v.srcLen,
      cs: String(v.checksum || '').slice(0, 16),
      kind: val.execution_kind,
      default: s.default_version_id === v.id,
    });
    const head = db.prepare(`SELECT substr(source_code, 1, 400) AS head FROM strategy_versions WHERE id = ?`).get(v.id);
    console.log('  head:', String(head.head || '').replace(/\n/g, ' | ').slice(0, 300));
    // extract triggerCents from params block if present
    const m = String(head.head || '').match(/triggerCents:\s*([0-9.]+)/)
      || String(head.head || '').match(/pctWallet:\s*([0-9.]+)/);
  }
  // full params sniff
  for (const v of vers) {
    const full = db.prepare(`SELECT source_code FROM strategy_versions WHERE id = ?`).get(v.id);
    const src = full.source_code || '';
    const pick = (re) => (src.match(re) || [])[1];
    console.log('  params sniff v' + v.version, {
      triggerCents: pick(/triggerCents:\s*([0-9.]+)/),
      pctWallet: pick(/pctWallet:\s*([0-9.]+)/),
      maxViradas: pick(/maxViradas:\s*([0-9.]+)/),
      fokEnabled: pick(/fokEnabled:\s*(true|false)/),
      multVirada: pick(/multVirada:\s*"([^"]+)"/),
      runner: pick(/strategyLibrary\("([^"]+)"/),
    });
  }
}

const libs = db.prepare(`
  SELECT d.slug, v.version, length(v.source_code) AS srcLen, v.checksum
  FROM strategy_library_definitions d
  JOIN strategy_library_versions v ON v.library_id = d.id
  WHERE d.slug LIKE '%hopper%'
`).all();
console.log('libs', libs.map((l) => ({ slug: l.slug, version: l.version, srcLen: l.srcLen, cs: String(l.checksum || '').slice(0, 16) })));

const portable = fs.readFileSync('labs/legacy/strategy-runners/portable/hopper-4-runner.js', 'utf8');
const json = JSON.parse(fs.readFileSync('data/strategy-libraries/hopper-4-runner.v1.json', 'utf8'));
const row = db.prepare(`
  SELECT v.source_code
  FROM strategy_library_definitions d
  JOIN strategy_library_versions v ON v.library_id = d.id
  WHERE d.slug = 'hopper-4-runner' AND v.version = 1
`).get();
console.log({
  portable: h(portable),
  json: h(json.source_code),
  sqlite: row ? h(row.source_code) : null,
  sqliteEqPortable: row ? row.source_code === portable : false,
  isStopReverse: row ? /VIRA-VENDE|multVirada/.test(row.source_code) : false,
  isHopper3Cascade: row ? /REV-BARATO|equalizado/.test(row.source_code) : false,
});

// Recent runs mentioning hopper
try {
  const cols = db.prepare(`PRAGMA table_info(backtest_runs)`).all();
  console.log('backtest_runs cols', cols.map((c) => c.name));
  const runs = db.prepare(`
    SELECT id, status, created_at
    FROM backtest_runs
    ORDER BY id DESC LIMIT 8
  `).all();
  console.log('recent runs', runs);
} catch (e) {
  console.log('runs query fail', e.message);
}
