/**
 * Audita os eventos position_settled do data-robot sem somar o mesmo
 * ativo/mercado mais de uma vez.
 *
 * O pnlDelta é somente a perna de settlement registrada pelo robô. Ele não é
 * PnL líquido de carteira: não desconta necessariamente fees nem recompõe
 * todas as saídas parciais. O objetivo deste script é detectar duplicidade e
 * caracterizar a razão ganho/perda observada, não certificar saldo.
 *
 * Uso:
 *   node labs/sandbox/midas-live-audit-dedup.mjs \
 *     --root ../data-robot/runs/labs-audit \
 *     --out labs/sandbox/midas-live-audit-dedup.json
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const flags = {
    root: '../data-robot/runs/labs-audit',
    out: 'labs/sandbox/midas-live-audit-dedup.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function filesUnder(root) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  }
  return found.sort();
}

function assetFrom(file, event) {
  const explicit = event.asset ?? event.underlying;
  if (explicit) return String(explicit).toUpperCase();
  const marketId = String(event.marketId ?? event.fromMarketId ?? '');
  const marketMatch = marketId.match(/^([a-z0-9]+)-updown-/i);
  if (marketMatch) return marketMatch[1].toUpperCase();
  const fileMatch = path.basename(file).match(/^(btc|eth|sol|xrp|doge|hype)/i);
  return fileMatch ? fileMatch[1].toUpperCase() : 'UNKNOWN';
}

function summarize(records) {
  const pnls = records.map((record) => Number(record.pnlDelta) || 0);
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const sorted = [...pnls].sort((a, b) => a - b);
  const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = -losses.reduce((sum, pnl) => sum + pnl, 0);
  const p05Index = sorted.length
    ? Math.max(0, Math.floor((sorted.length - 1) * 0.05))
    : 0;
  return {
    settlements: records.length,
    pnlDeltaSum: round(pnls.reduce((sum, pnl) => sum + pnl, 0)),
    wins: wins.length,
    losses: losses.length,
    winRatePct: round(records.length ? (100 * wins.length) / records.length : 0, 2),
    avgWin: round(wins.length ? grossProfit / wins.length : 0),
    avgLoss: round(losses.length ? -grossLoss / losses.length : 0),
    profitFactor: round(grossLoss > 0 ? grossProfit / grossLoss : 0),
    worst: round(sorted[0] ?? 0),
    p05: round(sorted[p05Index] ?? 0),
  };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const root = path.resolve(flags.root);
  const out = path.resolve(flags.out);
  const files = filesUnder(root);
  const settlements = [];
  const starts = [];

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'engine_started') {
        starts.push({
          asset: assetFrom(file, event),
          tsMs: Number(event.tsMs) || null,
          sourceCommit: event.deployment?.sourceCommit ?? null,
          hardCapUsd: Number(event.catalog?.canary?.hardCapUsd) || null,
          file: path.relative(root, file),
          line: index + 1,
        });
      }
      if (event.type !== 'position_settled') continue;
      const asset = assetFrom(file, event);
      const marketId = event.marketId ?? event.fromMarketId;
      if (!marketId) continue;
      settlements.push({
        asset,
        marketId: String(marketId),
        tsMs: Number(event.tsMs) || null,
        pnlDelta: Number(event.pnlDelta) || 0,
        side: event.side ?? null,
        qty: Number(event.qty) || 0,
        avgPrice: Number(event.avgPrice) || 0,
        settlementPrice: Number(event.settlementPrice) || 0,
        file: path.relative(root, file),
        line: index + 1,
      });
    }
  }

  const groups = new Map();
  for (const record of settlements) {
    const key = `${record.asset}:${record.marketId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const unique = [];
  const duplicates = [];
  let duplicateGroupsWithDifferentPnl = 0;
  for (const [key, records] of groups) {
    records.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
    unique.push(records[0]);
    if (records.length > 1) {
      const distinctPnl = new Set(records.map((record) => round(record.pnlDelta)));
      if (distinctPnl.size > 1) duplicateGroupsWithDifferentPnl += 1;
      duplicates.push({
        key,
        records: records.length,
        extraRecords: records.length - 1,
        firstPnlDelta: round(records[0].pnlDelta),
        distinctPnlDelta: [...distinctPnl],
        rawPnlDelta: round(records.reduce((sum, record) => sum + record.pnlDelta, 0)),
        events: records,
      });
    }
  }
  unique.sort(
    (a, b) =>
      (a.tsMs ?? 0) - (b.tsMs ?? 0) ||
      a.asset.localeCompare(b.asset) ||
      a.marketId.localeCompare(b.marketId),
  );

  const assets = [...new Set(unique.map((record) => record.asset))].sort();
  const rawSummary = summarize(settlements);
  const uniqueSummary = summarize(unique);
  const report = {
    meta: {
      root,
      generatedAt: new Date().toISOString(),
      files: files.length,
      note:
        'Dedup key = asset + marketId; conserva o primeiro settlement. pnlDelta e pre-fee/incompleto e nao equivale a PnL liquido de carteira.',
    },
    raw: rawSummary,
    unique: uniqueSummary,
    duplicateMarkets: duplicates.length,
    duplicateGroupsWithDifferentPnl,
    extraSettlementRecords: settlements.length - unique.length,
    duplicatePnlDeltaOverstatement: round(rawSummary.pnlDeltaSum - uniqueSummary.pnlDeltaSum),
    perAsset: Object.fromEntries(
      assets.map((asset) => [
        asset,
        summarize(unique.filter((record) => record.asset === asset)),
      ]),
    ),
    engineStarts: starts.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0)),
    worstUnique: [...unique]
      .sort((a, b) => a.pnlDelta - b.pnlDelta)
      .slice(0, 25),
    duplicates,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
