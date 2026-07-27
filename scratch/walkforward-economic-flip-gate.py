"""Walk-forward causal do gate econômico anti-flip.

Cada semana é prevista por um novo modelo logístico treinado somente em dias
anteriores. A regra principal EV<=0 não exige seleção de threshold: ela apenas
recusa uma entrada cujo retorno previsto, após fee e haircut, não é positivo.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(r"D:\Projetos\projeto-goldenlens\data-backtest")
INPUT = ROOT / "scratch" / "flip-features-canonical.csv"
OUT_JSON = ROOT / "scratch" / "walkforward-economic-flip-gate.json"
OUT_MD = ROOT / "scratch" / "walkforward-economic-flip-gate.md"
NAMES = [
    "log_z", "brown_risk_logit", "mom10_z", "mom30_z", "crosses60",
    "cross_fresh", "range_z", "book_risk_logit", "book_fall15",
    "spread", "odds_sum_dev", "stale_s",
]
BUDGET = 10.0
SETTLE = 0.995
EPOCHS = 450
LEARNING_RATE = 0.025
L2 = 0.015
MIN_TRAIN_DAYS = 21
TEST_DAYS = 7
BOOTSTRAPS = 50_000
SEED = 20260727


def normal_cdf_negative(z: np.ndarray) -> np.ndarray:
    x = np.abs(-z) / math.sqrt(2.0)
    t = 1.0 / (1.0 + 0.3275911 * x)
    poly = (
        (((((1.061405429 * t) - 1.453152027) * t + 1.421413741) * t
          - 0.284496736) * t + 0.254829592) * t
    )
    erf_abs = 1.0 - poly * np.exp(-(x * x))
    erf_value = np.where(-z < 0, -erf_abs, erf_abs)
    return 0.5 * (1.0 + erf_value)


def feature_matrix(frame: pd.DataFrame) -> np.ndarray:
    def values(column: str, fallback: float) -> np.ndarray:
        return frame[column].fillna(fallback).to_numpy(float)

    sigma = np.maximum(0.01, values("sigma60", 0.01))
    z = np.clip(values("z", 20), 0, 20)
    book_risk = np.clip(1.0 - values("favMid", 0.5), 0.0025, 0.9975)
    brown = np.clip(normal_cdf_negative(z), 0.0025, 0.9975)
    features = {
        "log_z": np.log1p(z),
        "brown_risk_logit": np.log(brown / (1.0 - brown)),
        "mom10_z": np.clip(
            values("momTo10", 0) / (sigma * math.sqrt(10)), -8, 8
        ),
        "mom30_z": np.clip(
            values("momTo30", 0) / (sigma * math.sqrt(30)), -8, 8
        ),
        "crosses60": np.clip(values("cross60", 0), 0, 8),
        "cross_fresh": np.exp(
            -np.clip(values("lastCrossAge", 999), 0, 300) / 30
        ),
        "range_z": np.clip(
            values("range60", 0) / (sigma * math.sqrt(60)), 0, 12
        ),
        "book_risk_logit": np.log(book_risk / (1.0 - book_risk)),
        "book_fall15": np.clip(-values("dMid15", 0), -0.5, 0.5),
        "spread": np.clip(values("spread", 0), 0, 0.25),
        "odds_sum_dev": np.clip(
            np.abs(values("oddsSum", 1) - 1.0), 0, 0.5
        ),
        "stale_s": np.clip(values("staleSecs", 0), 0, 20),
    }
    return np.column_stack([features[name] for name in NAMES])


def fit_logistic(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    means = x.mean(axis=0)
    stds = np.maximum(1e-6, x.std(axis=0, ddof=1))
    z = (x - means) / stds
    prevalence = np.clip(y.mean(), 0.001, 0.999)
    weights = np.zeros(z.shape[1] + 1)
    weights[0] = math.log(prevalence / (1.0 - prevalence))
    first = np.zeros_like(weights)
    second = np.zeros_like(weights)
    beta1 = 0.9
    beta2 = 0.999
    for epoch in range(1, EPOCHS + 1):
        score = weights[0] + z @ weights[1:]
        prediction = 1.0 / (1.0 + np.exp(-np.clip(score, -40, 40)))
        error = prediction - y
        gradient = np.r_[
            error.mean(),
            (z.T @ error) / len(y) + L2 * weights[1:],
        ]
        learning_rate = LEARNING_RATE / (1.0 + epoch / 900.0)
        first = beta1 * first + (1.0 - beta1) * gradient
        second = beta2 * second + (1.0 - beta2) * gradient * gradient
        first_hat = first / (1.0 - beta1**epoch)
        second_hat = second / (1.0 - beta2**epoch)
        weights -= learning_rate * first_hat / (np.sqrt(second_hat) + 1e-8)
    return means, stds, weights


def predict(x: np.ndarray, model: tuple[np.ndarray, np.ndarray, np.ndarray]) -> np.ndarray:
    means, stds, weights = model
    score = weights[0] + ((x - means) / stds) @ weights[1:]
    return 1.0 / (1.0 + np.exp(-np.clip(score, -40, 40)))


def max_drawdown(values: np.ndarray) -> float:
    if not len(values):
        return 0.0
    equity = np.cumsum(values)
    peaks = np.maximum.accumulate(np.r_[0.0, equity])[:-1]
    return float(np.max(peaks - equity))


def is_midas_like(frame: pd.DataFrame) -> np.ndarray:
    return (
        frame["favAsk"].between(0.55, 0.94, inclusive="both")
        & (frame["dist"].abs() < 40)
        & (frame["spread"] <= 0.03)
        & frame["oddsSum"].between(0.98, 1.06, inclusive="both")
    ).to_numpy(bool)


def realized_pnl(frame: pd.DataFrame) -> np.ndarray:
    ask = frame["favAsk"].to_numpy(float)
    shares = BUDGET / ask
    fee = shares * 0.07 * ask * (1.0 - ask)
    return np.where(
        frame["flip"].to_numpy(int) == 1,
        -BUDGET - fee,
        shares * SETTLE - BUDGET - fee,
    )


def predicted_pnl(frame: pd.DataFrame, p_flip: np.ndarray) -> np.ndarray:
    ask = frame["favAsk"].to_numpy(float)
    shares = BUDGET / ask
    fee = shares * 0.07 * ask * (1.0 - ask)
    return shares * (1.0 - p_flip) * SETTLE - BUDGET - fee


raw = pd.read_csv(INPUT)
rows = raw[raw["tau"] == 30].copy()
rows["date"] = pd.to_datetime(rows["day"])
rows.sort_values("event_start", inplace=True)
x_all = feature_matrix(rows)
x_market_all = x_all[:, [NAMES.index("book_risk_logit")]]
y_all = rows["flip"].to_numpy(float)

first_day = rows["date"].min()
last_day_exclusive = rows["date"].max() + pd.Timedelta(days=1)
test_start = first_day + pd.Timedelta(days=MIN_TRAIN_DAYS)
predicted_rows = []
folds = []

while test_start < last_day_exclusive:
    test_end = min(test_start + pd.Timedelta(days=TEST_DAYS), last_day_exclusive)
    train_mask = (rows["date"] < test_start).to_numpy(bool)
    test_mask = (
        (rows["date"] >= test_start) & (rows["date"] < test_end)
    ).to_numpy(bool)
    model = fit_logistic(x_all[train_mask], y_all[train_mask])
    market_only_model = fit_logistic(x_market_all[train_mask], y_all[train_mask])
    test_frame = rows.loc[test_mask].copy()
    test_frame["pFlipWalkForward"] = predict(x_all[test_mask], model)
    test_frame["pFlipMarketOnly"] = predict(
        x_market_all[test_mask], market_only_model
    )
    predicted_rows.append(test_frame)
    folds.append(
        {
            "trainFrom": str(first_day.date()),
            "trainToExclusive": str(test_start.date()),
            "testFrom": str(test_start.date()),
            "testToExclusive": str(test_end.date()),
            "trainRows": int(train_mask.sum()),
            "testRows": int(test_mask.sum()),
        }
    )
    test_start = test_end

oos = pd.concat(predicted_rows, ignore_index=True)
oos = oos.loc[is_midas_like(oos)].copy()
oos["realizedPnl"] = realized_pnl(oos)
oos["predictedPnl"] = predicted_pnl(
    oos, oos["pFlipWalkForward"].to_numpy(float)
)
oos["marketOnlyCalibratedPredictedPnl"] = predicted_pnl(
    oos, oos["pFlipMarketOnly"].to_numpy(float)
)
oos["marketPredictedPnl"] = predicted_pnl(
    oos, np.clip(1.0 - oos["favMid"].to_numpy(float), 0.001, 0.999)
)

combined_ev0 = oos["predictedPnl"].to_numpy(float) <= 0.0
combined_p40 = oos["pFlipWalkForward"].to_numpy(float) >= 0.40
market_ev = oos["marketPredictedPnl"].to_numpy(float)
market_risk = np.clip(1.0 - oos["favMid"].to_numpy(float), 0.001, 0.999)
market_ev_matched_threshold = float(np.quantile(market_ev, combined_ev0.mean()))
market_risk_matched_threshold = float(
    np.quantile(market_risk, 1.0 - combined_p40.mean())
)
gates = {
    "combined_ev_le_0": combined_ev0,
    "combined_ev_le_minus_0p5": oos["predictedPnl"].to_numpy(float) <= -0.5,
    "combined_pflip_ge_0p40": combined_p40,
    "combined_pflip_ge_0p45": (
        oos["pFlipWalkForward"].to_numpy(float) >= 0.45
    ),
    "combined_pflip_ge_0p50": (
        oos["pFlipWalkForward"].to_numpy(float) >= 0.50
    ),
    "market_only_calibrated_ev_le_0": (
        oos["marketOnlyCalibratedPredictedPnl"].to_numpy(float) <= 0.0
    ),
    "market_only_calibrated_pflip_ge_0p40": (
        oos["pFlipMarketOnly"].to_numpy(float) >= 0.40
    ),
    "market_ev_coverage_matched": market_ev <= market_ev_matched_threshold,
    "market_risk_coverage_matched": market_risk >= market_risk_matched_threshold,
    "market_ev_le_0": oos["marketPredictedPnl"].to_numpy(float) <= 0.0,
}
base_pnl = oos["realizedPnl"].to_numpy(float)
baseline = {
    "entries": int(len(oos)),
    "pnl": float(base_pnl.sum()),
    "maxDrawdown": max_drawdown(base_pnl),
}

rng = np.random.default_rng(SEED)
results = {}
for name, blocked in gates.items():
    kept_pnl = base_pnl[~blocked]
    oos[f"delta_{name}"] = np.where(blocked, -base_pnl, 0.0)
    daily = oos.groupby("day", sort=True)[f"delta_{name}"].sum().to_numpy(float)
    draws = rng.choice(daily, size=(BOOTSTRAPS, len(daily)), replace=True).sum(axis=1)
    low, high = np.quantile(draws, [0.025, 0.975])
    weekly = (
        oos.assign(
            week=pd.to_datetime(oos["day"]).dt.to_period("W-MON").astype(str)
        )
        .groupby("week", sort=True)[f"delta_{name}"]
        .sum()
        .to_numpy(float)
    )
    results[name] = {
        "blocked": int(blocked.sum()),
        "blockRate": float(blocked.mean()),
        "flipsAvoided": int(oos.loc[blocked, "flip"].sum()),
        "precision": float(oos.loc[blocked, "flip"].mean()) if blocked.any() else None,
        "pnlDelta": float(-base_pnl[blocked].sum()),
        "newPnl": float(kept_pnl.sum()),
        "newMaxDrawdown": max_drawdown(kept_pnl),
        "positiveDays": int((daily > 0).sum()),
        "negativeDays": int((daily < 0).sum()),
        "days": int(len(daily)),
        "positiveWeeks": int((weekly > 0).sum()),
        "negativeWeeks": int((weekly < 0).sum()),
        "weeks": int(len(weekly)),
        "bootstrapCi95Total": [float(low), float(high)],
        "bootstrapProbabilityPositive": float((draws > 0).mean()),
    }

comparisons = {}
for name, left, right in (
    (
        "combined_ev0_vs_market_only_ev0",
        "combined_ev_le_0",
        "market_only_calibrated_ev_le_0",
    ),
    (
        "combined_p40_vs_market_risk_matched",
        "combined_pflip_ge_0p40",
        "market_risk_coverage_matched",
    ),
):
    difference = oos[f"delta_{left}"] - oos[f"delta_{right}"]
    daily = (
        oos.assign(difference=difference)
        .groupby("day", sort=True)["difference"]
        .sum()
        .to_numpy(float)
    )
    draws = rng.choice(daily, size=(BOOTSTRAPS, len(daily)), replace=True).sum(axis=1)
    low, high = np.quantile(draws, [0.025, 0.975])
    comparisons[name] = {
        "left": left,
        "right": right,
        "deltaPnlDifference": float(difference.sum()),
        "positiveDays": int((daily > 0).sum()),
        "negativeDays": int((daily < 0).sum()),
        "bootstrapCi95Total": [float(low), float(high)],
        "bootstrapProbabilityPositive": float((draws > 0).mean()),
    }

fold_results = []
for fold in folds:
    start = pd.Timestamp(fold["testFrom"])
    end = pd.Timestamp(fold["testToExclusive"])
    selected = oos[
        (pd.to_datetime(oos["day"]) >= start)
        & (pd.to_datetime(oos["day"]) < end)
    ]
    fold_row = {
        "testFrom": fold["testFrom"],
        "testToExclusive": fold["testToExclusive"],
        "entries": int(len(selected)),
        "baselinePnl": float(selected["realizedPnl"].sum()),
        "gates": {},
    }
    for name in gates:
        blocked = selected[f"delta_{name}"].to_numpy(float) != 0
        fold_row["gates"][name] = {
            "blocked": int(blocked.sum()),
            "pnlDelta": float(selected[f"delta_{name}"].sum()),
        }
    fold_results.append(fold_row)

report = {
    "generatedAt": pd.Timestamp.utcnow().isoformat(),
    "method": "expanding weekly walk-forward; 21 initial training days; 7-day tests",
    "label": "Gamma resolved outcome; no final-book-consensus filter",
    "input": str(INPUT.relative_to(ROOT)),
    "folds": folds,
    "oosFrom": str(oos["day"].min()),
    "oosTo": str(oos["day"].max()),
    "baseline": baseline,
    "matchedControlThresholds": {
        "marketEvUsdPer10": market_ev_matched_threshold,
        "marketRisk": market_risk_matched_threshold,
    },
    "results": results,
    "comparisons": comparisons,
    "foldResults": fold_results,
    "warning": (
        "Execution is an entry counterfactual at best ask, without latency or fill guarantee. "
        "This evaluates a skip gate, not the full MIDAS engine."
    ),
}
OUT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

lines = [
    "# Gate econômico anti-flip — walk-forward semanal",
    "",
    f"OOS: {report['oosFrom']} a {report['oosTo']}; "
    f"{len(folds)} folds. Treino sempre anterior ao teste.",
    "",
    f"Baseline: {baseline['entries']} entradas, PnL {baseline['pnl']:+.2f}, "
    f"DD {baseline['maxDrawdown']:.2f}.",
    "",
    "| gate | bloqueadas | precisão flip | ΔPnL | PnL novo | DD novo | semanas +/− | IC95% Δ |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
]
for name, row in results.items():
    low, high = row["bootstrapCi95Total"]
    precision = "—" if row["precision"] is None else f"{row['precision']:.1%}"
    lines.append(
        f"| `{name}` | {row['blocked']} ({row['blockRate']:.1%}) | {precision} | "
        f"{row['pnlDelta']:+.2f} | {row['newPnl']:+.2f} | "
        f"{row['newMaxDrawdown']:.2f} | "
        f"{row['positiveWeeks']}/{row['negativeWeeks']} | "
        f"[{low:+.2f}; {high:+.2f}] |"
    )
lines.extend(
    [
        "",
        "O controle `market_ev_le_0` usa apenas `1 - favMid`; ele mostra se o "
        "efeito vem simplesmente do preço ou da calibração residual do modelo.",
        "",
        "## Comparações pareadas contra controles de preço",
        "",
        "| comparação | vantagem ΔPnL | dias +/− | IC95% |",
        "|---|---:|---:|---:|",
    ]
)
for name, row in comparisons.items():
    low, high = row["bootstrapCi95Total"]
    lines.append(
        f"| `{name}` | {row['deltaPnlDifference']:+.2f} | "
        f"{row['positiveDays']}/{row['negativeDays']} | "
        f"[{low:+.2f}; {high:+.2f}] |"
    )
lines.extend(
    [
        "",
        "## Evolução por fold",
        "",
        "| início teste | entradas | PnL base | EV≤0 bloqueadas | Δ EV≤0 | pFlip≥0,40 bloqueadas | Δ pFlip |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
)
for fold in fold_results:
    ev = fold["gates"]["combined_ev_le_0"]
    p40 = fold["gates"]["combined_pflip_ge_0p40"]
    lines.append(
        f"| {fold['testFrom']} | {fold['entries']} | "
        f"{fold['baselinePnl']:+.2f} | {ev['blocked']} | "
        f"{ev['pnlDelta']:+.2f} | {p40['blocked']} | "
        f"{p40['pnlDelta']:+.2f} |"
    )
OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(OUT_MD)
