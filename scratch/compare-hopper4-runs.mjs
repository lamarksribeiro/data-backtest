import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });

const ids = [161, 162, 163, 164];
for (const id of ids) {
  const r = db.prepare(`
    SELECT id, strategy, strategy_id, strategy_version_id, status, from_ts, to_ts,
           params_json, summary_json, strategy_snapshot_json, ticks, duration_ms, created_at
    FROM backtest_runs WHERE id = ?
  `).get(id);
  if (!r) {
    console.log('missing', id);
    continue;
  }
  const params = JSON.parse(r.params_json || '{}');
  const summary = JSON.parse(r.summary_json || '{}');
  let snap = null;
  try { snap = JSON.parse(r.strategy_snapshot_json || 'null'); } catch {}
  const ver = r.strategy_version_id
    ? db.prepare(`SELECT version, notes, substr(checksum,1,12) cs FROM strategy_versions WHERE id = ?`).get(r.strategy_version_id)
    : null;
  console.log('\n=== RUN', id, '===');
  console.log({
    created: r.created_at,
    strategy: r.strategy,
    version: ver,
    window: [r.from_ts, r.to_ts],
    ticks: r.ticks,
    duration_ms: r.duration_ms,
    pnl: summary.totalPnl ?? summary.pnl,
    pf: summary.profitFactor,
    wr: summary.winRate,
    entries: summary.totalEntries ?? summary.entries,
    fees: summary.totalFees ?? summary.feesPaid,
    maxDD: summary.maxDrawdown,
  });
  console.log('params keys', Object.keys(params).sort().join(','));
  console.log('key params', {
    triggerCents: params.triggerCents,
    maxViradas: params.maxViradas,
    distMinPtb: params.distMinPtb,
    fokEnabled: params.fokEnabled,
    pctWallet: params.pctWallet,
    multVirada: params.multVirada,
    cooldownFlipSec: params.cooldownFlipSec,
  });
  if (snap) {
    const src = snap.source_code || snap.sourceCode || '';
    console.log('snapshot', {
      slug: snap.slug,
      version: snap.version,
      runner: (src.match(/strategyLibrary\("([^"]+)"/) || [])[1],
      trigger: (src.match(/triggerCents:\s*([0-9.]+)/) || [])[1],
      maxV: (src.match(/maxViradas:\s*([0-9.]+)/) || [])[1],
      name: (src.match(/name:\s*"([^"]+)"/) || [])[1],
    });
  }
}

// Compare 161 vs later: identical params?
function dig(id) {
  const r = db.prepare(`SELECT params_json, summary_json FROM backtest_runs WHERE id = ?`).get(id);
  return { params: JSON.parse(r.params_json || '{}'), summary: JSON.parse(r.summary_json || '{}') };
}
const a = dig(161);
for (const id of [162, 163, 164]) {
  const b = dig(id);
  const sameParams = JSON.stringify(a.params) === JSON.stringify(b.params);
  const samePnl = Number(a.summary.totalPnl) === Number(b.summary.totalPnl);
  console.log(`\n161 vs ${id}: sameParams=${sameParams} samePnl=${samePnl} pnl161=${a.summary.totalPnl} pnl${id}=${b.summary.totalPnl}`);
}
