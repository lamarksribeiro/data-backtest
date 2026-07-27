"""Testa um gate anti-flip guiado por valor esperado, não por corte fixo.

O modelo logístico e suas escalas permanecem congelados no artefato canônico.
Para cada entrada MIDAS-like em 30 s, calculamos:

    E[PnL | pFlip] = shares * (1 - pFlip) * settle - budget - fee

O gate bloqueia somente entradas cujo valor esperado previsto fica abaixo de
um piso. O piso é selecionado usando treino + validação; julho é apenas lido
depois da escolha.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(r"D:\Projetos\projeto-goldenlens\data-backtest")
FEATURES = ROOT / "scratch" / "flip-features-canonical.csv"
MODEL_REPORT = ROOT / "scratch" / "flip-model-canonical-report.json"
OUT_JSON = ROOT / "scratch" / "economic-flip-gate.json"
OUT_MD = ROOT / "scratch" / "economic-flip-gate.md"
BUDGET = 10.0
SETTLE = 0.995
EV_FLOORS = (-4.0, -3.0, -2.5, -2.0, -1.5, -1.0, -0.75, -0.5, -0.25, 0.0)
BOOTSTRAPS = 50_000
SEED = 20260727


def split_of(day: str) -> str:
    if day < "2026-06-15":
        return "train"
    if day < "2026-07-01":
        return "validation"
    return "holdout"


def max_drawdown(values: np.ndarray) -> float:
    equity = np.cumsum(values)
    peaks = np.maximum.accumulate(np.r_[0.0, equity])[:-1]
    return float(np.max(peaks - equity)) if len(values) else 0.0


def normal_cdf_negative(z: np.ndarray) -> np.ndarray:
    # Mesma aproximação de Abramowitz-Stegun usada pelo script canônico.
    x = np.abs(-z) / math.sqrt(2.0)
    t = 1.0 / (1.0 + 0.3275911 * x)
    poly = (
        (((((1.061405429 * t) - 1.453152027) * t + 1.421413741) * t
          - 0.284496736) * t + 0.254829592) * t
    )
    erf_abs = 1.0 - poly * np.exp(-(x * x))
    erf_value = np.where(-z < 0, -erf_abs, erf_abs)
    return 0.5 * (1.0 + erf_value)


def build_features(frame: pd.DataFrame, names: list[str]) -> np.ndarray:
    def values(column: str, fallback: float) -> np.ndarray:
        return frame[column].fillna(fallback).to_numpy(float)

    sigma = np.maximum(0.01, values("sigma60", 0.01))
    z = np.clip(values("z", 20), 0, 20)
    book_risk = np.clip(1.0 - values("favMid", 0.5), 0.0025, 0.9975)
    brown = np.clip(normal_cdf_negative(z), 0.0025, 0.9975)
    values = {
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
    return np.column_stack([values[name] for name in names])


def summarize(frame: pd.DataFrame, blocked: np.ndarray) -> dict:
    kept = ~blocked
    skipped_pnl = frame.loc[blocked, "realizedPnl"].to_numpy(float)
    kept_pnl = frame.loc[kept, "realizedPnl"].to_numpy(float)
    return {
        "entries": int(len(frame)),
        "blocked": int(blocked.sum()),
        "blockRate": float(blocked.mean()) if len(frame) else 0.0,
        "flipsAvoided": int(frame.loc[blocked, "flip"].sum()),
        "precision": float(frame.loc[blocked, "flip"].mean()) if blocked.any() else None,
        "pnlDelta": float(-skipped_pnl.sum()),
        "newPnl": float(kept_pnl.sum()),
        "newMaxDrawdown": max_drawdown(kept_pnl),
    }


def daily_bootstrap(frame: pd.DataFrame, blocked: np.ndarray) -> dict:
    daily = (
        frame.assign(delta=np.where(blocked, -frame["realizedPnl"], 0.0))
        .groupby("day", sort=True)["delta"]
        .sum()
        .to_numpy(float)
    )
    rng = np.random.default_rng(SEED)
    draws = rng.choice(daily, size=(BOOTSTRAPS, len(daily)), replace=True).sum(axis=1)
    low, high = np.quantile(draws, [0.025, 0.975])
    return {
        "days": int(len(daily)),
        "positiveDays": int((daily > 0).sum()),
        "negativeDays": int((daily < 0).sum()),
        "ci95Total": [float(low), float(high)],
        "probabilityPositive": float((draws > 0).mean()),
    }


raw = pd.read_csv(FEATURES)
frame = raw[
    (raw["tau"] == 30)
    & raw["favAsk"].between(0.55, 0.94, inclusive="both")
    & (raw["dist"].abs() < 40)
    & (raw["spread"] <= 0.03)
    & raw["oddsSum"].between(0.98, 1.06, inclusive="both")
].copy()
frame["split"] = frame["day"].map(split_of)
frame.sort_values("event_start", inplace=True)

artifact = json.loads(MODEL_REPORT.read_text(encoding="utf-8"))
model = artifact["byTau"]["30"]["model"]
x = build_features(frame, model["names"])
standardized = (x - np.asarray(model["means"])) / np.asarray(model["stds"])
weights = np.asarray(model["weights"])
logit = weights[0] + standardized @ weights[1:]
frame["pFlip"] = 1.0 / (1.0 + np.exp(-np.clip(logit, -40, 40)))

ask = frame["favAsk"].to_numpy(float)
shares = BUDGET / ask
fee = shares * 0.07 * ask * (1.0 - ask)
frame["realizedPnl"] = np.where(
    frame["flip"].to_numpy(int) == 1,
    -BUDGET - fee,
    shares * SETTLE - BUDGET - fee,
)
frame["predictedPnl"] = (
    shares * (1.0 - frame["pFlip"].to_numpy(float)) * SETTLE
    - BUDGET
    - fee
)
market_p_flip = np.clip(1.0 - frame["favMid"].to_numpy(float), 0.001, 0.999)
frame["marketPredictedPnl"] = (
    shares * (1.0 - market_p_flip) * SETTLE
    - BUDGET
    - fee
)

baseline = {}
for split in ("train", "validation", "holdout"):
    selected = frame[frame["split"] == split]
    pnl = selected["realizedPnl"].to_numpy(float)
    baseline[split] = {
        "entries": int(len(selected)),
        "pnl": float(pnl.sum()),
        "maxDrawdown": max_drawdown(pnl),
    }

candidate_rows = []
market_candidate_rows = []
for floor in EV_FLOORS:
    result = {"evFloor": floor, "splits": {}}
    market_result = {"evFloor": floor, "splits": {}}
    for split in ("train", "validation", "holdout"):
        selected = frame[frame["split"] == split]
        blocked = selected["predictedPnl"].to_numpy(float) <= floor
        market_blocked = selected["marketPredictedPnl"].to_numpy(float) <= floor
        result["splits"][split] = summarize(selected, blocked)
        market_result["splits"][split] = summarize(selected, market_blocked)
    candidate_rows.append(result)
    market_candidate_rows.append(market_result)

eligible = [
    row for row in candidate_rows
    if row["splits"]["train"]["pnlDelta"] > 0
    and row["splits"]["validation"]["pnlDelta"] > 0
]
if not eligible:
    raise SystemExit("Nenhum piso de EV foi positivo em treino e validação.")

# Escolha conservadora: melhor pior delta normalizado entre treino e validação.
def selection_score(row: dict) -> float:
    return min(
        row["splits"][split]["pnlDelta"] / baseline[split]["entries"]
        for split in ("train", "validation")
    )


selected_row = max(eligible, key=selection_score)
selected_floor = selected_row["evFloor"]
bootstrap = {}
for split in ("train", "validation", "holdout"):
    selected = frame[frame["split"] == split]
    blocked = selected["predictedPnl"].to_numpy(float) <= selected_floor
    bootstrap[split] = daily_bootstrap(selected, blocked)
bootstrap["all"] = daily_bootstrap(
    frame,
    frame["predictedPnl"].to_numpy(float) <= selected_floor,
)

bounded_candidates = [
    row for row in eligible
    if max(
        row["splits"]["train"]["blockRate"],
        row["splits"]["validation"]["blockRate"],
    ) <= 0.15
]
bounded_row = max(bounded_candidates, key=selection_score)
bounded_floor = bounded_row["evFloor"]
bounded_bootstrap = {}
for split in ("train", "validation", "holdout"):
    selected = frame[frame["split"] == split]
    blocked = selected["predictedPnl"].to_numpy(float) <= bounded_floor
    bounded_bootstrap[split] = daily_bootstrap(selected, blocked)
bounded_bootstrap["all"] = daily_bootstrap(
    frame,
    frame["predictedPnl"].to_numpy(float) <= bounded_floor,
)

fixed_p40 = {}
fixed_p40_bootstrap = {}
for split in ("train", "validation", "holdout"):
    selected = frame[frame["split"] == split]
    blocked = selected["pFlip"].to_numpy(float) >= 0.40
    fixed_p40[split] = summarize(selected, blocked)
    fixed_p40_bootstrap[split] = daily_bootstrap(selected, blocked)
fixed_p40_bootstrap["all"] = daily_bootstrap(
    frame,
    frame["pFlip"].to_numpy(float) >= 0.40,
)

report = {
    "generatedAt": pd.Timestamp.utcnow().isoformat(),
    "input": str(FEATURES.relative_to(ROOT)),
    "model": str(MODEL_REPORT.relative_to(ROOT)),
    "selection": {
        "uses": ["train", "validation"],
        "criterion": "maximize minimum pnlDelta per baseline entry",
        "selectedEvFloorUsdPer10": selected_floor,
    },
    "baseline": baseline,
    "candidates": candidate_rows,
    "marketRawCandidates": market_candidate_rows,
    "selected": selected_row,
    "selectedBootstrap": bootstrap,
    "boundedSelection": {
        "criterion": "same score with maximum 15% block rate in train and validation",
        "selectedEvFloorUsdPer10": bounded_floor,
        "result": bounded_row,
        "bootstrap": bounded_bootstrap,
    },
    "fixedPFlip40Reference": fixed_p40,
    "fixedPFlip40Bootstrap": fixed_p40_bootstrap,
    "warning": (
        "July remains temporally out-of-sample for model fitting and floor selection, "
        "but is not an untouched analyst holdout after prior anti-flip research."
    ),
}
OUT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

lines = [
    "# Gate anti-flip por valor esperado",
    "",
    "Modelo congelado em 30 s. Piso escolhido apenas com treino + validação.",
    "",
    "| piso EV previsto / US$10 | Δ treino | Δ validação | Δ julho | bloqueadas julho |",
    "|---:|---:|---:|---:|---:|",
]
for row in candidate_rows:
    lines.append(
        f"| {row['evFloor']:+.2f} | "
        f"{row['splits']['train']['pnlDelta']:+.2f} | "
        f"{row['splits']['validation']['pnlDelta']:+.2f} | "
        f"{row['splits']['holdout']['pnlDelta']:+.2f} | "
        f"{row['splits']['holdout']['blocked']} |"
    )
lines.extend(
    [
        "",
        f"Selecionado: bloquear quando `E[PnL previsto] <= {selected_floor:+.2f}` "
        "por US$10.",
        "",
        "| split | bloqueadas | precisão | ΔPnL | PnL novo | DD novo | IC95% Δ |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
)
for split in ("train", "validation", "holdout"):
    row = selected_row["splits"][split]
    low, high = bootstrap[split]["ci95Total"]
    precision = "—" if row["precision"] is None else f"{row['precision']:.1%}"
    lines.append(
        f"| {split} | {row['blocked']} | {precision} | "
        f"{row['pnlDelta']:+.2f} | {row['newPnl']:+.2f} | "
        f"{row['newMaxDrawdown']:.2f} | [{low:+.2f}; {high:+.2f}] |"
    )
lines.extend(
    [
        "",
        f"Candidato com bloqueio limitado a 15%: "
        f"`E[PnL previsto] <= {bounded_floor:+.2f}` por US$10.",
        "",
        "| split | bloqueadas | precisão | ΔPnL | PnL novo | DD novo | IC95% Δ |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
)
for split in ("train", "validation", "holdout"):
    row = bounded_row["splits"][split]
    low, high = bounded_bootstrap[split]["ci95Total"]
    precision = "—" if row["precision"] is None else f"{row['precision']:.1%}"
    lines.append(
        f"| {split} | {row['blocked']} | {precision} | "
        f"{row['pnlDelta']:+.2f} | {row['newPnl']:+.2f} | "
        f"{row['newMaxDrawdown']:.2f} | [{low:+.2f}; {high:+.2f}] |"
    )
lines.extend(
    [
        "",
        "Aviso: julho é OOS para ajuste do modelo e escolha do piso, mas já foi "
        "consultado em pesquisas anti-flip anteriores; não é mais holdout analítico intocado.",
        "",
        "## Controle com probabilidade bruta do próprio mid",
        "",
        "| piso EV previsto / US$10 | Δ treino | Δ validação | Δ julho | bloqueadas julho |",
        "|---:|---:|---:|---:|---:|",
    ]
)
for row in market_candidate_rows:
    lines.append(
        f"| {row['evFloor']:+.2f} | "
        f"{row['splits']['train']['pnlDelta']:+.2f} | "
        f"{row['splits']['validation']['pnlDelta']:+.2f} | "
        f"{row['splits']['holdout']['pnlDelta']:+.2f} | "
        f"{row['splits']['holdout']['blocked']} |"
    )
OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(OUT_MD)
