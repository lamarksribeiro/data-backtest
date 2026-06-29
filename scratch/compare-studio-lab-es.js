#!/usr/bin/env node
/**
 * Compara PnL Studio (GLS renderizado por versão) vs Lab (strategy.json → v2.gls).
 * Uso: node scratch/compare-studio-lab-es.js
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { parse } from '../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../src/backtestStudio/gls/compiler.js';
import { loadPreset } from '../labs/shared/presets.js';
import { renderPresetGls } from '../labs/shared/renderPresetGls.js';
import {
	getEdgeSnipperV2GlsSource,
} from '../src/backtestStudio/gls/loadStrategySource.js';

const FROM = process.argv[2] || '2026-04-23';
const TO = process.argv[3] || '2026-05-30';
const PRESET = process.argv[4] || 'v1';

function parseDateStart(value) {
	return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function parseDateEnd(value) {
	return new Date(`${value}T23:59:59.999Z`).toISOString();
}

async function runScenario(db, label, sourceCode, params) {
	const glsAst = parse(sourceCode);
	const columnAnalysis = analyzeStrategyColumns(glsAst, 25);
	const started = Date.now();
	const result = await runBacktest(db, {
		from: parseDateStart(FROM),
		to: parseDateEnd(TO),
		underlying: 'BTC',
		interval: '5m',
		bookDepth: 25,
		strategy: 'gls:edge-snipper',
		glsAst,
		columnAnalysis,
		params,
		fastRun: true,
		glsExecution: 'compiled-soa',
		backtestWorkers: 1,
	});
	return {
		label,
		ms: Date.now() - started,
		entries: result.summary.entries,
		wins: result.summary.wins,
		pnl: result.summary.totalPnl,
		strategyName: result.strategy,
	};
}

async function main() {
	const { params, preset } = loadPreset(PRESET, {
		strategyFamily: 'edge',
		strategyId: 'edge-snipper',
	});
	const labStrategyJson = JSON.parse(
		readFileSync('labs/strategies/edge/edge-snipper/strategy.json', 'utf8'),
	);
	const labGlsPath = labStrategyJson.source.path;
	const labGlsSource = readFileSync(labGlsPath, 'utf8');

	const scenarios = [
		{
			label: 'studio (v2.gls renderizado, params no fonte)',
			source: renderPresetGls(getEdgeSnipperV2GlsSource(), params, `Edge Snipper · ${preset.name}`),
			params: {},
		},
		{
			label: 'lab_atual (strategy.json → v2.gls + runtime params)',
			source: labGlsSource,
			params,
		},
	];

	const config = loadConfig();
	const db = openStateDatabase(config.stateDbPath);
	const rows = [];

	try {
		const studioRuns = db.prepare(`
			SELECT r.id, r.status, r.from_ts, r.to_ts, r.summary_json, s.slug, sv.version
			FROM backtest_runs r
			LEFT JOIN strategy_versions sv ON sv.id = r.strategy_version_id
			LEFT JOIN strategy_definitions s ON s.id = r.strategy_id
			WHERE s.slug LIKE '%edge-snipper%' OR s.slug LIKE '%edge-sniper-v3%'
			ORDER BY r.id DESC
			LIMIT 6
		`).all();

		console.error(`[compare] preset=${PRESET} window=${FROM}..${TO}`);
		for (const scenario of scenarios) {
			console.error(`[compare] running: ${scenario.label}`);
			rows.push(await runScenario(db, scenario.label, scenario.source, scenario.params));
		}

		console.log(JSON.stringify({
			window: { from: FROM, to: TO },
			preset: PRESET,
			labStrategySource: labGlsPath,
			presetLabSummary: preset.labSummary ?? null,
			scenarios: rows,
			recentStudioRuns: studioRuns.map((row) => {
				let summary = {};
				try {
					summary = JSON.parse(row.summary_json || '{}');
				} catch {
					summary = {};
				}
				return {
					id: row.id,
					status: row.status,
					version: row.version,
					from: row.from_ts?.slice(0, 10),
					to: row.to_ts?.slice(0, 10),
					pnl: summary.totalPnl,
					entries: summary.entries ?? summary.totalEntries,
				};
			}),
		}, null, 2));
	} finally {
		closeStateDatabase(db);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
