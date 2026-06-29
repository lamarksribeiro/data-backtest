#!/usr/bin/env node
/**
 * Analisa eventos Edge Snipper com stop_bid disparado no mesmo tick da entrada.
 *
 * Uso:
 *   node labs/strategies/edge/edge-snipper/scripts/analyze-immediate-stop.js
 *   node labs/strategies/edge/edge-snipper/scripts/analyze-immediate-stop.js --preset v1 --from 2026-04-23 --to 2026-06-05
 *   node labs/strategies/edge/edge-snipper/scripts/analyze-immediate-stop.js --preset v2 --event-date 2026-06-05
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../../../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../../../../src/state/sqlite.js';
import { runBacktest } from '../../../../../src/backtest/engine.js';
import { parse } from '../../../../../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../../../../../src/backtestStudio/gls/compiler.js';
import { loadPreset } from '../../../../shared/presets.js';

const STRATEGY_ID = 'edge-snipper';
const STRATEGY_FAMILY = 'edge';

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

function parseDateStart(value) {
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid from date: ${value}`);
	return date;
}

function parseDateEnd(value) {
	const date = new Date(`${value}T23:59:59.999Z`);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid to date: ${value}`);
	return date;
}

function tsMs(value) {
	if (!value) return null;
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : null;
}

function sameTick(left, right, toleranceMs = 1000) {
	const a = tsMs(left);
	const b = tsMs(right);
	if (a == null || b == null) return false;
	return Math.abs(a - b) <= toleranceMs;
}

function analyzeEvent(event, stopBid) {
	const orders = event.orders || [];
	const entry = orders.find((o) => o.type === 'entry');
	if (!entry) return null;

	const exits = orders.filter((o) => o.type === 'exit');
	const stopExits = exits.filter((o) => String(o.reason || '').includes('stop_bid'));
	const firstStop = stopExits.sort((a, b) => tsMs(a.ts) - tsMs(b.ts))[0] ?? null;
	const entryPrice = Number(entry.avgPrice ?? entry.price);
	const entryShares = Number(entry.shares ?? 0);
	const immediateStop = firstStop && sameTick(entry.ts, firstStop.ts);
	const partialStop = immediateStop && Number(firstStop.remainingShares ?? 0) > 0;
	const fullStop = immediateStop && Number(firstStop.remainingShares ?? 0) <= 0;
	const askBelowStop = Number.isFinite(entryPrice) && entryPrice < stopBid;
	const bidWouldTrigger = askBelowStop; // entrada barata: bid tipicamente < ask <= stopBid

	let stopFillPct = null;
	if (immediateStop && entryShares > 0) {
		stopFillPct = (Number(firstStop.shares ?? 0) / entryShares) * 100;
	}

	return {
		eventId: event.eventId,
		eventStart: event.eventStart,
		side: entry.side ?? event.positionType,
		entryTs: entry.ts,
		entryPrice,
		entryShares,
		entryCost: Number(entry.notional ?? event.cost ?? 0),
		entryTimeRemaining: event.entryTimeRemaining,
		finalPnl: Number(event.final_pnl ?? event.finalPnl ?? 0),
		reason: event.reason,
		expirationResult: event.expirationResult,
		winnerSide: event.winnerSide,
		stopBid,
		askBelowStop,
		bidWouldTrigger,
		immediateStop,
		partialStop,
		fullStop,
		stopFillPct,
		stopExitShares: firstStop ? Number(firstStop.shares ?? 0) : 0,
		stopExitPrice: firstStop ? Number(firstStop.avgPrice ?? firstStop.price ?? 0) : null,
		remainingAfterStop: firstStop ? Number(firstStop.remainingShares ?? 0) : entryShares,
		exitReasons: exits.map((o) => o.reason),
	};
}

function summarize(rows) {
	const entered = rows.filter(Boolean);
	const immediate = entered.filter((r) => r.immediateStop);
	const partial = entered.filter((r) => r.partialStop);
	const full = entered.filter((r) => r.fullStop);
	const askBelow = entered.filter((r) => r.askBelowStop);

	const sumPnl = (list) => list.reduce((s, r) => s + r.finalPnl, 0);
	const wins = (list) => list.filter((r) => r.finalPnl > 0).length;

	return {
		totalEntries: entered.length,
		immediateStopCount: immediate.length,
		immediateStopPct: entered.length ? (immediate.length / entered.length) * 100 : 0,
		partialStopCount: partial.length,
		fullStopCount: full.length,
		askBelowStopCount: askBelow.length,
		askBelowStopPct: entered.length ? (askBelow.length / entered.length) * 100 : 0,
		pnlAll: sumPnl(entered),
		pnlImmediateStop: sumPnl(immediate),
		pnlPartialStop: sumPnl(partial),
		pnlFullStop: sumPnl(full),
		pnlNoImmediateStop: sumPnl(entered.filter((r) => !r.immediateStop)),
		winsImmediateStop: wins(immediate),
		winsPartialStop: wins(partial),
		winsFullStop: wins(full),
		avgStopFillPct: partial.length
			? partial.reduce((s, r) => s + (r.stopFillPct ?? 0), 0) / partial.length
			: 0,
		byFinalReason: groupBy(immediate, (r) => r.reason),
	};
}

function groupBy(rows, keyFn) {
	const map = {};
	for (const row of rows) {
		const key = keyFn(row);
		if (!map[key]) map[key] = { count: 0, pnl: 0 };
		map[key].count += 1;
		map[key].pnl += row.finalPnl;
	}
	return map;
}

function findEventsByDate(rows, dateStr) {
	return rows.filter((r) => r?.eventStart?.startsWith(dateStr));
}

async function main() {
	const flags = parseArgs(process.argv.slice(2));
	const presetId = flags.preset || 'btc-classic';
	const from = flags.from || '2026-04-23';
	const to = flags.to || '2026-06-05';

	const { preset, strategyRoot, params } = loadPreset(presetId, {
		strategyFamily: STRATEGY_FAMILY,
		strategyId: STRATEGY_ID,
	});
	const strategy = JSON.parse(readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
	const sourcePath = path.resolve(strategy.source.path);
	const sourceCode = readFileSync(sourcePath, 'utf8');
	const glsAst = parse(sourceCode);
	const bookDepth = Number(flags['book-depth'] || strategy.defaultBookDepth || 25);
	const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);
	const stopBid = Number(params.stopBid ?? 0.18);

	const config = loadConfig();
	const db = openStateDatabase(config.stateDbPath);

	console.error(`[analyze-immediate-stop] preset=${presetId} window=${from}..${to} stopBid=${stopBid}`);

	try {
		const result = await runBacktest(db, {
			from: parseDateStart(from).toISOString(),
			to: parseDateEnd(to).toISOString(),
			underlying: 'BTC',
			interval: '5m',
			bookDepth,
			batchSize: 25_000,
			strategy: `gls:${strategy.id}`,
			strategyLabel: strategy.name,
			glsAst,
			columnAnalysis,
			params,
			fastRun: false,
			glsExecution: 'compiled-soa',
			backtestWorkers: Number(flags.workers || 1),
			strategyMeta: { lab: true, preset: presetId, analysis: 'immediate-stop' },
		});

		const analyzed = (result.events || [])
			.map((event) => analyzeEvent(event, stopBid))
			.filter(Boolean);

		const summary = summarize(analyzed);
		const topPartialWins = analyzed
			.filter((r) => r.partialStop && r.finalPnl > 0)
			.sort((a, b) => b.finalPnl - a.finalPnl)
			.slice(0, 10);

		const topPartialLosses = analyzed
			.filter((r) => r.partialStop && r.finalPnl < 0)
			.sort((a, b) => a.finalPnl - b.finalPnl)
			.slice(0, 5);

		let highlighted = [];
		if (flags['event-date']) {
			highlighted = findEventsByDate(analyzed, flags['event-date']);
		}

		const output = {
			ok: true,
			preset: presetId,
			presetName: preset.name,
			window: { from, to },
			stopBid,
			backtestSummary: result.summary,
			immediateStopAnalysis: summary,
			topPartialWins,
			topPartialLosses,
			highlightedEvents: highlighted,
		};

		console.log(JSON.stringify(output, null, 2));
	} finally {
		closeStateDatabase(db);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
