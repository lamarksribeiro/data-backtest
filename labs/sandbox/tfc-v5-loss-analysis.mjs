/**
 * TFC V4 entry analysis — pattern mining on hold-to-settlement PnL.
 * Usage: node --max-old-space-size=6144 labs/sandbox/tfc-v5-loss-analysis.mjs
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const CUBE_DIR = path.join("labs", "mining", "cube");
const REPORT_PATH = path.join("labs", "sandbox", "tfc-v5-loss-analysis-report.md");
const FROM = "2026-04-27";
const TO = "2026-06-27";
const JUNE_CUTOFF = "2026-06-01";

const COL = {
	dt: 0,
	condition_id: 1,
	ts_ms: 2,
	tau: 3,
	dist_abs: 7,
	fav: 8,
	ask_fav: 9,
	spread_fav: 11,
	odds_sum: 14,
	d_spot_5: 15,
	d_spot_30: 19,
	d_spot_60: 20,
	sigma_ps_90: 21,
	flips_60: 22,
	secs_since_flip: 23,
	pin45: 24,
	d_askfav_10: 25,
	d_askfav_15: 26,
	d_askfav_30: 27,
	sigma_askfav_15: 28,
	depth5_ask_fav: 29,
	depth5_bid_fav: 30,
	obi5: 31,
	ladder_fav: 32,
	mkt_agree: 40,
	pnl_fav: 43,
};

function parseNum(s) {
	if (s === "" || s == null) return NaN;
	const v = Number(s);
	return Number.isFinite(v) ? v : NaN;
}

function passesV4(fields) {
	const tau = parseNum(fields[COL.tau]);
	const distAbs = parseNum(fields[COL.dist_abs]);
	const askFav = parseNum(fields[COL.ask_fav]);
	const spreadFav = parseNum(fields[COL.spread_fav]);
	const oddsSum = parseNum(fields[COL.odds_sum]);
	const dSpot5 = parseNum(fields[COL.d_spot_5]);
	const fav = fields[COL.fav];

	if (!(tau >= 5 && tau < 30)) return false;
	if (!(distAbs < 15)) return false;
	if (!(askFav >= 0.55 && askFav <= 0.78)) return false;
	if (!(spreadFav <= 0.02)) return false;
	if (!(oddsSum >= 0.98 && oddsSum <= 1.06)) return false;
	if (fav === "UP" && dSpot5 < -8) return false;
	if (fav === "DOWN" && dSpot5 > 8) return false;
	return true;
}

function rowToEntry(fields) {
	const fav = fields[COL.fav];
	const dSpot5 = parseNum(fields[COL.d_spot_5]);
	const dSpot30 = parseNum(fields[COL.d_spot_30]);
	const dSpot60 = parseNum(fields[COL.d_spot_60]);
	const sign = fav === "UP" ? 1 : -1;

	return {
		dt: fields[COL.dt],
		condition_id: fields[COL.condition_id],
		ts_ms: parseNum(fields[COL.ts_ms]),
		tau: parseNum(fields[COL.tau]),
		dist_abs: parseNum(fields[COL.dist_abs]),
		fav,
		ask_fav: parseNum(fields[COL.ask_fav]),
		obi5: parseNum(fields[COL.obi5]),
		sigma_ps_90: parseNum(fields[COL.sigma_ps_90]),
		d_askfav_10: parseNum(fields[COL.d_askfav_10]),
		d_askfav_15: parseNum(fields[COL.d_askfav_15]),
		d_askfav_30: parseNum(fields[COL.d_askfav_30]),
		sigma_askfav_15: parseNum(fields[COL.sigma_askfav_15]),
		depth5_ask_fav: parseNum(fields[COL.depth5_ask_fav]),
		depth5_bid_fav: parseNum(fields[COL.depth5_bid_fav]),
		ladder_fav: parseNum(fields[COL.ladder_fav]),
		flips_60: parseNum(fields[COL.flips_60]),
		secs_since_flip: parseNum(fields[COL.secs_since_flip]),
		d_spot_5_sig: sign * dSpot5,
		d_spot_30_sig: sign * dSpot30,
		d_spot_60_sig: sign * dSpot60,
		mkt_agree: parseNum(fields[COL.mkt_agree]),
		pin45: parseNum(fields[COL.pin45]),
		pnl_fav: parseNum(fields[COL.pnl_fav]),
		hour_utc: new Date(parseNum(fields[COL.ts_ms])).getUTCHours(),
	};
}

function splitName(dt) {
	return dt >= JUNE_CUTOFF ? "june" : "train";
}

function* dateRange(from, to) {
	const d = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	while (d <= end) {
		yield d.toISOString().slice(0, 10);
		d.setUTCDate(d.getUTCDate() + 1);
	}
}

async function loadEntries() {
	const firstByCondition = new Map();

	for (const dt of dateRange(FROM, TO)) {
		const filePath = path.join(CUBE_DIR, `dt=${dt}.csv`);
		if (!fs.existsSync(filePath)) {
			console.error(`AVISO: arquivo ausente ${filePath}`);
			continue;
		}

		const rl = readline.createInterface({
			input: fs.createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		let lineNo = 0;
		for await (const line of rl) {
			lineNo += 1;
			if (lineNo === 1) continue;
			if (!line.trim()) continue;

			const fields = line.split(",");
			if (!passesV4(fields)) continue;

			const cid = fields[COL.condition_id];
			const tsMs = parseNum(fields[COL.ts_ms]);
			const prev = firstByCondition.get(cid);
			if (!prev || tsMs < prev.ts_ms) {
				firstByCondition.set(cid, rowToEntry(fields));
			}
		}
	}

	return [...firstByCondition.values()];
}

function stats(rows) {
	if (rows.length === 0) {
		return { n: 0, winrate: 0, exp: 0, sum: 0 };
	}
	const n = rows.length;
	const wins = rows.filter((r) => r.pnl_fav > 0).length;
	const sum = rows.reduce((a, r) => a + r.pnl_fav, 0);
	return { n, winrate: wins / n, exp: sum / n, sum };
}

function fmtPct(x) {
	return `${(x * 100).toFixed(1)}%`;
}

function fmtUsd(x) {
	return `$${x.toFixed(3)}`;
}

function quartileEdges(values) {
	const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
	if (sorted.length === 0) return [0, 0, 0, 0];
	const q = (p) => {
		const idx = (sorted.length - 1) * p;
		const lo = Math.floor(idx);
		const hi = Math.ceil(idx);
		if (lo === hi) return sorted[lo];
		return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
	};
	return [q(0.25), q(0.5), q(0.75)];
}

function binQuartile(v, edges, label) {
	if (!Number.isFinite(v)) return `${label}:NA`;
	const [q1, q2, q3] = edges;
	if (v <= q1) return `${label}:Q1(≤${q1.toFixed(4)})`;
	if (v <= q2) return `${label}:Q2(${q1.toFixed(4)}-${q2.toFixed(4)})`;
	if (v <= q3) return `${label}:Q3(${q2.toFixed(4)}-${q3.toFixed(4)})`;
	return `${label}:Q4(>${q3.toFixed(4)})`;
}

function binObi5(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < -0.3) return "<-0.3";
	if (v < 0) return "-0.3..0";
	if (v <= 0.3) return "0..0.3";
	return ">0.3";
}

function binDAskFav(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < -0.03) return "<-0.03";
	if (v < -0.01) return "-0.03..-0.01";
	if (v <= 0.01) return "-0.01..0.01";
	if (v <= 0.03) return "0.01..0.03";
	return ">0.03";
}

function binDepthRatio(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < 0.5) return "<0.5";
	if (v < 1) return "0.5-1";
	if (v <= 2) return "1-2";
	return ">2";
}

function binFlips(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v >= 4) return "4+";
	return String(Math.floor(v));
}

function binSecsSinceFlip(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < 10) return "<10";
	if (v < 30) return "10-30";
	if (v <= 60) return "30-60";
	return ">60";
}

function binDSpot5(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < -5) return "<-5";
	if (v < -2) return "-5..-2";
	if (v < 0) return "-2..0";
	if (v <= 2) return "0..2";
	if (v <= 5) return "2..5";
	return ">5";
}

function binDSpotLong(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < -15) return "<-15";
	if (v < -5) return "-15..-5";
	if (v < 0) return "-5..0";
	if (v <= 5) return "0..5";
	if (v <= 15) return "5..15";
	return ">15";
}

function binTau(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < 10) return "5-10";
	if (v < 15) return "10-15";
	if (v < 20) return "15-20";
	if (v < 25) return "20-25";
	return "25-30";
}

function binAskFav(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < 0.6) return "0.55-0.60";
	if (v < 0.65) return "0.60-0.65";
	if (v < 0.7) return "0.65-0.70";
	if (v < 0.75) return "0.70-0.75";
	return "0.75-0.78";
}

function binDistAbs(v) {
	if (!Number.isFinite(v)) return "NA";
	if (v < 3) return "0-3";
	if (v < 6) return "3-6";
	if (v < 9) return "6-9";
	if (v < 12) return "9-12";
	return "12-15";
}

function binHourUtc(h) {
	const block = Math.floor(h / 4) * 4;
	const end = block + 4;
	return `${String(block).padStart(2, "0")}-${String(end).padStart(2, "0")} UTC`;
}

function binBinary(v, label, threshold = 0) {
	if (!Number.isFinite(v)) return `${label}:NA`;
	return v > threshold ? `${label}:1` : `${label}:0`;
}

function groupBy(rows, keyFn) {
	const map = new Map();
	for (const r of rows) {
		const k = keyFn(r);
		if (!map.has(k)) map.set(k, []);
		map.get(k).push(r);
	}
	return map;
}

function reportBinTable(lines, title, trainRows, juneRows, keyFn, orderFn) {
	lines.push(`### ${title}`);
	lines.push("");
	lines.push("| Bin | n_train | WR_train | exp_train | n_june | WR_june | exp_june |");
	lines.push("|-----|---------|----------|-----------|--------|---------|----------|");

	const trainGroups = groupBy(trainRows, keyFn);
	const juneGroups = groupBy(juneRows, keyFn);
	const allKeys = [...new Set([...trainGroups.keys(), ...juneGroups.keys()])].sort(orderFn);

	for (const k of allKeys) {
		const st = stats(trainGroups.get(k) ?? []);
		const sj = stats(juneGroups.get(k) ?? []);
		lines.push(
			`| ${k} | ${st.n} | ${fmtPct(st.winrate)} | ${fmtUsd(st.exp)} | ${sj.n} | ${fmtPct(sj.winrate)} | ${fmtUsd(sj.exp)} |`,
		);
	}
	lines.push("");
}

function collectCells(trainRows, juneRows, feature, binLabel, keyFn) {
	const cells = [];
	const trainGroups = groupBy(trainRows, keyFn);
	const juneGroups = groupBy(juneRows, keyFn);
	for (const [bin, tr] of trainGroups) {
		const jr = juneGroups.get(bin) ?? [];
		const st = stats(tr);
		const sj = stats(jr);
		cells.push({
			feature,
			bin: `${binLabel}: ${bin}`,
			filterLabel: `${binLabel} = ${bin}`,
			n_train: st.n,
			exp_train: st.exp,
			n_june: sj.n,
			exp_june: sj.exp,
			minN: Math.min(st.n, sj.n),
			avgExp: (st.exp + sj.exp) / 2,
			matchFn: (r) => keyFn(r) === bin,
		});
	}
	return cells;
}

function main() {
	return loadEntries().then((entries) => {
		const trainRows = entries.filter((r) => splitName(r.dt) === "train");
		const juneRows = entries.filter((r) => splitName(r.dt) === "june");
		const stTrain = stats(trainRows);
		const stJune = stats(juneRows);
		const stAll = stats(entries);

		const lines = [];
		lines.push("# TFC V4 — Análise de Padrões de Perda (hold-to-settlement)");
		lines.push("");
		lines.push(`Período: ${FROM} a ${TO} | Split june: dt >= ${JUNE_CUTOFF}`);
		lines.push("");

		lines.push("## 1. Resumo por split");
		lines.push("");
		lines.push("| Split | n | Winrate | Exp média pnl_fav | Soma pnl_fav |");
		lines.push("|-------|---|---------|-------------------|--------------|");
		lines.push(
			`| train (dt < ${JUNE_CUTOFF}) | ${stTrain.n} | ${fmtPct(stTrain.winrate)} | ${fmtUsd(stTrain.exp)} | ${fmtUsd(stTrain.sum)} |`,
		);
		lines.push(
			`| june (dt >= ${JUNE_CUTOFF}) | ${stJune.n} | ${fmtPct(stJune.winrate)} | ${fmtUsd(stJune.exp)} | ${fmtUsd(stJune.sum)} |`,
		);
		lines.push(
			`| **total** | ${stAll.n} | ${fmtPct(stAll.winrate)} | ${fmtUsd(stAll.exp)} | ${fmtUsd(stAll.sum)} |`,
		);
		lines.push("");

		lines.push("## 2. Padrões por feature");
		lines.push("");

		reportBinTable(lines, "obi5", trainRows, juneRows, (r) => binObi5(r.obi5), (a, b) =>
			["<-0.3", "-0.3..0", "0..0.3", ">0.3", "NA"].indexOf(a) -
			["<-0.3", "-0.3..0", "0..0.3", ">0.3", "NA"].indexOf(b),
		);

		const qSigmaPsTrain = quartileEdges(trainRows.map((r) => r.sigma_ps_90));
		const qSigmaPsJune = quartileEdges(juneRows.map((r) => r.sigma_ps_90));
		reportBinTable(
			lines,
			`sigma_ps_90 (quartis train: Q1=${qSigmaPsTrain[0].toFixed(4)}, Q2=${qSigmaPsTrain[1].toFixed(4)}, Q3=${qSigmaPsTrain[2].toFixed(4)})`,
			trainRows,
			juneRows,
			(r) => binQuartile(r.sigma_ps_90, qSigmaPsTrain, "σps"),
			(a, b) => a.localeCompare(b),
		);

		for (const [feat, label] of [
			["d_askfav_10", "d_askfav_10"],
			["d_askfav_15", "d_askfav_15"],
			["d_askfav_30", "d_askfav_30"],
		]) {
			reportBinTable(
				lines,
				`${label} (momentum ask fav)`,
				trainRows,
				juneRows,
				(r) => binDAskFav(r[feat]),
				(a, b) =>
					["<-0.03", "-0.03..-0.01", "-0.01..0.01", "0.01..0.03", ">0.03", "NA"].indexOf(a) -
					["<-0.03", "-0.03..-0.01", "-0.01..0.01", "0.01..0.03", ">0.03", "NA"].indexOf(b),
			);
		}

		const qSigmaAskTrain = quartileEdges(trainRows.map((r) => r.sigma_askfav_15));
		reportBinTable(
			lines,
			`sigma_askfav_15 (quartis train)`,
			trainRows,
			juneRows,
			(r) => binQuartile(r.sigma_askfav_15, qSigmaAskTrain, "σask"),
			(a, b) => a.localeCompare(b),
		);

		const qDepthBidTrain = quartileEdges(trainRows.map((r) => r.depth5_bid_fav));
		reportBinTable(
			lines,
			"depth5_bid_fav (quartis train)",
			trainRows,
			juneRows,
			(r) => binQuartile(r.depth5_bid_fav, qDepthBidTrain, "bid"),
			(a, b) => a.localeCompare(b),
		);

		const qDepthAskTrain = quartileEdges(trainRows.map((r) => r.depth5_ask_fav));
		reportBinTable(
			lines,
			"depth5_ask_fav (quartis train)",
			trainRows,
			juneRows,
			(r) => binQuartile(r.depth5_ask_fav, qDepthAskTrain, "ask"),
			(a, b) => a.localeCompare(b),
		);

		reportBinTable(
			lines,
			"depth5_bid_fav / depth5_ask_fav",
			trainRows,
			juneRows,
			(r) => binDepthRatio(r.depth5_bid_fav / r.depth5_ask_fav),
			(a, b) => ["<0.5", "0.5-1", "1-2", ">2", "NA"].indexOf(a) - ["<0.5", "0.5-1", "1-2", ">2", "NA"].indexOf(b),
		);

		const qLadderTrain = quartileEdges(trainRows.map((r) => r.ladder_fav));
		reportBinTable(
			lines,
			"ladder_fav (quartis train)",
			trainRows,
			juneRows,
			(r) => binQuartile(r.ladder_fav, qLadderTrain, "ladder"),
			(a, b) => a.localeCompare(b),
		);

		reportBinTable(
			lines,
			"flips_60",
			trainRows,
			juneRows,
			(r) => binFlips(r.flips_60),
			(a, b) => ["0", "1", "2", "3", "4+", "NA"].indexOf(a) - ["0", "1", "2", "3", "4+", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"secs_since_flip",
			trainRows,
			juneRows,
			(r) => binSecsSinceFlip(r.secs_since_flip),
			(a, b) => ["<10", "10-30", "30-60", ">60", "NA"].indexOf(a) - ["<10", "10-30", "30-60", ">60", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"d_spot_5 sinalizado (a favor do fav)",
			trainRows,
			juneRows,
			(r) => binDSpot5(r.d_spot_5_sig),
			(a, b) =>
				["<-5", "-5..-2", "-2..0", "0..2", "2..5", ">5", "NA"].indexOf(a) -
				["<-5", "-5..-2", "-2..0", "0..2", "2..5", ">5", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"d_spot_30 sinalizado",
			trainRows,
			juneRows,
			(r) => binDSpotLong(r.d_spot_30_sig),
			(a, b) =>
				["<-15", "-15..-5", "-5..0", "0..5", "5..15", ">15", "NA"].indexOf(a) -
				["<-15", "-15..-5", "-5..0", "0..5", "5..15", ">15", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"d_spot_60 sinalizado",
			trainRows,
			juneRows,
			(r) => binDSpotLong(r.d_spot_60_sig),
			(a, b) =>
				["<-15", "-15..-5", "-5..0", "0..5", "5..15", ">15", "NA"].indexOf(a) -
				["<-15", "-15..-5", "-5..0", "0..5", "5..15", ">15", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"tau (segundos restantes)",
			trainRows,
			juneRows,
			(r) => binTau(r.tau),
			(a, b) => ["5-10", "10-15", "15-20", "20-25", "25-30", "NA"].indexOf(a) - ["5-10", "10-15", "15-20", "20-25", "25-30", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"ask_fav",
			trainRows,
			juneRows,
			(r) => binAskFav(r.ask_fav),
			(a, b) =>
				["0.55-0.60", "0.60-0.65", "0.65-0.70", "0.70-0.75", "0.75-0.78", "NA"].indexOf(a) -
				["0.55-0.60", "0.60-0.65", "0.65-0.70", "0.70-0.75", "0.75-0.78", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"dist_abs (USD)",
			trainRows,
			juneRows,
			(r) => binDistAbs(r.dist_abs),
			(a, b) => ["0-3", "3-6", "6-9", "9-12", "12-15", "NA"].indexOf(a) - ["0-3", "3-6", "6-9", "9-12", "12-15", "NA"].indexOf(b),
		);

		reportBinTable(
			lines,
			"fav (lado)",
			trainRows,
			juneRows,
			(r) => r.fav,
			(a, b) => a.localeCompare(b),
		);

		reportBinTable(
			lines,
			"hora UTC (blocos 4h)",
			trainRows,
			juneRows,
			(r) => binHourUtc(r.hour_utc),
			(a, b) => a.localeCompare(b),
		);

		reportBinTable(
			lines,
			"mkt_agree",
			trainRows,
			juneRows,
			(r) => binBinary(r.mkt_agree, "mkt_agree"),
			(a, b) => a.localeCompare(b),
		);

		reportBinTable(
			lines,
			"pin45",
			trainRows,
			juneRows,
			(r) => binBinary(r.pin45, "pin45"),
			(a, b) => a.localeCompare(b),
		);

		lines.push("## 3. Interações-chave");
		lines.push("");

		function reportInteraction(title, keyFn) {
			lines.push(`### ${title}`);
			lines.push("");
			lines.push("| Célula | n_train | WR_train | exp_train | n_june | WR_june | exp_june |");
			lines.push("|--------|---------|----------|-----------|--------|---------|----------|");
			const tg = groupBy(trainRows, keyFn);
			const jg = groupBy(juneRows, keyFn);
			for (const k of [...new Set([...tg.keys(), ...jg.keys()])].sort()) {
				const st = stats(tg.get(k) ?? []);
				const sj = stats(jg.get(k) ?? []);
				lines.push(
					`| ${k} | ${st.n} | ${fmtPct(st.winrate)} | ${fmtUsd(st.exp)} | ${sj.n} | ${fmtPct(sj.winrate)} | ${fmtUsd(sj.exp)} |`,
				);
			}
			lines.push("");
		}

		reportInteraction("tau × dist_abs", (r) => {
			const tauBin = r.tau < 15 ? "tau 5-15" : "tau 15-30";
			const distBin = r.dist_abs < 6 ? "dist 0-6" : "dist 6-15";
			return `${tauBin} × ${distBin}`;
		});

		reportInteraction("d_askfav_15 × ask_fav", (r) => {
			const mom = r.d_askfav_15 < 0 ? "d_askfav_15<0" : "d_askfav_15≥0";
			const ask = r.ask_fav < 0.65 ? "ask<0.65" : "ask≥0.65";
			return `${mom} × ${ask}`;
		});

		reportInteraction("obi5 × fav", (r) => {
			const obi = r.obi5 > 0 ? "obi5>0" : "obi5≤0";
			return `${obi} × ${r.fav}`;
		});

		// Collect all individual filter candidates
		const allCells = [];
		const binSpecs = [
			["obi5", "obi5", (r) => binObi5(r.obi5)],
			["sigma_ps_90", "sigma_ps_90", (r) => binQuartile(r.sigma_ps_90, qSigmaPsTrain, "σps")],
			["d_askfav_10", "d_askfav_10", (r) => binDAskFav(r.d_askfav_10)],
			["d_askfav_15", "d_askfav_15", (r) => binDAskFav(r.d_askfav_15)],
			["d_askfav_30", "d_askfav_30", (r) => binDAskFav(r.d_askfav_30)],
			["sigma_askfav_15", "sigma_askfav_15", (r) => binQuartile(r.sigma_askfav_15, qSigmaAskTrain, "σask")],
			["depth5_bid_fav", "depth5_bid_fav", (r) => binQuartile(r.depth5_bid_fav, qDepthBidTrain, "bid")],
			["depth5_ask_fav", "depth5_ask_fav", (r) => binQuartile(r.depth5_ask_fav, qDepthAskTrain, "ask")],
			["depth_ratio", "bid/ask depth", (r) => binDepthRatio(r.depth5_bid_fav / r.depth5_ask_fav)],
			["ladder_fav", "ladder_fav", (r) => binQuartile(r.ladder_fav, qLadderTrain, "ladder")],
			["flips_60", "flips_60", (r) => binFlips(r.flips_60)],
			["secs_since_flip", "secs_since_flip", (r) => binSecsSinceFlip(r.secs_since_flip)],
			["d_spot_5_sig", "d_spot_5 sig", (r) => binDSpot5(r.d_spot_5_sig)],
			["d_spot_30_sig", "d_spot_30 sig", (r) => binDSpotLong(r.d_spot_30_sig)],
			["d_spot_60_sig", "d_spot_60 sig", (r) => binDSpotLong(r.d_spot_60_sig)],
			["tau", "tau", (r) => binTau(r.tau)],
			["ask_fav", "ask_fav", (r) => binAskFav(r.ask_fav)],
			["dist_abs", "dist_abs", (r) => binDistAbs(r.dist_abs)],
			["fav", "fav", (r) => r.fav],
			["hour_utc", "hora UTC", (r) => binHourUtc(r.hour_utc)],
			["mkt_agree", "mkt_agree", (r) => binBinary(r.mkt_agree, "mkt_agree")],
			["pin45", "pin45", (r) => binBinary(r.pin45, "pin45")],
		];

		for (const [feat, label, keyFn] of binSpecs) {
			allCells.push(...collectCells(trainRows, juneRows, feat, label, keyFn));
		}

		// Interações também entram na busca de bolsões
		const interactionSpecs = [
			["tau×dist", (r) => {
				const tauBin = r.tau < 15 ? "tau 5-15" : "tau 15-30";
				const distBin = r.dist_abs < 6 ? "dist 0-6" : "dist 6-15";
				return `${tauBin} × ${distBin}`;
			}],
			["d_ask×ask", (r) => {
				const mom = r.d_askfav_15 < 0 ? "d_askfav_15<0" : "d_askfav_15≥0";
				const ask = r.ask_fav < 0.65 ? "ask<0.65" : "ask≥0.65";
				return `${mom} × ${ask}`;
			}],
			["obi×fav", (r) => {
				const obi = r.obi5 > 0 ? "obi5>0" : "obi5≤0";
				return `${obi} × ${r.fav}`;
			}],
		];
		for (const [label, keyFn] of interactionSpecs) {
			const intCells = collectCells(trainRows, juneRows, label, label, keyFn);
			allCells.push(...intCells);
		}

		// Filtros por limiar (cortes naturais além dos bins discretos)
		const thresholdFilters = [
			["ask_fav ≥ 0.65", (r) => r.ask_fav >= 0.65],
			["ask_fav ≥ 0.70", (r) => r.ask_fav >= 0.70],
			["ask_fav < 0.65", (r) => r.ask_fav < 0.65],
			["dist_abs ≥ 6", (r) => r.dist_abs >= 6],
			["dist_abs ≥ 9", (r) => r.dist_abs >= 9],
			["dist_abs < 6", (r) => r.dist_abs < 6],
			["tau < 15s", (r) => r.tau < 15],
			["tau ≥ 15s", (r) => r.tau >= 15],
			["tau ≤ 20s", (r) => r.tau <= 20],
			["obi5 > 0", (r) => r.obi5 > 0],
			["obi5 ≤ 0", (r) => r.obi5 <= 0],
			["fav = DOWN", (r) => r.fav === "DOWN"],
			["fav = UP", (r) => r.fav === "UP"],
			["pin45 = 0", (r) => r.pin45 === 0],
			["pin45 = 1", (r) => r.pin45 === 1],
			["d_askfav_15 < 0", (r) => r.d_askfav_15 < 0],
			["d_askfav_15 ≥ 0", (r) => r.d_askfav_15 >= 0],
			["d_spot_30_sig ∈ [0,5]", (r) => r.d_spot_30_sig >= 0 && r.d_spot_30_sig <= 5],
			["flips_60 ≤ 1", (r) => r.flips_60 <= 1],
			["flips_60 ≥ 2", (r) => r.flips_60 >= 2],
			["depth_ratio > 2", (r) => r.depth5_bid_fav / r.depth5_ask_fav > 2],
			["depth_ratio < 0.5", (r) => r.depth5_bid_fav / r.depth5_ask_fav < 0.5],
		];

		const thresholdCells = thresholdFilters.map(([label, pred]) => {
			const tr = trainRows.filter(pred);
			const jr = juneRows.filter(pred);
			const st = stats(tr);
			const sj = stats(jr);
			return {
				feature: "threshold",
				bin: label,
				filterLabel: label,
				n_train: st.n,
				exp_train: st.exp,
				n_june: sj.n,
				exp_june: sj.exp,
				matchFn: pred,
			};
		});

		const allFilterCandidates = [...allCells, ...thresholdCells];

		const minRetain = 0.6;
		const filterCandidates = allFilterCandidates
			.filter((c) => c.n_train >= stTrain.n * minRetain && c.n_june >= stJune.n * minRetain)
			.map((c) => {
				const deltaTrain = c.exp_train - stTrain.exp;
				const deltaJune = c.exp_june - stJune.exp;
				const consistent = deltaTrain > 0 && deltaJune > 0;
				return {
					...c,
					deltaTrain,
					deltaJune,
					deltaAvg: (deltaTrain + deltaJune) / 2,
					consistent,
					pctTrain: c.n_train / stTrain.n,
					pctJune: c.n_june / stJune.n,
				};
			})
			.filter((c) => c.consistent)
			.sort((a, b) => b.deltaAvg - a.deltaAvg);

		lines.push("## 4. Melhores cortes individuais (≥60% n em ambos splits, consistentes train+june)");
		lines.push("");
		lines.push(
			`Baseline: train exp=${fmtUsd(stTrain.exp)} (n=${stTrain.n}), june exp=${fmtUsd(stJune.exp)} (n=${stJune.n})`,
		);
		lines.push("");
		lines.push("| # | Filtro | n_train (%base) | exp_train | Δ_train | n_june (%base) | exp_june | Δ_june | Δ_avg |");
		lines.push("|---|--------|-----------------|-----------|---------|----------------|----------|--------|-------|");

		const top8 = filterCandidates.slice(0, 8);
		if (top8.length === 0) {
			lines.push(
				"*Nenhum corte binário isolado atende ≥60% de retenção em ambos splits com melhora consistente. Tabela abaixo: melhores cortes (bins + limiares) que passam no critério.*",
			);
			lines.push("");
		}
		top8.forEach((c, i) => {
			lines.push(
				`| ${i + 1} | ${c.filterLabel} | ${c.n_train} (${fmtPct(c.pctTrain)}) | ${fmtUsd(c.exp_train)} | ${c.deltaTrain >= 0 ? "+" : ""}${fmtUsd(c.deltaTrain)} | ${c.n_june} (${fmtPct(c.pctJune)}) | ${fmtUsd(c.exp_june)} | ${c.deltaJune >= 0 ? "+" : ""}${fmtUsd(c.deltaJune)} | ${c.deltaAvg >= 0 ? "+" : ""}${fmtUsd(c.deltaAvg)} |`,
			);
		});
		if (top8.length === 0) {
			const fallback = allFilterCandidates
				.map((c) => ({
					...c,
					deltaTrain: c.exp_train - stTrain.exp,
					deltaJune: c.exp_june - stJune.exp,
					deltaAvg: (c.exp_train - stTrain.exp + c.exp_june - stJune.exp) / 2,
					pctTrain: c.n_train / stTrain.n,
					pctJune: c.n_june / stJune.n,
					consistent: c.exp_train > stTrain.exp && c.exp_june > stJune.exp,
				}))
				.filter((c) => c.consistent)
				.sort((a, b) => b.deltaAvg - a.deltaAvg)
				.slice(0, 8);
			lines.push("");
			lines.push("### Fallback — melhores cortes consistentes (sem exigir 60% retenção)");
			lines.push("");
			lines.push("| # | Filtro | n_train (%base) | exp_train | Δ_train | n_june (%base) | exp_june | Δ_june | Δ_avg |");
			lines.push("|---|--------|-----------------|-----------|---------|----------------|----------|--------|-------|");
			fallback.forEach((c, i) => {
				lines.push(
					`| ${i + 1} | ${c.filterLabel} | ${c.n_train} (${fmtPct(c.pctTrain)}) | ${fmtUsd(c.exp_train)} | +${fmtUsd(c.deltaTrain)} | ${c.n_june} (${fmtPct(c.pctJune)}) | ${fmtUsd(c.exp_june)} | +${fmtUsd(c.deltaJune)} | +${fmtUsd(c.deltaAvg)} |`,
				);
			});
		}
		lines.push("");

		const lossCandidates = allCells
			.filter((c) => c.n_train >= 50 && c.n_june >= 50)
			.map((c) => ({
				...c,
				avgExpBoth: (c.exp_train + c.exp_june) / 2,
				deltaVsBase: (c.exp_train - stTrain.exp + c.exp_june - stJune.exp) / 2,
			}));

		const lossPocketsNeg = lossCandidates.filter((c) => c.avgExpBoth < 0).sort((a, b) => a.avgExpBoth - b.avgExpBoth);
		const lossPockets =
			lossPocketsNeg.length > 0
				? lossPocketsNeg.slice(0, 5)
				: lossCandidates.sort((a, b) => a.avgExpBoth - b.avgExpBoth).slice(0, 5);

		lines.push("## 5. Piores bolsões de perda (n≥50 em ambos splits)");
		lines.push("");
		if (lossPocketsNeg.length === 0) {
			lines.push(
				`*Nenhuma célula com expectância média negativa em ambos splits — a V4 é positiva em todos os bolsões com n≥50. Listando as 5 piores por exp média (mais abaixo do baseline ~$0.73).*`,
			);
			lines.push("");
		}
		lines.push("| # | Célula | n_train | exp_train | n_june | exp_june | exp média | Δ vs base |");
		lines.push("|---|--------|---------|-----------|--------|----------|-----------|-----------|");

		lossPockets.forEach((c, i) => {
			lines.push(
				`| ${i + 1} | ${c.bin} | ${c.n_train} | ${fmtUsd(c.exp_train)} | ${c.n_june} | ${fmtUsd(c.exp_june)} | ${fmtUsd(c.avgExpBoth)} | ${c.deltaVsBase >= 0 ? "+" : ""}${fmtUsd(c.deltaVsBase)} |`,
			);
		});
		lines.push("");

		const report = lines.join("\n");
		console.log(report);
		fs.writeFileSync(REPORT_PATH, report, "utf8");
		console.error(`\nRelatório salvo em ${REPORT_PATH}`);

		return { stTrain, stJune, top8, lossPockets, reportPath: REPORT_PATH };
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
