/**
 * Scientific analysis of BTC 5m late-flip features.
 *
 * Input is produced by scratch/extract-flip-features.mjs.  The time split is
 * deliberately chronological:
 *   train      2026-04-27 .. 2026-06-14
 *   validation 2026-06-15 .. 2026-06-30
 *   holdout    2026-07-01 .. 2026-07-26
 *
 * No holdout row is used to fit the logistic models or select the simple rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const INPUT = process.argv.includes('--input')
  ? process.argv[process.argv.indexOf('--input') + 1]
  : path.join(ROOT, 'scratch/flip-features.csv');
const JSON_OUT = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : path.join(ROOT, 'scratch/flip-model-report.json');
const MD_OUT = process.argv.includes('--md')
  ? process.argv[process.argv.indexOf('--md') + 1]
  : path.join(ROOT, 'scratch/flip-model-report.md');
const CANONICAL_LABEL = process.argv.includes('--canonical');

const TAUS = [60, 30, 20, 10];
const EPS = 1e-9;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-Math.min(value, 40));
    return 1 / (1 + z);
  }
  const z = Math.exp(Math.max(value, -40));
  return z / (1 + z);
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + (0.3275911 * x));
  const poly = (((((1.061405429 * t) - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - (poly * Math.exp(-x * x)));
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function splitOf(day) {
  if (day < '2026-06-15') return 'train';
  if (day < '2026-07-01') return 'validation';
  return 'holdout';
}

function n(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function featureMap(row) {
  const sigma = Math.max(0.01, n(row.sigma60, 0.01));
  const z = clamp(n(row.z, 20), 0, 20);
  const bookRisk = clamp(1 - n(row.favMid, 0.5), 0.0025, 0.9975);
  const mom10z = clamp(n(row.momTo10) / (sigma * Math.sqrt(10)), -8, 8);
  const mom30z = clamp(n(row.momTo30) / (sigma * Math.sqrt(30)), -8, 8);
  return {
    log_z: Math.log1p(z),
    brown_risk_logit: Math.log(clamp(normalCdf(-z), 0.0025, 0.9975)
      / (1 - clamp(normalCdf(-z), 0.0025, 0.9975))),
    mom10_z: mom10z,
    mom30_z: mom30z,
    crosses60: clamp(n(row.cross60), 0, 8),
    cross_fresh: Math.exp(-clamp(n(row.lastCrossAge, 999), 0, 300) / 30),
    range_z: clamp(n(row.range60) / (sigma * Math.sqrt(60)), 0, 12),
    book_risk_logit: Math.log(bookRisk / (1 - bookRisk)),
    book_risk: bookRisk,
    book_fall15: clamp(-n(row.dMid15), -0.5, 0.5),
    spread: clamp(n(row.spread), 0, 0.25),
    odds_sum_dev: clamp(Math.abs(n(row.oddsSum, 1) - 1), 0, 0.5),
    stale_s: clamp(n(row.staleSecs), 0, 20),
    abs_dist_log: Math.log1p(Math.abs(n(row.dist))),
  };
}

const FEATURE_SETS = {
  market_only: ['book_risk_logit'],
  physics_only: [
    'log_z', 'brown_risk_logit', 'mom10_z', 'mom30_z',
    'crosses60', 'cross_fresh', 'range_z',
  ],
  combined: [
    'log_z', 'brown_risk_logit', 'mom10_z', 'mom30_z',
    'crosses60', 'cross_fresh', 'range_z',
    'book_risk_logit', 'book_fall15', 'spread', 'odds_sum_dev', 'stale_s',
  ],
};

function prepare(rows, names) {
  return rows.map((row) => {
    const features = featureMap(row);
    return {
      row,
      y: n(row.flip),
      x: names.map((name) => features[name]),
    };
  }).filter(({ x }) => x.every(Number.isFinite));
}

function fitLogistic(rows, names, {
  epochs = 450,
  learningRate = 0.025,
  l2 = 0.015,
} = {}) {
  const prepared = prepare(rows, names);
  const dimensions = names.length;
  const means = Array(dimensions).fill(0);
  const stds = Array(dimensions).fill(1);
  for (let j = 0; j < dimensions; j += 1) {
    means[j] = prepared.reduce((sum, sample) => sum + sample.x[j], 0) / prepared.length;
    const variance = prepared.reduce(
      (sum, sample) => sum + ((sample.x[j] - means[j]) ** 2),
      0,
    ) / Math.max(1, prepared.length - 1);
    stds[j] = Math.max(1e-6, Math.sqrt(variance));
  }
  for (const sample of prepared) {
    sample.z = sample.x.map((value, index) => (value - means[index]) / stds[index]);
  }

  const prevalence = prepared.reduce((sum, sample) => sum + sample.y, 0) / prepared.length;
  const weights = Array(dimensions + 1).fill(0);
  weights[0] = Math.log(clamp(prevalence, 0.001, 0.999)
    / (1 - clamp(prevalence, 0.001, 0.999)));
  const firstMoment = Array(weights.length).fill(0);
  const secondMoment = Array(weights.length).fill(0);
  const beta1 = 0.9;
  const beta2 = 0.999;

  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    for (const sample of prepared) {
      let score = weights[0];
      for (let j = 0; j < dimensions; j += 1) score += weights[j + 1] * sample.z[j];
      const error = sigmoid(score) - sample.y;
      gradient[0] += error;
      for (let j = 0; j < dimensions; j += 1) gradient[j + 1] += error * sample.z[j];
    }
    gradient[0] /= prepared.length;
    for (let j = 1; j < gradient.length; j += 1) {
      gradient[j] = (gradient[j] / prepared.length) + (l2 * weights[j]);
    }
    const lr = learningRate / (1 + (epoch / 900));
    for (let j = 0; j < weights.length; j += 1) {
      firstMoment[j] = (beta1 * firstMoment[j]) + ((1 - beta1) * gradient[j]);
      secondMoment[j] = (beta2 * secondMoment[j]) + ((1 - beta2) * gradient[j] * gradient[j]);
      const mHat = firstMoment[j] / (1 - (beta1 ** epoch));
      const vHat = secondMoment[j] / (1 - (beta2 ** epoch));
      weights[j] -= lr * mHat / (Math.sqrt(vHat) + 1e-8);
    }
  }

  return {
    names,
    means,
    stds,
    weights,
    predict(row) {
      const features = featureMap(row);
      let score = weights[0];
      for (let j = 0; j < names.length; j += 1) {
        score += weights[j + 1] * ((features[names[j]] - means[j]) / stds[j]);
      }
      return sigmoid(score);
    },
    coefficients: names.map((name, index) => ({
      name,
      standardized: weights[index + 1],
    })).sort((left, right) => Math.abs(right.standardized) - Math.abs(left.standardized)),
  };
}

function auc(items) {
  const sorted = [...items].sort((a, b) => a.p - b.p);
  let rank = 1;
  let positiveRankSum = 0;
  let positives = 0;
  let negatives = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && Math.abs(sorted[j].p - sorted[i].p) < 1e-12) j += 1;
    const averageRank = (rank + (rank + (j - i) - 1)) / 2;
    for (let k = i; k < j; k += 1) {
      if (sorted[k].y === 1) {
        positiveRankSum += averageRank;
        positives += 1;
      } else {
        negatives += 1;
      }
    }
    rank += j - i;
    i = j;
  }
  if (!positives || !negatives) return null;
  return (positiveRankSum - (positives * (positives + 1) / 2)) / (positives * negatives);
}

function averagePrecision(items) {
  const sorted = [...items].sort((a, b) => b.p - a.p);
  const positives = sorted.reduce((sum, item) => sum + item.y, 0);
  if (!positives) return null;
  let seenPositive = 0;
  let precisionSum = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].y === 1) {
      seenPositive += 1;
      precisionSum += seenPositive / (i + 1);
    }
  }
  return precisionSum / positives;
}

function wilson(successes, total, z = 1.96) {
  if (!total) return [null, null];
  const p = successes / total;
  const denominator = 1 + ((z * z) / total);
  const center = (p + ((z * z) / (2 * total))) / denominator;
  const half = z * Math.sqrt(((p * (1 - p) / total) + ((z * z) / (4 * total * total))))
    / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function metricSummary(rows, predictor) {
  const items = rows.map((row) => ({
    y: n(row.flip),
    p: clamp(predictor(row), 1e-6, 1 - 1e-6),
  }));
  const prevalence = items.reduce((sum, item) => sum + item.y, 0) / items.length;
  const brier = items.reduce((sum, item) => sum + ((item.p - item.y) ** 2), 0) / items.length;
  const logLoss = -items.reduce(
    (sum, item) => sum + (item.y * Math.log(item.p))
      + ((1 - item.y) * Math.log(1 - item.p)),
    0,
  ) / items.length;
  return {
    n: items.length,
    flips: items.reduce((sum, item) => sum + item.y, 0),
    prevalence,
    auc: auc(items),
    averagePrecision: averagePrecision(items),
    brier,
    logLoss,
  };
}

function thresholdSummary(rows, predictor, thresholds = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50]) {
  const positives = rows.reduce((sum, row) => sum + n(row.flip), 0);
  return thresholds.map((threshold) => {
    const flagged = rows.filter((row) => predictor(row) >= threshold);
    const truePositive = flagged.reduce((sum, row) => sum + n(row.flip), 0);
    const kept = rows.length - flagged.length;
    const keptFlips = positives - truePositive;
    return {
      threshold,
      flagged: flagged.length,
      flagRate: flagged.length / rows.length,
      truePositive,
      precision: flagged.length ? truePositive / flagged.length : null,
      precision95: wilson(truePositive, flagged.length),
      recall: positives ? truePositive / positives : null,
      kept,
      keptFlipRate: kept ? keptFlips / kept : null,
    };
  });
}

function isMidasLike(row) {
  const ask = n(row.favAsk);
  return n(row.tau) === 30
    && ask >= 0.55 && ask <= 0.94
    && Math.abs(n(row.dist)) < 40
    && n(row.spread) <= 0.03
    && n(row.oddsSum) >= 0.98 && n(row.oddsSum) <= 1.06;
}

function entryPnl(row, budget = 10) {
  const ask = n(row.favAsk);
  if (!(ask > 0 && ask < 1)) return 0;
  const shares = budget / ask;
  const entryFee = shares * 0.07 * ask * (1 - ask);
  if (n(row.flip) === 1) return -budget - entryFee;
  return (shares * 0.995) - budget - entryFee;
}

function maxDrawdown(pnls) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function pnlSummary(rows, predictor, thresholds = [0.20, 0.30, 0.40, 0.50]) {
  const sorted = [...rows].sort((a, b) => String(a.event_start).localeCompare(String(b.event_start)));
  const allPnls = sorted.map((row) => entryPnl(row));
  const baseline = {
    trades: sorted.length,
    wins: sorted.filter((row) => n(row.flip) === 0).length,
    pnl: allPnls.reduce((sum, value) => sum + value, 0),
    maxDrawdown: maxDrawdown(allPnls),
  };
  baseline.winRate = baseline.trades ? baseline.wins / baseline.trades : null;

  const variants = thresholds.map((threshold) => {
    const kept = sorted.filter((row) => predictor(row) < threshold);
    const skipped = sorted.filter((row) => predictor(row) >= threshold);
    const keptPnls = kept.map((row) => entryPnl(row));
    const skippedPnls = skipped.map((row) => entryPnl(row));
    const lossesSkipped = skipped.filter((row) => n(row.flip) === 1).length;
    return {
      threshold,
      trades: kept.length,
      skipped: skipped.length,
      skippedFlipPrecision: skipped.length ? lossesSkipped / skipped.length : null,
      flipsAvoided: lossesSkipped,
      flipRecall: baseline.trades - baseline.wins
        ? lossesSkipped / (baseline.trades - baseline.wins)
        : null,
      pnl: keptPnls.reduce((sum, value) => sum + value, 0),
      pnlDelta: -skippedPnls.reduce((sum, value) => sum + value, 0),
      maxDrawdown: maxDrawdown(keptPnls),
      winRate: kept.length ? kept.filter((row) => n(row.flip) === 0).length / kept.length : null,
    };
  });
  return { baseline, variants };
}

function describeRule(rule) {
  const clauses = [`bookRisk>=${rule.bookRiskMin.toFixed(2)}`, `z<=${rule.zMax}`];
  if (Number.isFinite(rule.mom10zMax)) clauses.push(`mom10z<=${rule.mom10zMax}`);
  if (rule.crossMin > 0) clauses.push(`cross60>=${rule.crossMin}`);
  if (Number.isFinite(rule.bookFallMin)) clauses.push(`bookFall15>=${rule.bookFallMin}`);
  return clauses.join(' AND ');
}

function ruleHit(row, rule) {
  const f = featureMap(row);
  return f.book_risk >= rule.bookRiskMin
    && n(row.z) <= rule.zMax
    && f.mom10_z <= rule.mom10zMax
    && n(row.cross60) >= rule.crossMin
    && f.book_fall15 >= rule.bookFallMin;
}

function evaluateRule(rows, rule) {
  const flips = rows.reduce((sum, row) => sum + n(row.flip), 0);
  const hits = rows.filter((row) => ruleHit(row, rule));
  const truePositive = hits.reduce((sum, row) => sum + n(row.flip), 0);
  return {
    n: hits.length,
    truePositive,
    precision: hits.length ? truePositive / hits.length : 0,
    recall: flips ? truePositive / flips : 0,
    flagRate: rows.length ? hits.length / rows.length : 0,
  };
}

function selectSimpleRule(trainRows, validationRows) {
  const candidates = [];
  for (const bookRiskMin of [0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30]) {
    for (const zMax of [0.5, 0.75, 1, 1.5, 2, 3, 4]) {
      for (const mom10zMax of [-0.5, 0, 0.5, Number.POSITIVE_INFINITY]) {
        for (const crossMin of [0, 1]) {
          for (const bookFallMin of [-0.02, 0, 0.02, Number.NEGATIVE_INFINITY]) {
            const rule = { bookRiskMin, zMax, mom10zMax, crossMin, bookFallMin };
            const train = evaluateRule(trainRows, rule);
            const validation = evaluateRule(validationRows, rule);
            if (train.n < 100 || validation.n < 40) continue;
            if (train.precision < 0.25 || validation.precision < 0.25) continue;
            const robustPrecision = Math.min(train.precision, validation.precision);
            const score = robustPrecision * Math.sqrt(validation.recall)
              * Math.sqrt(Math.min(1, validation.n / 150));
            candidates.push({ rule, train, validation, score });
          }
        }
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] || null;
}

function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDeep(item)]));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Number(value.toFixed(6));
  return value;
}

function pct(value, digits = 1) {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function money(value) {
  return value == null ? '—' : `$${value.toFixed(2)}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# BTC 5m — estudo científico de flips terminais');
  lines.push('');
  lines.push(`Gerado: ${report.generatedAt}`);
  lines.push(CANONICAL_LABEL
    ? `Dataset: ${report.dataset.events} eventos com outcome canônico; ${report.dataset.rows} linhas.`
    : `Dataset: ${report.dataset.events} eventos com consenso spot/book; ${report.dataset.rows} linhas.`);
  lines.push('Split temporal: treino até 14/06, validação 15–30/06, holdout 01–26/07.');
  lines.push('');
  lines.push('## Frequência natural de flip');
  lines.push('');
  lines.push('| antecedência | eventos | flips | taxa |');
  lines.push('|---:|---:|---:|---:|');
  for (const row of report.baseRates) {
    lines.push(`| ${row.tau}s | ${row.n} | ${row.flips} | ${pct(row.rate)} |`);
  }
  lines.push('');
  lines.push('## Modelos no holdout intocado');
  lines.push('');
  lines.push('| antecedência | modelo | AUC | AP | Brier | log loss |');
  lines.push('|---:|---|---:|---:|---:|---:|');
  for (const tau of TAUS) {
    for (const [modelName, metrics] of Object.entries(report.byTau[tau].holdoutMetrics)) {
      lines.push(`| ${tau}s | ${modelName} | ${metrics.auc.toFixed(3)} | ${metrics.averagePrecision.toFixed(3)} | ${metrics.brier.toFixed(3)} | ${metrics.logLoss.toFixed(3)} |`);
    }
  }
  lines.push('');
  lines.push('## Detector combinado no holdout');
  lines.push('');
  for (const tau of TAUS) {
    const section = report.byTau[tau];
    lines.push(`### ${tau}s antes`);
    lines.push('');
    lines.push('| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |');
    lines.push('|---:|---:|---:|---:|---:|');
    for (const row of section.thresholds) {
      lines.push(`| ${pct(row.threshold, 0)} | ${row.flagged} (${pct(row.flagRate)}) | ${pct(row.precision)} | ${pct(row.recall)} | ${pct(row.keptFlipRate)} |`);
    }
    lines.push('');
  }
  lines.push('## Regra simples selecionada sem olhar o holdout');
  lines.push('');
  lines.push(`\`${report.simpleRule.description}\``);
  lines.push('');
  lines.push('| split | sinais | precisão | recall | cobertura |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const split of ['train', 'validation', 'holdout']) {
    const row = report.simpleRule[split];
    lines.push(`| ${split} | ${row.n} | ${pct(row.precision)} | ${pct(row.recall)} | ${pct(row.flagRate)} |`);
  }
  lines.push('');
  lines.push('## Contrafactual de não entrada (proxy MIDAS, checkpoint 30s, holdout)');
  lines.push('');
  const pnl = report.midasLikePnl;
  lines.push(`Baseline: ${pnl.baseline.trades} entradas, WR ${pct(pnl.baseline.winRate)}, PnL ${money(pnl.baseline.pnl)}, DD ${money(pnl.baseline.maxDrawdown)}.`);
  lines.push('');
  lines.push('| risco mínimo para bloquear | bloqueadas | flips evitados | precisão | recall | ΔPnL | PnL restante | DD |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of pnl.variants) {
    lines.push(`| ${pct(row.threshold, 0)} | ${row.skipped} | ${row.flipsAvoided} | ${pct(row.skippedFlipPrecision)} | ${pct(row.flipRecall)} | ${money(row.pnlDelta)} | ${money(row.pnl)} | ${money(row.maxDrawdown)} |`);
  }
  lines.push('');
  lines.push('## Coeficientes do modelo combinado a 30s');
  lines.push('');
  lines.push('| feature | coeficiente padronizado |');
  lines.push('|---|---:|');
  for (const row of report.byTau[30].coefficients) {
    lines.push(`| ${row.name} | ${row.standardized.toFixed(3)} |`);
  }
  lines.push('');
  lines.push('## Limites');
  lines.push('');
  lines.push(CANONICAL_LABEL
    ? '- O label é o resultado resolvido publicado pela Gamma/Polymarket; nenhum filtro retrospectivo de consenso do book final foi aplicado.'
    : '- O label é o último spot válido, aceito apenas quando o book final concorda; não é uma prova de settlement externo.');
  lines.push('- O contrafactual usa best ask/bid e taxa configurada no projeto; não modela latência nem garante fill.');
  lines.push('- A regra prevê risco, não certeza. Perto do PTB existe aleatoriedade irredutível.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function loadRows() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  await connection.run('SET threads TO 6');
  const normalized = INPUT.replace(/\\/g, '/').replaceAll("'", "''");
  const result = await connection.runAndReadAll(`
    SELECT
      CAST(day AS VARCHAR) AS day,
      CAST(event_start AS VARCHAR) AS event_start,
      CAST(tau AS DOUBLE) AS tau,
      CAST(leader AS DOUBLE) AS leader,
      CAST(winner AS DOUBLE) AS winner,
      CAST(flip AS DOUBLE) AS flip,
      CAST(dist AS DOUBLE) AS dist,
      CAST(sigma60 AS DOUBLE) AS sigma60,
      CAST(z AS DOUBLE) AS z,
      CAST(momTo10 AS DOUBLE) AS momTo10,
      CAST(momTo30 AS DOUBLE) AS momTo30,
      CAST(cross60 AS DOUBLE) AS cross60,
      CAST(lastCrossAge AS DOUBLE) AS lastCrossAge,
      CAST(range60 AS DOUBLE) AS range60,
      CAST(favMid AS DOUBLE) AS favMid,
      CAST(favAsk AS DOUBLE) AS favAsk,
      CAST(spread AS DOUBLE) AS spread,
      CAST(oddsSum AS DOUBLE) AS oddsSum,
      CAST(dMid15 AS DOUBLE) AS dMid15,
      CAST(staleSecs AS DOUBLE) AS staleSecs
    FROM read_csv_auto('${normalized}', header=true, nullstr='')
    WHERE tau IN (60, 30, 20, 10)
    ORDER BY event_start, tau DESC
  `);
  const rows = result.getRowObjectsJson().map((row) => ({ ...row, split: splitOf(row.day) }));
  await connection.closeSync();
  return rows;
}

async function main() {
  const rows = await loadRows();
  const report = {
    generatedAt: new Date().toISOString(),
    input: INPUT,
    methodology: {
      train: 'day < 2026-06-15',
      validation: '2026-06-15 <= day < 2026-07-01',
      holdout: 'day >= 2026-07-01',
      label: CANONICAL_LABEL
        ? 'leader at checkpoint differs from Gamma resolved winner; no final-book filter'
        : 'leader at checkpoint differs from final spot winner, with final book consensus',
    },
    dataset: {
      rows: rows.length,
      events: new Set(rows.map((row) => row.event_start)).size,
      firstDay: rows[0]?.day,
      lastDay: rows[rows.length - 1]?.day,
    },
    baseRates: [],
    byTau: {},
  };

  for (const tau of TAUS) {
    const tauRows = rows.filter((row) => n(row.tau) === tau);
    const trainRows = tauRows.filter((row) => row.split === 'train');
    const validationRows = tauRows.filter((row) => row.split === 'validation');
    const holdoutRows = tauRows.filter((row) => row.split === 'holdout');
    const flips = tauRows.reduce((sum, row) => sum + n(row.flip), 0);
    report.baseRates.push({ tau, n: tauRows.length, flips, rate: flips / tauRows.length });

    const models = {};
    for (const [name, featureNames] of Object.entries(FEATURE_SETS)) {
      models[name] = fitLogistic(trainRows, featureNames);
    }
    const baselines = {
      market_raw: (row) => clamp(1 - n(row.favMid, 0.5), 0.001, 0.999),
      brownian_raw: (row) => clamp(normalCdf(-n(row.z, 20)), 0.001, 0.999),
      market_only: models.market_only.predict,
      physics_only: models.physics_only.predict,
      combined: models.combined.predict,
    };
    const holdoutMetrics = {};
    const validationMetrics = {};
    for (const [name, predictor] of Object.entries(baselines)) {
      validationMetrics[name] = metricSummary(validationRows, predictor);
      holdoutMetrics[name] = metricSummary(holdoutRows, predictor);
    }
    report.byTau[tau] = {
      rows: {
        train: trainRows.length,
        validation: validationRows.length,
        holdout: holdoutRows.length,
      },
      validationMetrics,
      holdoutMetrics,
      thresholds: thresholdSummary(holdoutRows, models.combined.predict),
      coefficients: models.combined.coefficients,
      model: {
        names: models.combined.names,
        means: models.combined.means,
        stds: models.combined.stds,
        weights: models.combined.weights,
      },
    };
  }

  const tau30 = rows.filter((row) => n(row.tau) === 30);
  const train30 = tau30.filter((row) => row.split === 'train');
  const validation30 = tau30.filter((row) => row.split === 'validation');
  const holdout30 = tau30.filter((row) => row.split === 'holdout');
  const selected = selectSimpleRule(train30, validation30);
  if (!selected) throw new Error('No robust simple rule met minimum support.');
  report.simpleRule = {
    description: describeRule(selected.rule),
    params: selected.rule,
    train: selected.train,
    validation: selected.validation,
    holdout: evaluateRule(holdout30, selected.rule),
  };

  const combined30 = fitLogistic(train30, FEATURE_SETS.combined);
  const marketOnly30 = fitLogistic(train30, FEATURE_SETS.market_only);
  const midasLikeHoldout = holdout30.filter(isMidasLike);
  report.midasLikePopulation = {
    n: midasLikeHoldout.length,
    flips: midasLikeHoldout.reduce((sum, row) => sum + n(row.flip), 0),
  };
  report.midasLikePnl = pnlSummary(midasLikeHoldout, combined30.predict);
  report.midasLikePnlBySplit = Object.fromEntries(
    [
      ['train', train30],
      ['validation', validation30],
      ['holdout', holdout30],
    ].map(([split, splitRows]) => [
      split,
      pnlSummary(splitRows.filter(isMidasLike), combined30.predict),
    ]),
  );
  report.midasLikePnlByModel = Object.fromEntries(
    [
      ['market_raw', (row) => clamp(1 - n(row.favMid, 0.5), 0.001, 0.999)],
      ['market_only', marketOnly30.predict],
      ['combined', combined30.predict],
    ].map(([model, predictor]) => [
      model,
      Object.fromEntries(
        [
          ['train', train30],
          ['validation', validation30],
          ['holdout', holdout30],
        ].map(([split, splitRows]) => [
          split,
          pnlSummary(splitRows.filter(isMidasLike), predictor),
        ]),
      ),
    ]),
  );

  const rounded = roundDeep(report);
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(rounded, null, 2)}\n`, 'utf8');
  fs.writeFileSync(MD_OUT, renderMarkdown(rounded), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    rows: rounded.dataset.rows,
    events: rounded.dataset.events,
    simpleRule: rounded.simpleRule,
    midasLikePnl: rounded.midasLikePnl,
    outputs: { json: JSON_OUT, md: MD_OUT },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
